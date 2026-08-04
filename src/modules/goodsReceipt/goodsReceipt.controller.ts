import type { Request, Response } from 'express';

import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { goodsReceiptService } from '@/modules/goodsReceipt/goodsReceipt.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const goodsReceiptController = {

  create: catchAsync(async (req: Request, res: Response) => {
    const receipt = await goodsReceiptService.create(req.body, req.user!);

    activityLogService.record(
      { action: 'goods_receipt_created', targetId: String(receipt._id), targetType: 'GoodsReceipt', newValue: { grnNumber: receipt.grnNumber, purchaseOrder: receipt.purchaseOrder } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, receipt, 'Goods Receipt recorded successfully', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await goodsReceiptService.list(
      req.query as Record<string, unknown> as Parameters<typeof goodsReceiptService.list>[0],
      req.user!,
    );
    sendSuccess(res, items, 'Goods Receipts fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const receipt = await goodsReceiptService.getById(req.params.id as string, req.user!);
    sendSuccess(res, receipt, 'Goods Receipt fetched');
  }),

  getByPurchaseOrder: catchAsync(async (req: Request, res: Response) => {
    const receipt = await goodsReceiptService.getByPurchaseOrder(req.params.purchaseOrderId as string, req.user!);
    sendSuccess(res, receipt, receipt ? 'Goods Receipt fetched' : 'No Goods Receipt found for this Purchase Order');
  }),
};
