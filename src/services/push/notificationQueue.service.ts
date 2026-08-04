/**
 * FCM Delivery Retry Queue
 *
 * When FCM sendEach returns failures:
 *   - Retryable errors (server/quota)  → add to queue, exponential backoff
 *   - Invalid token errors             → remove token from User.fcmTokens immediately
 *
 * Retry schedule (minutes): 1 → 5 → 30 → 120 → 480 (max 5 attempts)
 */

import { NotificationQueue } from '@/modules/notification/notificationQueue.model';
import { User } from '@/modules/user/user.model';
import { firebaseService } from '@/services/firebase/firebase.service';
import type admin from 'firebase-admin';

const RETRY_DELAYS_MIN = [1, 5, 30, 120, 480];

// FCM error codes that are retryable (server-side problems)
const RETRYABLE_CODES = new Set([
  'messaging/internal-error',
  'messaging/server-unavailable',
  'messaging/quota-exceeded',
  'messaging/message-rate-exceeded',
  'messaging/device-message-rate-exceeded',
]);

// FCM error codes that mean the token is permanently invalid
const INVALID_TOKEN_CODES = new Set([
  'messaging/invalid-registration-token',
  'messaging/registration-token-not-registered',
  'messaging/invalid-argument',
]);

function getRetryDelayMs(retryCount: number): number {
  const minutes = RETRY_DELAYS_MIN[retryCount] ?? RETRY_DELAYS_MIN.at(-1) ?? 480;
  return minutes * 60 * 1000;
}

function extractErrorCode(error: unknown): string {
  const e = error as { code?: string; errorInfo?: { code?: string } };
  return e?.errorInfo?.code ?? e?.code ?? 'messaging/unknown';
}

/**
 * Process failures from a sendEach batch.
 * Queues retryable failures; immediately cleans up invalid tokens.
 */
export async function handleSendFailures(
  tokens: Array<{ token: string; userId: string }>,
  payloads: admin.messaging.Message[],
  responses: admin.messaging.SendResponse[],
): Promise<void> {
  const queueDocs: Array<{
    token: string; userId: string; payload: Record<string, unknown>;
    retryCount: number; maxRetries: number; nextRetryAt: Date; lastError: string;
  }> = [];

  const invalidTokens: string[] = [];

  for (let i = 0; i < responses.length; i++) {
    const resp = responses[i];
    if (!resp) continue;
    if (resp.success) continue;

    const token   = tokens[i]?.token   ?? '';
    const userId  = tokens[i]?.userId  ?? '';
    const payload = payloads[i] as unknown as Record<string, unknown>;
    const code    = extractErrorCode(resp.error);

    if (INVALID_TOKEN_CODES.has(code)) {
      invalidTokens.push(token);
    } else if (RETRYABLE_CODES.has(code)) {
      const nextRetryAt = new Date(Date.now() + getRetryDelayMs(0));
      queueDocs.push({ token, userId, payload, retryCount: 0, maxRetries: 5, nextRetryAt, lastError: code });
    }
    // Other errors (e.g. invalid payload) are not retried
  }

  if (invalidTokens.length > 0) {
    await User.updateMany(
      { 'fcmTokens.token': { $in: invalidTokens } },
      { $pull: { fcmTokens: { token: { $in: invalidTokens } } } },
    );
    console.info(`[queue] Removed ${invalidTokens.length} invalid FCM token(s) from user profiles`);
  }

  if (queueDocs.length > 0) {
    await NotificationQueue.insertMany(queueDocs);
    console.info(`[queue] Queued ${queueDocs.length} FCM message(s) for retry`);
  }
}

/**
 * Process the retry queue — runs on a timer every 2 minutes.
 * Picks up items where nextRetryAt <= now and status === 'pending'.
 */
export async function processRetryQueue(): Promise<void> {
  const messaging = firebaseService.getMessaging();
  if (!messaging) return;

  const now = new Date();
  const items = await NotificationQueue.find({
    status:      'pending',
    nextRetryAt: { $lte: now },
  }).limit(50);

  if (items.length === 0) return;

  // Mark all as processing to avoid duplicate picks
  const ids = items.map((i) => i._id);
  await NotificationQueue.updateMany({ _id: { $in: ids } }, { status: 'processing' });

  for (const item of items) {
    try {
      const message = item.payload as unknown as admin.messaging.Message;
      const result = await messaging.send({ ...message, token: item.token });

      if (result) {
        await NotificationQueue.findByIdAndUpdate(item._id, { status: 'done' });
        console.info(`[queue] Retry succeeded for token ${item.token.slice(-8)}`);
      }
    } catch (err) {
      const code = extractErrorCode(err);

      if (INVALID_TOKEN_CODES.has(code)) {
        await User.updateMany(
          { 'fcmTokens.token': item.token },
          { $pull: { fcmTokens: { token: item.token } } },
        );
        await NotificationQueue.findByIdAndUpdate(item._id, {
          status: 'dead', lastError: `invalid_token: ${code}`,
        });
      } else {
        const nextCount = item.retryCount + 1;
        if (nextCount >= item.maxRetries) {
          await NotificationQueue.findByIdAndUpdate(item._id, {
            status: 'dead', retryCount: nextCount, lastError: code,
          });
          console.warn(`[queue] Message for token ${item.token.slice(-8)} exceeded max retries — marked dead`);
        } else {
          const nextRetryAt = new Date(Date.now() + getRetryDelayMs(nextCount));
          await NotificationQueue.findByIdAndUpdate(item._id, {
            status: 'pending', retryCount: nextCount, nextRetryAt, lastError: code,
          });
        }
      }
    }
  }
}

const QUEUE_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes
let queueIntervalHandle: ReturnType<typeof setInterval> | null = null;

export function startQueueProcessor(): void {
  if (queueIntervalHandle) return;
  queueIntervalHandle = setInterval(
    () => processRetryQueue().catch((err) => console.error('[queue] processRetryQueue error:', err)),
    QUEUE_INTERVAL_MS,
  );
  console.info('[queue] FCM retry queue processor started (2 min interval)');
}

export function stopQueueProcessor(): void {
  if (queueIntervalHandle) {
    clearInterval(queueIntervalHandle);
    queueIntervalHandle = null;
  }
}
