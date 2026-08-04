import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { directorReviewService } from '@/modules/directorReview/directorReview.service';
import { notificationService } from '@/modules/notification/notification.service';
import { Quotation } from '@/modules/quotation/quotation.model';
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

      if (requirement.status === 'approved') {
        // Names the winning quotation in the notification itself — without this, "Ready for
        // vendor registration" gave no hint of WHICH vendor won until the Department User
        // opened the requirement and scrolled to the (now-added) Approved Quotation card.
        const winningQuotation = review.selectedQuotation
          ? await Quotation.findById(review.selectedQuotation).populate('vendor', 'name').select('quotationCode amount vendor temporaryVendor')
          : null;
        const winningVendorName = winningQuotation
          ? ((winningQuotation.vendor as unknown as { name?: string } | undefined)?.name ?? winningQuotation.temporaryVendor?.name)
          : undefined;

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
