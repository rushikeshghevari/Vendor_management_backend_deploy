import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

const newHodSchema = z.object({
  name: z.string().trim().min(2).max(100),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8).max(128),
  phone: z.string().trim().max(20).optional(),
});

export const createDepartmentSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    code: z.string().trim().min(2).max(20),
    description: z.string().trim().max(500).optional(),
    departmentHead: z.string().trim().max(100).optional(),
    isActive: z.boolean().optional(),
    isRequirementTarget: z.boolean().optional(),
    // Optional HOD assignment at creation time — at most one of the two.
    createHod: z.boolean().optional(),
    hod: newHodSchema.optional(),
    hodId: objectId.optional(),
  })
  .superRefine((data, ctx) => {
    if (data.hod && data.hodId) {
      ctx.addIssue({ code: 'custom', path: ['hodId'], message: 'Provide either "hod" (create new) or "hodId" (assign existing), not both' });
    }
    if (data.createHod && !data.hod) {
      ctx.addIssue({ code: 'custom', path: ['hod'], message: '"hod" details are required when createHod is true' });
    }
  });

export const updateDepartmentSchema = z.object({
  name: z.string().trim().min(2).max(100).optional(),
  code: z.string().trim().min(2).max(20).optional(),
  description: z.string().trim().max(500).optional(),
  departmentHead: z.string().trim().max(100).optional(),
  isActive: z.boolean().optional(),
  isRequirementTarget: z.boolean().optional(),
});

export const updateDepartmentStatusSchema = z.object({
  isActive: z.boolean(),
});

export const transferHodSchema = z.object({
  newHodId: objectId,
  demoteOldHod: z.boolean().optional(),
});

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema>;
export type UpdateDepartmentStatusInput = z.infer<typeof updateDepartmentStatusSchema>;
export type TransferHodInput = z.infer<typeof transferHodSchema>;
