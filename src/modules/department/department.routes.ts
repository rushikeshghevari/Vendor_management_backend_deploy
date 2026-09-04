import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { departmentController } from '@/modules/department/department.controller';
import {
  createDepartmentSchema,
  transferHodSchema,
  updateDepartmentSchema,
  updateDepartmentStatusSchema,
} from '@/modules/department/department.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Departments
 *   description: Department CRUD, per-department analytics, and HOD assignment/transfer (Super Admin only, except GET which any authenticated user can call)
 */

/**
 * @openapi
 * /departments:
 *   post:
 *     tags: [Departments]
 *     summary: Create a department (Super Admin only) — optionally create a brand-new HOD account or assign an existing user as HOD in the same request
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, code]
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 100, example: "Procurement" }
 *               code: { type: string, minLength: 2, maxLength: 20, example: "PROC" }
 *               description: { type: string, maxLength: 500 }
 *               departmentHead: { type: string, maxLength: 100, description: "Free-text label, distinct from the linked hod/hodId account" }
 *               isActive: { type: boolean, default: true }
 *               createHod: { type: boolean, description: "If true, creates a new HOD user from the hod object below" }
 *               hod:
 *                 type: object
 *                 description: "New HOD account details — required when createHod is true. Provide either hod or hodId, not both."
 *                 properties:
 *                   name: { type: string, minLength: 2, maxLength: 100 }
 *                   email: { type: string, format: email }
 *                   password: { type: string, minLength: 8, maxLength: 128 }
 *                   phone: { type: string, maxLength: 20 }
 *               hodId: { type: string, description: "Id of an existing user to assign as HOD. Provide either hod or hodId, not both." }
 *     responses:
 *       201:
 *         description: Department created
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
 *                     hod: { type: string, nullable: true, description: "HOD user id, if one was created/assigned" }
 *                     isActive: { type: boolean }
 *                     createdBy: { type: string }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: "Validation failed (e.g. both hod and hodId provided, or createHod true without hod)"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Department name or code already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/',
  authorize(ROLES.SUPER_ADMIN),
  validate({ body: createDepartmentSchema }),
  departmentController.create,
);

/**
 * @openapi
 * /departments:
 *   get:
 *     tags: [Departments]
 *     summary: List departments, each enriched with its populated HOD and record-count statistics
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
 *         description: Filter by active/inactive status
 *     responses:
 *       200:
 *         description: Paginated list of departments
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
 *                       name: { type: string }
 *                       code: { type: string }
 *                       description: { type: string, nullable: true }
 *                       departmentHead: { type: string, nullable: true }
 *                       hod:
 *                         type: object
 *                         nullable: true
 *                         description: Populated HOD account, if one is assigned
 *                         properties:
 *                           id: { type: string }
 *                           name: { type: string }
 *                           email: { type: string }
 *                           phone: { type: string }
 *                           isActive: { type: boolean }
 *                       isActive: { type: boolean }
 *                       createdBy: { type: string }
 *                       createdAt: { type: string, format: date-time }
 *                       updatedAt: { type: string, format: date-time }
 *                       userCount: { type: integer }
 *                       vendorCount: { type: integer }
 *                       quotationCount: { type: integer }
 *                       purchaseOrderCount: { type: integer }
 *                       billCount: { type: integer }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     totalPages: { type: integer }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/', departmentController.list);

/**
 * @openapi
 * /departments/{id}:
 *   get:
 *     tags: [Departments]
 *     summary: Get a single department by id, enriched with its populated HOD and record-count statistics
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Department found
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
 *                     createdBy: { type: string }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *                     userCount: { type: integer }
 *                     vendorCount: { type: integer }
 *                     quotationCount: { type: integer }
 *                     purchaseOrderCount: { type: integer }
 *                     billCount: { type: integer }
 *       400:
 *         description: Invalid id format
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Department not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/:id', validate({ params: mongoIdParamSchema() }), departmentController.getById);

/**
 * @openapi
 * /departments/{id}/analytics:
 *   get:
 *     tags: [Departments]
 *     summary: Get analytics for a department (Super Admin only) — user counts, pending/rejected/completed rollups, and weekly/monthly trend series
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Department analytics
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
 *                     activeUsers: { type: integer, description: "Active department users" }
 *                     inactiveUsers: { type: integer, description: "Inactive department users" }
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
 *                     requirementTrend:
 *                       type: array
 *                       description: Last 6 months, requirements raised per month (chronological)
 *                       items: { type: integer }
 *                     quotationTrend:
 *                       type: array
 *                       description: Last 6 months, quotations created per month (chronological)
 *                       items: { type: integer }
 *                     purchaseOrderTrend:
 *                       type: array
 *                       description: Last 6 months, purchase orders created per month (chronological)
 *                       items: { type: integer }
 *                     billTrend:
 *                       type: array
 *                       description: Last 6 months, bills created per month (chronological)
 *                       items: { type: integer }
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
 *       400:
 *         description: Invalid id format
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Department not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/:id/analytics',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  departmentController.getAnalytics,
);

/**
 * @openapi
 * /departments/{id}:
 *   put:
 *     tags: [Departments]
 *     summary: Replace a department's editable fields (Super Admin only). Does not touch HOD assignment — use PUT /departments/{id}/transfer-hod for that.
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
 *               code: { type: string, minLength: 2, maxLength: 20 }
 *               description: { type: string, maxLength: 500 }
 *               departmentHead: { type: string, maxLength: 100 }
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: Department updated
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
 *                     isActive: { type: boolean }
 *                     createdBy: { type: string }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Department not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Department name or code already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.put(
  '/:id',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: updateDepartmentSchema }),
  departmentController.update,
);

/**
 * @openapi
 * /departments/{id}:
 *   patch:
 *     tags: [Departments]
 *     summary: Partially update a department's editable fields (Super Admin only). Same behavior as PUT, all fields optional.
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
 *               code: { type: string, minLength: 2, maxLength: 20 }
 *               description: { type: string, maxLength: 500 }
 *               departmentHead: { type: string, maxLength: 100 }
 *               isActive: { type: boolean }
 *     responses:
 *       200:
 *         description: Department updated
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
 *                     isActive: { type: boolean }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Department not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Department name or code already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: updateDepartmentSchema }),
  departmentController.update,
);

/**
 * @openapi
 * /departments/{id}/status:
 *   patch:
 *     tags: [Departments]
 *     summary: Activate or deactivate a department (Super Admin only)
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
 *         description: Department status updated
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
 *                     isActive: { type: boolean }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Department not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/status',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: updateDepartmentStatusSchema }),
  departmentController.setStatus,
);

/**
 * @openapi
 * /departments/{id}:
 *   delete:
 *     tags: [Departments]
 *     summary: Deactivate a department (Super Admin only) — soft delete, sets isActive to false rather than removing the record
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Department deactivated
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
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Department not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete(
  '/:id',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  departmentController.remove,
);

/**
 * @openapi
 * /departments/{id}/transfer-hod:
 *   put:
 *     tags: [Departments]
 *     summary: Assign, replace, or move the department's HOD (Super Admin only) — the single entry point for all post-creation HOD ownership changes
 *     description: >
 *       If newHodId currently heads another department, they are removed from it first.
 *       If the target department already has a different HOD, that user is optionally
 *       demoted back to department_user (demoteOldHod). The new HOD's own role/department
 *       are updated to hod / this department as part of the same operation.
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
 *             required: [newHodId]
 *             properties:
 *               newHodId: { type: string, description: "Id of the user to assign as the new HOD" }
 *               demoteOldHod: { type: boolean, description: "If true, the department's previous HOD (if different) is demoted to department_user" }
 *     responses:
 *       200:
 *         description: HOD transferred — returns the department with its newly-populated hod and statistics
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
 *       400:
 *         description: Validation failed (e.g. missing/malformed newHodId)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Department or the given newHodId user was not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.put(
  '/:id/transfer-hod',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: transferHodSchema }),
  departmentController.transferHod,
);

export default router;
