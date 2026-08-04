/**
 * Rich FCM Push Notification Service
 *
 * Channel selection:
 *   priority === 'critical'              → vms_critical   (high-importance Android channel)
 *   module === 'payment'                 → vms_payments
 *   module quotation|bill, approval type → vms_approvals
 *   silent === true                      → vms_silent     (data-only, no heads-up)
 *   otherwise                            → vms_default
 *
 * Action categories (iOS/Android notification action buttons):
 *   APPROVAL_ACTION   → Approve / Reject / Open  (quotation & bill approval types)
 *   PAYMENT_ACTION    → Confirm / Open            (payment types)
 *   INFO_ACTION       → Open                      (everything else)
 */

import type admin from 'firebase-admin';

import { firebaseService } from '@/services/firebase/firebase.service';
import { handleSendFailures } from '@/services/push/notificationQueue.service';

export interface RichPushPayload {
  title: string;
  body: string;
  module?: string;
  referenceId?: string;
  notificationType?: string;
  priority?: 'low' | 'medium' | 'high' | 'critical';
  imageUrl?: string;
  silent?: boolean;
  badgeCount?: number;
}

interface TokenEntry {
  token: string;
  userId: string;
  platform: 'android' | 'ios' | 'web';
}

export interface PushResult {
  successCount: number;
  failureCount: number;
}

// Approval-related notification types that get Approve/Reject action buttons
const APPROVAL_TYPES = new Set([
  'quotation_submitted', 'quotation_resubmitted',
  'bill_submitted', 'bill_resubmitted',
  'review_pending', 'bill_review_pending',
]);

const PAYMENT_TYPES = new Set([
  'payment_created', 'payment_processing', 'payment_paid',
  'payment_pending', 'payment_completed', 'payment_failed',
]);

function resolveChannelId(payload: RichPushPayload): string {
  if (payload.silent) return 'vms_silent';
  if (payload.priority === 'critical') return 'vms_critical';
  if (payload.module === 'payment') return 'vms_payments';
  if (
    (payload.module === 'quotation' || payload.module === 'bill') &&
    payload.notificationType &&
    APPROVAL_TYPES.has(payload.notificationType)
  ) return 'vms_approvals';
  return 'vms_default';
}

function resolveAndroidPriority(payload: RichPushPayload): 'high' | 'normal' {
  return payload.priority === 'critical' || payload.priority === 'high' ? 'high' : 'normal';
}

function resolveNotificationPriority(priority: string | undefined): 'max' | 'high' | 'default' | 'low' | 'min' {
  if (priority === 'critical') return 'max';
  if (priority === 'high') return 'high';
  if (priority === 'low') return 'low';
  return 'default';
}

function resolveCategoryId(payload: RichPushPayload): string {
  if (payload.notificationType && APPROVAL_TYPES.has(payload.notificationType)) {
    return 'vms_approval_action';
  }
  if (payload.notificationType && PAYMENT_TYPES.has(payload.notificationType)) {
    return 'vms_payment_action';
  }
  return 'vms_info_action';
}

function resolveApnsSound(payload: RichPushPayload): admin.messaging.ApnsPayload['aps']['sound'] {
  if (payload.priority === 'critical') {
    return { critical: true, name: 'default', volume: 1.0 };
  }
  if (payload.silent) return undefined;
  return 'default';
}

function buildMessage(entry: TokenEntry, payload: RichPushPayload): admin.messaging.Message {
  const channelId = resolveChannelId(payload);
  const androidPriority = resolveAndroidPriority(payload);
  const notifPriority = resolveNotificationPriority(payload.priority);
  const categoryId = resolveCategoryId(payload);
  const groupKey = payload.module ? `vms_${payload.module}` : 'vms_general';
  const tag = payload.notificationType && payload.referenceId
    ? `${payload.notificationType}_${payload.referenceId}`
    : undefined;

  const data: Record<string, string> = {
    module:           payload.module ?? '',
    referenceId:      payload.referenceId ?? '',
    notificationType: payload.notificationType ?? '',
    priority:         payload.priority ?? 'medium',
    channelId,
  };

  // Silent (data-only) — no notification key, content-available: 1
  if (payload.silent) {
    return {
      token: entry.token,
      data,
      android: { priority: 'high' },
      apns: {
        payload: { aps: { contentAvailable: true } },
        headers: { 'apns-push-type': 'background', 'apns-priority': '5' },
      },
    };
  }

  const message: admin.messaging.Message = {
    token: entry.token,
    notification: {
      title: payload.title,
      body:  payload.body,
      ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
    },
    data,
    android: {
      priority: androidPriority,
      notification: {
        channelId,
        priority: notifPriority,
        sound: channelId === 'vms_critical' ? 'vms_critical' : 'default',
        tag,
        ...(payload.imageUrl ? { imageUrl: payload.imageUrl } : {}),
      },
    },
    apns: {
      payload: {
        aps: {
          alert: { title: payload.title, body: payload.body },
          sound: resolveApnsSound(payload),
          badge: payload.badgeCount ?? 1,
          threadId: groupKey,
          category: categoryId,
        },
      },
      ...(payload.imageUrl ? { fcmOptions: { imageUrl: payload.imageUrl } } : {}),
    },
  };

  return message;
}

/**
 * Send rich FCM push notifications to a list of device tokens.
 * Silently no-ops if Firebase is not configured.
 * Handles delivery failures: removes invalid tokens, queues retryable failures.
 */
export async function sendPushToTokens(
  tokens: TokenEntry[],
  payload: RichPushPayload,
): Promise<PushResult> {
  const messaging = firebaseService.getMessaging();
  if (!messaging || tokens.length === 0) return { successCount: 0, failureCount: 0 };

  const active = tokens.filter((t) => t.token.length > 0);
  if (active.length === 0) return { successCount: 0, failureCount: 0 };

  const messages = active.map((entry) => buildMessage(entry, payload));

  try {
    const batch = await messaging.sendEach(messages);
    if (batch.failureCount > 0) {
      console.warn(`[push] ${batch.failureCount}/${messages.length} FCM messages failed`);
      // Fire-and-forget retry queue handling
      handleSendFailures(active, messages, batch.responses).catch((err) =>
        console.error('[push] handleSendFailures error:', err),
      );
    }
    return { successCount: batch.successCount, failureCount: batch.failureCount };
  } catch (err) {
    console.error('[push] FCM sendEach error:', err);
    return { successCount: 0, failureCount: active.length };
  }
}

