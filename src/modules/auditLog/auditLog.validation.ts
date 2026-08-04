import { z } from 'zod';

import { ACCOUNTS_AUDIT_DECISIONS } from '@/modules/auditLog/auditLog.model';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid ObjectId');

export const createAuditLogSchema = z.object({
  purchaseOrderId:  objectId,
  billId:           objectId,
  quotationId:      objectId,
  accountsDecision: z.enum(ACCOUNTS_AUDIT_DECISIONS),
  reason: z.string().max(1000).optional(),
}).superRefine((data, ctx) => {
  if (['correction_requested', 'rejected'].includes(data.accountsDecision) && !data.reason?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['reason'], message: 'Reason is required for this decision' });
  }
});

export type CreateAuditLogBody = z.infer<typeof createAuditLogSchema>;
