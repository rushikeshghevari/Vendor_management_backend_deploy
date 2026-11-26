import { z } from 'zod';

import { ADVANCE_PAYMENT_STATUS } from '@/constants/status';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const accountsVerifyAdvancePaymentSchema = z.object({
  remarks: z.string().trim().max(1000).optional(),
});

export const markAdvancePaymentPaidSchema = z.object({
  paymentReference: z.string().trim().min(1, 'Payment reference is required').max(200),
  remarks: z.string().trim().max(1000).optional(),
});

export const advancePaymentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(Object.values(ADVANCE_PAYMENT_STATUS) as [string, ...string[]]).optional(),
  department: objectId.optional(),
  search: z.string().optional(),
});

export type AccountsVerifyAdvancePaymentInput = z.infer<typeof accountsVerifyAdvancePaymentSchema>;
export type MarkAdvancePaymentPaidInput = z.infer<typeof markAdvancePaymentPaidSchema>;
export type AdvancePaymentListQuery = z.infer<typeof advancePaymentListQuerySchema>;
