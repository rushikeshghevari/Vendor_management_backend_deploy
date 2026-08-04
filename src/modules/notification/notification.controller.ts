import type { Request, Response } from 'express';

import { notificationService } from '@/modules/notification/notification.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const notificationController = {
  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await notificationService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Notifications fetched', 200, meta);
  }),

  unreadCount: catchAsync(async (req: Request, res: Response) => {
    const result = await notificationService.getUnreadCount(req.user!);
    sendSuccess(res, result, 'Unread notification count fetched');
  }),

  markRead: catchAsync(async (req: Request, res: Response) => {
    const notification = await notificationService.markRead(req.params.id as string, req.user!);
    sendSuccess(res, notification, 'Notification marked as read');
  }),

  markAllRead: catchAsync(async (req: Request, res: Response) => {
    await notificationService.markAllRead(req.user!);
    sendSuccess(res, null, 'All notifications marked as read');
  }),

  archive: catchAsync(async (req: Request, res: Response) => {
    const notification = await notificationService.archive(req.params.id as string, req.user!);
    sendSuccess(res, notification, 'Notification archived');
  }),

  pin: catchAsync(async (req: Request, res: Response) => {
    const notification = await notificationService.pin(req.params.id as string, req.user!);
    sendSuccess(res, notification, 'Notification pinned');
  }),

  unpin: catchAsync(async (req: Request, res: Response) => {
    const notification = await notificationService.unpin(req.params.id as string, req.user!);
    sendSuccess(res, notification, 'Notification unpinned');
  }),

  softDelete: catchAsync(async (req: Request, res: Response) => {
    await notificationService.softDelete(req.params.id as string, req.user!);
    sendSuccess(res, null, 'Notification deleted');
  }),

  deleteAll: catchAsync(async (req: Request, res: Response) => {
    await notificationService.deleteAll(req.user!);
    sendSuccess(res, null, 'All notifications deleted');
  }),

  broadcast: catchAsync(async (req: Request, res: Response) => {
    const result = await notificationService.broadcast(req.body, req.user!);
    sendSuccess(res, result, 'Broadcast sent', 201);
  }),

  analytics: catchAsync(async (req: Request, res: Response) => {
    const result = await notificationService.getAnalytics(req.user!);
    sendSuccess(res, result, 'Notification analytics fetched');
  }),

  recordDelivery: catchAsync(async (req: Request, res: Response) => {
    const notification = await notificationService.recordDelivery(req.params.id as string, req.user!);
    sendSuccess(res, notification, 'Delivery recorded');
  }),

  scheduleFollowUp: catchAsync(async (req: Request, res: Response) => {
    const notification = await notificationService.scheduleFollowUp(
      req.params.id as string,
      new Date(req.body.followUpDate as string),
      req.user!,
    );
    sendSuccess(res, notification, 'Follow-up reminder scheduled');
  }),
};
