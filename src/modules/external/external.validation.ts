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
