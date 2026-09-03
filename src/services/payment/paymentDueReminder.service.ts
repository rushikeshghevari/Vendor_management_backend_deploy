/**
 * Payment-due reminder — runs on a 1-day interval, same in-process `setInterval` pattern as
 * escalation.service.ts / recurringExpenseReminder.service.ts.
 *
 * Two sources feed the same "payment coming up" notification to Payment Department:
 *  - Bill.dueDate, for bills already VERIFIED/PAYMENT_PENDING — a confirmed amount
 *    (invoiceAmount), since the real invoice already exists.
 *  - RecurringExpense.nextDueDate, for a series whose cycle hasn't been generated yet — a
 *    tentative amount (the originally Director-approved baseline), flagged as such since the
 *    real invoice amount is only known once someone actually generates that cycle.
 *
 * "Within N days" always means daysRemaining <= N, which naturally includes 0 and negative
 * (overdue) — an overdue payment keeps getting a daily nudge for as long as it stays unpaid,
 * the same self-correcting design already used by recurringExpenseReminder's own due check.
 * dedupKey is scoped to today's date, so a restart never re-sends today's reminder twice, but
 * tomorrow's tick still sends a fresh one for as long as the payment remains outstanding.
 */

import { ROLES } from '@/constants/roles';
import { BILL_STATUS } from '@/constants/status';
import { Bill } from '@/modules/bill/bill.model';
import { notificationService } from '@/modules/notification/notification.service';
import { RecurringExpense } from '@/modules/recurringExpense/recurringExpense.model';

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

interface ApprovalLike {
  decision: string;
  decidedAt: Date;
  director?: { name?: string } | null;
}

/** Renders a Quotation's director-approval roster as one readable string — used so the Payment
 *  Department reminder always states who approved the spend, not just the amount and date. */
export function formatQuotationApprovals(
  quotation: { directorApprovals?: ApprovalLike[] } | null | undefined,
): string {
  const approvals = (quotation?.directorApprovals ?? []).filter((a) => a.decision === 'approved');
  if (approvals.length === 0) return 'no Director approval on record';
  return approvals
    .map((a) => `${a.director?.name ?? 'a Director'} (${new Date(a.decidedAt).toLocaleDateString('en-IN')})`)
    .join(', ');
}

/** The raw timestamp of the first Director approval on record, for a consumer that wants a
 *  parseable date rather than `formatQuotationApprovals`' human-readable string. `null` when
 *  no Director has approved yet — same "not approved" case `formatQuotationApprovals` reports. */
export function getFirstApprovalDate(
  quotation: { directorApprovals?: ApprovalLike[] } | null | undefined,
): Date | null {
  const approved = (quotation?.directorApprovals ?? []).find((a) => a.decision === 'approved');
  return approved ? new Date(approved.decidedAt) : null;
}

async function notifyBillsDue(now: Date): Promise<void> {
  const paymentTeam = await notificationService.findActiveUsersByRole(ROLES.PAYMENT_DEPARTMENT);
  if (paymentTeam.length === 0) return;

  const cutoff = new Date(now.getTime() + REMINDER_WINDOW_DAYS * DAY_MS);
  const bills = await Bill.find({
    status: { $in: [BILL_STATUS.VERIFIED, BILL_STATUS.PAYMENT_PENDING] },
    isDeleted: { $ne: true },
    dueDate: { $lte: cutoff },
  })
    .populate('vendor', 'name')
    .populate('reimbursedTo', 'name')
    .populate({ path: 'quotation', populate: { path: 'directorApprovals.director', select: 'name' } })
    .lean();

  const today = now.toISOString().slice(0, 10);

  for (const bill of bills) {
    const vendor = bill.vendor as unknown as { name?: string } | null;
    const reimbursedTo = bill.reimbursedTo as unknown as { name?: string } | null;
    const payee = vendor?.name ?? reimbursedTo?.name ?? 'Unknown';
    const days = daysRemaining(bill.dueDate, now);
    const approvalsText = formatQuotationApprovals(bill.quotation as unknown as { directorApprovals?: ApprovalLike[] });

    await notificationService
      .notifyUsers(paymentTeam, {
        title: 'Payment Due Soon',
        message: `${bill.billCode} — ₹${bill.invoiceAmount.toLocaleString('en-IN')} for ${payee}, ${formatDaysText(days)}. Approved by: ${approvalsText}.`,
        module: 'bill',
        relatedRecord: String(bill._id),
        notificationType: 'payment_due_reminder',
        priority: days <= 2 ? 'critical' : days <= 5 ? 'high' : 'medium',
        category: 'warning',
        dedupKey: `payment-due:${today}:${bill._id}`,
      })
      .catch((err) => console.error(`[payment-due] notify failed for bill ${bill._id}:`, err));
  }
}

async function notifyRecurringDue(now: Date): Promise<void> {
  const paymentTeam = await notificationService.findActiveUsersByRole(ROLES.PAYMENT_DEPARTMENT);
  if (paymentTeam.length === 0) return;

  const cutoff = new Date(now.getTime() + REMINDER_WINDOW_DAYS * DAY_MS);
  const series = await RecurringExpense.find({
    isActive: true,
    nextDueDate: { $lte: cutoff },
  })
    .populate('vendor', 'name')
    .populate('reimbursedTo', 'name')
    .lean();

  const today = now.toISOString().slice(0, 10);

  for (const item of series) {
    const vendor = item.vendor as unknown as { name?: string } | null;
    const reimbursedTo = item.reimbursedTo as unknown as { name?: string } | null;
    const payee = vendor?.name ?? reimbursedTo?.name ?? 'Unknown';
    const days = daysRemaining(item.nextDueDate, now);

    await notificationService
      .notifyUsers(paymentTeam, {
        title: 'Upcoming Recurring Payment (Tentative)',
        message: `${item.title} — approx ₹${item.baselineAmount.toLocaleString('en-IN')} for ${payee}, ${formatDaysText(days)}. Actual invoice not generated yet — amount may change.`,
        module: 'bill',
        relatedRecord: String(item._id),
        notificationType: 'payment_due_reminder',
        priority: days <= 2 ? 'high' : 'medium',
        category: 'information',
        dedupKey: `recurring-payment-due:${today}:${item._id}`,
      })
      .catch((err) => console.error(`[payment-due] notify failed for series ${item._id}:`, err));
  }
}

async function runPaymentDueCheck(): Promise<void> {
  const now = new Date();
  await notifyBillsDue(now).catch((err) => console.error('[payment-due] bill check failed:', err));
  await notifyRecurringDue(now).catch((err) => console.error('[payment-due] recurring check failed:', err));
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startPaymentDueReminderScheduler(): void {
  if (intervalHandle) return; // already running
  runPaymentDueCheck().catch((err) => console.error('[payment-due] initial run failed:', err));
  intervalHandle = setInterval(
    () => runPaymentDueCheck().catch((err) => console.error('[payment-due] run failed:', err)),
    DAY_MS,
  );
  console.info(`[payment-due] Payment due reminder scheduler started (24h interval, ${REMINDER_WINDOW_DAYS}-day window)`);
}

export function stopPaymentDueReminderScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
