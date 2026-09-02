import type { Request, Response } from 'express';

import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { recurringExpenseService } from '@/modules/recurringExpense/recurringExpense.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const recurringExpenseController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const series = await recurringExpenseService.create(req.body, req.user!);

    activityLogService.record(
      { action: 'recurring_expense_created', targetId: String(series._id), targetType: 'RecurringExpense', newValue: { title: series.title, mode: series.mode } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, series, 'Recurring expense created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await recurringExpenseService.list(
      req.query as Record<string, unknown> as Parameters<typeof recurringExpenseService.list>[0],
      req.user!,
    );
    sendSuccess(res, items, 'Recurring expenses fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const series = await recurringExpenseService.getById(req.params.id as string, req.user!);
    sendSuccess(res, series, 'Recurring expense fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const series = await recurringExpenseService.update(req.params.id as string, req.body, req.user!);
    sendSuccess(res, series, 'Recurring expense updated');
  }),

  generateCycle: catchAsync(async (req: Request, res: Response) => {
    const bill = await recurringExpenseService.generateCycle(req.params.id as string, req.body, req.user!);

    activityLogService.record(
      { action: 'recurring_expense_cycle_generated', targetId: String(bill._id), targetType: 'Bill', newValue: { billCode: bill.billCode, recurringExpense: req.params.id } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, bill, 'Bill created for this cycle — upload the invoice and submit', 201);
  }),
};
