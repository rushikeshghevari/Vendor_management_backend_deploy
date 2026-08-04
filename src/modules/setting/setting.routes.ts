import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { settingController } from '@/modules/setting/setting.controller';
import { updateSettingSchema } from '@/modules/setting/setting.validation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Settings
 *   description: System-wide settings (singleton document) — CEO approval limit, etc.
 */

/**
 * @openapi
 * /settings:
 *   get:
 *     tags: [Settings]
 *     summary: Get the current system settings
 *     responses:
 *       200:
 *         description: Current system settings
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
 *                     id: { type: string, example: system }
 *                     ceoApprovalLimit: { type: number, example: 50000, description: Quotation amount above which CEO approval is required instead of Director }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/', settingController.get);

/**
 * @openapi
 * /settings:
 *   patch:
 *     tags: [Settings]
 *     summary: Update system settings (Super Admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ceoApprovalLimit]
 *             properties:
 *               ceoApprovalLimit: { type: number, exclusiveMinimum: 0, example: 75000 }
 *     responses:
 *       200:
 *         description: Settings updated
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
 *                     id: { type: string, example: system }
 *                     ceoApprovalLimit: { type: number }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed (ceoApprovalLimit must be greater than 0)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Super Admin may update settings
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/', authorize(ROLES.SUPER_ADMIN), validate({ body: updateSettingSchema }), settingController.update);

export default router;
