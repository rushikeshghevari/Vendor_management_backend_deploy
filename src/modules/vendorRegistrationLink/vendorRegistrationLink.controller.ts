import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { notificationService } from '@/modules/notification/notification.service';
import { collectDocuments } from '@/modules/vendorRegistration/vendorRegistration.controller';
import { vendorRegistrationLinkService } from '@/modules/vendorRegistrationLink/vendorRegistrationLink.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

type PopulatedRef = { _id: { toString(): string }; name?: string; hod?: { toString(): string } };

function idOf(doc: { _id: unknown }): string {
  return String(doc._id);
}

export const vendorRegistrationLinkController = {
  generate: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const { link, created } = await vendorRegistrationLinkService.generate(requirementId, req.user!);

    if (created) {
      activityLogService.record(
        { action: 'vendor_registration_link_generated', targetId: idOf(link), targetType: 'VendorRegistrationLink', newValue: { requirement: requirementId } },
        req.user!,
        req,
      ).catch(() => null);
    }

    sendSuccess(res, link, created ? 'Vendor registration link generated' : 'Vendor registration link fetched', created ? 201 : 200);
  }),

  getStatus: catchAsync(async (req: Request, res: Response) => {
    const link = await vendorRegistrationLinkService.getStatus(req.params.id as string, req.user!);
    sendSuccess(res, link, 'Vendor registration link status fetched');
  }),

  // No auth — only the minimal, non-sensitive fields the public form's header needs.
  getPublicInfo: catchAsync(async (req: Request, res: Response) => {
    const info = await vendorRegistrationLinkService.getPublicInfo(req.params.token as string);
    sendSuccess(res, info, 'Vendor registration link fetched');
  }),

  // No auth — the vendor's own browser submission.
  submitPublic: catchAsync(async (req: Request, res: Response) => {
    const documents = collectDocuments(req.files);
    const link = await vendorRegistrationLinkService.submit(req.params.token as string, req.body, documents);
    sendSuccess(res, { status: link.status }, 'Submitted — awaiting verification', 201);
  }),

  verify: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const { vendor, requirement, quotation } = await vendorRegistrationLinkService.verify(requirementId, req.user!);

    const department = requirement.department as unknown as PopulatedRef;
    activityLogService.record(
      {
        action: 'vendor_registration_link_verified',
        department: department._id?.toString?.(),
        targetId: idOf(vendor),
        targetType: 'Vendor',
        newValue: { name: vendor.name, code: vendor.code, createdFromRequirement: requirementId, createdFromQuotation: idOf(quotation) },
      },
      req.user!,
      req,
    ).catch(() => null);

    (async () => {
      const receivers: Array<{ id: string; role: (typeof ROLES)[keyof typeof ROLES] }> = [];
      if (department.hod) receivers.push({ id: department.hod.toString(), role: ROLES.HOD });
      if (vendor.approvedByDirector) receivers.push({ id: String(vendor.approvedByDirector), role: ROLES.DIRECTOR });

      const admins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
      // Same dedupKey shape as the direct registration flow's notification — safe to share
      // since only one of the two pipelines can ever succeed for a given requirement
      // (Vendor.createdFromRequirement is unique).
      await notificationService.notifyUsers([...receivers, ...admins], {
        title: 'Vendor Registered',
        message: `${vendor.name} (${vendor.code}) was verified and registered for ${requirement.requirementNumber} — ready for Purchase Order.`,
        module: 'vendor',
        relatedRecord: idOf(vendor),
        notificationType: 'vendor_registered',
        priority: 'medium',
        category: 'success',
        sender: req.user!.id,
        dedupKey: `vendor_registered:${requirementId}`,
      });
    })().catch(() => null);

    sendSuccess(res, { vendor, requirement }, 'Vendor registration verified and finalized', 200);
  }),
};
