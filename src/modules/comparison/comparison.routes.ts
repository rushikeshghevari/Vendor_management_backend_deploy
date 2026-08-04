import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { comparisonController } from '@/modules/comparison/comparison.controller';
import { comparisonParamsSchema } from '@/modules/comparison/comparison.validation';

// Mounted at `/requirements` in routes/index.ts, alongside requirement.routes.ts — a
// Comparison has no independent existence outside "the comparison for Requirement X", so it
// lives at `/requirements/:id/comparison` rather than a flat top-level `/comparisons`
// resource (Express allows two routers to share the same mount prefix; their path patterns
// don't overlap, same as how `auditLog` gets its own dedicated routes file for a similarly
// AI-adjacent, cross-record result).
const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Comparison
 *   description: >
 *     Phase 4 — AI Comparison Engine. Reads the OCR structured data already stored on each
 *     of a Requirement's quotations (Phase 3) and produces a recommendation-only comparison.
 *     Never re-runs OCR, never modifies OCR data, never approves or finalizes anything.
 */

/**
 * @openapi
 * /requirements/{id}/comparison:
 *   post:
 *     tags: [Comparison]
 *     summary: >
 *       Generate a fresh comparison across every quotation attached to this requirement —
 *       Department User, HOD, or Super Admin only. Always creates a new comparison record
 *       (never overwrites an earlier one); GET returns the latest.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       201: { description: Comparison generated }
 *       400: { description: No quotations exist yet for this requirement }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User, HOD, or Super Admin }
 *       404: { description: Requirement not found, or not visible to the caller }
 */
router.post(
  '/:id/comparison',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ params: comparisonParamsSchema }),
  comparisonController.generate,
);

/**
 * @openapi
 * /requirements/{id}/comparison:
 *   get:
 *     tags: [Comparison]
 *     summary: Get the most recently generated comparison for this requirement — Department User (own), HOD (department), Director, or Super Admin
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Comparison found }
 *       401: { description: Missing or invalid access token }
 *       404: { description: Requirement not found, or no comparison has been generated yet }
 */
router.get(
  '/:id/comparison',
  validate({ params: comparisonParamsSchema }),
  comparisonController.getLatest,
);

export default router;
