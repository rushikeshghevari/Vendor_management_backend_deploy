import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { directorController } from '@/modules/director/director.controller';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Director
 *   description: Director Financial Review — read-only aggregation of a Bill's Quotation, Purchase Order, stored AI verification, differences, timeline, and approval history
 */

/**
 * @openapi
 * /director/bills/{id}/review:
 *   get:
 *     tags: [Director]
 *     summary: Full financial review payload for a Bill (Director only)
 *     description: >
 *       Read-only aggregation reusing the already-stored AI verification result on the linked
 *       Purchase Order (`purchaseOrder.aiVerification`) — never triggers a new AI run.
 *       If no AI verification exists yet, `aiVerification.available` is `false` and
 *       `canTriggerAiVerification` indicates whether the caller may run one via
 *       `POST /purchase-orders/{purchaseOrderId}/verify`.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *         description: Bill id
 *     responses:
 *       200:
 *         description: Financial review payload
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill financial review fetched }
 *                 data:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Director can access this review
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/bills/:id/review',
  authorize(ROLES.DIRECTOR),
  validate({ params: mongoIdParamSchema() }),
  directorController.getBillReview,
);

export default router;
