import type { Request, Response } from 'express';

import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { paymentService } from '@/modules/payment/payment.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const paymentController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const payment = await paymentService.create(req.body, req.user!);
    sendSuccess(res, payment, 'Payment created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await paymentService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Payments fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const payment = await paymentService.getById(req.params.id as string, req.user!);
    sendSuccess(res, payment, 'Payment fetched');
  }),

  getByQuotation: catchAsync(async (req: Request, res: Response) => {
    const payment = await paymentService.getByQuotation(req.params.quotationId as string);
    sendSuccess(res, payment, 'Payment fetched');
  }),

  startProcessing: catchAsync(async (req: Request, res: Response) => {
    const payment = await paymentService.startProcessing(req.params.id as string, req.body, req.user!);
    sendSuccess(res, payment, 'Payment is now processing');
  }),

  markPaid: catchAsync(async (req: Request, res: Response) => {
    const payment = await paymentService.markPaid(req.params.id as string, req.body, req.user!);
    sendSuccess(res, payment, 'Payment marked as paid');
  }),

  markCompleted: catchAsync(async (req: Request, res: Response) => {
    const payment = await paymentService.markCompleted(req.params.id as string, req.user!);

    activityLogService.record(
      { action: 'payment_completed', targetId: payment.id, targetType: 'Payment', newValue: { paymentCode: payment.paymentCode, bill: payment.bill } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, payment, 'Payment marked as completed');
  }),

  markFailed: catchAsync(async (req: Request, res: Response) => {
    const payment = await paymentService.markFailed(req.params.id as string, req.body, req.user!);
    sendSuccess(res, payment, 'Payment marked as failed');
  }),

  paymentDeptStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await paymentService.getPaymentDeptStats(req.user!);
    sendSuccess(res, stats, 'Payment dashboard stats fetched');
  }),

  accountsStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await paymentService.getAccountsPaymentStats(req.user!);
    sendSuccess(res, stats, 'Accounts payment stats fetched');
  }),

  superAdminStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await paymentService.getSuperAdminPaymentStats(req.user!);
    sendSuccess(res, stats, 'Super Admin payment stats fetched');
  }),

  myStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await paymentService.getMyPaymentStats(req.user!);
    sendSuccess(res, stats, 'My payment stats fetched');
  }),
};
