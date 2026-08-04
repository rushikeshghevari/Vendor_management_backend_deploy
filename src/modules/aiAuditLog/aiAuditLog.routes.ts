import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { mongoIdParamSchema } from '@/utils/commonValidation';
import { aiAuditLogController } from '@/modules/aiAuditLog/aiAuditLog.controller';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: AI Audit Logs
 *   description: Gemini AI verification run log for the Purchase Order / Bill 3-way match — prompts, token usage, timing, and outcome of each AI verification call
 */

// GET /ai-audit-logs — Super Admin only: full list with pagination + filters
/**
 * @openapi
 * /ai-audit-logs:
 *   get:
 *     tags: [AI Audit Logs]
 *     summary: List AI verification run logs with pagination and filters (Super Admin only)
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
 *         name: success
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: usedFallback
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: risk
 *         schema: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *     responses:
 *       200:
 *         description: Paginated list of AI verification run logs
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
 *                       triggeredBy: { type: string }
 *                       triggeredByRole: { type: string }
 *                       executionTimeMs: { type: number }
 *                       inputTokens: { type: number }
 *                       outputTokens: { type: number }
 *                       totalTokens: { type: number }
 *                       matchPercentage: { type: number }
 *                       risk: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                       recommendation: { type: string, enum: [APPROVE, MANUAL_REVIEW, REJECT] }
 *                       confidence: { type: number }
 *                       differenceCount: { type: number }
 *                       modelVersion: { type: string }
 *                       promptVersion: { type: string }
 *                       success: { type: boolean }
 *                       errorMessage: { type: string, nullable: true }
 *                       usedFallback: { type: boolean }
 *                       createdAt: { type: string, format: date-time }
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
 *         description: Only Super Admin may view AI audit logs
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/', authorize(ROLES.SUPER_ADMIN), aiAuditLogController.list);

// GET /ai-audit-logs/po/:purchaseOrderId — Accounts + Super Admin
/**
 * @openapi
 * /ai-audit-logs/po/{purchaseOrderId}:
 *   get:
 *     tags: [AI Audit Logs]
 *     summary: List AI verification run logs for a specific Purchase Order (Accounts, Super Admin)
 *     parameters:
 *       - in: path
 *         name: purchaseOrderId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: AI verification run logs for the Purchase Order, most recent first
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
 *                       triggeredBy: { type: string }
 *                       triggeredByRole: { type: string }
 *                       executionTimeMs: { type: number }
 *                       inputTokens: { type: number }
 *                       outputTokens: { type: number }
 *                       totalTokens: { type: number }
 *                       matchPercentage: { type: number }
 *                       risk: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                       recommendation: { type: string, enum: [APPROVE, MANUAL_REVIEW, REJECT] }
 *                       confidence: { type: number }
 *                       differenceCount: { type: number }
 *                       modelVersion: { type: string }
 *                       promptVersion: { type: string }
 *                       success: { type: boolean }
 *                       errorMessage: { type: string, nullable: true }
 *                       usedFallback: { type: boolean }
 *                       createdAt: { type: string, format: date-time }
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
  '/po/:purchaseOrderId',
  authorize(ROLES.ACCOUNTS, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema('purchaseOrderId') }),
  aiAuditLogController.listByPurchaseOrder,
);

export default router;
