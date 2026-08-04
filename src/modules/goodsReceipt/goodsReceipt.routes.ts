import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { goodsReceiptController } from '@/modules/goodsReceipt/goodsReceipt.controller';
import { createGoodsReceiptSchema, goodsReceiptListQuerySchema } from '@/modules/goodsReceipt/goodsReceipt.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Goods Receipt
 *   description: Phase 8 — Goods Receipt & Inspection records against a Purchase Order, gating Bill creation for Requirement-originated Purchase Orders
 */

// Get GRN by Purchase Order ID — must be before /:id
/**
 * @openapi
 * /goods-receipts/by-po/{purchaseOrderId}:
 *   get:
 *     tags: [Goods Receipt]
 *     summary: Get the Goods Receipt recorded for a given Purchase Order, if any
 *     description: Used by the mobile app to decide "Record Goods Receipt" vs "View Goods Receipt".
 *     parameters:
 *       - in: path
 *         name: purchaseOrderId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Goods Receipt found, or null if none exists yet for this Purchase Order
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Goods Receipt fetched }
 *                 data: { nullable: true, type: object }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/by-po/:purchaseOrderId',
  validate({ params: mongoIdParamSchema('purchaseOrderId') }),
  goodsReceiptController.getByPurchaseOrder,
);

/**
 * @openapi
 * /goods-receipts:
 *   get:
 *     tags: [Goods Receipt]
 *     summary: List Goods Receipts visible to the caller (paginated, searchable)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of Goods Receipts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Goods Receipts fetched }
 *                 data: { type: array, items: { type: object } }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     totalPages: { type: integer }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/', validate({ query: goodsReceiptListQuerySchema }), goodsReceiptController.list);

/**
 * @openapi
 * /goods-receipts:
 *   post:
 *     tags: [Goods Receipt]
 *     summary: Record a Goods Receipt against a Purchase Order (Department User / HOD / Super Admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [purchaseOrder, receivedDate, items, overallCondition]
 *             properties:
 *               purchaseOrder: { type: string }
 *               receivedDate: { type: string, format: date }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [itemName, orderedQuantity, receivedQuantity, condition]
 *                   properties:
 *                     itemName: { type: string }
 *                     orderedQuantity: { type: number, minimum: 0 }
 *                     receivedQuantity: { type: number, minimum: 0 }
 *                     condition: { type: string, enum: [good, damaged, short_supply] }
 *                     remarks: { type: string }
 *               overallCondition: { type: string, enum: [good, damaged, partial] }
 *               remarks: { type: string }
 *     responses:
 *       201:
 *         description: Goods Receipt recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Goods Receipt recorded successfully }
 *                 data: { type: object }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User, HOD, or Super Admin can record Goods Receipt
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Purchase Order not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: A Goods Receipt has already been recorded for this Purchase Order
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ body: createGoodsReceiptSchema }),
  goodsReceiptController.create,
);

/**
 * @openapi
 * /goods-receipts/{id}:
 *   get:
 *     tags: [Goods Receipt]
 *     summary: Get a single Goods Receipt by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Goods Receipt found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Goods Receipt fetched }
 *                 data: { type: object }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Goods Receipt not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/:id', validate({ params: mongoIdParamSchema() }), goodsReceiptController.getById);

export default router;
