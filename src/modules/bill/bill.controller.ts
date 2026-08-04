import type { Request, Response } from 'express';

import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { billService } from '@/modules/bill/bill.service';
import { ApiError } from '@/utils/ApiError';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const billController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.create(req.body, req.user!);

    activityLogService.record(
      { action: 'bill_uploaded', targetId: bill.id, targetType: 'Bill', newValue: { billCode: bill.billCode, invoiceNumber: bill.invoiceNumber } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, bill, 'Bill created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await billService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Bills fetched', 200, meta);
  }),

  accountsStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await billService.getAccountsStats(req.user!);
    sendSuccess(res, stats, 'Accounts dashboard stats fetched');
  }),

  paymentStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await billService.getPaymentStats(req.user!);
    sendSuccess(res, stats, 'Payment dashboard stats fetched');
  }),

  directorStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await billService.getDirectorStats(req.user!);
    sendSuccess(res, stats, 'Director dashboard stats fetched');
  }),

  superAdminStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await billService.getSuperAdminStats(req.user!);
    sendSuccess(res, stats, 'Super Admin dashboard stats fetched');
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.getById(req.params.id as string, req.user!);
    sendSuccess(res, bill, 'Bill fetched');
  }),

  getTimeline: catchAsync(async (req: Request, res: Response) => {
    const timeline = await billService.getTimeline(req.params.id as string, req.user!);
    sendSuccess(res, timeline, 'Bill timeline fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.update(req.params.id as string, req.body, req.user!);
    sendSuccess(res, bill, 'Bill updated');
  }),

  submit: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.submit(req.params.id as string, req.user!);
    sendSuccess(res, bill, 'Bill submitted to Accounts');
  }),

  resubmit: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.resubmit(req.params.id as string, req.user!);
    sendSuccess(res, bill, 'Bill resubmitted to Accounts');
  }),

  retryAiVerification: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.retryAiVerification(req.params.id as string, req.user!);
    sendSuccess(res, bill, 'AI verification retried');
  }),

  decide: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.decide(req.params.id as string, req.body, req.user!);

    // Only "verified" maps to the spec's "Accounts Approved" activity — correction_requested
    // and rejected are Accounts' own decision types, not an approval.
    if (req.body?.decision === 'verified') {
      activityLogService.record(
        { action: 'accounts_approved', targetId: bill.id, targetType: 'Bill', newValue: { remarks: req.body?.remarks } },
        req.user!,
        req,
      ).catch(() => null);
    }

    sendSuccess(res, bill, 'Decision recorded');
  }),

  decideFinancialApproval: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.decideFinancialApproval(req.params.id as string, req.body, req.user!);

    const action = req.body?.decision === 'approved' ? 'director_approved'
      : req.body?.decision === 'rejected' ? 'director_rejected'
      : null;
    if (action) {
      activityLogService.record(
        { action, targetId: bill.id, targetType: 'Bill', newValue: { decision: req.body?.decision, remarks: req.body?.remarks } },
        req.user!,
        req,
      ).catch(() => null);
    }

    sendSuccess(res, bill, 'Financial approval decision recorded');
  }),

  updatePaymentStatus: catchAsync(async (req: Request, res: Response) => {
    const bill = await billService.updatePaymentStatus(req.params.id as string, req.body, req.user!);
    sendSuccess(res, bill, 'Payment status updated');
  }),

  uploadInvoice: catchAsync(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('An invoice PDF file is required');
    const url = `/uploads/bills/${req.file.filename}`;
    const bill = await billService.uploadInvoice(req.params.id as string, req.file.originalname, url, req.user!);
    sendSuccess(res, bill, 'Invoice PDF uploaded');
  }),

  uploadSupportingDocument: catchAsync(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('A supporting document PDF file is required');
    const url = `/uploads/bills/${req.file.filename}`;
    const bill = await billService.uploadSupportingDocument(req.params.id as string, req.file.originalname, url, req.user!);
    sendSuccess(res, bill, 'Supporting document uploaded');
  }),

  remove: catchAsync(async (req: Request, res: Response) => {
    await billService.remove(req.params.id as string, req.user!);
    sendSuccess(res, null, 'Bill deleted');
  }),
};
