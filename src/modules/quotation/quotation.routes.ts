import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { uploadQuotationPdf } from '@/middleware/upload.middleware';
import { validate } from '@/middleware/validate.middleware';
import { quotationController } from '@/modules/quotation/quotation.controller';
import {
  createQuotationSchema,
  decisionSchema,
  quotationListQuerySchema,
  updateQuotationSchema,
} from '@/modules/quotation/quotation.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Quotations
 *   description: Vendor quotations — creation, submission, negotiation, and Director/CEO approval
 */

/**
 * @openapi
 * /quotations:
 *   post:
 *     tags: [Quotations]
 *     summary: Create a draft quotation (Department User / HOD only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [vendor, quotationDate, requiredDate, amount, gst, paymentTerms, deliveryTerms]
 *             properties:
 *               vendor: { type: string, description: Vendor id (24-char hex), example: 665f1c2b9b1d4c1a2c8e4a10 }
 *               quotationDate: { type: string, format: date }
 *               requiredDate: { type: string, format: date }
 *               amount: { type: number, minimum: 0.01, example: 25000 }
 *               gst: { type: number, minimum: 0, maximum: 100, example: 18 }
 *               currency: { type: string, enum: [INR, USD, EUR, GBP], default: INR }
 *               paymentTerms: { type: string, example: "Net 30" }
 *               deliveryTerms: { type: string, example: "FOB destination" }
 *               priority: { type: string, enum: [low, medium, high, urgent], default: medium }
 *               description: { type: string, maxLength: 2000 }
 *               remarks: { type: string, maxLength: 1000 }
 *     responses:
 *       201:
 *         description: Quotation created in Draft status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Quotation created }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     quotationCode: { type: string, example: QTN-0001 }
 *                     vendor: { type: string }
 *                     department: { type: string }
 *                     createdBy: { type: string }
 *                     quotationDate: { type: string, format: date-time }
 *                     requiredDate: { type: string, format: date-time }
 *                     amount: { type: number }
 *                     gst: { type: number }
 *                     currency: { type: string, enum: [INR, USD, EUR, GBP] }
 *                     paymentTerms: { type: string }
 *                     deliveryTerms: { type: string }
 *                     priority: { type: string, enum: [low, medium, high, urgent] }
 *                     description: { type: string }
 *                     status: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
 *                     createdAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed, vendor not found, or vendor not Active
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can create a quotation (or vendor is outside caller's own department/registrations)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ body: createQuotationSchema }),
  quotationController.create,
);

/**
 * @openapi
 * /quotations:
 *   get:
 *     tags: [Quotations]
 *     summary: List quotations visible to the caller (paginated, filterable)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *       - in: query
 *         name: vendor
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of quotations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Quotations fetched }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       quotationCode: { type: string }
 *                       vendor: { type: string }
 *                       department: { type: string }
 *                       amount: { type: number }
 *                       currency: { type: string, enum: [INR, USD, EUR, GBP] }
 *                       priority: { type: string, enum: [low, medium, high, urgent] }
 *                       status: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
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
router.get('/', validate({ query: quotationListQuerySchema }), quotationController.list);

// Must be registered before the `/:id` route below, or "stats" would be parsed as an id.
/**
 * @openapi
 * /quotations/stats/director:
 *   get:
 *     tags: [Quotations]
 *     summary: Director dashboard stats — quotations pending this Director's decision, plus counts by status
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
 *                   description: Aggregate counts of quotations by status, scoped to those awaiting or decided by this Director.
 *                   additionalProperties: true
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Director can view the Director dashboard
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/director', authorize(ROLES.DIRECTOR), quotationController.directorStats);

/**
 * @openapi
 * /quotations/stats/ceo:
 *   get:
 *     tags: [Quotations]
 *     summary: CEO dashboard stats — quotations above the CEO Approval Limit, plus counts by status
 *     responses:
 *       200:
 *         description: CEO dashboard stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: CEO dashboard stats fetched }
 *                 data:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only the CEO or Super Admin can view the CEO dashboard stats
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/ceo', authorize(ROLES.CEO, ROLES.SUPER_ADMIN), quotationController.ceoStats);

/**
 * @openapi
 * /quotations/stats/super-admin:
 *   get:
 *     tags: [Quotations]
 *     summary: Super Admin dashboard stats — org-wide quotation totals
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Stats fetched
 *       403:
 *         description: Only Super Admin can view this dashboard
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats/super-admin', authorize(ROLES.SUPER_ADMIN), quotationController.superAdminStats);

/**
 * @openapi
 * /quotations/{id}:
 *   get:
 *     tags: [Quotations]
 *     summary: Get a single quotation by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Quotation found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Quotation fetched }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     quotationCode: { type: string }
 *                     vendor: { type: string }
 *                     department: { type: string }
 *                     createdBy: { type: string }
 *                     quotationDate: { type: string, format: date-time }
 *                     requiredDate: { type: string, format: date-time }
 *                     amount: { type: number }
 *                     gst: { type: number }
 *                     currency: { type: string, enum: [INR, USD, EUR, GBP] }
 *                     paymentTerms: { type: string }
 *                     deliveryTerms: { type: string }
 *                     priority: { type: string, enum: [low, medium, high, urgent] }
 *                     description: { type: string }
 *                     pdfFiles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           version: { type: integer }
 *                           fileName: { type: string }
 *                           url: { type: string }
 *                           uploadedAt: { type: string, format: date-time }
 *                     remarks: { type: string }
 *                     directorRemarks: { type: string, nullable: true }
 *                     directorApprovals:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           director: { type: string }
 *                           decision: { type: string, enum: [approved, negotiation, rejected] }
 *                           remarks: { type: string }
 *                           decidedAt: { type: string, format: date-time }
 *                     status: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
 *                     submittedAt: { type: string, format: date-time, nullable: true }
 *                     decisionAt: { type: string, format: date-time, nullable: true }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/:id', validate({ params: mongoIdParamSchema() }), quotationController.getById);

/**
 * @openapi
 * /quotations/{id}:
 *   patch:
 *     tags: [Quotations]
 *     summary: Update a Draft quotation (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       description: Partial update — all fields from quotation creation are optional here.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               vendor: { type: string }
 *               quotationDate: { type: string, format: date }
 *               requiredDate: { type: string, format: date }
 *               amount: { type: number }
 *               gst: { type: number }
 *               currency: { type: string, enum: [INR, USD, EUR, GBP] }
 *               paymentTerms: { type: string }
 *               deliveryTerms: { type: string }
 *               priority: { type: string, enum: [low, medium, high, urgent] }
 *               description: { type: string }
 *               remarks: { type: string }
 *     responses:
 *       200:
 *         description: Quotation updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Quotation updated }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can edit a quotation
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found, or no longer editable (not in Draft)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema(), body: updateQuotationSchema }),
  quotationController.update,
);

/**
 * @openapi
 * /quotations/{id}/submit:
 *   patch:
 *     tags: [Quotations]
 *     summary: Submit a Draft quotation for Director/CEO approval (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Quotation submitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Quotation submitted }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
 *                     submittedAt: { type: string, format: date-time }
 *       400:
 *         description: No active CEO available, or two active Directors are required before submission
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can submit a quotation
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found, or it is not in Draft status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/submit',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  quotationController.submit,
);

/**
 * @openapi
 * /quotations/{id}/resubmit:
 *   patch:
 *     tags: [Quotations]
 *     summary: Resubmit a quotation that was returned for Negotiation (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Quotation resubmitted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Quotation resubmitted }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can resubmit a quotation
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found, or it is not in Negotiation status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/resubmit',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  quotationController.resubmit,
);

// Director or CEO — which one is actually authorized for a given quotation is resolved
// inside quotationService.decide() by amount vs the CEO Approval Limit.
/**
 * @openapi
 * /quotations/{id}/decision:
 *   patch:
 *     tags: [Quotations]
 *     summary: Approve, reject, or send a submitted quotation to Negotiation (Director or CEO)
 *     description: >
 *       Whether a Director or the CEO is actually authorized to decide on this specific
 *       quotation is resolved server-side by comparing the quotation amount against the
 *       CEO Approval Limit.
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
 *               decision: { type: string, enum: [negotiation, approved, rejected] }
 *               remarks: { type: string, maxLength: 1000, description: Mandatory for negotiation and rejected decisions }
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
 *                     status: { type: string, enum: [draft, submitted, negotiation, resubmitted, approved, rejected, billed] }
 *                     decisionAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed (remarks required for non-approved decisions)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller is not the Director/CEO authorized to decide on this quotation given its amount vs the CEO Approval Limit
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found, or it is no longer open for a decision
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/decision',
  authorize(ROLES.DIRECTOR, ROLES.CEO),
  validate({ params: mongoIdParamSchema(), body: decisionSchema }),
  quotationController.decide,
);

/**
 * @openapi
 * /quotations/{id}/pdf:
 *   post:
 *     tags: [Quotations]
 *     summary: Upload a quotation PDF (Department User / HOD only) — each upload appends a new version
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
 *               file: { type: string, format: binary, description: PDF file }
 *     responses:
 *       200:
 *         description: PDF uploaded
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: PDF uploaded }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     pdfFiles:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           version: { type: integer }
 *                           fileName: { type: string }
 *                           url: { type: string }
 *                           uploadedAt: { type: string, format: date-time }
 *       400:
 *         description: A PDF file is required
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can upload a quotation PDF
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/:id/pdf',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  uploadQuotationPdf,
  quotationController.uploadPdf,
);

/**
 * @openapi
 * /quotations/{id}:
 *   delete:
 *     tags: [Quotations]
 *     summary: Delete a Draft quotation (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Quotation deleted
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Quotation deleted }
 *                 data: { nullable: true, example: null }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can delete a quotation
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found, or only a Draft quotation can be deleted
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete(
  '/:id',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  quotationController.remove,
);

export default router;
