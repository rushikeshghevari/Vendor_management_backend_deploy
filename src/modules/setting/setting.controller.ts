import type { Request, Response } from 'express';

import { settingService } from '@/modules/setting/setting.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const settingController = {
  get: catchAsync(async (_req: Request, res: Response) => {
    const setting = await settingService.get();
    sendSuccess(res, setting, 'Settings fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const setting = await settingService.update(req.body);
    sendSuccess(res, setting, 'Settings updated');
  }),
};
