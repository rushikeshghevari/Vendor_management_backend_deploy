import type { Request, Response } from 'express';

import { authService } from '@/modules/auth/auth.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const authController = {
  login: catchAsync(async (req: Request, res: Response) => {
    const { email, password } = req.body;
    const result = await authService.login(email, password);
    sendSuccess(res, result, 'Login successful');
  }),

  refresh: catchAsync(async (req: Request, res: Response) => {
    const result = await authService.refresh(req.body.refreshToken);
    sendSuccess(res, result, 'Token refreshed');
  }),

  logout: catchAsync(async (req: Request, res: Response) => {
    await authService.logout(req.body.refreshToken);
    sendSuccess(res, null, 'Logged out');
  }),

  me: catchAsync(async (req: Request, res: Response) => {
    const user = await authService.getProfile(req.user!.id);
    sendSuccess(res, user, 'Profile fetched');
  }),
};
