import type { Request, Response } from 'express';

import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const activityLogController = {
  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await activityLogService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Activity logs fetched', 200, meta);
  }),
};
