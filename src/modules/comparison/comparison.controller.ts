import type { Request, Response } from 'express';

import { ROLES } from '@/constants/roles';
import { activityLogService } from '@/modules/activityLog/activityLog.service';
import { comparisonService } from '@/modules/comparison/comparison.service';
import { Department } from '@/modules/department/department.model';
import { notificationService } from '@/modules/notification/notification.service';
import { Requirement } from '@/modules/requirement/requirement.model';
import { sendSuccess } from '@/utils/ApiResponse';
import { catchAsync } from '@/utils/catchAsync';

export const comparisonController = {
  generate: catchAsync(async (req: Request, res: Response) => {
    const requirementId = req.params.id as string;
    const comparison = await comparisonService.generate(requirementId, req.user!);

    activityLogService.record(
      {
        action: 'comparison_generated',
        targetId: String(comparison._id),
        targetType: 'Comparison',
        newValue: { requirement: requirementId, totalQuotations: comparison.statistics.totalQuotations },
      },
      req.user!,
      req,
    ).catch(() => null);

    // "Ready for Director Review" — notify the department's HOD and every active Director
    // and Super Admin that a comparison is available. Purely informational: nothing here
    // approves, scores, or finalizes a vendor (see docs/PHASE4_AI_COMPARISON.md).
    (async () => {
      const requirement = await Requirement.findById(requirementId).select('requirementNumber title department');
      if (!requirement) return;
      const department = await Department.findById(requirement.department).select('hod');

      const receivers: Array<{ id: string; role: (typeof ROLES)[keyof typeof ROLES] }> = [];
      if (department?.hod) receivers.push({ id: department.hod.toString(), role: ROLES.HOD });

      const [directors, admins] = await Promise.all([
        notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
        notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN),
      ]);

      await notificationService.notifyUsers([...receivers, ...directors, ...admins], {
        title: 'Quotation Comparison Ready',
        message: `A comparison of ${comparison.statistics.totalQuotations} quotation(s) for ${requirement.requirementNumber} — ${requirement.title} is ready for review.`,
        module: 'requirement',
        relatedRecord: requirementId,
        notificationType: 'comparison_generated',
        priority: 'medium',
        category: 'information',
        sender: req.user!.id,
      });
    })().catch(() => null);

    sendSuccess(res, comparison, 'Comparison generated', 201);
  }),

  getLatest: catchAsync(async (req: Request, res: Response) => {
    
    const comparison = await comparisonService.getLatest(req.params.id as string, req.user!);
    sendSuccess(res, comparison, 'Comparison fetched');
  }),
};
