import type { Request, Response } from 'express';

import { directorService } from '@/modules/director/director.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const directorController = {
  getBillReview: catchAsync(async (req: Request, res: Response) => {
    const review = await directorService.getBillReview(req.params.id as string, req.user!);
    sendSuccess(res, review, 'Bill financial review fetched');
  }),
};
