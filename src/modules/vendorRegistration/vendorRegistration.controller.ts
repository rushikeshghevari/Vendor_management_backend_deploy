import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { notificationService } from '@/modules/notification/notification.service';
import type { IVendorDocument, VendorDocumentType } from '@/modules/vendor/vendor.model';
import { vendorRegistrationService } from '@/modules/vendorRegistration/vendorRegistration.service';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

type PopulatedRef = { _id: { toString(): string }; name?: string; hod?: { toString(): string } };

function idOf(doc: { _id: unknown }): string {
  return String(doc._id);
}

// Maps each of the four multipart field names to the document type stored on the Vendor.
const DOCUMENT_FIELDS: Record<string, VendorDocumentType> = {
  gstCertificate: 'gst_certificate',
  panCard: 'pan_card',
  cancelledCheque: 'cancelled_cheque',
  msmeCertificate: 'msme_certificate',
};

// Exported for reuse by vendorRegistrationLink.controller.ts's public submit endpoint —
// same four multipart field names, same document shape.
export function collectDocuments(files: Request['files']): IVendorDocument[] {
  if (!files || Array.isArray(files)) return [];

  const documents: IVendorDocument[] = [];
  for (const [field, type] of Object.entries(DOCUMENT_FIELDS)) {
    const file = files[field]?.[0];
    if (!file) continue;
    documents.push({
      type,
      fileName: file.originalname,
      url: `/uploads/vendors/${file.filename}`,
      mimeType: file.mimetype,
      uploadedAt: new Date(),
    });
  }
  return documents;
}

export const vendorRegistrationController = {
  getRegisteredVendor: catchAsync(async (req: Request, res: Response) => {
    const vendor = await vendorRegistrationService.getRegisteredVendor(req.params.id as string, req.user!);
    sendSuccess(res, vendor, 'Registered vendor fetched');
  }),

  checkVendorStatus: catchAsync(async (req: Request, res: Response) => {
    const status = await vendorRegistrationService.checkVendorStatus(req.params.id as string, req.user!);
    sendSuccess(res, status, 'Vendor status checked');
  }),

  linkExistingVendor: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const { vendor, requirement, quotation } = await vendorRegistrationService.linkExistingVendor(
      requirementId,
      req.body.vendorId as string,
      req.user!,
    );

    const department = requirement.department as unknown as PopulatedRef;
    activityLogService.record(
      {
        action: 'vendor_registered',
        department: department._id.toString(),
        targetId: idOf(vendor),
        targetType: 'Vendor',
        newValue: { name: vendor.name, code: vendor.code, reused: true, createdFromRequirement: requirementId, createdFromQuotation: idOf(quotation) },
      },
      req.user!,
      req,
    ).catch(() => null);

    (async () => {
      const receivers: Array<{ id: string; role: (typeof ROLES)[keyof typeof ROLES] }> = [];
      if (department.hod) receivers.push({ id: department.hod.toString(), role: ROLES.HOD });

      const admins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
      await notificationService.notifyUsers([...receivers, ...admins], {
        title: 'Vendor Linked',
        message: `${vendor.name} (${vendor.code}) was linked to ${requirement.requirementNumber} — ready for Purchase Order.`,
        module: 'vendor',
        relatedRecord: idOf(vendor),
        notificationType: 'vendor_registered',
        priority: 'medium',
        category: 'success',
        sender: req.user!.id,
        dedupKey: `vendor_registered:${requirementId}`,
      });
    })().catch(() => null);

    sendSuccess(res, { vendor, requirement }, 'Vendor linked to requirement', 200);
  }),

  register: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const documents = collectDocuments(req.files);

    const { vendor, requirement, quotation } = await vendorRegistrationService.register(
      requirementId,
      req.body,
      documents,
      req.user!,
    );

    const department = requirement.department as unknown as PopulatedRef;
    activityLogService.record(
      {
        action: 'vendor_registered',
        department: department._id.toString(),
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
      await notificationService.notifyUsers([...receivers, ...admins], {
        title: 'Vendor Registered',
        message: `${vendor.name} (${vendor.code}) was registered for ${requirement.requirementNumber} — ready for Purchase Order.`,
        module: 'vendor',
        relatedRecord: idOf(vendor),
        notificationType: 'vendor_registered',
        priority: 'medium',
        category: 'success',
        sender: req.user!.id,
        dedupKey: `vendor_registered:${requirementId}`,
      });
    })().catch(() => null);

    sendSuccess(res, { vendor, requirement }, 'Vendor registered', 201);
  }),
};
