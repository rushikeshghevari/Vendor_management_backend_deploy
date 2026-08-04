import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { userController } from '@/modules/user/user.controller';
import {
  bulkUserStatusSchema,
  changePasswordSchema,
  createUserSchema,
  registerDeviceSchema,
  removeDeviceSchema,
  resetPasswordSchema,
  updateUserSchema,
  updateUserStatusSchema,
  userListQuerySchema,
} from '@/modules/user/user.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Users
 *   description: >
 *     User self-service (password, device tokens) plus Super Admin user management CRUD.
 *     Every route except the /me/* ones requires the super_admin role.
 */

/**
 * @openapi
 * /users/me/password:
 *   patch:
 *     tags: [Users]
 *     summary: Change the caller's own password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [currentPassword, newPassword]
 *             properties:
 *               currentPassword: { type: string, minLength: 8 }
 *               newPassword: { type: string, minLength: 8, maxLength: 128 }
 *     responses:
 *       200:
 *         description: Password updated
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
 *         description: Missing/invalid access token, or currentPassword is incorrect
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/me/password', validate({ body: changePasswordSchema }), userController.changePassword);

// Device token management — any authenticated user can register/remove their own devices
/**
 * @openapi
 * /users/me/register-device:
 *   post:
 *     tags: [Users]
 *     summary: Register (or refresh) a push-notification device token for the caller, and subscribe it to the caller's role/department FCM topics
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [token, deviceId, platform]
 *             properties:
 *               token: { type: string, maxLength: 500, description: "FCM device token" }
 *               deviceId: { type: string, maxLength: 200, description: "Stable client-generated device identifier" }
 *               platform: { type: string, enum: [android, ios, web] }
 *               deviceName: { type: string, maxLength: 100 }
 *     responses:
 *       200:
 *         description: Device registered
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
 */
router.post('/me/register-device', validate({ body: registerDeviceSchema }), userController.registerDevice);
/**
 * @openapi
 * /users/me/remove-device:
 *   post:
 *     tags: [Users]
 *     summary: Remove one of the caller's registered device tokens and unsubscribe it from all FCM topics
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [deviceId]
 *             properties:
 *               deviceId: { type: string, maxLength: 200 }
 *     responses:
 *       200:
 *         description: Device removed
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
 */
router.post('/me/remove-device',   validate({ body: removeDeviceSchema }),   userController.removeDevice);
/**
 * @openapi
 * /users/me/devices:
 *   get:
 *     tags: [Users]
 *     summary: List the caller's own registered push-notification devices
 *     responses:
 *       200:
 *         description: Devices fetched
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
 *                       token: { type: string }
 *                       deviceId: { type: string }
 *                       platform: { type: string, enum: [android, ios, web] }
 *                       deviceName: { type: string, nullable: true }
 *                       lastUsed: { type: string, format: date-time }
 *                       isActive: { type: boolean }
 *                       createdAt: { type: string, format: date-time }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/me/devices',                                                     userController.myDevices);

/**
 * @openapi
 * /users:
 *   post:
 *     tags: [Users]
 *     summary: Create a user of any role (Super Admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, email, password, role]
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 100 }
 *               email: { type: string, format: email }
 *               password: { type: string, minLength: 8, maxLength: 128 }
 *               role: { type: string, enum: [super_admin, department_user, hod, director, ceo, accounts, payment_department] }
 *               department: { type: string, description: "Required when role is department_user or hod" }
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
 *         description: "Validation failed (e.g. department missing for department_user/hod role)"
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Email or phone already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/',
  authorize(ROLES.SUPER_ADMIN),
  validate({ body: createUserSchema }),
  userController.create,
);

/**
 * @openapi
 * /users:
 *   get:
 *     tags: [Users]
 *     summary: List users (Super Admin only), with filtering, free-text search, and sorting
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: role
 *         schema: { type: string, enum: [super_admin, department_user, hod, director, ceo, accounts, payment_department] }
 *       - in: query
 *         name: department
 *         schema: { type: string }
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
 *         description: Paginated list of users
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
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/',
  authorize(ROLES.SUPER_ADMIN),
  validate({ query: userListQuerySchema }),
  userController.list,
);

/**
 * @openapi
 * /users/bulk-status:
 *   patch:
 *     tags: [Users]
 *     summary: Activate or deactivate multiple users at once (Super Admin only)
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
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/bulk-status',
  authorize(ROLES.SUPER_ADMIN),
  validate({ body: bulkUserStatusSchema }),
  userController.bulkSetStatus,
);

/**
 * @openapi
 * /users/{id}:
 *   get:
 *     tags: [Users]
 *     summary: Get a single user by id (Super Admin only)
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
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/:id',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  userController.getById,
);

/**
 * @openapi
 * /users/{id}:
 *   put:
 *     tags: [Users]
 *     summary: Replace a user's editable fields, including role/department (Super Admin only)
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
 *               role: { type: string, enum: [super_admin, department_user, hod, director, ceo, accounts, payment_department] }
 *               department: { type: string }
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
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Phone already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.put(
  '/:id',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: updateUserSchema }),
  userController.update,
);

/**
 * @openapi
 * /users/{id}:
 *   patch:
 *     tags: [Users]
 *     summary: Partially update a user's editable fields, including role/department (Super Admin only). Same behavior as PUT, all fields optional.
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
 *               role: { type: string, enum: [super_admin, department_user, hod, director, ceo, accounts, payment_department] }
 *               department: { type: string }
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
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing or invalid access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Phone already in use
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: updateUserSchema }),
  userController.update,
);

/**
 * @openapi
 * /users/{id}/status:
 *   patch:
 *     tags: [Users]
 *     summary: Activate or deactivate a user (Super Admin only)
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
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/status',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: updateUserStatusSchema }),
  userController.setStatus,
);

/**
 * @openapi
 * /users/{id}/reset-password:
 *   patch:
 *     tags: [Users]
 *     summary: Reset a user's password (Super Admin only, no current password required)
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
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/reset-password',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: resetPasswordSchema }),
  userController.resetPassword,
);

/**
 * @openapi
 * /users/{id}:
 *   delete:
 *     tags: [Users]
 *     summary: Deactivate a user (soft delete, Super Admin only) — sets isActive to false rather than removing the record
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
 *         description: Caller is not a Super Admin
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: User not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete(
  '/:id',
  authorize(ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  userController.deactivate,
);

export default router;
