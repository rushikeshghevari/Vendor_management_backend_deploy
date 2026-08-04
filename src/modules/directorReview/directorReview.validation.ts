import { z } from 'zod';

import { DIRECTOR_REVIEW_DECIDABLE } from '@/modules/directorReview/directorReview.model';
import { mongoIdParamSchema } from '@/utils/commonValidation';

export const directorReviewParamsSchema = mongoIdParamSchema('id');

// Remarks are mandatory for Reject and Send Back (the Department User needs to know why),
// optional for Approve — same convention as `quotation.validation.ts`'s `decisionSchema`.
export const decisionSchema = z
  .object({
    decision: z.enum(DIRECTOR_REVIEW_DECIDABLE),
    remarks: z.string().trim().max(2000).optional(),
    // Only meaningful for Approve — the Director's explicit pick of the winning quotation
    // (see vendorRegistrationService.resolveWinningQuotation). Rejected outright for
    // Reject/Send Back below rather than silently ignored, so a client bug surfaces clearly.
    selectedQuotationId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid quotation id').optional(),
  })
  .superRefine((data, ctx) => {
    if (data.decision !== 'approved' && !data.remarks) {
      ctx.addIssue({
        code: 'custom',
        path: ['remarks'],
        message: 'Remarks are mandatory for Reject and Send Back decisions',
      });
    }
    if (data.decision !== 'approved' && data.selectedQuotationId) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedQuotationId'],
        message: 'selectedQuotationId is only allowed when decision is approved',
      });
    }
    // The Director must explicitly pick the winning quotation — there is no AI/earliest-quotation
    // default finalization anymore (see vendorRegistrationService.resolveWinningQuotation).
    if (data.decision === 'approved' && !data.selectedQuotationId) {
      ctx.addIssue({
        code: 'custom',
        path: ['selectedQuotationId'],
        message: 'Select a quotation before approving — a Director must explicitly choose the winning quotation',
      });
    }
  });

export const remarksSchema = z.object({
  remarks: z.string().trim().min(1, 'Remarks are required').max(2000),
});

export type DecisionInput = z.infer<typeof decisionSchema>;
export type RemarksInput = z.infer<typeof remarksSchema>;
