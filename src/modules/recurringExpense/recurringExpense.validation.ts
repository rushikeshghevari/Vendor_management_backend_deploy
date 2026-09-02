import { z } from 'zod';

import { RECURRING_FREQUENCY, RECURRING_MODE } from '@/constants/status';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const UPI_REGEX = /^[\w.+-]{2,256}@[a-zA-Z]{2,64}$/;

// Mirrors Vendor.bankDetails (vendor.validation.ts) — there's no Vendor record for a
// reimbursement payee, so this is captured directly on the series instead.
const reimbursementBankDetailsSchema = z.object({
  bankName: z.string().trim().min(1, 'Bank name is required'),
  accountHolderName: z.string().trim().min(1, 'Account holder name is required'),
  accountNumber: z.string().trim().min(4, 'Enter a valid account number').max(20),
  ifscCode: z.string().trim().toUpperCase().regex(IFSC_REGEX, 'Enter a valid IFSC code'),
  upiId: z.string().trim().regex(UPI_REGEX, 'Enter a valid UPI ID').optional().or(z.literal('')),
});

// `department` and `createdBy` are always derived server-side from the authenticated actor.
// `vendor` is required for vendor_bill mode, `reimbursedTo`/`reimbursementBankDetails` for
// reimbursement mode — enforced below since exactly one applies depending on `mode`.
export const createRecurringExpenseSchema = z
  .object({
    title: z.string().trim().min(2, 'Title is required').max(150),
    mode: z.enum(Object.values(RECURRING_MODE) as [string, ...string[]]),
    vendor: objectId.optional(),
    reimbursedTo: objectId.optional(),
    reimbursementBankDetails: reimbursementBankDetailsSchema.optional(),
    frequency: z.enum(Object.values(RECURRING_FREQUENCY) as [string, ...string[]]),
    baselineAmount: z.coerce.number().positive('Baseline amount must be greater than 0'),
    thresholdPercent: z.coerce.number().min(0).max(1000).optional(),
    originRequirement: objectId.optional(),
    originQuotation: objectId.optional(),
    nextDueDate: z.coerce.date(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === RECURRING_MODE.VENDOR_BILL && !data.vendor) {
      ctx.addIssue({ code: 'custom', path: ['vendor'], message: 'Select the vendor being paid each cycle' });
    }
    if (data.mode === RECURRING_MODE.REIMBURSEMENT) {
      if (!data.reimbursedTo) {
        ctx.addIssue({ code: 'custom', path: ['reimbursedTo'], message: 'Select who is being reimbursed each cycle' });
      }
      if (!data.reimbursementBankDetails) {
        ctx.addIssue({ code: 'custom', path: ['reimbursementBankDetails'], message: 'Bank details are required to reimburse this employee' });
      }
    }
  });

export const updateRecurringExpenseSchema = z.object({
  title: z.string().trim().min(2).max(150).optional(),
  thresholdPercent: z.coerce.number().min(0).max(1000).optional(),
  reimbursementBankDetails: reimbursementBankDetailsSchema.optional(),
  isActive: z.boolean().optional(),
});

// The evidence for one cycle — a real invoice (vendor_bill) or a paid receipt (reimbursement).
// `invoiceFiles` is uploaded separately (mirrors createBillSchema's own file-after-create
// pattern) via the existing `POST /bills/:id/invoice` once the draft Bill this creates exists.
export const generateRecurringCycleSchema = z.object({
  invoiceNumber: z.string().trim().min(1, 'Invoice/reference number is required'),
  invoiceDate: z.coerce.date(),
  invoiceAmount: z.coerce.number().positive('Amount must be greater than 0'),
  taxableAmount: z.coerce.number().min(0).optional(),
  gstAmount: z.coerce.number().min(0).optional(),
  paymentTerms: z.string().trim().max(200).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

export const recurringExpenseListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  search: z.string().optional(),
});

export type CreateRecurringExpenseInput = z.infer<typeof createRecurringExpenseSchema>;
export type UpdateRecurringExpenseInput = z.infer<typeof updateRecurringExpenseSchema>;
export type GenerateRecurringCycleInput = z.infer<typeof generateRecurringCycleSchema>;
export type RecurringExpenseListQuery = z.infer<typeof recurringExpenseListQuerySchema>;
