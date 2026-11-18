import type { Request, Response } from 'express';

import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { goodsHandoverService } from '@/modules/goodsHandover/goodsHandover.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const goodsHandoverController = {

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await goodsHandoverService.list(
      req.query as Record<string, unknown> as Parameters<typeof goodsHandoverService.list>[0],
      req.user!,
    );
    sendSuccess(res, items, 'Goods Handovers fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const handover = await goodsHandoverService.getById(req.params.id as string, req.user!);
    sendSuccess(res, handover, 'Goods Handover fetched');
  }),

  getByGoodsReceipt: catchAsync(async (req: Request, res: Response) => {
    const handover = await goodsHandoverService.getByGoodsReceipt(req.params.goodsReceiptId as string, req.user!);
    sendSuccess(res, handover, handover ? 'Goods Handover fetched' : 'No Goods Handover for this Goods Receipt');
  }),

  handOver: catchAsync(async (req: Request, res: Response) => {
    const handover = await goodsHandoverService.handOver(req.params.id as string, req.user!);

    activityLogService.record(
      { action: 'goods_handover_handed_over', targetId: String(handover._id), targetType: 'GoodsHandover', newValue: { requirementNumber: handover.requirementNumber } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, handover, 'Handover confirmed');
  }),

  receive: catchAsync(async (req: Request, res: Response) => {
    const handover = await goodsHandoverService.receive(req.params.id as string, req.user!);

    activityLogService.record(
      { action: 'goods_handover_received', targetId: String(handover._id), targetType: 'GoodsHandover', newValue: { requirementNumber: handover.requirementNumber } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, handover, 'Receipt confirmed');
  }),

  distribute: catchAsync(async (req: Request, res: Response) => {
    const handover = await goodsHandoverService.distribute(req.params.id as string, req.body, req.user!);

    activityLogService.record(
      { action: 'goods_handover_distributed', targetId: String(handover._id), targetType: 'GoodsHandover', newValue: { requirementNumber: handover.requirementNumber, distributedToDepartment: handover.distributedToDepartment } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, handover, 'Distribution logged');
  }),
};
