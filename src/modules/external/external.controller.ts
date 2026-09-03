import type { Request, Response } from 'express';

import { externalService } from '@/modules/external/external.service';
import type { ExternalBillListQuery, ExternalUpcomingPaymentsQuery } from '@/modules/external/external.validation';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const externalController = {
  listBills: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await externalService.listBills(req.query as unknown as ExternalBillListQuery);
    sendSuccess(res, items, 'Bills fetched', 200, meta);
  }),

  listUpcomingPayments: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await externalService.listUpcomingPayments(req.query as unknown as ExternalUpcomingPaymentsQuery);
    sendSuccess(res, items, 'Upcoming payments fetched', 200, meta);
  }),
};
