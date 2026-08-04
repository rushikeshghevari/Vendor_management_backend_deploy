import { z } from 'zod';

import { REQUIREMENT_PRIORITIES, REQUIREMENT_STATUS } from '@/constants/status';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const requirementItemSchema = z.object({
  itemName: z.string().trim().min(1, 'Item name is required'),
  specification: z.string().trim().max(1000).optional(),
  quantity: z.coerce.number().positive('Quantity must be greater than 0'),
  unit: z.string().trim().min(1, 'Unit is required'),
  estimatedRate: z.coerce.number().min(0),
  // Optional — requirement.service.ts auto-computes it as quantity * estimatedRate when omitted.
  estimatedAmount: z.coerce.number().min(0).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

// `department` and `createdBy` are deliberately absent — both are always derived
// server-side from the authenticated department_user, never trusted from the body
// (same idiom as createQuotationSchema).
export const createRequirementSchema = z.object({
  title: z.string().trim().min(2, 'Title is required'),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(REQUIREMENT_PRIORITIES).default('medium'),
  budget: z.coerce.number().positive('Budget must be greater than 0'),
  requiredDate: z.coerce.date(),
  remarks: z.string().trim().max(1000).optional(),
  items: z.array(requirementItemSchema).min(1, 'At least one item is required'),
});

export const updateRequirementSchema = createRequirementSchema.partial();

export const requirementListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  status: z.enum(Object.values(REQUIREMENT_STATUS) as [string, ...string[]]).optional(),
  department: objectId.optional(),
  priority: z.enum(REQUIREMENT_PRIORITIES).optional(),
  search: z.string().optional(),
});

export type CreateRequirementInput = z.infer<typeof createRequirementSchema>;
export type UpdateRequirementInput = z.infer<typeof updateRequirementSchema>;
