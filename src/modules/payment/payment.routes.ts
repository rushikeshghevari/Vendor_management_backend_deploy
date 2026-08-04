import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { paymentController } from '@/modules/payment/payment.controller';
import {
  createPaymentSchema,
  markFailedSchema,
  markPaidSchema,
  paymentListQuerySchema,
  startProcessingSchema,
} from '@/modules/payment/payment.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Payments
 *   description: Payment lifecycle — creation, method capture, status transitions (pending → processing → paid → completed/failed), and role-scoped dashboard stats
 */

/**
 * @openapi
 * /payments:
 *   post:
 *     tags: [Payments]
 *     summary: Create a payment record for a verified bill (Payment Department only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [bill]
 *             properties:
 *               bill: { type: string, description: Verified Bill ObjectId, example: 665f1c2b9b1d4c1a2c8e4a10 }
 *     responses:
 *       201:
 *         description: Payment created with status payment_pending
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
 *                     paymentCode: { type: string, example: PAY-2026-0001 }
 *                     bill: { type: string }
 *                     quotation: { type: string }
 *                     vendor: { type: string }
 *                     department: { type: string }
 *                     amount: { type: number }
 *                     gst: { type: number }
 *                     invoiceNumber: { type: string }
 *                     invoiceDate: { type: string, format: date-time }
 *                     status: { type: string, enum: [payment_pending, processing, paid, completed, failed] }
 *                     retryCount: { type: number }
 *                     createdBy: { type: string }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only the Payment Department role may create payments
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: A payment already exists for this bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post('/', authorize(ROLES.PAYMENT_DEPARTMENT), validate({ body: createPaymentSchema }), paymentController.create);

/**
 * @openapi
 * /payments:
 *   get:
 *     tags: [Payments]
 *     summary: List payments with pagination and filters (Payment Department, Accounts, Super Admin, Department User)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [payment_pending, processing, paid, completed, failed] }
 *       - in: query
 *         name: vendor
 *         schema: { type: string }
 *         description: Vendor ObjectId
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *         description: Department ObjectId
 *       - in: query
 *         name: paymentMethod
 *         schema: { type: string, enum: [bank_transfer, cheque, upi, rtgs, neft, imps, cash] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of payments, scoped to the caller's role/department
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
 *                       paymentCode: { type: string }
 *                       bill: { type: string }
 *                       vendor: { type: string }
 *                       department: { type: string }
 *                       amount: { type: number }
 *                       status: { type: string, enum: [payment_pending, processing, paid, completed, failed] }
 *                       paymentMethod: { type: string, nullable: true }
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
 *       403:
 *         description: Caller's role may not list payments
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/',
  authorize(ROLES.PAYMENT_DEPARTMENT, ROLES.ACCOUNTS, ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER),
  validate({ query: paymentListQuerySchema }),
  paymentController.list,
);

// Must be registered before the `/:id` route below, or these would be parsed as an id.
/**
 * @openapi
 * /payments/stats/payment-department:
 *   get:
 *     tags: [Payments]
 *     summary: Payment Department dashboard stats (pending/processing/paid counts and amounts)
 *     responses:
 *       200:
 *         description: Dashboard stats object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   description: Aggregated payment counts and totals by status, shape defined by the service layer
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Payment Department or Super Admin may view this
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/payment-department', authorize(ROLES.PAYMENT_DEPARTMENT, ROLES.SUPER_ADMIN), paymentController.paymentDeptStats);
/**
 * @openapi
 * /payments/stats/accounts:
 *   get:
 *     tags: [Payments]
 *     summary: Accounts dashboard stats for payments (Accounts, Super Admin)
 *     responses:
 *       200:
 *         description: Dashboard stats object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   description: Aggregated payment counts and totals, shape defined by the service layer
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Accounts or Super Admin may view this
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/accounts', authorize(ROLES.ACCOUNTS, ROLES.SUPER_ADMIN), paymentController.accountsStats);
/**
 * @openapi
 * /payments/stats/super-admin:
 *   get:
 *     tags: [Payments]
 *     summary: Organization-wide payment dashboard stats (Super Admin only)
 *     responses:
 *       200:
 *         description: Dashboard stats object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   description: Aggregated payment counts and totals across the organization, shape defined by the service layer
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Super Admin may view this
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/super-admin', authorize(ROLES.SUPER_ADMIN), paymentController.superAdminStats);
/**
 * @openapi
 * /payments/stats/my-payments:
 *   get:
 *     tags: [Payments]
 *     summary: The caller's own department payment stats (Department User only)
 *     responses:
 *       200:
 *         description: Dashboard stats object
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   description: Aggregated payment counts and totals for the caller's department, shape defined by the service layer
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Department User may view this
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/my-payments', authorize(ROLES.DEPARTMENT_USER), paymentController.myStats);

// CEO/Director's only window into Payment data — a narrow, single-record, read-only lookup
// embedded in Quotation Details. No list/full-detail access for these two roles.
/**
 * @openapi
 * /payments/by-quotation/{quotationId}:
 *   get:
 *     tags: [Payments]
 *     summary: Get the payment linked to a quotation (embedded read-only lookup for Quotation Details)
 *     parameters:
 *       - in: path
 *         name: quotationId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Payment linked to the quotation, or null if none exists yet
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string }
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id: { type: string }
 *                     paymentCode: { type: string }
 *                     amount: { type: number }
 *                     status: { type: string, enum: [payment_pending, processing, paid, completed, failed] }
 *                     paymentDate: { type: string, format: date-time, nullable: true }
 *       400:
 *         description: Validation failed (invalid quotationId)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller's role may not view this payment
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/by-quotation/:quotationId',
  authorize(ROLES.CEO, ROLES.DIRECTOR, ROLES.SUPER_ADMIN, ROLES.ACCOUNTS, ROLES.PAYMENT_DEPARTMENT, ROLES.DEPARTMENT_USER),
  validate({ params: mongoIdParamSchema('quotationId') }),
  paymentController.getByQuotation,
);

/**
 * @openapi
 * /payments/{id}:
 *   get:
 *     tags: [Payments]
 *     summary: Get a payment by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Payment detail
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
 *                     paymentCode: { type: string }
 *                     bill: { type: string }
 *                     quotation: { type: string }
 *                     vendor: { type: string }
 *                     department: { type: string }
 *                     amount: { type: number }
 *                     gst: { type: number }
 *                     invoiceNumber: { type: string }
 *                     invoiceDate: { type: string, format: date-time }
 *                     paymentMethod: { type: string, enum: [bank_transfer, cheque, upi, rtgs, neft, imps, cash], nullable: true }
 *                     utrNumber: { type: string, nullable: true }
 *                     chequeNumber: { type: string, nullable: true }
 *                     paymentDate: { type: string, format: date-time, nullable: true }
 *                     status: { type: string, enum: [payment_pending, processing, paid, completed, failed] }
 *                     retryCount: { type: number }
 *                     history:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           status: { type: string }
 *                           remarks: { type: string, nullable: true }
 *                           failureReason: { type: string, nullable: true }
 *                           changedBy: { type: string }
 *                           changedAt: { type: string, format: date-time }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed (invalid id)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller's role may not view this payment
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Payment not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/:id',
  authorize(ROLES.PAYMENT_DEPARTMENT, ROLES.ACCOUNTS, ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER),
  validate({ params: mongoIdParamSchema() }),
  paymentController.getById,
);

/**
 * @openapi
 * /payments/{id}/start-processing:
 *   patch:
 *     tags: [Payments]
 *     summary: Move a payment from Payment Pending to Processing, capturing the payment method (Payment Department only)
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
 *             required: [paymentMethod]
 *             properties:
 *               paymentMethod: { type: string, enum: [bank_transfer, cheque, upi, rtgs, neft, imps, cash] }
 *               bankName: { type: string }
 *               accountNumber: { type: string }
 *               ifsc: { type: string }
 *               upiId: { type: string }
 *     responses:
 *       200:
 *         description: Payment moved to processing
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
 *                     status: { type: string, example: processing }
 *                     paymentMethod: { type: string }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Payment Department may start processing
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Payment not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Payment is not in a state that can be moved to processing
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/start-processing',
  authorize(ROLES.PAYMENT_DEPARTMENT),
  validate({ params: mongoIdParamSchema(), body: startProcessingSchema }),
  paymentController.startProcessing,
);

/**
 * @openapi
 * /payments/{id}/mark-paid:
 *   patch:
 *     tags: [Payments]
 *     summary: Mark a processing payment as paid (Payment Department only)
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
 *             required: [paymentDate]
 *             properties:
 *               utrNumber: { type: string, description: Required for online transfer methods }
 *               transactionReference: { type: string }
 *               chequeNumber: { type: string, description: Required for cheque method }
 *               paymentDate: { type: string, format: date }
 *               remarks: { type: string, maxLength: 1000 }
 *     responses:
 *       200:
 *         description: Payment marked as paid
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
 *                     status: { type: string, example: paid }
 *                     paymentDate: { type: string, format: date-time }
 *       400:
 *         description: Validation failed, or the method-specific reference (UTR/cheque number) is missing
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Payment Department may mark payments as paid
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Payment not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Payment is not in the Processing state
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/mark-paid',
  authorize(ROLES.PAYMENT_DEPARTMENT),
  validate({ params: mongoIdParamSchema(), body: markPaidSchema }),
  paymentController.markPaid,
);

/**
 * @openapi
 * /payments/{id}/mark-completed:
 *   patch:
 *     tags: [Payments]
 *     summary: Mark a paid payment as completed, closing out the payment lifecycle (Payment Department only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Payment marked as completed
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
 *                     status: { type: string, example: completed }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Payment Department may mark payments as completed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Payment not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Payment is not in the Paid state
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch('/:id/mark-completed', authorize(ROLES.PAYMENT_DEPARTMENT), validate({ params: mongoIdParamSchema() }), paymentController.markCompleted);

/**
 * @openapi
 * /payments/{id}/mark-failed:
 *   patch:
 *     tags: [Payments]
 *     summary: Mark a processing payment as failed with a reason, allowing retry (Payment Department only)
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
 *             required: [failureReason]
 *             properties:
 *               failureReason:
 *                 type: string
 *                 enum: [bank_timeout, upi_failed, cheque_rejected, insufficient_balance, account_closed, invalid_ifsc, network_failure, manual_hold, other]
 *               remarks: { type: string, maxLength: 1000 }
 *     responses:
 *       200:
 *         description: Payment marked as failed; retryCount is incremented
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
 *                     status: { type: string, example: failed }
 *                     retryCount: { type: number }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Payment Department may mark payments as failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Payment not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Payment is not in the Processing state
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/mark-failed',
  authorize(ROLES.PAYMENT_DEPARTMENT),
  validate({ params: mongoIdParamSchema(), body: markFailedSchema }),
  paymentController.markFailed,
);

export default router;
