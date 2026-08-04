/**
 * Escalation scheduler — runs on a 1-hour interval.
 * Checks for pending quotations/bills that have not moved in 24h/48h/72h and
 * notifies the next approval tier.
 *
 * This runs in-process alongside the Express server (no separate worker needed
 * for this scale). For very large deployments, move to a BullMQ/cron worker.
 */

import { ROLES } from '@/constants/roles';
import { Quotation } from '@/modules/quotation/quotation.model';
import { notificationService } from '@/modules/notification/notification.service';
import { User } from '@/modules/user/user.model';

const HOUR_MS = 60 * 60 * 1000;

export async function runEscalationCheck(): Promise<void> {
  const now = Date.now();

  // ── Quotation escalation ──────────────────────────────────────────────────
  try {
    const pendingQuotations = await Quotation.find({
      status: { $in: ['submitted', 'resubmitted'] },
      isDeleted: false,
    }).select('_id quotationCode updatedAt createdBy').lean();

    for (const q of pendingQuotations) {
      const ageMs = now - new Date(q.updatedAt).getTime();
      const ageHours = ageMs / HOUR_MS;

      // dedupKey below is `escalation:<tier>:<quotationId>` (notifyUsers appends
      // `:<receiverId>` per recipient) — a Director who already got the 24h notice for
      // this quotation can never get it again, on the next hourly tick OR after a
      // restart, since the unique index rejects the second insert at the DB level.
      // This is the actual fix for "same notification resent on every server restart."
      if (ageHours >= 72) {
        // 72h+ — notify Super Admin
        const superAdmins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
        if (superAdmins.length > 0) {
          await notificationService.notifyUsers(superAdmins, {
            title: 'Escalation: Quotation Overdue (72h)',
            message: `Quotation ${q.quotationCode} has been pending approval for over 72 hours.`,
            module: 'quotation',
            relatedRecord: q._id.toString(),
            notificationType: 'escalation',
            priority: 'critical',
            category: 'warning',
            dedupKey: `escalation:72h:${q._id}`,
          });
        }
      } else if (ageHours >= 48) {
        // 48h — notify CEO
        const ceos = await notificationService.findActiveUsersByRole(ROLES.CEO);
        if (ceos.length > 0) {
          await notificationService.notifyUsers(ceos, {
            title: 'Escalation: Quotation Pending (48h)',
            message: `Quotation ${q.quotationCode} has been pending approval for over 48 hours.`,
            module: 'quotation',
            relatedRecord: q._id.toString(),
            notificationType: 'escalation',
            priority: 'high',
            category: 'warning',
            dedupKey: `escalation:48h:${q._id}`,
          });
        }
      } else if (ageHours >= 24) {
        // 24h — notify Directors
        const directors = await notificationService.findActiveUsersByRole(ROLES.DIRECTOR);
        if (directors.length > 0) {
          await notificationService.notifyUsers(directors, {
            title: 'Escalation: Quotation Pending (24h)',
            message: `Quotation ${q.quotationCode} has been pending approval for over 24 hours.`,
            module: 'quotation',
            relatedRecord: q._id.toString(),
            notificationType: 'escalation',
            priority: 'medium',
            category: 'warning',
            dedupKey: `escalation:24h:${q._id}`,
          });
        }
      }
    }
  } catch (err) {
    console.error('[escalation] quotation check failed:', err);
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startEscalationScheduler(): void {
  if (intervalHandle) return; // already running
  // Run immediately on startup, then every hour
  runEscalationCheck().catch((err) => console.error('[escalation] initial run failed:', err));
  intervalHandle = setInterval(
    () => runEscalationCheck().catch((err) => console.error('[escalation] run failed:', err)),
    HOUR_MS,
  );
  console.info('[escalation] Escalation scheduler started (1h interval)');
}

export function stopEscalationScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
