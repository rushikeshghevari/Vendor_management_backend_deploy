import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const goodsHandoverListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
});

// Admin's final internal distribution log — a plain note, no acknowledgment required from
// the receiving department/user (confirmed decision — see
// docs/PHASE12_DEPARTMENT_ROUTING_AND_GOODS_HANDOVER.md).
export const distributeGoodsHandoverSchema = z.object({
  distributedToDepartment: objectId,
  distributedToUser: objectId.optional(),
  note: z.string().trim().max(1000).optional(),
});

export type GoodsHandoverListQuery = z.infer<typeof goodsHandoverListQuerySchema>;
export type DistributeGoodsHandoverInput = z.infer<typeof distributeGoodsHandoverSchema>;
