import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { activityLogController } from '@/modules/activityLog/activityLog.controller';
import { activityLogListQuerySchema } from '@/modules/activityLog/activityLog.validation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Activity Logs
 *   description: >
 *     Generic action-audit trail — "who did what to what, and from where" across
 *     department/HOD/user/vendor/quotation/purchase-order/bill actions. Distinct from
 *     /audit-logs (PO/Bill/Quotation 3-way AI-match decisions) and /ai-audit-logs (Gemini
 *     verification run logs). Super Admin sees every department's activity; a HOD sees only
 *     their own department's.
 */

/**
 * @openapi
 * /activity-logs:
 *   get:
 *     tags: [Activity Logs]
 *     summary: List activity log entries (Super Admin or HOD only), with filtering and pagination
 *     description: >
 *       Super Admin sees all departments' activity by default and may additionally filter by
 *       department; a HOD is always scoped to their own department server-side and the
 *       department query param is ignored for them.
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: action
 *         schema:
 *           type: string
 *           enum:
 *             - department_created
 *             - department_updated
 *             - hod_assigned
 *             - hod_transferred
 *             - hod_removed
 *             - department_user_created
 *             - department_user_updated
 *             - department_user_deactivated
 *             - department_user_reactivated
 *             - vendor_created
 *             - vendor_updated
 *             - quotation_created
 *             - purchase_order_created
 *             - bill_uploaded
 *             - password_reset
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *         description: Mongo id — Super Admin only, ignored for a HOD caller
 *       - in: query
 *         name: performedBy
 *         schema: { type: string }
 *         description: Mongo id of the user who performed the action
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *         description: ISO 8601 datetime — lower bound (inclusive) on createdAt
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *         description: ISO 8601 datetime — upper bound (inclusive) on createdAt
 *     responses:
 *       200:
 *         description: Paginated list of activity log entries, newest first
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
 *                       action: { type: string, example: "department_user_created" }
 *                       performedBy: { type: string, description: "User id of the actor" }
 *                       performedByName: { type: string }
 *                       performedByRole: { type: string, enum: [super_admin, department_user, hod, director, ceo, accounts, payment_department] }
 *                       department:
 *                         type: object
 *                         nullable: true
 *                         description: Populated with name/code only
 *                         properties:
 *                           id: { type: string }
 *                           name: { type: string }
 *                           code: { type: string }
 *                       targetId: { type: string, nullable: true, description: "Id of the record the action was performed on" }
 *                       targetType: { type: string, nullable: true, example: "User" }
 *                       oldValue: { type: object, nullable: true, description: "Snapshot of relevant fields before the change" }
 *                       newValue: { type: object, nullable: true, description: "Snapshot of relevant fields after the change" }
 *                       ipAddress: { type: string, nullable: true }
 *                       device: { type: string, nullable: true, description: "Raw User-Agent header of the request that triggered the action" }
 *                       createdAt: { type: string, format: date-time }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     totalPages: { type: integer }
 *       400:
 *         description: Invalid query parameters
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin or HOD
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.HOD),
  validate({ query: activityLogListQuerySchema }),
  activityLogController.list,
);

export default router;
