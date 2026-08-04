import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { directorReviewController } from '@/modules/directorReview/directorReview.controller';
import { decisionSchema, directorReviewParamsSchema, remarksSchema } from '@/modules/directorReview/directorReview.validation';

// Mounted at `/requirements` in routes/index.ts, alongside requirement.routes.ts and
// comparison.routes.ts — same "no independent existence outside one Requirement" shape as
// Phase 4's Comparison routes.
const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Director Review
 *   description: >
 *     Phase 5 — Director Review & Approval. Begins once an AI comparison exists for a
 *     Requirement (Phase 4). A Director reviews the full procurement package (requirement,
 *     quotations, OCR data, AI comparison, activity history) and Approves, Rejects, or Sends
 *     Back. Never creates a Vendor or Purchase Order, never modifies OCR or the AI
 *     comparison itself.
 */

/**
 * @openapi
 * /requirements/{id}/director-review:
 *   get:
 *     tags: [Director Review]
 *     summary: >
 *       Get the full Director Review package — requirement, quotations (with OCR data), the
 *       latest AI comparison, recent activity log entries, and the review record itself.
 *       Department User (own) and HOD (department) get read-only access; a Director or
 *       Super Admin viewing it also advances the requirement into Director Review status.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Review package fetched }
 *       400: { description: No AI comparison has been generated yet for this requirement }
 *       401: { description: Missing or invalid access token }
 *       404: { description: Requirement not found, or not visible to the caller }
 */
router.get(
  '/:id/director-review',
  // Read-only pipeline visibility (additive) — CEO/Accounts/Payment Department never gain
  // any write access here, only GET. Both are excluded from `REVIEW_ROLES` in
  // directorReview.service.ts, so viewing by them never advances the requirement's status or
  // gets logged as a "viewed" history entry — only a Director/Super Admin's view does that.
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.DIRECTOR, ROLES.SUPER_ADMIN, ROLES.CEO, ROLES.ACCOUNTS, ROLES.PAYMENT_DEPARTMENT),
  validate({ params: directorReviewParamsSchema }),
  directorReviewController.getReviewPackage,
);

/**
 * @openapi
 * /requirements/{id}/director-review/decision:
 *   post:
 *     tags: [Director Review]
 *     summary: >
 *       Approve, Reject, or Send Back a requirement that is currently in Director Review —
 *       Director or Super Admin only. Approve moves the requirement to Approved (ready for
 *       Vendor Registration in Phase 6); Reject is terminal; Send Back returns it to
 *       Quotation Collection for the Department User to revise.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [decision]
 *             properties:
 *               decision: { type: string, enum: [approved, rejected, sent_back] }
 *               remarks: { type: string, maxLength: 2000, description: "Mandatory for rejected/sent_back" }
 *               selectedQuotationId: { type: string, description: "Only allowed when decision is approved — the Director's explicit pick of the winning quotation" }
 *     responses:
 *       200: { description: Decision recorded }
 *       400: { description: Validation failed, or no AI comparison exists yet }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Director or Super Admin }
 *       404: { description: Requirement not found, or not currently in Director Review }
 */
router.post(
  '/:id/director-review/decision',
  authorize(ROLES.DIRECTOR, ROLES.SUPER_ADMIN),
  validate({ params: directorReviewParamsSchema, body: decisionSchema }),
  directorReviewController.decide,
);

/**
 * @openapi
 * /requirements/{id}/director-review/remarks:
 *   patch:
 *     tags: [Director Review]
 *     summary: Update the Director's remarks on a requirement's review without changing its decision — Director or Super Admin only
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [remarks]
 *             properties:
 *               remarks: { type: string, minLength: 1, maxLength: 2000 }
 *     responses:
 *       200: { description: Remarks updated }
 *       400: { description: Validation failed }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Director or Super Admin }
 *       404: { description: Requirement not found }
 */
router.patch(
  '/:id/director-review/remarks',
  authorize(ROLES.DIRECTOR, ROLES.SUPER_ADMIN),
  validate({ params: directorReviewParamsSchema, body: remarksSchema }),
  directorReviewController.updateRemarks,
);

export default router;
