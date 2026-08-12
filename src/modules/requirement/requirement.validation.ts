import { z } from 'zod';

import { REQUIREMENT_PRIORITIES, REQUIREMENT_STATUS } from '@/constants/status';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const requirementItemSchema = z.object({
  itemName: z.string().trim().min(1, 'Item name is required'),
  specification: z.string().trim().max(1000).optional(),
  quantity: z.coerce.number().positive('Quantity must be greater than 0'),
  // Optional — the requester only has to say what's needed and how much; unit/rate are filled
  // in later during quotation collection. requirement.service.ts defaults unit to 'pcs' and
  // estimatedRate to 0 when omitted.
  unit: z.string().trim().min(1, 'Unit is required').optional(),
  estimatedRate: z.coerce.number().min(0).optional(),
  // Optional — requirement.service.ts auto-computes it as quantity * estimatedRate when omitted.
  estimatedAmount: z.coerce.number().min(0).optional(),
  remarks: z.string().trim().max(1000).optional(),
});

// `department` and `createdBy` are deliberately absent — both are always derived
// server-side from the authenticated department_user, never trusted from the body
// (same idiom as createQuotationSchema). `targetDepartment` is the one deliberate escape
// hatch: a Department User may route the requirement to a *different* department (e.g. an
// IT user requesting furniture routes to Admin) — requirement.service.ts validates it against
// the isRequirementTarget-flagged department list before trusting it.
//
// `title`, `budget`, and `requiredDate` are all optional: the requester shouldn't have to set
// a budget upfront (that's decided later, against actual quotations) or write a title (derived
// from the item names) or pick a target date (defaulted). requirement.service.ts fills all
// three in server-side so the stored Requirement document always has them set.
export const createRequirementSchema = z.object({
  title: z.string().trim().min(2, 'Title is required').optional(),
  description: z.string().trim().max(2000).optional(),
  priority: z.enum(REQUIREMENT_PRIORITIES).default('medium'),
  budget: z.coerce.number().min(0).optional(),
  requiredDate: z.coerce.date().optional(),
  remarks: z.string().trim().max(1000).optional(),
  items: z.array(requirementItemSchema).min(1, 'At least one item is required'),
  targetDepartment: objectId.optional(),
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
