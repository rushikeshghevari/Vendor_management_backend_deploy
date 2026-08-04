import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { notificationController } from '@/modules/notification/notification.controller';
import {
  broadcastSchema,
  notificationListQuerySchema,
  scheduleFollowUpSchema,
} from '@/modules/notification/notification.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Notifications
 *   description: Teams/Slack-style notification center — list/search/filter, read/unread, pin, archive, soft-delete, and Super Admin broadcast + analytics
 */

/**
 * @openapi
 * /notifications:
 *   get:
 *     tags: [Notifications]
 *     summary: List the caller's notifications with search, filters, and pagination
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: module
 *         schema: { type: string, enum: [quotation, bill, payment, purchase_order, vendor, system] }
 *       - in: query
 *         name: isRead
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: isArchived
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: isPinned
 *         schema: { type: string, enum: ['true', 'false'] }
 *       - in: query
 *         name: priority
 *         schema: { type: string, enum: [low, medium, high, critical] }
 *       - in: query
 *         name: search
 *         schema: { type: string, maxLength: 200 }
 *       - in: query
 *         name: since
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Paginated list of the caller's notifications
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
 *                       title: { type: string }
 *                       message: { type: string }
 *                       module: { type: string, enum: [quotation, bill, payment, purchase_order, vendor, system] }
 *                       relatedRecord: { type: string }
 *                       sender: { type: string, nullable: true }
 *                       receiver: { type: string }
 *                       receiverRole: { type: string, enum: [super_admin, department_user, hod, director, ceo, accounts, payment_department] }
 *                       notificationType: { type: string, example: bill_ai_verified }
 *                       priority: { type: string, enum: [low, medium, high, critical] }
 *                       category: { type: string, enum: [information, success, warning, error] }
 *                       isRead: { type: boolean }
 *                       isArchived: { type: boolean }
 *                       isPinned: { type: boolean }
 *                       isPushSent: { type: boolean }
 *                       pushDeliveryStatus: { type: string, enum: [pending, sent, failed] }
 *                       createdAt: { type: string, format: date-time }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer }
 *                     limit: { type: integer }
 *                     total: { type: integer }
 *                     totalPages: { type: integer }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/',            validate({ query: notificationListQuerySchema }), notificationController.list);
/**
 * @openapi
 * /notifications/unread-count:
 *   get:
 *     tags: [Notifications]
 *     summary: Get the caller's unread notification count (for the bell badge)
 *     responses:
 *       200:
 *         description: Unread count
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
 *                     count: { type: integer, example: 4 }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/unread-count',                                                  notificationController.unreadCount);
/**
 * @openapi
 * /notifications/analytics:
 *   get:
 *     tags: [Notifications]
 *     summary: Notification analytics — delivery/read metrics across the system (Super Admin only)
 *     responses:
 *       200:
 *         description: Analytics summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   description: Aggregated notification counts, read rates, and push delivery breakdown, shape defined by the service layer
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Super Admin may view notification analytics
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/analytics',   authorize(ROLES.SUPER_ADMIN),                     notificationController.analytics);

/**
 * @openapi
 * /notifications/read-all:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark all of the caller's notifications as read
 *     responses:
 *       200:
 *         description: All notifications marked as read
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: object, nullable: true, example: null }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/read-all',  notificationController.markAllRead);
/**
 * @openapi
 * /notifications/all:
 *   delete:
 *     tags: [Notifications]
 *     summary: Soft-delete all of the caller's notifications
 *     responses:
 *       200:
 *         description: All notifications deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: object, nullable: true, example: null }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete('/all',      notificationController.deleteAll);

/**
 * @openapi
 * /notifications/broadcast:
 *   post:
 *     tags: [Notifications]
 *     summary: Broadcast a system announcement to roles and/or specific users (Super Admin only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, message]
 *             properties:
 *               title: { type: string, minLength: 1, maxLength: 200 }
 *               message: { type: string, minLength: 1, maxLength: 1000 }
 *               targetRoles:
 *                 type: array
 *                 items: { type: string, enum: [super_admin, department_user, hod, director, ceo, accounts, payment_department] }
 *               targetUserIds:
 *                 type: array
 *                 items: { type: string }
 *     responses:
 *       201:
 *         description: Broadcast sent; a notification of type "broadcast" is created for each targeted user
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   description: Broadcast dispatch result (e.g. recipient count), shape defined by the service layer
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Super Admin may broadcast
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/broadcast',
  authorize(ROLES.SUPER_ADMIN),
  validate({ body: broadcastSchema }),
  notificationController.broadcast,
);

/**
 * @openapi
 * /notifications/{id}/read:
 *   patch:
 *     tags: [Notifications]
 *     summary: Mark a single notification as read
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Notification marked as read
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
 *                     isRead: { type: boolean, example: true }
 *       400:
 *         description: Validation failed (invalid id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Notification not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/:id/read',      validate({ params: mongoIdParamSchema() }), notificationController.markRead);
/**
 * @openapi
 * /notifications/{id}/archive:
 *   patch:
 *     tags: [Notifications]
 *     summary: Archive a notification
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Notification archived
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
 *                     isArchived: { type: boolean, example: true }
 *       400:
 *         description: Validation failed (invalid id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Notification not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/:id/archive',   validate({ params: mongoIdParamSchema() }), notificationController.archive);
/**
 * @openapi
 * /notifications/{id}/pin:
 *   patch:
 *     tags: [Notifications]
 *     summary: Pin a notification to the top of the list
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Notification pinned
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
 *                     isPinned: { type: boolean, example: true }
 *       400:
 *         description: Validation failed (invalid id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Notification not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/:id/pin',       validate({ params: mongoIdParamSchema() }), notificationController.pin);
/**
 * @openapi
 * /notifications/{id}/unpin:
 *   patch:
 *     tags: [Notifications]
 *     summary: Unpin a notification
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Notification unpinned
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
 *                     isPinned: { type: boolean, example: false }
 *       400:
 *         description: Validation failed (invalid id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Notification not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/:id/unpin',     validate({ params: mongoIdParamSchema() }), notificationController.unpin);
/**
 * @openapi
 * /notifications/{id}/delivered:
 *   patch:
 *     tags: [Notifications]
 *     summary: Record client-side push delivery confirmation for a notification (device delivery tracking)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Delivery recorded
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
 *                     pushDeliveryStatus: { type: string, enum: [pending, sent, failed] }
 *                     pushSentAt: { type: string, format: date-time, nullable: true }
 *       400:
 *         description: Validation failed (invalid id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Notification not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/:id/delivered', validate({ params: mongoIdParamSchema() }), notificationController.recordDelivery);
/**
 * @openapi
 * /notifications/{id}/follow-up:
 *   patch:
 *     tags: [Notifications]
 *     summary: Schedule a one-time follow-up reminder on a notification (the sole exception to "send once")
 *     description: >
 *       A single reminder fires at `followUpDate`, then is marked sent forever — it is
 *       never resent, including across server restarts.
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
 *             required: [followUpDate]
 *             properties:
 *               followUpDate: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Follow-up reminder scheduled
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
 *                     followUpDate: { type: string, format: date-time }
 *                     followUpSent: { type: boolean, example: false }
 *       400:
 *         description: Validation failed (invalid id or date)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Notification not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/follow-up',
  validate({ params: mongoIdParamSchema(), body: scheduleFollowUpSchema }),
  notificationController.scheduleFollowUp,
);
/**
 * @openapi
 * /notifications/{id}:
 *   delete:
 *     tags: [Notifications]
 *     summary: Soft-delete a single notification
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Notification deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data: { type: object, nullable: true, example: null }
 *       400:
 *         description: Validation failed (invalid id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Notification not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete('/:id',          validate({ params: mongoIdParamSchema() }), notificationController.softDelete);

export default router;
