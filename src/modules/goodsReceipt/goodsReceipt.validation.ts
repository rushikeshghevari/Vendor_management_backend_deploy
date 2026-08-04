import { z } from 'zod';

import { GRN_ITEM_CONDITION, GRN_OVERALL_CONDITION } from '@/constants/status';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const goodsReceiptItemSchema = z.object({
  itemName: z.string().trim().min(1, 'Item name is required'),
  orderedQuantity: z.coerce.number().min(0, 'Ordered quantity cannot be negative'),
  receivedQuantity: z.coerce.number().min(0, 'Received quantity cannot be negative'),
  condition: z.enum(Object.values(GRN_ITEM_CONDITION) as [string, ...string[]]),
  remarks: z.string().trim().max(500).optional(),
});

// `purchaseOrder`, `poNumber`, `requirement`, `vendor`, `department`, and `createdBy` are
// always derived server-side from the Purchase Order — never client-supplied.
export const createGoodsReceiptSchema = z.object({
  purchaseOrder: objectId,
  receivedDate: z.coerce.date(),
  items: z.array(goodsReceiptItemSchema).min(1, 'At least one item is required'),
  overallCondition: z.enum(Object.values(GRN_OVERALL_CONDITION) as [string, ...string[]]),
  remarks: z.string().trim().max(1000).optional(),
});

export const goodsReceiptListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  search: z.string().optional(),
});

export type CreateGoodsReceiptInput = z.infer<typeof createGoodsReceiptSchema>;
export type GoodsReceiptListQuery = z.infer<typeof goodsReceiptListQuerySchema>;
