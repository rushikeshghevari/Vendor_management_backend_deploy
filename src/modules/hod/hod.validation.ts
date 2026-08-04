import { z } from 'zod';

// `.strict()` rejects any unknown key outright (e.g. role/department) — department is always
// derived from the authenticated HOD's own token, never accepted from the client.
export const hodCreateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100),
    email: z.string().trim().toLowerCase().email(),
    password: z.string().min(8).max(128),
    phone: z.string().trim().max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const hodUpdateUserSchema = z
  .object({
    name: z.string().trim().min(2).max(100).optional(),
    phone: z.string().trim().max(20).optional(),
    isActive: z.boolean().optional(),
  })
  .strict();

export const hodUserListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  isActive: z.enum(['true', 'false']).optional(),
  search: z.string().trim().max(200).optional(),
  sort: z.enum(['name', 'email', 'createdAt']).optional(),
  order: z.enum(['asc', 'desc']).optional(),
});

export const hodBulkUserStatusSchema = z.object({
  ids: z.array(z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id')).min(1).max(200),
  isActive: z.boolean(),
});

export const hodResetPasswordSchema = z.object({
  newPassword: z.string().min(8).max(128),
});

export const hodUpdateUserStatusSchema = z.object({
  isActive: z.boolean(),
});

export type HodCreateUserInput = z.infer<typeof hodCreateUserSchema>;
export type HodUpdateUserInput = z.infer<typeof hodUpdateUserSchema>;
export type HodBulkUserStatusInput = z.infer<typeof hodBulkUserStatusSchema>;
