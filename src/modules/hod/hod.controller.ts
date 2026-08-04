import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { hodService } from '@/modules/hod/hod.service';
import { notificationService } from '@/modules/notification/notification.service';
import { User } from '@/modules/user/user.model';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const hodController = {
  createUser: catchAsync(async (req: Request, res: Response) => {
    const user = await hodService.createUser(req.body, req.user!);
    const userId = String(user._id);

    activityLogService.record(
      { action: 'department_user_created', targetId: userId, targetType: 'User', newValue: { name: user.name, email: user.email } },
      req.user!,
      req,
    ).catch(() => null);

    notificationService.notifyUser(
      { id: userId, role: ROLES.DEPARTMENT_USER },
      {
        title: 'Account Created',
        message: 'Your department user account has been created.',
        module: 'system',
        relatedRecord: userId,
        notificationType: 'department_user_created',
        priority: 'medium',
        category: 'information',
        sender: req.user!.id,
      },
    ).catch(() => null);

    sendSuccess(res, user, 'User created', 201);
  }),

  listUsers: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await hodService.listUsers(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Users fetched', 200, meta);
  }),

  getUser: catchAsync(async (req: Request, res: Response) => {
    const user = await hodService.getUser(req.params.id as string, req.user!);
    sendSuccess(res, user, 'User fetched');
  }),

  updateUser: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const before = await User.findById(id).select('name email phone isActive').lean();

    const user = await hodService.updateUser(id, req.body, req.user!);

    activityLogService.record(
      {
        action: 'department_user_updated',
        targetId: id,
        targetType: 'User',
        oldValue: before,
        newValue: { name: user.name, email: user.email, phone: user.phone, isActive: user.isActive },
      },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, user, 'User updated');
  }),

  setUserStatus: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const isActive = Boolean(req.body.isActive);
    const user = await hodService.setUserStatus(id, isActive, req.user!);

    activityLogService.record(
      {
        action: isActive ? 'department_user_reactivated' : 'department_user_deactivated',
        targetId: id,
        targetType: 'User',
        newValue: { isActive },
      },
      req.user!,
      req,
    ).catch(() => null);

    if (!isActive) {
      notificationService.notifyUser(
        { id, role: ROLES.DEPARTMENT_USER },
        {
          title: 'Account Disabled',
          message: 'Your account has been deactivated by your HOD.',
          module: 'system',
          relatedRecord: id,
          notificationType: 'department_user_disabled',
          priority: 'high',
          category: 'warning',
          sender: req.user!.id,
        },
      ).catch(() => null);
    }

    sendSuccess(res, user, 'User status updated');
  }),

  resetUserPassword: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    await hodService.resetUserPassword(id, req.body.newPassword, req.user!);

    activityLogService.record(
      { action: 'password_reset', targetId: id, targetType: 'User' },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, null, 'Password reset');
  }),

  bulkSetUserStatus: catchAsync(async (req: Request, res: Response) => {
    const { ids, isActive } = req.body as { ids: string[]; isActive: boolean };
    const { matched } = await hodService.bulkSetUserStatus(ids, isActive, req.user!);

    for (const u of matched) {
      activityLogService.record(
        {
          action: isActive ? 'department_user_reactivated' : 'department_user_deactivated',
          targetId: u.id,
          targetType: 'User',
          newValue: { isActive },
        },
        req.user!,
        req,
      ).catch(() => null);

      if (!isActive) {
        notificationService.notifyUser(
          { id: u.id, role: ROLES.DEPARTMENT_USER },
          {
            title: 'Account Disabled',
            message: 'Your account has been deactivated by your HOD.',
            module: 'system',
            relatedRecord: u.id,
            notificationType: 'department_user_disabled',
            priority: 'high',
            category: 'warning',
            sender: req.user!.id,
          },
        ).catch(() => null);
      }
    }

    sendSuccess(res, { updated: matched.length }, 'User status updated');
  }),

  deactivateUser: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    await hodService.deactivateUser(id, req.user!);

    activityLogService.record(
      { action: 'department_user_deactivated', targetId: id, targetType: 'User' },
      req.user!,
      req,
    ).catch(() => null);

    notificationService.notifyUser(
      { id, role: ROLES.DEPARTMENT_USER },
      {
        title: 'Account Disabled',
        message: 'Your account has been deactivated by your HOD.',
        module: 'system',
        relatedRecord: id,
        notificationType: 'department_user_disabled',
        priority: 'high',
        category: 'warning',
        sender: req.user!.id,
      },
    ).catch(() => null);

    sendSuccess(res, null, 'User deactivated');
  }),

  getOwnDepartment: catchAsync(async (req: Request, res: Response) => {
    const department = await hodService.getOwnDepartment(req.user!);
    sendSuccess(res, department, 'Department fetched');
  }),

  getOwnAnalytics: catchAsync(async (req: Request, res: Response) => {
    const analytics = await hodService.getOwnAnalytics(req.user!);
    sendSuccess(res, analytics, 'Analytics fetched');
  }),
};
