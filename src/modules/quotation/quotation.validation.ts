import { z } from 'zod';

import { QUOTATION_STATUS } from '@/constants/status';
import { QUOTATION_CURRENCIES, QUOTATION_PRIORITIES } from '@/modules/quotation/quotation.model';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const temporaryVendorSchema = z.object({
  name: z.string().trim().min(2, 'Vendor name is required'),
  contactPerson: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(50).optional(),
  email: z.string().trim().email('Enter a valid email').optional(),
  address: z.string().trim().max(500).optional(),
});

// A quotation's advance can never exceed its own total — caught here so a typo doesn't
// silently produce a negative balance amount downstream (external payments API, etc).
function refineAdvanceAmount<T extends { amount: number; advanceAmount?: number }>(
  data: T,
  ctx: z.RefinementCtx,
): void {
  if (data.advanceAmount !== undefined && data.advanceAmount > data.amount) {
    ctx.addIssue({
      code: 'custom',
      path: ['advanceAmount'],
      message: 'Advance amount cannot exceed the quotation amount',
    });
  }
}

// `quotationCode`, `department`, and `createdBy` are deliberately absent — all three are
// always derived server-side from the authenticated department_user, never trusted from the body.
// Kept as a plain (unrefined) object so `updateQuotationSchema` below can still `.omit()`/
// `.partial()` it — `.superRefine()` is applied separately, only on the create-time export.
const baseQuotationSchema = z.object({
  vendor: objectId,
  quotationDate: z.coerce.date(),
  requiredDate: z.coerce.date(),
  amount: z.coerce.number().positive('Amount must be greater than 0'),
  gst: z.coerce.number().min(0).max(100),
  currency: z.enum(QUOTATION_CURRENCIES).default('INR'),
  paymentTerms: z.string().trim().min(1, 'Payment terms are required'),
  deliveryTerms: z.string().trim().min(1, 'Delivery terms are required'),
  creditPeriod: z.coerce.number().min(0, 'Credit period is required'),
  // How much the vendor wants paid before the PO/goods — 0/omitted means nothing upfront,
  // equal to `amount` means the vendor wants 100% in advance. The remainder is due per
  // `creditPeriod` above.
  advanceAmount: z.coerce.number().min(0).optional(),
  // The vendor's own promised delivery date for this quotation.
  expectedDeliveryDate: z.coerce.date().optional(),
  // When the department expects to raise the PO — the real deadline for advanceAmount above.
  expectedPODate: z.coerce.date().optional(),
  priority: z.enum(QUOTATION_PRIORITIES).default('medium'),
  description: z.string().trim().max(2000).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

export const createQuotationSchema = baseQuotationSchema.superRefine(refineAdvanceAmount);

export const createRequirementQuotationSchema = z
  .object({
    temporaryVendor: temporaryVendorSchema,
    quotationDate: z.coerce.date(),
    amount: z.coerce.number().positive('Amount must be greater than 0'),
    gst: z.coerce.number().min(0).max(100),
    currency: z.enum(QUOTATION_CURRENCIES).default('INR'),
    paymentTerms: z.string().trim().min(1, 'Payment terms are required'),
    deliveryTerms: z.string().trim().min(1, 'Delivery terms are required'),
    creditPeriod: z.coerce.number().min(0, 'Credit period is required'),
    advanceAmount: z.coerce.number().min(0).optional(),
    expectedDeliveryDate: z.coerce.date().optional(),
    expectedPODate: z.coerce.date().optional(),
    priority: z.enum(QUOTATION_PRIORITIES).default('medium'),
    description: z.string().trim().max(2000).optional(),
    remarks: z.string().trim().max(1000).optional(),
  })
  .superRefine(refineAdvanceAmount);

// `vendor` is deliberately omitted — create() validates the caller owns/can-see that vendor
// (ownership + department + active-status checks); update() has no equivalent re-validation,
// so allowing a client to repoint an existing quotation at an arbitrary vendor id would bypass
// those checks entirely. Reassigning the vendor means creating a new quotation, not editing one
// (mirrors the same omission on Bill — see bill.validation.ts's updateBillSchema).
export const updateQuotationSchema = baseQuotationSchema.omit({ vendor: true }).partial();

export const decisionSchema = z
  .object({
    decision: z.enum([QUOTATION_STATUS.NEGOTIATION, QUOTATION_STATUS.APPROVED, QUOTATION_STATUS.REJECTED]),
    remarks: z.string().trim().max(1000).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision !== QUOTATION_STATUS.APPROVED && !data.remarks) {
      ctx.addIssue({
        code: 'custom',
        path: ['remarks'],
        message: 'Remarks are mandatory for Negotiation and Rejection decisions',
      });
    }
  });

export const quotationListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(Object.values(QUOTATION_STATUS) as [string, ...string[]]).optional(),
  department: objectId.optional(),
  vendor: objectId.optional(),
  requirement: objectId.optional(),
  search: z.string().optional(),
});

export type CreateQuotationInput = z.infer<typeof createQuotationSchema>;
export type CreateRequirementQuotationInput = z.infer<typeof createRequirementQuotationSchema>;
export type UpdateQuotationInput = z.infer<typeof updateQuotationSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;
