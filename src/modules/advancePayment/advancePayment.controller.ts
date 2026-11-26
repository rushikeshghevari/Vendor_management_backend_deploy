import type { Request, Response } from 'express';

import { advancePaymentService } from '@/modules/advancePayment/advancePayment.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const advancePaymentController = {
  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await advancePaymentService.list(req.query as never, req.user!);
    sendSuccess(res, items, 'Advance payments fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const advancePayment = await advancePaymentService.getById(req.params.id as string, req.user!);
    sendSuccess(res, advancePayment, 'Advance payment fetched');
  }),

  accountsVerify: catchAsync(async (req: Request, res: Response) => {
    const advancePayment = await advancePaymentService.accountsVerify(req.params.id as string, req.body, req.user!);
    sendSuccess(res, advancePayment, 'Advance payment verified');
  }),

  markPaid: catchAsync(async (req: Request, res: Response) => {
    const advancePayment = await advancePaymentService.markPaid(req.params.id as string, req.body, req.user!);
    sendSuccess(res, advancePayment, 'Advance payment marked as paid');
  }),
};
