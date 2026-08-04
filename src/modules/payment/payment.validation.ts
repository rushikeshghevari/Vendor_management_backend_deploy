import { z } from 'zod';

import { PAYMENT_FAILURE_REASON, PAYMENT_METHOD, PAYMENT_STATUS } from '@/constants/status';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const createPaymentSchema = z.object({
  bill: objectId,
});

// Field-level requirements (UTR for online methods, cheque number for cheque) are enforced in
// payment.service.ts markPaid() — they depend on the method chosen in startProcessing, which
// this schema has no access to.
export const startProcessingSchema = z.object({
  paymentMethod: z.enum(Object.values(PAYMENT_METHOD) as [string, ...string[]]),
  bankName: z.string().trim().optional(),
  accountNumber: z.string().trim().optional(),
  ifsc: z.string().trim().optional(),
  upiId: z.string().trim().optional(),
});

export const markPaidSchema = z.object({
  utrNumber: z.string().trim().optional(),
  transactionReference: z.string().trim().optional(),
  chequeNumber: z.string().trim().optional(),
  paymentDate: z.coerce.date(),
  remarks: z.string().trim().max(1000).optional(),
});

export const markFailedSchema = z.object({
  failureReason: z.enum(Object.values(PAYMENT_FAILURE_REASON) as [string, ...string[]], {
    message: 'Select a failure reason',
  }),
  remarks: z.string().trim().max(1000).optional(),
});

export const paymentListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(Object.values(PAYMENT_STATUS) as [string, ...string[]]).optional(),
  vendor: objectId.optional(),
  department: objectId.optional(),
  paymentMethod: z.enum(Object.values(PAYMENT_METHOD) as [string, ...string[]]).optional(),
  search: z.string().optional(),
});

export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;
export type StartProcessingInput = z.infer<typeof startProcessingSchema>;
export type MarkPaidInput = z.infer<typeof markPaidSchema>;
export type MarkFailedInput = z.infer<typeof markFailedSchema>;
