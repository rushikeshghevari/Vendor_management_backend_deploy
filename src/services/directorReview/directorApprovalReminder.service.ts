/**
 * Director approval-due reminder — runs on a 1-day interval, same in-process `setInterval`
 * pattern as escalation.service.ts / paymentDueReminder.service.ts.
 *
 * As a Requirement's prepared quotation's expectedPODate gets close, whichever Director(s)
 * on that requirement's DirectorReview roster still have a `pending` decision get a daily
 * nudge — a Director who already decided (approved/rejected/sent_back) never gets one, even
 * if the requirement is still waiting on the other Director.
 *
 * dedupKey is scoped to today's date + requirement + director, so a restart never re-sends
 * today's reminder twice, but tomorrow's tick still sends a fresh one for as long as that
 * Director's decision remains pending and the requirement is still in Director Review.
 */

import { ROLES } from '@/constants/roles';
import { REQUIREMENT_STATUS } from '@/constants/status';
import { DirectorReview } from '@/modules/directorReview/directorReview.model';
import { notificationService } from '@/modules/notification/notification.service';
import { Requirement } from '@/modules/requirement/requirement.model';

const DAY_MS = 24 * 60 * 60 * 1000;
const REMINDER_WINDOW_DAYS = 7;

function daysRemaining(dueDate: Date, now: Date): number {
  return Math.ceil((dueDate.getTime() - now.getTime()) / DAY_MS);
}

function formatDaysText(days: number): string {
  if (days < 0) return `overdue by ${Math.abs(days)} day${Math.abs(days) === 1 ? '' : 's'}`;
  if (days === 0) return 'due today';
  return `due in ${days} day${days === 1 ? '' : 's'}`;
}

async function runDirectorApprovalCheck(now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() + REMINDER_WINDOW_DAYS * DAY_MS);

  const requirements = await Requirement.find({
    status: REQUIREMENT_STATUS.DIRECTOR_REVIEW,
    preparedQuotation: { $exists: true, $ne: null },
    isDeleted: { $ne: true },
  })
    .select('requirementNumber title preparedQuotation')
    .populate('preparedQuotation', 'expectedPODate')
    .lean();

  const dueRequirements = requirements.filter((req) => {
    const quotation = req.preparedQuotation as unknown as { expectedPODate?: Date } | null;
    return quotation?.expectedPODate && new Date(quotation.expectedPODate) <= cutoff;
  });
  if (dueRequirements.length === 0) return;

  const reviews = await DirectorReview.find({ requirement: { $in: dueRequirements.map((r) => r._id) } })
    .select('requirement approvals')
    .lean();
  const reviewByRequirement = new Map(reviews.map((r) => [String(r.requirement), r]));

  const today = now.toISOString().slice(0, 10);

  for (const req of dueRequirements) {
    const review = reviewByRequirement.get(String(req._id));
    if (!review) continue;

    const pendingDirectors = review.approvals.filter((a) => a.decision === 'pending');
    if (pendingDirectors.length === 0) continue;

    const quotation = req.preparedQuotation as unknown as { expectedPODate: Date };
    const days = daysRemaining(quotation.expectedPODate, now);

    await notificationService
      .notifyUsers(
        pendingDirectors.map((d) => ({ id: d.director.toString(), role: ROLES.DIRECTOR })),
        {
          title: 'Director Approval Needed',
          message: `${req.requirementNumber} (${req.title}) — PO is planned ${formatDaysText(days)} and still needs your decision.`,
          module: 'requirement',
          relatedRecord: String(req._id),
          notificationType: 'director_approval_due_reminder',
          priority: days <= 1 ? 'critical' : days <= 3 ? 'high' : 'medium',
          category: 'warning',
          dedupKey: `director-approval-due:${today}:${req._id}`,
        },
      )
      .catch((err) => console.error(`[director-approval-due] notify failed for requirement ${req._id}:`, err));
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startDirectorApprovalReminderScheduler(): void {
  if (intervalHandle) return; // already running
  runDirectorApprovalCheck(new Date()).catch((err) => console.error('[director-approval-due] initial run failed:', err));
  intervalHandle = setInterval(
    () => runDirectorApprovalCheck(new Date()).catch((err) => console.error('[director-approval-due] run failed:', err)),
    DAY_MS,
  );
  console.info(`[director-approval-due] Director approval-due reminder scheduler started (24h interval, ${REMINDER_WINDOW_DAYS}-day window)`);
}

export function stopDirectorApprovalReminderScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
