import type { Request, Response } from 'express';

import { aiAuditLogService } from '@/modules/aiAuditLog/aiAuditLog.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const aiAuditLogController = {

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await aiAuditLogService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'AI audit logs fetched', 200, meta);
  }),

  listByPurchaseOrder: catchAsync(async (req: Request, res: Response) => {
    const items = await aiAuditLogService.listByPurchaseOrder(req.params.purchaseOrderId!, req.user!);
    sendSuccess(res, items, 'AI audit logs fetched');
  }),
};
