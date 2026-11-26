import type { Request, Response } from 'express';
import type { Types } from 'mongoose';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { advancePaymentService } from '@/modules/advancePayment/advancePayment.service';
import { directorReviewService } from '@/modules/directorReview/directorReview.service';
import { notificationService } from '@/modules/notification/notification.service';
import { Quotation } from '@/modules/quotation/quotation.model';
import { User } from '@/modules/user/user.model';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

type PopulatedRef = { _id: { toString(): string }; name?: string; hod?: { toString(): string } };

function idOf(doc: { _id: unknown }): string {
  return String(doc._id);
}

export const directorReviewController = {
  getReviewPackage: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const { requirement, comparison, quotations, activityLogs, review } = await directorReviewService.getReviewPackage(requirementId, req.user!);

    if (req.user!.role === ROLES.DIRECTOR || req.user!.role === ROLES.SUPER_ADMIN) {
      // `requirement.department` is populated — same `._id` dereference gotcha documented in
      // requirementController.submit: `.toString()` on the populated Document is not the id.
      const department = requirement.department as unknown as PopulatedRef;
      activityLogService.record(
        {
          action: 'director_review_viewed',
          department: department._id.toString(),
          targetId: idOf(requirement),
          targetType: 'Requirement',
        },
        req.user!,
        req,
      ).catch(() => null);
    }

    sendSuccess(res, { requirement, comparison, quotations, activityLogs, review }, 'Director review package fetched');
  }),

  decide: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const { requirement, review } = await directorReviewService.decide(requirementId, req.body, req.user!);

    const department = requirement.department as unknown as PopulatedRef;
    const createdBy = requirement.createdBy as unknown as PopulatedRef;
    // This Director's own individual decision — distinct from the requirement's resulting
    // (aggregate) status below, which is what actually determines whether to notify the
    // Department User. Approving while the other Director still hasn't decided leaves
    // `requirement.status` at `director_review` — no notification fires for that; see
    // docs/WORKFLOW_DUAL_DIRECTOR_APPROVAL.md.
    const decision = req.body.decision as 'approved' | 'rejected' | 'sent_back';
    const remarks = req.body.remarks as string | undefined;

    const action = decision === 'approved' ? 'director_review_approved' : decision === 'rejected' ? 'director_review_rejected' : 'director_review_sent_back';
    activityLogService.record(
      {
        action,
        department: department._id.toString(),
        targetId: idOf(requirement),
        targetType: 'Requirement',
        newValue: { decision, remarks },
      },
      req.user!,
      req,
    ).catch(() => null);

    (async () => {
      const receivers: Array<{ id: string; role: (typeof ROLES)[keyof typeof ROLES] }> = [
        { id: createdBy._id.toString(), role: ROLES.DEPARTMENT_USER },
      ];
      if (department.hod) receivers.push({ id: department.hod.toString(), role: ROLES.HOD });

      // Whoever actually added a quotation to this requirement (e.g. a co-worker in the
      // receiving department on a routed-in requirement — see RequirementListScreen's
      // routing fix) has real stake in the Director's decision too, not just the original
      // creator and the HOD. `submittedBy` covers an HOD submitting on a Department User's
      // behalf; both fields can be absent/equal to createdBy, so dedup against what's
      // already in `receivers` by id — `notifyUsers`' per-receiver dedupKey would also
      // absorb an exact repeat, but skipping the extra User lookups here is cheaper.
      const quotationUploaderIds = await Quotation.find({ requirement: requirement._id, isDeleted: { $ne: true } })
        .distinct('createdBy')
        .then((ids) => ids.map((id) => id.toString()));
      const submittedByIds = await Quotation.find({ requirement: requirement._id, isDeleted: { $ne: true }, submittedBy: { $exists: true } })
        .distinct('submittedBy')
        .then((ids) => ids.map((id) => id.toString()));
      const existingReceiverIds = new Set(receivers.map((r) => r.id));
      const extraUploaderIds = [...new Set([...quotationUploaderIds, ...submittedByIds])].filter((id) => !existingReceiverIds.has(id));
      if (extraUploaderIds.length > 0) {
        const uploaders = await User.find({ _id: { $in: extraUploaderIds } }).select('role').lean();
        for (const uploader of uploaders) {
          receivers.push({ id: uploader._id.toString(), role: uploader.role as (typeof ROLES)[keyof typeof ROLES] });
        }
      }

      if (requirement.status === 'approved') {
        // Names the winning quotation in the notification itself — without this, "Ready for
        // vendor registration" gave no hint of WHICH vendor won until the Department User
        // opened the requirement and scrolled to the (now-added) Approved Quotation card.
        const winningQuotation = review.selectedQuotation
          ? await Quotation.findById(review.selectedQuotation)
              .populate('vendor', 'name')
              .select('quotationCode amount advanceAmount expectedPODate vendor temporaryVendor')
          : null;
        const winningVendorName = winningQuotation
          ? ((winningQuotation.vendor as unknown as { name?: string } | undefined)?.name ?? winningQuotation.temporaryVendor?.name)
          : undefined;

        if (winningQuotation) {
          advancePaymentService
            .createForApprovedQuotation(
              {
                _id: requirement._id,
                requirementNumber: requirement.requirementNumber,
                department: department._id as unknown as Types.ObjectId,
                createdBy: createdBy._id as unknown as Types.ObjectId,
              },
              winningQuotation,
              req.user!,
            )
            .catch((err) => console.error(`[Advance Payment] Auto-create failed for requirement ${idOf(requirement)}:`, err));
        }

        const admins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
        await notificationService.notifyUsers([...receivers, ...admins], {
          title: 'Requirement Approved',
          message: winningQuotation && winningVendorName
            ? `${requirement.requirementNumber} — ${requirement.title} was approved by both Directors. Winning quotation: ${winningQuotation.quotationCode} — ${winningVendorName} (₹${winningQuotation.amount.toLocaleString()}). Ready for vendor registration.`
            : `${requirement.requirementNumber} — ${requirement.title} was approved by both Directors. Ready for vendor registration.`,
          module: 'requirement',
          relatedRecord: idOf(requirement),
          notificationType: 'director_review_approved',
          priority: 'high',
          category: 'success',
          sender: req.user!.id,
          dedupKey: `director_review_approved:${idOf(requirement)}`,
        });
      } else if (requirement.status === 'rejected') {
        await notificationService.notifyUsers(receivers, {
          title: 'Requirement Rejected',
          message: `${requirement.requirementNumber} — ${requirement.title} was rejected by the Director.${remarks ? ` Remarks: ${remarks}` : ''}`,
          module: 'requirement',
          relatedRecord: idOf(requirement),
          notificationType: 'director_review_rejected',
          priority: 'high',
          category: 'error',
          sender: req.user!.id,
          dedupKey: `director_review_rejected:${idOf(requirement)}`,
        });
      } else if (requirement.status === 'quotation_collection') {
        await notificationService.notifyUser(
          { id: createdBy._id.toString(), role: ROLES.DEPARTMENT_USER },
          {
            title: 'Requirement Sent Back',
            message: `${requirement.requirementNumber} — ${requirement.title} was sent back by the Director for revision.${remarks ? ` Remarks: ${remarks}` : ''}`,
            module: 'requirement',
            relatedRecord: idOf(requirement),
            notificationType: 'director_review_sent_back',
            priority: 'high',
            category: 'warning',
            sender: req.user!.id,
          },
        );
      }
      // else: requirement.status is still 'director_review' — one Director approved, the
      // other hasn't yet. Nothing to notify the Department User about until it resolves.
    })().catch(() => null);

    sendSuccess(res, { requirement, review }, 'Decision recorded');
  }),

  updateRemarks: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const review = await directorReviewService.addRemarks(requirementId, req.body.remarks, req.user!);

    activityLogService.record(
      {
        action: 'director_review_remarks_updated',
        targetId: requirementId,
        targetType: 'Requirement',
        newValue: { remarks: req.body.remarks },
      },
      req.user!,
      req,
    ).catch(() => null);

    sendSuccess(res, review, 'Remarks updated');
  }),
};
