import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { uploadBillInvoice, uploadBillSupportingDocument } from '@/middleware/billUpload.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { billController } from '@/modules/bill/bill.controller';
import {
  billFinancialDecisionSchema,
  billDecisionSchema,
  billListQuerySchema,
  billPaymentStatusSchema,
  createBillSchema,
  updateBillSchema,
} from '@/modules/bill/bill.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Bills
 *   description: Vendor invoices/bills — creation, AI 3-way verification, Director Financial Approval, Accounts verification, and Payment
 */

/**
 * @openapi
 * /bills:
 *   post:
 *     tags: [Bills]
 *     summary: Create a Draft bill against an Approved quotation (Department User / HOD only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [quotation, invoiceNumber, invoiceDate, invoiceAmount, taxableAmount, gstAmount, paymentTerms, dueDate]
 *             properties:
 *               quotation: { type: string, description: Approved Quotation id }
 *               invoiceNumber: { type: string }
 *               invoiceDate: { type: string, format: date }
 *               invoiceAmount: { type: number, minimum: 0.01 }
 *               taxableAmount: { type: number, minimum: 0 }
 *               gstAmount: { type: number, minimum: 0 }
 *               paymentTerms: { type: string }
 *               dueDate: { type: string, format: date }
 *               remarks: { type: string, maxLength: 1000 }
 *     responses:
 *       201:
 *         description: Bill created in Draft status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill created }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     billCode: { type: string, example: BILL-0001 }
 *                     quotation: { type: string }
 *                     vendor: { type: string }
 *                     department: { type: string }
 *                     createdBy: { type: string }
 *                     invoiceNumber: { type: string }
 *                     invoiceDate: { type: string, format: date-time }
 *                     invoiceAmount: { type: number }
 *                     taxableAmount: { type: number }
 *                     gstAmount: { type: number }
 *                     paymentTerms: { type: string }
 *                     dueDate: { type: string, format: date-time }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *                     createdAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed, quotation not found/not Approved, or a duplicate GST-invoice-number was detected for this vendor
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can create a bill (for a quotation they created, in their own department)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: A bill already exists for this quotation
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post('/', authorize(ROLES.DEPARTMENT_USER, ROLES.HOD), validate({ body: createBillSchema }), billController.create);

/**
 * @openapi
 * /bills:
 *   get:
 *     tags: [Bills]
 *     summary: List bills visible to the caller (paginated, filterable)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *       - in: query
 *         name: vendor
 *         schema: { type: string }
 *       - in: query
 *         name: quotation
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: dateFrom
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: dateTo
 *         schema: { type: string, format: date }
 *     responses:
 *       200:
 *         description: Paginated list of bills
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bills fetched }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       billCode: { type: string }
 *                       quotation: { type: string }
 *                       vendor: { type: string }
 *                       department: { type: string }
 *                       invoiceNumber: { type: string }
 *                       invoiceAmount: { type: number }
 *                       status:
 *                         type: string
 *                         enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *                       createdAt: { type: string, format: date-time }
 *                 pagination:
 *                   type: object
 *                   properties:
 *                     page: { type: integer, example: 1 }
 *                     limit: { type: integer, example: 20 }
 *                     total: { type: integer, example: 42 }
 *                     totalPages: { type: integer, example: 3 }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/', validate({ query: billListQuerySchema }), billController.list);

// Must be registered before the `/:id` route below, or "stats" would be parsed as an id.
/**
 * @openapi
 * /bills/stats/accounts:
 *   get:
 *     tags: [Bills]
 *     summary: Accounts dashboard stats — bills awaiting/decided by Accounts, plus counts by status (Accounts only)
 *     responses:
 *       200:
 *         description: Accounts dashboard stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Accounts dashboard stats fetched }
 *                 data:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Accounts can view this dashboard
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/accounts', authorize(ROLES.ACCOUNTS), billController.accountsStats);

/**
 * @openapi
 * /bills/stats/payment:
 *   get:
 *     tags: [Bills]
 *     summary: Payment Department dashboard stats — bills awaiting payment, plus counts by status (Payment Department only)
 *     responses:
 *       200:
 *         description: Payment dashboard stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Payment dashboard stats fetched }
 *                 data:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Payment Department can view this dashboard
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/payment', authorize(ROLES.PAYMENT_DEPARTMENT), billController.paymentStats);

/**
 * @openapi
 * /bills/stats/director:
 *   get:
 *     tags: [Bills]
 *     summary: Director dashboard stats — bills awaiting Director Financial Approval, plus counts by status (Director only)
 *     responses:
 *       200:
 *         description: Director dashboard stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Director dashboard stats fetched }
 *                 data:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Director can view this dashboard
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/director', authorize(ROLES.DIRECTOR), billController.directorStats);

/**
 * @openapi
 * /bills/stats/super-admin:
 *   get:
 *     tags: [Bills]
 *     summary: Super Admin dashboard stats — org-wide bill totals
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Stats fetched
 *       403:
 *         description: Only Super Admin can view this dashboard
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/super-admin', authorize(ROLES.SUPER_ADMIN), billController.superAdminStats);

/**
 * @openapi
 * /bills/{id}:
 *   get:
 *     tags: [Bills]
 *     summary: Get a single bill by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bill found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill fetched }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     billCode: { type: string }
 *                     quotation: { type: string }
 *                     purchaseOrder: { type: string, nullable: true }
 *                     vendor: { type: string }
 *                     department: { type: string }
 *                     createdBy: { type: string }
 *                     invoiceNumber: { type: string }
 *                     invoiceDate: { type: string, format: date-time }
 *                     invoiceAmount: { type: number }
 *                     taxableAmount: { type: number }
 *                     gstAmount: { type: number }
 *                     paymentTerms: { type: string }
 *                     dueDate: { type: string, format: date-time }
 *                     invoiceFiles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           version: { type: integer }
 *                           fileName: { type: string }
 *                           url: { type: string }
 *                           uploadedAt: { type: string, format: date-time }
 *                     supportingDocuments:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           version: { type: integer }
 *                           fileName: { type: string }
 *                           url: { type: string }
 *                           uploadedAt: { type: string, format: date-time }
 *                     remarks: { type: string }
 *                     directorFinancialDecision: { type: string, enum: [approved, rejected, correction_required], nullable: true }
 *                     directorFinancialBy: { type: string, nullable: true }
 *                     directorFinancialAt: { type: string, format: date-time, nullable: true }
 *                     directorFinancialRemarks: { type: string, nullable: true }
 *                     accountsRemarks: { type: string, nullable: true }
 *                     verifiedBy: { type: string, nullable: true }
 *                     verifiedAt: { type: string, format: date-time, nullable: true }
 *                     decisionHistory:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           decision:
 *                             type: string
 *                             enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *                           remarks: { type: string }
 *                           decidedBy: { type: string }
 *                           decidedAt: { type: string, format: date-time }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *                     submittedAt: { type: string, format: date-time, nullable: true }
 *                     decisionAt: { type: string, format: date-time, nullable: true }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/:id', validate({ params: mongoIdParamSchema() }), billController.getById);

/**
 * @openapi
 * /bills/{id}/timeline:
 *   get:
 *     tags: [Bills]
 *     summary: Complete Bill Timeline — status changes, AI runs, approvals, remarks, actor, and timestamp for every event
 *     description: >
 *       Merges the Bill's own append-only history, Accounts' decisionHistory, and every
 *       AiAuditLog run for this bill into one chronologically-sorted feed. Visibility mirrors
 *       GET /bills/{id} — the same role-scoped rule applies.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bill timeline fetched
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill timeline fetched }
 *                 data:
 *                   type: object
 *                   properties:
 *                     billId: { type: string }
 *                     billCode: { type: string }
 *                     events:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           type: { type: string, enum: [bill_event, accounts_decision, ai_run] }
 *                           event: { type: string }
 *                           status: { type: string }
 *                           remarks: { type: string }
 *                           actorName: { type: string }
 *                           actorRole: { type: string }
 *                           at: { type: string, format: date-time }
 *                           meta: { type: object, additionalProperties: true }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found (or not visible to this role)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/:id/timeline', validate({ params: mongoIdParamSchema() }), billController.getTimeline);

/**
 * @openapi
 * /bills/{id}:
 *   patch:
 *     tags: [Bills]
 *     summary: Update a Draft bill (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       description: Partial update — all fields from bill creation (except quotation) are optional here.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               invoiceNumber: { type: string }
 *               invoiceDate: { type: string, format: date }
 *               invoiceAmount: { type: number }
 *               taxableAmount: { type: number }
 *               gstAmount: { type: number }
 *               paymentTerms: { type: string }
 *               dueDate: { type: string, format: date }
 *               remarks: { type: string }
 *     responses:
 *       200:
 *         description: Bill updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill updated }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can edit a bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found, or it is no longer editable
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema(), body: updateBillSchema }),
  billController.update,
);

/**
 * @openapi
 * /bills/{id}/submit:
 *   patch:
 *     tags: [Bills]
 *     summary: Submit a Draft bill to Accounts — kicks off the AI 3-way verification pipeline (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bill submitted to Accounts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill submitted to Accounts }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *                     submittedAt: { type: string, format: date-time }
 *       400:
 *         description: An invoice PDF must be uploaded before submitting this bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can submit a bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found, or it is not in Draft status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/submit',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  billController.submit,
);

/**
 * @openapi
 * /bills/{id}/resubmit:
 *   patch:
 *     tags: [Bills]
 *     summary: Resubmit a bill returned for correction (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bill resubmitted to Accounts
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill resubmitted to Accounts }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *       400:
 *         description: An invoice PDF must be uploaded before resubmitting
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can resubmit a bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found or not in a resubmittable status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/resubmit',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  billController.resubmit,
);

// Recovery path for a Bill stuck at SUBMITTED with no linked PO at the time AI ran
// (see billService.retryAiVerification) — Director / Super Admin only.
/**
 * @openapi
 * /bills/{id}/retry-ai-verification:
 *   patch:
 *     tags: [Bills]
 *     summary: Retry AI verification for a Bill stuck at Submitted (Director / Super Admin only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: AI verification retried
 *         content: { application/json: { schema: { type: object, properties: { success: { type: boolean }, message: { type: string }, data: { type: object } } } } }
 *       400:
 *         description: No Purchase Order exists yet for this Bill's Quotation
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Director or Super Admin can retry AI verification
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found, or it is not stuck in Submitted status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/retry-ai-verification',
  authorize(ROLES.DIRECTOR, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  billController.retryAiVerification,
);

// Accounts-only — backend support for the next phase; no mobile UI yet.
/**
 * @openapi
 * /bills/{id}/decision:
 *   patch:
 *     tags: [Bills]
 *     summary: Accounts verification decision on a bill (Accounts only)
 *     description: Backend support for the next phase — no mobile UI yet.
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
 *             required: [decision]
 *             properties:
 *               decision: { type: string, enum: [verified, correction_requested, rejected] }
 *               remarks: { type: string, maxLength: 1000, description: Mandatory for correction_requested and rejected decisions }
 *     responses:
 *       200:
 *         description: Decision recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Decision recorded }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *       400:
 *         description: Validation failed (remarks required for non-verified decisions)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Accounts can decide on a bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found, or it is not awaiting Accounts verification
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/decision',
  authorize(ROLES.ACCOUNTS),
  validate({ params: mongoIdParamSchema(), body: billDecisionSchema }),
  billController.decide,
);

// Director Financial Approval (Approval 2 — after 3-Way AI, before Accounts).
/**
 * @openapi
 * /bills/{id}/financial-decision:
 *   patch:
 *     tags: [Bills]
 *     summary: Director Financial Approval decision on a bill (Director only) — Approval 2, after the AI 3-way match, before Accounts
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
 *             required: [decision]
 *             properties:
 *               decision: { type: string, enum: [approved, rejected, correction_required] }
 *               remarks: { type: string, maxLength: 2000, description: Mandatory for rejected and correction_required decisions }
 *     responses:
 *       200:
 *         description: Financial approval decision recorded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Financial approval decision recorded }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     directorFinancialDecision: { type: string, enum: [approved, rejected, correction_required] }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *       400:
 *         description: Validation failed (remarks required for non-approved decisions)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Director can make a financial approval decision on a bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found, or it is not awaiting Director Financial Approval
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/financial-decision',
  authorize(ROLES.DIRECTOR),
  validate({ params: mongoIdParamSchema(), body: billFinancialDecisionSchema }),
  billController.decideFinancialApproval,
);

// Payment Department-only — backend support for the future Payment module; no mobile UI yet.
/**
 * @openapi
 * /bills/{id}/payment-status:
 *   patch:
 *     tags: [Bills]
 *     summary: Update a bill's payment status (Payment Department only)
 *     description: Backend support for the future Payment module — no mobile UI yet.
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
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [payment_pending, paid, completed] }
 *     responses:
 *       200:
 *         description: Payment status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Payment status updated }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status:
 *                       type: string
 *                       enum: [draft, submitted, ai_verified, director_approved, director_rejected, director_correction, verified, correction_requested, rejected, payment_pending, paid, completed]
 *       400:
 *         description: Invalid payment status transition
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Payment Department can update a bill payment status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: Bill cannot transition to the requested status from its current status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/payment-status',
  authorize(ROLES.PAYMENT_DEPARTMENT),
  validate({ params: mongoIdParamSchema(), body: billPaymentStatusSchema }),
  billController.updatePaymentStatus,
);

/**
 * @openapi
 * /bills/{id}/invoice:
 *   post:
 *     tags: [Bills]
 *     summary: Upload the invoice PDF for a bill (Department User / HOD only) — each upload appends a new version
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary, description: Invoice PDF file }
 *     responses:
 *       200:
 *         description: Invoice PDF uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Invoice PDF uploaded }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     invoiceFiles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           version: { type: integer }
 *                           fileName: { type: string }
 *                           url: { type: string }
 *                           uploadedAt: { type: string, format: date-time }
 *       400:
 *         description: An invoice PDF file is required
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can upload a bill invoice
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/:id/invoice',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  uploadBillInvoice,
  billController.uploadInvoice,
);

/**
 * @openapi
 * /bills/{id}/supporting-documents:
 *   post:
 *     tags: [Bills]
 *     summary: Upload a supporting document PDF for a bill (Department User / HOD only) — each upload appends a new version
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file: { type: string, format: binary, description: Supporting document PDF file }
 *     responses:
 *       200:
 *         description: Supporting document uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Supporting document uploaded }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     supportingDocuments:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           version: { type: integer }
 *                           fileName: { type: string }
 *                           url: { type: string }
 *                           uploadedAt: { type: string, format: date-time }
 *       400:
 *         description: A supporting document PDF file is required
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can upload a bill supporting document
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/:id/supporting-documents',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  uploadBillSupportingDocument,
  billController.uploadSupportingDocument,
);

/**
 * @openapi
 * /bills/{id}:
 *   delete:
 *     tags: [Bills]
 *     summary: Delete a Draft bill (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Bill deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Bill deleted }
 *                 data: { nullable: true, example: null }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can delete a bill
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Bill not found, or only a Draft bill can be deleted
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete('/:id', authorize(ROLES.DEPARTMENT_USER, ROLES.HOD), validate({ params: mongoIdParamSchema() }), billController.remove);

export default router;
