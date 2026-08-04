import { z } from 'zod';

export const mongoIdParamSchema = (paramName = 'id') =>
  z.object({ [paramName]: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id') });

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});
