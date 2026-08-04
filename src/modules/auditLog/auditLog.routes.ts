import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { auditLogController } from '@/modules/auditLog/auditLog.controller';
import { createAuditLogSchema } from '@/modules/auditLog/auditLog.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();
router.use(authenticate);
router.use(authorize(ROLES.ACCOUNTS, ROLES.SUPER_ADMIN));

/**
 * @openapi
 * tags:
 *   name: Audit Logs
 *   description: Accounts' 3-way AI-match decision trail for Purchase Order / Bill / Quotation (Accounts, Super Admin only)
 */

/**
 * @openapi
 * /audit-logs:
 *   post:
 *     tags: [Audit Logs]
 *     summary: Record an Accounts decision (verify/correction/reject) on a Purchase Order's 3-way AI match, snapshotting the AI result
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [purchaseOrderId, billId, quotationId, accountsDecision]
 *             properties:
 *               purchaseOrderId: { type: string, example: 665f1c2b9b1d4c1a2c8e4a10 }
 *               billId: { type: string }
 *               quotationId: { type: string }
 *               accountsDecision: { type: string, enum: [verified, correction_requested, rejected] }
 *               reason: { type: string, maxLength: 1000, description: Required when accountsDecision is correction_requested or rejected }
 *     responses:
 *       201:
 *         description: Audit log entry created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     purchaseOrder: { type: string }
 *                     bill: { type: string }
 *                     quotation: { type: string }
 *                     aiRecommendation: { type: string, enum: [APPROVE, MANUAL_REVIEW, REJECT] }
 *                     aiConfidence: { type: number }
 *                     matchPercentage: { type: number }
 *                     quotationMatch: { type: number, nullable: true }
 *                     purchaseOrderMatch: { type: number, nullable: true }
 *                     risk: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                     differenceCount: { type: number }
 *                     differences:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           field: { type: string }
 *                           purchaseOrder: {}
 *                           bill: {}
 *                           difference: { type: string }
 *                     accountsDecision: { type: string, enum: [verified, correction_requested, rejected] }
 *                     reason: { type: string, nullable: true }
 *                     decidedBy: { type: string }
 *                     decidedByName: { type: string }
 *                     decidedByRole: { type: string }
 *                     decidedAt: { type: string, format: date-time }
 *                     createdAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed (e.g. missing reason for correction_requested/rejected)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Accounts or Super Admin may create audit log entries
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Purchase Order, Bill, or Quotation not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post('/', validate({ body: createAuditLogSchema }), auditLogController.create);

/**
 * @openapi
 * /audit-logs:
 *   get:
 *     tags: [Audit Logs]
 *     summary: List audit log entries with pagination and filters (Accounts, Super Admin)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: purchaseOrderId
 *         schema: { type: string }
 *       - in: query
 *         name: accountsDecision
 *         schema: { type: string, enum: [verified, correction_requested, rejected] }
 *       - in: query
 *         name: risk
 *         schema: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *     responses:
 *       200:
 *         description: Paginated list of audit log entries
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       purchaseOrder: { type: string }
 *                       bill: { type: string }
 *                       quotation: { type: string }
 *                       aiRecommendation: { type: string, enum: [APPROVE, MANUAL_REVIEW, REJECT] }
 *                       matchPercentage: { type: number }
 *                       risk: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                       accountsDecision: { type: string, enum: [verified, correction_requested, rejected] }
 *                       decidedByName: { type: string }
 *                       decidedAt: { type: string, format: date-time }
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
 *       403:
 *         description: Only Accounts or Super Admin may list audit logs
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/', auditLogController.list);
/**
 * @openapi
 * /audit-logs/by-po/{purchaseOrderId}:
 *   get:
 *     tags: [Audit Logs]
 *     summary: List all audit log entries for a specific Purchase Order (full decision history)
 *     parameters:
 *       - in: path
 *         name: purchaseOrderId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Audit log entries for the Purchase Order, most recent first
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       bill: { type: string }
 *                       quotation: { type: string }
 *                       aiRecommendation: { type: string, enum: [APPROVE, MANUAL_REVIEW, REJECT] }
 *                       matchPercentage: { type: number }
 *                       risk: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                       accountsDecision: { type: string, enum: [verified, correction_requested, rejected] }
 *                       reason: { type: string, nullable: true }
 *                       decidedByName: { type: string }
 *                       decidedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed (invalid purchaseOrderId)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Accounts or Super Admin may view this
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/by-po/:purchaseOrderId',
  validate({ params: mongoIdParamSchema('purchaseOrderId') }),
  auditLogController.listByPurchaseOrder,
);

export default router;
