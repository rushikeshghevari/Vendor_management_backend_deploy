import type { Request, Response } from 'express';

import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { quotationService } from '@/modules/quotation/quotation.service';
import { ApiError } from '@/utils/ApiError';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const quotationController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const quotation = await quotationService.create(req.body, req.user!);

    activityLogService.record(
      { action: 'quotation_created', targetId: quotation.id, targetType: 'Quotation', newValue: { vendor: quotation.vendor, amount: quotation.amount } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, quotation, 'Quotation created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await quotationService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Quotations fetched', 200, meta);
  }),

  directorStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await quotationService.getDirectorStats(req.user!);
    sendSuccess(res, stats, 'Director dashboard stats fetched');
  }),

  ceoStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await quotationService.getCeoStats(req.user!);
    sendSuccess(res, stats, 'CEO dashboard stats fetched');
  }),

  superAdminStats: catchAsync(async (req: Request, res: Response) => {
    const stats = await quotationService.getSuperAdminStats(req.user!);
    sendSuccess(res, stats, 'Super Admin dashboard stats fetched');
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const quotation = await quotationService.getById(req.params.id as string, req.user!);
    sendSuccess(res, quotation, 'Quotation fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const quotation = await quotationService.update(req.params.id as string, req.body, req.user!);
    sendSuccess(res, quotation, 'Quotation updated');
  }),

  submit: catchAsync(async (req: Request, res: Response) => {
    const quotation = await quotationService.submit(req.params.id as string, req.user!);

    activityLogService.record(
      { action: 'quotation_submitted', targetId: quotation.id, targetType: 'Quotation', newValue: { status: quotation.status } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, quotation, 'Quotation submitted');
  }),

  resubmit: catchAsync(async (req: Request, res: Response) => {
    const quotation = await quotationService.resubmit(req.params.id as string, req.user!);
    sendSuccess(res, quotation, 'Quotation resubmitted');
  }),

  decide: catchAsync(async (req: Request, res: Response) => {
    const quotation = await quotationService.decide(req.params.id as string, req.body, req.user!);

    // Mirrors notifyOfDecision's own timing (quotation.service.ts): reject is a blocking
    // decision logged immediately; approve is only logged once the shared status actually
    // flips to "approved" (i.e. every approver on the route has signed off), not on each
    // individual Director's vote while others are still pending.
    if (req.body?.decision === 'rejected') {
      activityLogService.record(
        { action: 'quotation_rejected', targetId: String(quotation._id), targetType: 'Quotation', newValue: { remarks: req.body?.remarks } },
        req.user!,
        req,
      ).catch(() => null);
    } else if (quotation.status === 'approved') {
      activityLogService.record(
        { action: 'quotation_approved', targetId: String(quotation._id), targetType: 'Quotation' },
        req.user!,
        req,
      ).catch(() => null);
    }

    sendSuccess(res, quotation, 'Decision recorded');
  }),

  uploadPdf: catchAsync(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('A PDF file is required');
    const url = `/uploads/quotations/${req.file.filename}`;
    const quotation = await quotationService.uploadPdf(
      req.params.id as string,
      req.file.originalname,
      url,
      req.user!,
    );
    sendSuccess(res, quotation, 'PDF uploaded');
  }),

  remove: catchAsync(async (req: Request, res: Response) => {
    await quotationService.remove(req.params.id as string, req.user!);
    sendSuccess(res, null, 'Quotation deleted');
  }),
};
