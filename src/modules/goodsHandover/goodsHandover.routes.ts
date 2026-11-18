import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { goodsHandoverController } from '@/modules/goodsHandover/goodsHandover.controller';
import { distributeGoodsHandoverSchema, goodsHandoverListQuerySchema } from '@/modules/goodsHandover/goodsHandover.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Goods Handover
 *   description: >
 *     Phase 12 — tracks the internal hand-off of received goods to Admin, for a Requirement
 *     whose routing history shows Admin as a pass-through department. Created automatically
 *     once a Goods Receipt is recorded; never created directly via the API.
 */

router.get(
  '/by-receipt/:goodsReceiptId',
  validate({ params: mongoIdParamSchema('goodsReceiptId') }),
  goodsHandoverController.getByGoodsReceipt,
);

router.get('/', validate({ query: goodsHandoverListQuerySchema }), goodsHandoverController.list);

router.get('/:id', validate({ params: mongoIdParamSchema() }), goodsHandoverController.getById);

/**
 * @openapi
 * /goods-handovers/{id}/hand-over:
 *   patch:
 *     tags: [Goods Handover]
 *     summary: The department that ran the Purchase Order confirms it physically handed the goods to Admin
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Handover confirmed }
 *       403: { description: Caller is not from the department that ran the Purchase Order }
 *       404: { description: Goods Handover not found }
 *       409: { description: Already confirmed as handed over }
 */
router.patch(
  '/:id/hand-over',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  goodsHandoverController.handOver,
);

/**
 * @openapi
 * /goods-handovers/{id}/receive:
 *   patch:
 *     tags: [Goods Handover]
 *     summary: Admin confirms receipt of the goods — the second, independent side of the two-way confirmation
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Receipt confirmed }
 *       403: { description: Caller is not from Admin }
 *       404: { description: Goods Handover not found }
 *       409: { description: Not yet handed over }
 */
router.patch(
  '/:id/receive',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  goodsHandoverController.receive,
);

/**
 * @openapi
 * /goods-handovers/{id}/distribute:
 *   patch:
 *     tags: [Goods Handover]
 *     summary: Admin logs the final internal distribution — a plain note, no acknowledgment required from the receiving department/user
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
 *             required: [distributedToDepartment]
 *             properties:
 *               distributedToDepartment: { type: string }
 *               distributedToUser: { type: string }
 *               note: { type: string, maxLength: 1000 }
 *     responses:
 *       200: { description: Distribution logged }
 *       403: { description: Caller is not from Admin }
 *       404: { description: Goods Handover not found }
 *       409: { description: Not yet received, or already logged }
 */
router.patch(
  '/:id/distribute',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: distributeGoodsHandoverSchema }),
  goodsHandoverController.distribute,
);

export default router;
