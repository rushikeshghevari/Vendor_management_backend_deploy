/**
 * Recurring Expense due-date reminder — runs on a 1-day interval, same in-process
 * `setInterval` pattern as `src/services/reminder/reminder.service.ts` and
 * `src/services/escalation/escalation.service.ts`.
 *
 * Never creates a Bill itself — a real invoice/receipt has to be attached by a human first
 * (see recurringExpenseService.generateCycle). This only nudges the department to do that once
 * a series' `nextDueDate` has arrived, and keeps nudging daily until they do (nextDueDate isn't
 * advanced until a cycle is actually generated), same as the department getting a daily
 * reminder that a payment is overdue.
 */

import { recurringExpenseService } from '@/modules/recurringExpense/recurringExpense.service';

const DAY_MS = 24 * 60 * 60 * 1000;

async function runDueCheck(): Promise<void> {
  const due = await recurringExpenseService.findDueSeries(new Date());
  for (const series of due) {
    await recurringExpenseService.notifyDue(series).catch((err) =>
      console.error(`[recurring-expense] notify failed for series ${series._id}:`, err),
    );
  }
}

let intervalHandle: ReturnType<typeof setInterval> | null = null;

export function startRecurringExpenseReminderScheduler(): void {
  if (intervalHandle) return; // already running
  runDueCheck().catch((err) => console.error('[recurring-expense] initial run failed:', err));
  intervalHandle = setInterval(
    () => runDueCheck().catch((err) => console.error('[recurring-expense] run failed:', err)),
    DAY_MS,
  );
  console.info('[recurring-expense] Due-date reminder scheduler started (24h interval)');
}

export function stopRecurringExpenseReminderScheduler(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
