import type { Request, Response } from 'express';

import { auditLogService } from '@/modules/auditLog/auditLog.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const auditLogController = {

  create: catchAsync(async (req: Request, res: Response) => {
    const log = await auditLogService.create({ ...req.body, actor: req.user! });
    sendSuccess(res, log, 'Audit log created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await auditLogService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Audit logs fetched', 200, meta);
  }),

  listByPurchaseOrder: catchAsync(async (req: Request, res: Response) => {
    const logs = await auditLogService.listByPurchaseOrder(req.params.purchaseOrderId as string, req.user!);
    sendSuccess(res, logs, 'Audit logs fetched');
  }),
};
