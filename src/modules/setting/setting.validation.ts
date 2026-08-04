import { z } from 'zod';

export const updateSettingSchema = z.object({
  ceoApprovalLimit: z.coerce.number().positive('CEO Approval Limit must be greater than 0'),
});

export type UpdateSettingInput = z.infer<typeof updateSettingSchema>;
