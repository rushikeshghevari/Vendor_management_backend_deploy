import { z } from 'zod';

import { BILL_STATUS } from '@/constants/status';

export const externalBillListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(Object.values(BILL_STATUS) as [string, ...string[]]).optional(),
  // Only bills whose credit-period due date falls within the next N days (overdue ones —
  // due date already in the past — are included too, never excluded, since those need a
  // reminder more urgently than an upcoming one).
  dueWithinDays: z.coerce.number().int().min(0).optional(),
});

export type ExternalBillListQuery = z.infer<typeof externalBillListQuerySchema>;

// GET /external/payments/upcoming — merges confirmed Bill.dueDate entries with tentative
// RecurringExpense.nextDueDate entries (real invoice not generated yet) into one list, for the
// same Payment-department calendar-reminder integration described above.
export const externalUpcomingPaymentsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  // Defaults to 7 (not optional-with-no-default) since this endpoint's whole purpose is
  // "what's coming due soon" — unlike externalBillListQuerySchema's dueWithinDays, which only
  // filters when a caller opts in. Overdue items (daysRemaining < 0) are always included too.
  withinDays: z.coerce.number().int().min(0).max(365).default(7),
});

export type ExternalUpcomingPaymentsQuery = z.infer<typeof externalUpcomingPaymentsQuerySchema>;
