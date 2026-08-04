import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { Department } from '@/modules/department/department.model';
import { departmentService } from '@/modules/department/department.service';
import { notificationService } from '@/modules/notification/notification.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const departmentController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const department = await departmentService.create(req.body, req.user!.id);

    activityLogService.record(
      { action: 'department_created', department: department.id, targetId: department.id, targetType: 'Department', newValue: { name: department.name, code: department.code } },
      req.user!,
      req,
    ).catch(() => null);

    if (department.hod) {
      const hodId = department.hod.toString();
      activityLogService.record(
        { action: 'hod_assigned', department: department.id, targetId: hodId, targetType: 'User', newValue: { department: department.id } },
        req.user!,
        req,
      ).catch(() => null);

      notificationService.notifyUser(
        { id: hodId, role: ROLES.HOD },
        {
          title: 'HOD Assignment',
          message: `You have been assigned as HOD of ${department.name}.`,
          module: 'system',
          relatedRecord: department.id,
          notificationType: 'hod_assigned',
          priority: 'high',
          category: 'information',
          sender: req.user!.id,
        },
      ).catch(() => null);
    }

    sendSuccess(res, department, 'Department created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await departmentService.list(req.query as Record<string, unknown>);
    sendSuccess(res, items, 'Departments fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const department = await departmentService.getById(req.params.id as string);
    sendSuccess(res, department, 'Department fetched');
  }),

  getAnalytics: catchAsync(async (req: Request, res: Response) => {
    const analytics = await departmentService.getAnalytics(req.params.id as string);
    sendSuccess(res, analytics, 'Department analytics fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const before = await Department.findById(id).select('name code description isActive').lean();

    const department = await departmentService.update(id, req.body);

    activityLogService.record(
      {
        action: 'department_updated',
        department: department.id,
        targetId: department.id,
        targetType: 'Department',
        oldValue: before,
        newValue: { name: department.name, code: department.code, description: department.description, isActive: department.isActive },
      },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, department, 'Department updated');
  }),

  setStatus: catchAsync(async (req: Request, res: Response) => {
    const department = await departmentService.update(req.params.id as string, { isActive: req.body.isActive });
    sendSuccess(res, department, 'Department status updated');
  }),

  remove: catchAsync(async (req: Request, res: Response) => {
    await departmentService.remove(req.params.id as string);
    sendSuccess(res, null, 'Department deactivated');
  }),

  transferHod: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const before = await Department.findById(id).select('hod').lean();
    const previousHodId = before?.hod?.toString();

    const department = await departmentService.transferHod(id, req.body);
    const newHodId = department.hod?.toString();

    activityLogService.record(
      {
        action: 'hod_transferred',
        department: id,
        targetId: id,
        targetType: 'Department',
        oldValue: { hod: previousHodId },
        newValue: { hod: newHodId, demoteOldHod: Boolean(req.body.demoteOldHod) },
      },
      req.user!,
      req,
    ).catch(() => null);

    if (previousHodId && req.body.demoteOldHod && previousHodId !== newHodId) {
      activityLogService.record(
        { action: 'hod_removed', department: id, targetId: previousHodId, targetType: 'User' },
        req.user!,
        req,
      ).catch(() => null);
    }

    if (newHodId) {
      notificationService.notifyUser(
        { id: newHodId, role: ROLES.HOD },
        {
          title: 'HOD Assignment',
          message: `You have been assigned as HOD of ${department.name}.`,
          module: 'system',
          relatedRecord: id,
          notificationType: 'hod_transferred',
          priority: 'high',
          category: 'information',
          sender: req.user!.id,
        },
      ).catch(() => null);
    }

    notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN)
      .then((admins) => notificationService.notifyUsers(admins, {
        title: 'HOD Transferred',
        message: `${department.name}'s HOD was transferred.`,
        module: 'system',
        relatedRecord: id,
        notificationType: 'hod_transferred',
        priority: 'medium',
        category: 'information',
        sender: req.user!.id,
      }))
      .catch(() => null);

    sendSuccess(res, department, 'HOD transferred');
  }),
};
