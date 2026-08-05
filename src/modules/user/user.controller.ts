import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { notificationService } from '@/modules/notification/notification.service';
import { userService } from '@/modules/user/user.service';
import { User } from '@/modules/user/user.model';
import { roleTopic, deptTopic, subscribeToTopic, unsubscribeFromAllTopics } from '@/services/push/topicManager.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';
import type { Role } from '@/constants/roles';

export const userController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const user = await userService.create(req.body);
    const userId = String(user._id);

    if (user.role === ROLES.DEPARTMENT_USER) {
      activityLogService.record(
        {
          action: 'department_user_created',
          department: user.department ? String(user.department) : undefined,
          targetId: userId,
          targetType: 'User',
          newValue: { name: user.name, email: user.email },
        },
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
    }

    sendSuccess(res, user, 'User created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await userService.list(req.query as Record<string, unknown>);
    sendSuccess(res, items, 'Users fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const user = await userService.getById(req.params.id as string);
    sendSuccess(res, user, 'User fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const before = await User.findById(id).select('name email phone isActive role department').lean();

    const user = await userService.update(id, req.body);

    if (user.role === ROLES.DEPARTMENT_USER || before?.role === ROLES.DEPARTMENT_USER) {
      activityLogService.record(
        {
          action: 'department_user_updated',
          department: user.department ? String(user.department) : undefined,
          targetId: id,
          targetType: 'User',
          oldValue: before,
          newValue: { name: user.name, email: user.email, phone: user.phone, isActive: user.isActive },
        },
        req.user!,
        req,
      ).catch(() => null);
    }

    sendSuccess(res, user, 'User updated');
  }),

  setStatus: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const isActive = Boolean(req.body.isActive);
    const user = await userService.setStatus(id, isActive);

    if (user.role === ROLES.DEPARTMENT_USER) {
      activityLogService.record(
        {
          action: isActive ? 'department_user_reactivated' : 'department_user_deactivated',
          department: user.department ? String(user.department) : undefined,
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
            message: 'Your account has been deactivated.',
            module: 'system',
            relatedRecord: id,
            notificationType: 'department_user_disabled',
            priority: 'high',
            category: 'warning',
            sender: req.user!.id,
          },
        ).catch(() => null);
      }
    }

    sendSuccess(res, user, 'User status updated');
  }),

  bulkSetStatus: catchAsync(async (req: Request, res: Response) => {
    const { ids, isActive } = req.body as { ids: string[]; isActive: boolean };
    const { matched } = await userService.bulkSetStatus(ids, isActive);
    const departmentUsers = matched.filter((u) => u.role === ROLES.DEPARTMENT_USER);

    for (const u of departmentUsers) {
      activityLogService.record(
        {
          action: isActive ? 'department_user_reactivated' : 'department_user_deactivated',
          department: u.department,
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
            message: 'Your account has been deactivated.',
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

  deactivate: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const before = await User.findById(id).select('role department').lean();

    await userService.deactivate(id);

    if (before?.role === ROLES.DEPARTMENT_USER) {
      activityLogService.record(
        {
          action: 'department_user_deactivated',
          department: before.department ? String(before.department) : undefined,
          targetId: id,
          targetType: 'User',
        },
        req.user!,
        req,
      ).catch(() => null);

      notificationService.notifyUser(
        { id, role: ROLES.DEPARTMENT_USER },
        {
          title: 'Account Disabled',
          message: 'Your account has been deactivated.',
          module: 'system',
          relatedRecord: id,
          notificationType: 'department_user_disabled',
          priority: 'high',
          category: 'warning',
          sender: req.user!.id,
        },
      ).catch(() => null);
    }

    sendSuccess(res, null, 'User deactivated');
  }),

  changePassword: catchAsync(async (req: Request, res: Response) => {
    const { currentPassword, newPassword } = req.body;
    await userService.changePassword(req.user!.id, currentPassword, newPassword);
    sendSuccess(res, null, 'Password updated');
  }),

  resetPassword: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    await userService.resetPassword(id, req.body.newPassword);

    activityLogService.record(
      { action: 'password_reset', targetId: id, targetType: 'User' },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, null, 'Password reset');
  }),

  registerDevice: catchAsync(async (req: Request, res: Response) => {
    const { token, deviceId, platform, deviceName } = req.body as {
      token: string; deviceId: string; platform: 'android' | 'ios' | 'web'; deviceName?: string;
    };
    const userId = req.user!.id;
    const role   = req.user!.role as Role;

    // A physical device can only be logged in as one user at a time. If this deviceId is
    // still registered under any OTHER user — e.g. a shared test phone switched to a
    // different account without logging out first, or the app was uninstalled instead of
    // logged out — that stale entry must be purged from every account, not just this one.
    // Otherwise every account that was ever logged in on this device keeps receiving its
    // pushes forever, regardless of role (the reported "notifications go to everyone").
    const staleOwners = await User.find({ 'fcmTokens.deviceId': deviceId, _id: { $ne: userId } })
      .select('_id role department fcmTokens')
      .lean();
    for (const staleOwner of staleOwners) {
      const staleEntry = staleOwner.fcmTokens?.find((t) => t.deviceId === deviceId);
      if (staleEntry?.token) {
        unsubscribeFromAllTopics(
          [staleEntry.token],
          staleOwner.role as Role,
          staleOwner.department?.toString(),
        ).catch(() => null);
      }
    }
    if (staleOwners.length > 0) {
      await User.updateMany(
        { 'fcmTokens.deviceId': deviceId, _id: { $ne: userId } },
        { $pull: { fcmTokens: { deviceId } } },
      );
    }

    // Remove stale entry for this deviceId before re-registering
    await User.findByIdAndUpdate(userId, { $pull: { fcmTokens: { deviceId } } });
    const updated = await User.findByIdAndUpdate(
      userId,
      {
        $push: {
          fcmTokens: {
            token, deviceId, platform, deviceName,
            lastUsed: new Date(),
            isActive: true,
          },
        },
      },
      { new: true },
    ).lean();

    // Subscribe to role + all_users topics; department topic if applicable
    const departmentId = updated?.department?.toString();
    subscribeToTopic([token], roleTopic(role)).catch(() => null);
    subscribeToTopic([token], 'all_users').catch(() => null);
    if (departmentId) subscribeToTopic([token], deptTopic(departmentId)).catch(() => null);

    sendSuccess(res, null, 'Device registered');
  }),

  removeDevice: catchAsync(async (req: Request, res: Response) => {
    const { deviceId } = req.body as { deviceId: string };
    const userId = req.user!.id;
    const role   = req.user!.role as Role;

    // Find the token before pulling so we can unsubscribe from FCM topics
    const userDoc = await User.findById(userId).select('fcmTokens department').lean();
    const entry   = userDoc?.fcmTokens?.find((t) => t.deviceId === deviceId);

    await User.findByIdAndUpdate(userId, { $pull: { fcmTokens: { deviceId } } });

    if (entry?.token) {
      const departmentId = userDoc?.department?.toString();
      unsubscribeFromAllTopics([entry.token], role, departmentId).catch(() => null);
    }

    sendSuccess(res, null, 'Device removed');
  }),

  myDevices: catchAsync(async (req: Request, res: Response) => {
    const user = await User.findById(req.user!.id).select('fcmTokens').lean();
    sendSuccess(res, user?.fcmTokens ?? [], 'Devices fetched');
  }),
};
