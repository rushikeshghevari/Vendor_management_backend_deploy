/**
 * Follow-up reminder scheduler — runs on a 1-minute interval.
 *
 * This is the one deliberate exception to "every notification sends exactly once":
 * a notification can carry a `followUpDate`, and once that time passes, one reminder
 * fires and `followUpSent` latches true forever. The tick (and the immediate check on
 * server boot) is restart-safe by construction — `notificationService.processFollowUpReminders()`
 * atomically claims each due reminder via `findOneAndUpdate({ followUpSent: false }, { followUpSent: true })`,
 * so a reminder already sent by a previous run is never picked up again, no matter how
 * many times the process restarts or how many overlapping ticks occur.
 */

import { notificationService } from '@/modules/notification/notification.service';

const MINUTE_MS = 60 * 1000;

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startReminderScheduler(): void {
  if (intervalHandle) return; // already running

  // Checking immediately on boot is safe (not a duplicate-send risk): it only ever
  // acts on documents whose followUpSent is still false, and a past successful run
  // always flips that flag before this could see it again.
  notificationService.processFollowUpReminders().catch((err) =>
    console.error('[reminder] initial run failed:', err),
  );
  intervalHandle = setInterval(
    () => notificationService.processFollowUpReminders().catch((err) => console.error('[reminder] run failed:', err)),
    MINUTE_MS,
  );
  console.info('[reminder] Follow-up reminder scheduler started (1m interval)');
}

export function stopReminderScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
