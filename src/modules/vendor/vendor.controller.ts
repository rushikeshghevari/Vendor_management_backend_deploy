import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { notificationService } from '@/modules/notification/notification.service';
import { vendorService } from '@/modules/vendor/vendor.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const vendorController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const vendor = await vendorService.create(req.body, req.user!);

    activityLogService.record(
      { action: 'vendor_created', targetId: vendor.id, targetType: 'Vendor', newValue: { name: vendor.name, code: vendor.code } },
      req.user!,
      req,
    ).catch(() => null);

    notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN)
      .then((admins) => notificationService.notifyUsers(admins, {
        title: 'Vendor Created',
        message: `A new vendor "${vendor.name}" was registered.`,
        module: 'vendor',
        relatedRecord: vendor.id,
        notificationType: 'vendor_created',
        priority: 'low',
        category: 'information',
        sender: req.user!.id,
      }))
      .catch(() => null);

    sendSuccess(res, vendor, 'Vendor created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await vendorService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Vendors fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const vendor = await vendorService.getById(req.params.id as string, req.user!);
    sendSuccess(res, vendor, 'Vendor fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const vendor = await vendorService.update(req.params.id as string, req.body, req.user!);

    activityLogService.record(
      { action: 'vendor_updated', targetId: vendor.id, targetType: 'Vendor', newValue: { name: vendor.name, status: vendor.status } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, vendor, 'Vendor updated');
  }),

  setStatus: catchAsync(async (req: Request, res: Response) => {
    const vendor = await vendorService.setStatus(req.params.id as string, req.body.status, req.user!);
    sendSuccess(res, vendor, 'Vendor status updated');
  }),

  remove: catchAsync(async (req: Request, res: Response) => {
    await vendorService.remove(req.params.id as string, req.user!);
    sendSuccess(res, null, 'Vendor deactivated');
  }),
};
