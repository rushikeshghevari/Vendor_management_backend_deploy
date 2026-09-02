import crypto from 'node:crypto';
import fs from 'node:fs';

import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { Department } from '@/modules/department/department.model';
import { notificationService } from '@/modules/notification/notification.service';
import { quotationService } from '@/modules/quotation/quotation.service';
import { Requirement } from '@/modules/requirement/requirement.model';
import { requirementService } from '@/modules/requirement/requirement.service';
import { quotationOcrService } from '@/services/ocr/quotationOcr.service';
import { ApiError } from '@/utils/ApiError';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const requirementController = {
  create: catchAsync(async (req: Request, res: Response) => {
    const requirement = await requirementService.create(req.body, req.user!);

    activityLogService.record(
      {
        action: 'requirement_created',
        department: requirement.department.toString(),
        targetId: requirement.id,
        targetType: 'Requirement',
        newValue: { requirementNumber: requirement.requirementNumber, title: requirement.title },
      },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, requirement, 'Requirement created', 201);
  }),

  list: catchAsync(async (req: Request, res: Response) => {
    const { items, meta } = await requirementService.list(req.query as Record<string, unknown>, req.user!);
    sendSuccess(res, items, 'Requirements fetched', 200, meta);
  }),

  getById: catchAsync(async (req: Request, res: Response) => {
    const requirement = await requirementService.getById(req.params.id as string, req.user!);
    sendSuccess(res, requirement, 'Requirement fetched');
  }),

  update: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const requirement = await requirementService.update(id, req.body, req.user!);

    activityLogService.record(
      {
        action: 'requirement_updated',
        department: requirement.department.toString(),
        targetId: requirement.id,
        targetType: 'Requirement',
        newValue: { title: requirement.title, budget: requirement.budget },
      },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, requirement, 'Requirement updated');
  }),

  submit: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const requirement = await requirementService.submit(id, req.user!);

    // `requirement.department` is populated (see requirementService.submit) — it's a
    // Document, not a raw ObjectId, so `.toString()` on it returns an inspect-style
    // string, not the id. Must dereference `._id` explicitly (this exact mistake
    // silently failed ActivityLog.create's ObjectId cast on every submit — caught via
    // real-device testing, see docs/PHASE1_REQUIREMENT_MODULE.md verification notes).
    const department = requirement.department as unknown as { _id: { toString(): string }; hod?: { toString(): string } };

    activityLogService.record(
      {
        action: 'requirement_submitted',
        department: department._id.toString(),
        targetId: requirement.id,
        targetType: 'Requirement',
        newValue: { requirementNumber: requirement.requirementNumber },
      },
      req.user!,
      req,
    ).catch(() => null);

    const receivers: Array<{ id: string; role: (typeof ROLES)[keyof typeof ROLES] }> = [];
    if (department?.hod) {
      receivers.push({ id: department.hod.toString(), role: ROLES.HOD });
    }

    notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN)
      .then((admins) => notificationService.notifyUsers([...receivers, ...admins], {
        title: 'Requirement Submitted',
        message: `${requirement.requirementNumber} — ${requirement.title} was submitted for review.`,
        module: 'requirement',
        relatedRecord: requirement.id,
        notificationType: 'requirement_submitted',
        priority: 'medium',
        category: 'information',
        sender: req.user!.id,
        dedupKey: `requirement_submitted:${requirement.id}`,
      }))
      .catch(() => null);

    sendSuccess(res, requirement, 'Requirement submitted');
  }),

  submitToDirector: catchAsync(async (req: Request, res: Response) => {
    const id = req.params.id as string;
    const requirement = await requirementService.submitToDirector(id, req.user!);

    const department = requirement.department as unknown as { _id: { toString(): string }; hod?: { toString(): string } };

    activityLogService.record(
      {
        action: 'requirement_submitted_to_director',
        department: department._id.toString(),
        targetId: requirement.id,
        targetType: 'Requirement',
        newValue: { requirementNumber: requirement.requirementNumber },
      },
      req.user!,
      req,
    ).catch(() => null);

    // The only trigger point for this notification now — moved here from the first quotation
    // upload (see the removed `enteredCollection` block below in createQuotation) so a
    // Director only ever learns of a requirement once the Department User has explicitly
    // handed it over. No dedupKey: unlike a one-shot event (e.g. po_generated), this can fire
    // again after every Send Back → revise → resubmit cycle, and each cycle must notify again.
    Promise.all([
      notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
      notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN),
    ])
      .then(([directors, admins]) => notificationService.notifyUsers([...directors, ...admins], {
        title: 'Requirement Ready for Review',
        message: `${requirement.requirementNumber} — ${requirement.title} was submitted for Director Review.`,
        module: 'requirement',
        relatedRecord: requirement.id,
        notificationType: 'requirement_ready_for_review',
        priority: 'medium',
        category: 'information',
        sender: req.user!.id,
      }))
      .catch(() => null);

    sendSuccess(res, requirement, 'Requirement submitted to Director');
  }),

  remove: catchAsync(async (req: Request, res: Response) => {
    await requirementService.remove(req.params.id as string, req.user!);
    sendSuccess(res, null, 'Requirement deleted');
  }),

  createQuotation: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const { quotation } = await quotationService.createForRequirement(requirementId, req.body, req.user!);

    activityLogService.record(
      {
        action: 'quotation_created',
        targetId: quotation.id,
        targetType: 'Quotation',
        newValue: { requirement: requirementId, amount: quotation.amount, temporaryVendor: quotation.temporaryVendor?.name },
      },
      req.user!,
      req,
    ).catch(() => null);

    // Same fan-out as requirementController.submit: notify the department's HOD (unless
    // they're the one who just added the quotation) plus every active Super Admin.
    const [requirement, department] = await Promise.all([
      Requirement.findById(requirementId).select('requirementNumber'),
      Department.findById(req.user!.department).select('name hod'),
    ]);

    const receivers: Array<{ id: string; role: (typeof ROLES)[keyof typeof ROLES] }> = [];
    if (department?.hod && department.hod.toString() !== req.user!.id) {
      receivers.push({ id: department.hod.toString(), role: ROLES.HOD });
    }

    Promise.all([
      notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN),
      notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
    ])
      .then(([admins, directors]) => notificationService.notifyUsers([...receivers, ...admins, ...directors], {
        title: 'Quotation Added',
        message: `${quotation.quotationCode} (₹${quotation.amount.toLocaleString()}) was added to ${requirement?.requirementNumber ?? 'a requirement'} — ${department?.name ?? 'Unknown department'}.`,
        module: 'requirement',
        relatedRecord: requirementId,
        notificationType: 'quotation_added',
        priority: 'medium',
        category: 'information',
        sender: req.user!.id,
        dedupKey: `quotation_added:${quotation.id}`,
      }))
      .catch(() => null);

    // Confirms the upload to the person who just did it — every other notification in this
    // controller deliberately skips the actor themselves, but a Department User waiting to see
    // their own quotation land (especially after an AI-upload OCR run) has no other in-app signal
    // that the save actually went through.
    notificationService.notifyUsers([{ id: req.user!.id, role: req.user!.role }], {
      title: 'Quotation Submitted',
      message: `Your quotation ${quotation.quotationCode} (₹${quotation.amount.toLocaleString()}) was submitted for ${requirement?.requirementNumber ?? 'this requirement'}.`,
      module: 'requirement',
      relatedRecord: requirementId,
      notificationType: 'quotation_added',
      priority: 'low',
      category: 'information',
      sender: req.user!.id,
    }).catch(() => null);

    // Directors are deliberately NOT notified here anymore — merely uploading a quotation
    // (even the first one, which still moves the requirement into quotation_collection so
    // uploads stay open) must never expose the requirement to the Director. The Department
    // User controls when that happens via the explicit "Submit to Director" action
    // (requirementController.submitToDirector), which is the only place that notification fires.

    sendSuccess(res, quotation, 'Quotation created', 201);
  }),

  listQuotations: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    // Enforces requirement-level visibility (Department User: own; HOD: department;
    // Director/Super Admin: any — requirementService.getById's own scoping) before listing its
    // quotations — throws 404 for a requirement the caller can't see. Deliberately NOT
    // quotationService.list()'s own scopeToOwner, which applies the standalone
    // Quotation-approval-routing model (CEO-limit amount split, DRAFT excluded for Director/
    // CEO) — that model has nothing to do with Requirement-linked quotations, which are never
    // individually decided (they stay at DRAFT forever; see docs/
    // WORKFLOW_ENHANCEMENT_DIRECTOR_SUBMISSION.md). Applying it here silently hid every
    // Requirement-linked quotation from a Director opening a Requirement they were just
    // notified about.
    await requirementService.getById(requirementId, req.user!);

    const { items, meta } = await quotationService.list(
      { ...req.query, requirement: requirementId },
      req.user!,
    );
    sendSuccess(res, items, 'Requirement quotations fetched', 200, meta);
  }),

  uploadQuotationAttachment: catchAsync(async (req: Request, res: Response) => {
    if (!req.file) throw ApiError.badRequest('A PDF or image file is required');
    const url = `/uploads/quotations/${req.file.filename}`;
    const fileHash = crypto.createHash('sha256').update(fs.readFileSync(req.file.path)).digest('hex');
    const quotationId = req.params.quotationId as string;

    const quotation = await quotationService.uploadAttachment(
      quotationId,
      req.file.originalname,
      url,
      req.file.mimetype,
      fileHash,
      req.user!,
    );

    // Phase 3 — OCR runs automatically right after a successful upload; fire-and-forget,
    // same as every other side effect here. Mobile polls the quotation for `ocr.status`.
    quotationOcrService.run(quotationId, req.user!);

    sendSuccess(res, quotation, 'Attachment uploaded');
  }),

  retryOcr: catchAsync(async (req: Request, res: Response) => {
    const quotationId = req.params.quotationId as string;
    // Reuses the existing ownership/visibility check (Department User: own; HOD: department;
    // Super Admin: any) rather than duplicating that scoping logic here.
    await quotationService.getById(quotationId, req.user!);
    const quotation = await quotationOcrService.retry(quotationId, req.user!);
    sendSuccess(res, quotation, 'OCR retry started');
  }),

  setPreparedQuotation: catchAsync(async (req: Request, res: Response) => {
    const requirement = await requirementService.setPreparedQuotation(
      req.params.id as string,
      req.params.quotationId as string,
      req.body,
      req.user!,
    );
    sendSuccess(res, requirement, req.body.prepared ? 'Quotation marked as prepared' : 'Quotation unmarked as prepared');
  }),
};
