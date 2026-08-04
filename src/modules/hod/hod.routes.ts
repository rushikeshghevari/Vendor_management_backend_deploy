import { Router } from 'express';

import { authenticate } from '@/middleware/auth.middleware';
import { requireHOD } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { hodController } from '@/modules/hod/hod.controller';
import {
  hodBulkUserStatusSchema,
  hodCreateUserSchema,
  hodResetPasswordSchema,
  hodUpdateUserSchema,
  hodUpdateUserStatusSchema,
  hodUserListQuerySchema,
} from '@/modules/hod/hod.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate, requireHOD);

/**
 * @openapi
 * tags:
 *   name: HOD
 *   description: >
 *     Self-service endpoints for a Head of Department — manage their own department's
 *     users. Every endpoint is scoped to the caller's own department (taken from their JWT,
 *     never from client-supplied input) and requires the hod role.
 */

/**
 * @openapi
 * /hod/department:
 *   get:
 *     tags: [HOD]
 *     summary: Get the calling HOD's own department, enriched with populated HOD account and record-count statistics
 *     responses:
 *       200:
 *         description: Own department
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
 *                     name: { type: string }
 *                     code: { type: string }
 *                     description: { type: string, nullable: true }
 *                     departmentHead: { type: string, nullable: true }
 *                     hod:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         id: { type: string }
 *                         name: { type: string }
 *                         email: { type: string }
 *                         phone: { type: string }
 *                         isActive: { type: boolean }
 *                     isActive: { type: boolean }
 *                     userCount: { type: integer }
 *                     vendorCount: { type: integer }
 *                     quotationCount: { type: integer }
 *                     purchaseOrderCount: { type: integer }
 *                     billCount: { type: integer }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "Caller is not a HOD, or the HOD account has no department assigned"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/department', hodController.getOwnDepartment);

/**
 * @openapi
 * /hod/analytics:
 *   get:
 *     tags: [HOD]
 *     summary: Get analytics for the calling HOD's own department — identical shape to GET /departments/{id}/analytics
 *     responses:
 *       200:
 *         description: Own department analytics
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
 *                     activeUsers: { type: integer }
 *                     inactiveUsers: { type: integer }
 *                     pendingApprovals: { type: integer, description: "Quotations + bills currently awaiting approval" }
 *                     rejected: { type: integer, description: "Quotations + bills rejected" }
 *                     completed: { type: integer, description: "Bills paid/completed" }
 *                     weeklyActivity:
 *                       type: array
 *                       description: Last 7 days, one entry per day
 *                       items:
 *                         type: object
 *                         properties:
 *                           date: { type: string, example: "2026-07-04" }
 *                           quotations: { type: integer }
 *                           bills: { type: integer }
 *                     monthlyTrend:
 *                       type: array
 *                       description: Last 6 months, one entry per month
 *                       items:
 *                         type: object
 *                         properties:
 *                           month: { type: string, example: "2026-07" }
 *                           quotations: { type: integer }
 *                           bills: { type: integer }
 *                     vendorGrowth:
 *                       type: array
 *                       description: Last 6 months, new vendors created per month
 *                       items:
 *                         type: object
 *                         properties:
 *                           month: { type: string, example: "2026-07" }
 *                           count: { type: integer }
 *                     quotationStatusBreakdown:
 *                       type: array
 *                       description: One entry per quotation status value that has at least one matching document
 *                       items:
 *                         type: object
 *                         properties:
 *                           status: { type: string, example: submitted }
 *                           count: { type: integer }
 *                     billStatusBreakdown:
 *                       type: array
 *                       description: One entry per bill status value that has at least one matching document
 *                       items:
 *                         type: object
 *                         properties:
 *                           status: { type: string, example: submitted }
 *                           count: { type: integer }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "Caller is not a HOD, or the HOD account has no department assigned"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/analytics', hodController.getOwnAnalytics);

/**
 * @openapi
 * /hod/users:
 *   post:
 *     tags: [HOD]
 *     summary: Create a department_user in the calling HOD's own department
 *     description: >
 *       Request body is validated with a .strict() Zod schema — any extra fields (e.g. role,
 *       department) are rejected with 400, since role is always department_user and department
 *       is always derived from the HOD's own JWT, never accepted from the client.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password]
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 100 }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8, maxLength: 128 }
 *               phone: { type: string, maxLength: 20 }
 *               isActive: { type: boolean, default: true }
 *     responses:
 *       201:
 *         description: User created
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: Validation failed, or an unknown field was supplied
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "Caller is not a HOD, or the HOD account has no department assigned"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Email or phone already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post('/users', validate({ body: hodCreateUserSchema }), hodController.createUser);

/**
 * @openapi
 * /hod/users:
 *   get:
 *     tags: [HOD]
 *     summary: List department_user accounts in the calling HOD's own department
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: isActive
 *         schema: { type: string, enum: [true, false] }
 *       - in: query
 *         name: search
 *         schema: { type: string, maxLength: 200 }
 *         description: Free-text search across name/email
 *       - in: query
 *         name: sort
 *         schema: { type: string, enum: [name, email, createdAt] }
 *       - in: query
 *         name: order
 *         schema: { type: string, enum: [asc, desc] }
 *     responses:
 *       200:
 *         description: Paginated list of department users
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: array
 *                   items: { $ref: '#/components/schemas/User' }
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
 *         description: Caller is not a HOD
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/users', validate({ query: hodUserListQuerySchema }), hodController.listUsers);

/**
 * @openapi
 * /hod/users/bulk-status:
 *   patch:
 *     tags: [HOD]
 *     summary: Activate or deactivate multiple department users in the calling HOD's own department at once
 *     description: >
 *       Scoped server-side to the HOD's own department and to department_user accounts only —
 *       any ids outside that scope are silently excluded from the update rather than erroring.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [ids, isActive]
 *             properties:
 *               ids:
 *                 type: array
 *                 minItems: 1
 *                 maxItems: 200
 *                 items: { type: string }
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: Users updated
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
 *                     updated: { type: integer, description: "Number of users actually matched and updated" }
 *       400:
 *         description: Validation failed (e.g. empty ids array, or a malformed id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "Caller is not a HOD, or the HOD account has no department assigned"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/users/bulk-status',
  validate({ body: hodBulkUserStatusSchema }),
  hodController.bulkSetUserStatus,
);

/**
 * @openapi
 * /hod/users/{id}:
 *   get:
 *     tags: [HOD]
 *     summary: Get a single department_user by id, scoped to the calling HOD's own department
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: Invalid id format
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "User exists but is not a department_user in the caller's own department"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/users/:id', validate({ params: mongoIdParamSchema() }), hodController.getUser);

/**
 * @openapi
 * /hod/users/{id}:
 *   put:
 *     tags: [HOD]
 *     summary: Update a department_user's editable fields, scoped to the calling HOD's own department
 *     description: >
 *       Request body is validated with a .strict() Zod schema — extra fields (e.g. role,
 *       department) are rejected with 400, since department_user/own-department are always
 *       enforced server-side and can't be changed via this endpoint.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 100 }
 *               phone: { type: string, maxLength: 20 }
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: User updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: Validation failed, or an unknown field was supplied
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "User exists but is not a department_user in the caller's own department"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Phone already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.put(
  '/users/:id',
  validate({ params: mongoIdParamSchema(), body: hodUpdateUserSchema }),
  hodController.updateUser,
);

/**
 * @openapi
 * /hod/users/{id}/status:
 *   patch:
 *     tags: [HOD]
 *     summary: Activate or deactivate a department_user, scoped to the calling HOD's own department
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
 *             required: [isActive]
 *             properties:
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: User status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { $ref: '#/components/schemas/User' }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "User exists but is not a department_user in the caller's own department"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/users/:id/status',
  validate({ params: mongoIdParamSchema(), body: hodUpdateUserStatusSchema }),
  hodController.setUserStatus,
);

/**
 * @openapi
 * /hod/users/{id}/reset-password:
 *   patch:
 *     tags: [HOD]
 *     summary: Reset a department_user's password, scoped to the calling HOD's own department (no current password required)
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
 *             required: [newPassword]
 *             properties:
 *               newPassword: { type: string, minLength: 8, maxLength: 128 }
 *     responses:
 *       200:
 *         description: Password reset
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: object, nullable: true, example: null }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "User exists but is not a department_user in the caller's own department"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/users/:id/reset-password',
  validate({ params: mongoIdParamSchema(), body: hodResetPasswordSchema }),
  hodController.resetUserPassword,
);

/**
 * @openapi
 * /hod/users/{id}:
 *   delete:
 *     tags: [HOD]
 *     summary: Deactivate a department_user (soft delete), scoped to the calling HOD's own department
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: User deactivated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: object, nullable: true, example: null }
 *       400:
 *         description: Invalid id format
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: "User exists but is not a department_user in the caller's own department"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete('/users/:id', validate({ params: mongoIdParamSchema() }), hodController.deactivateUser);

export default router;
