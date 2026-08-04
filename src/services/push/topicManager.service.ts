/**
 * FCM Topic Manager
 *
 * Topic naming conventions:
 *   Role topics:       role_<role>              e.g. role_accounts
 *   Department topics: dept_<departmentId>       e.g. dept_64abc...
 *   Broadcast:         all_users
 *
 * Topics are managed server-side via the Firebase Admin SDK.
 * Mobile devices do NOT need to call subscribeToTopic() — the backend
 * manages subscriptions when devices register/unregister.
 */

import type { Role } from '@/constants/roles';
import { firebaseService } from '@/services/firebase/firebase.service';

export function roleTopic(role: Role): string {
  return `role_${role}`;
}

export function deptTopic(departmentId: string): string {
  return `dept_${departmentId}`;
}

const BATCH_SIZE = 1000; // FCM allows up to 1000 tokens per subscribeToTopic call

/**
 * Subscribe a list of FCM tokens to a topic.
 * Silently no-ops if Firebase is not configured.
 */
export async function subscribeToTopic(tokens: string[], topic: string): Promise<void> {
  const messaging = firebaseService.getMessaging();
  if (!messaging || tokens.length === 0) return;

  // FCM limits batches to 1000 tokens
  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    try {
      await messaging.subscribeToTopic(batch, topic);
    } catch (err) {
      console.error(`[topic] subscribeToTopic(${topic}) failed:`, err);
    }
  }
}

/**
 * Unsubscribe a list of FCM tokens from a topic.
 */
export async function unsubscribeFromTopic(tokens: string[], topic: string): Promise<void> {
  const messaging = firebaseService.getMessaging();
  if (!messaging || tokens.length === 0) return;

  for (let i = 0; i < tokens.length; i += BATCH_SIZE) {
    const batch = tokens.slice(i, i + BATCH_SIZE);
    try {
      await messaging.unsubscribeFromTopic(batch, topic);
    } catch (err) {
      console.error(`[topic] unsubscribeFromTopic(${topic}) failed:`, err);
    }
  }
}

/**
 * Unsubscribe a token from all VMS topics it might be subscribed to.
 * Called when a device is removed.
 */
export async function unsubscribeFromAllTopics(tokens: string[], role: Role, departmentId?: string): Promise<void> {
  const messaging = firebaseService.getMessaging();
  if (!messaging || tokens.length === 0) return;

  const topics = [roleTopic(role), 'all_users'];
  if (departmentId) topics.push(deptTopic(departmentId));

  for (const topic of topics) {
    await unsubscribeFromTopic(tokens, topic).catch(() => null);
  }
}

