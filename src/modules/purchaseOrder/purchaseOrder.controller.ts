import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { notificationService } from '@/modules/notification/notification.service';
import { purchaseOrderService } from '@/modules/purchaseOrder/purchaseOrder.service';
import { emailService } from '@/services/email/email.service';
import { generatePurchaseOrderPdf } from '@/services/pdf/pdf.service';
import { ApiError } from '@/utils/ApiError';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const purchaseOrderController = {

  create: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.create(req.body, req.user!);

    activityLogService.record(
      { action: 'purchase_order_created', targetId: String(po._id), targetType: 'PurchaseOrder', newValue: { poNumber: po.poNumber, vendor: po.vendor } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, po, 'Purchase Order generated successfully', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await purchaseOrderService.list(
      req.query as Record<string, unknown> as Parameters<typeof purchaseOrderService.list>[0],
      req.user!,
    );
    sendSuccess(res, items, 'Purchase Orders fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.getById(req.params.id as string, req.user!);
    sendSuccess(res, po, 'Purchase Order fetched');
  }),

  getByQuotation: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.getByQuotation(req.params.quotationId as string, req.user!);
    sendSuccess(res, po, po ? 'Purchase Order fetched' : 'No Purchase Order found for this Quotation');
  }),

  getByRequirement: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.getByRequirement(req.params.requirementId as string, req.user!);
    sendSuccess(res, po, po ? 'Purchase Order fetched' : 'No Purchase Order found for this Requirement');
  }),

  triggerAiVerification: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.triggerAiVerification(req.params.id as string, req.user!);
    sendSuccess(res, po, 'AI Verification completed');
  }),

  downloadPdf: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.getById(req.params.id as string, req.user!);
    const { filePath, fileName } = await generatePurchaseOrderPdf(po);
    res.download(filePath, fileName);
  }),

  // Audit-only endpoint — the actual sharing (native share sheet / email / WhatsApp / print)
  // happens entirely on-device; this just records that it happened. getById() re-validates
  // the caller can actually see this PO before logging anything against it.
  share: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.getById(req.params.id as string, req.user!);

    activityLogService.record(
      { action: 'po_shared', targetId: String(po._id), targetType: 'PurchaseOrder', newValue: { channel: req.body?.channel ?? 'unknown' } },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, null, 'Purchase Order share recorded');
  }),

  stats: catchAsync(async (req: Request, res: Response) => {
    const stats = await purchaseOrderService.getStats(req.user!);
    sendSuccess(res, stats, 'Purchase Order stats fetched');
  }),

  // Actually emails the generated PDF to the vendor (or an explicit override address) via
  // SMTP — distinct from `share` above, which is a client-side-only, audit-log-only action.
  // Never throws when email isn't sent: SMTP being unconfigured, or a send failure, is
  // reported back as `sent: false` so the PO itself is never blocked by this.
  emailToVendor: catchAsync(async (req: Request, res: Response) => {
    const po = await purchaseOrderService.getById(req.params.id as string, req.user!);
    // `po.vendor` is populated by getById (POPULATE_DETAIL) — dereference `._id` rather than
    // passing the populated object straight to Vendor.findById.
    const vendorId = (po.vendor as unknown as { _id?: string })._id ?? po.vendor;
    const recipientEmail: string | undefined = req.body?.recipientEmail || await purchaseOrderService.getVendorEmail(vendorId);

    if (!recipientEmail) {
      throw ApiError.badRequest('No recipient email available — the vendor has no email on file');
    }

    const { filePath } = await generatePurchaseOrderPdf(po);
    const result = await emailService.sendPurchaseOrderEmail({ to: recipientEmail, po, pdfPath: filePath });

    activityLogService.record(
      {
        action: 'po_emailed',
        targetId: String(po._id),
        targetType: 'PurchaseOrder',
        newValue: { recipientEmail, sent: result.sent, reason: result.reason },
      },
      req.user!,
      req,
    ).catch(() => null);

    if (result.sent) {
      notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN)
        .then((admins) => notificationService.notifyUsers(admins, {
          title: 'Purchase Order Emailed',
          message: `PO ${po.poNumber} was emailed to ${recipientEmail}`,
          module: 'purchase_order',
          relatedRecord: String(po._id),
          notificationType: 'po_emailed',
          sender: req.user!.id,
        }))
        .catch(() => null);
    }

    sendSuccess(
      res,
      { sent: result.sent, reason: result.reason, recipientEmail },
      result.sent ? 'Purchase Order emailed to vendor' : 'Purchase Order PDF generated, but the email was not sent',
    );
  }),
};
