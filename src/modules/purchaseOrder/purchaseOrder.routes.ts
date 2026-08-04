import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { purchaseOrderController } from '@/modules/purchaseOrder/purchaseOrder.controller';
import { createPurchaseOrderSchema, emailPurchaseOrderSchema, poListQuerySchema } from '@/modules/purchaseOrder/purchaseOrder.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Purchase Orders
 *   description: Purchase Order generation from an Approved Quotation, listing, PDF download, and AI (3-way match) verification
 */

// Stats — must be before /:id to avoid "stats" being parsed as an id
/**
 * @openapi
 * /purchase-orders/stats:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: Purchase Order dashboard stats — counts by status, scoped to the caller
 *     responses:
 *       200:
 *         description: Purchase Order stats
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Purchase Order stats fetched }
 *                 data:
 *                   type: object
 *                   additionalProperties: true
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/stats', purchaseOrderController.stats);

// Get PO by Quotation ID (used by mobile to check if PO exists for a quotation)
/**
 * @openapi
 * /purchase-orders/by-quotation/{quotationId}:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: Get the Purchase Order generated for a given Quotation, if any
 *     description: Used by the mobile app to check whether a PO already exists for a Quotation.
 *     parameters:
 *       - in: path
 *         name: quotationId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Purchase Order found, or null if none exists yet for this Quotation
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Purchase Order fetched }
 *                 data:
 *                   nullable: true
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     poNumber: { type: string, example: PO-0001 }
 *                     status: { type: string, enum: [generated, bill_uploaded, ai_verification_pending, ai_verified, accounts_verified, payment_pending, paid, closed] }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/by-quotation/:quotationId',
  validate({ params: mongoIdParamSchema('quotationId') }),
  purchaseOrderController.getByQuotation,
);

/**
 * @openapi
 * /purchase-orders/by-requirement/{requirementId}:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: Get the Purchase Order generated for a given Requirement, if any (Phase 7)
 *     description: Used by the mobile app to check whether a PO already exists for a vendor_finalized Requirement.
 *     parameters:
 *       - in: path
 *         name: requirementId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Purchase Order found, or null if none exists yet for this Requirement
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Purchase Order fetched }
 *                 data:
 *                   nullable: true
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     poNumber: { type: string }
 *                     requirementNumber: { type: string }
 *                     status: { type: string, enum: [generated, bill_uploaded, ai_verification_pending, ai_verified, accounts_verified, payment_pending, paid, closed] }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/by-requirement/:requirementId',
  validate({ params: mongoIdParamSchema('requirementId') }),
  purchaseOrderController.getByRequirement,
);

/**
 * @openapi
 * /purchase-orders:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: List Purchase Orders visible to the caller (paginated, filterable)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [generated, bill_uploaded, ai_verification_pending, ai_verified, accounts_verified, payment_pending, paid, closed] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *       - in: query
 *         name: vendorId
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Paginated list of Purchase Orders
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Purchase Orders fetched }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       poNumber: { type: string }
 *                       poDate: { type: string, format: date-time }
 *                       quotation: { type: string }
 *                       vendorName: { type: string }
 *                       grandTotal: { type: number }
 *                       status: { type: string, enum: [generated, bill_uploaded, ai_verification_pending, ai_verified, accounts_verified, payment_pending, paid, closed] }
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
router.get('/', validate({ query: poListQuerySchema }), purchaseOrderController.list);

// Department User, HOD, and Super Admin can generate POs
/**
 * @openapi
 * /purchase-orders:
 *   post:
 *     tags: [Purchase Orders]
 *     summary: >
 *       Generate a Purchase Order — either from an Approved Quotation (original flow) or
 *       from a vendor_finalized Requirement (Phase 7). Provide exactly one of
 *       quotationId/requirementId. (Department User / HOD / Super Admin)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               quotationId: { type: string, description: Approved Quotation id — exactly one of quotationId/requirementId must be provided }
 *               requirementId: { type: string, description: A vendor_finalized Requirement id — the registered Vendor's winning quotation is used automatically }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [itemName, quantity, unitPrice, total]
 *                   properties:
 *                     itemName: { type: string }
 *                     description: { type: string }
 *                     quantity: { type: number, minimum: 0.01 }
 *                     unitPrice: { type: number, minimum: 0 }
 *                     gstRate: { type: number, minimum: 0, maximum: 100, default: 0 }
 *                     gstAmount: { type: number, minimum: 0, default: 0 }
 *                     taxAmount: { type: number, minimum: 0, default: 0 }
 *                     discount: { type: number, minimum: 0, default: 0 }
 *                     total: { type: number, minimum: 0 }
 *               terms: { type: string }
 *               notes: { type: string }
 *     responses:
 *       201:
 *         description: Purchase Order generated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Purchase Order generated successfully }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     poNumber: { type: string, example: PO-0001 }
 *                     poDate: { type: string, format: date-time }
 *                     quotation: { type: string }
 *                     quotationCode: { type: string }
 *                     vendor: { type: string }
 *                     vendorName: { type: string }
 *                     vendorGst: { type: string }
 *                     vendorAddress: { type: string }
 *                     department: { type: string }
 *                     departmentName: { type: string }
 *                     createdBy: { type: string }
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           itemName: { type: string }
 *                           description: { type: string }
 *                           quantity: { type: number }
 *                           unitPrice: { type: number }
 *                           gstRate: { type: number }
 *                           gstAmount: { type: number }
 *                           taxAmount: { type: number }
 *                           discount: { type: number }
 *                           total: { type: number }
 *                     subtotal: { type: number }
 *                     totalGst: { type: number }
 *                     totalTax: { type: number }
 *                     totalDiscount: { type: number }
 *                     grandTotal: { type: number }
 *                     terms: { type: string }
 *                     notes: { type: string }
 *                     status: { type: string, enum: [generated, bill_uploaded, ai_verification_pending, ai_verified, accounts_verified, payment_pending, paid, closed] }
 *                     createdAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed, or Quotation is not in Approved status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User, HOD, or Super Admin can generate Purchase Orders
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Quotation not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       409:
 *         description: A Purchase Order already exists for this Quotation
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ body: createPurchaseOrderSchema }),
  purchaseOrderController.create,
);

/**
 * @openapi
 * /purchase-orders/{id}:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: Get a single Purchase Order by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Purchase Order found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Purchase Order fetched }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     poNumber: { type: string }
 *                     poDate: { type: string, format: date-time }
 *                     quotation: { type: string }
 *                     quotationCode: { type: string }
 *                     vendor: { type: string }
 *                     vendorName: { type: string }
 *                     department: { type: string }
 *                     items:
 *                       type: array
 *                       items:
 *                         type: object
 *                         properties:
 *                           itemName: { type: string }
 *                           quantity: { type: number }
 *                           unitPrice: { type: number }
 *                           total: { type: number }
 *                     subtotal: { type: number }
 *                     totalGst: { type: number }
 *                     totalTax: { type: number }
 *                     totalDiscount: { type: number }
 *                     grandTotal: { type: number }
 *                     status: { type: string, enum: [generated, bill_uploaded, ai_verification_pending, ai_verified, accounts_verified, payment_pending, paid, closed] }
 *                     bill: { type: string, nullable: true }
 *                     aiVerification:
 *                       type: object
 *                       nullable: true
 *                       properties:
 *                         matchPercentage: { type: number }
 *                         quotationMatch: { type: number }
 *                         purchaseOrderMatch: { type: number }
 *                         risk: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                         recommendation: { type: string, enum: [APPROVE, MANUAL_REVIEW, REJECT] }
 *                         confidence: { type: number }
 *                         summary: { type: string }
 *                         differences:
 *                           type: array
 *                           items:
 *                             type: object
 *                             properties:
 *                               field: { type: string }
 *                               purchaseOrder: {}
 *                               bill: {}
 *                               difference: { type: string }
 *                               severity: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                         ruleEngineScore: { type: number }
 *                         verifiedAt: { type: string, format: date-time }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Purchase Order not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get('/:id', validate({ params: mongoIdParamSchema() }), purchaseOrderController.getById);

// Accounts / Super Admin trigger AI verification on demand
/**
 * @openapi
 * /purchase-orders/{id}/verify:
 *   post:
 *     tags: [Purchase Orders]
 *     summary: Trigger AI (3-way match) verification of the Purchase Order against its linked Bill (Accounts / Super Admin / Director)
 *     description: >
 *       Runs the Rule Engine + Gemini-based 3-way match (Quotation + Purchase Order + Bill)
 *       and persists the resulting `aiVerification` result on the Purchase Order.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: AI Verification completed
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: AI Verification completed }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status: { type: string, enum: [generated, bill_uploaded, ai_verification_pending, ai_verified, accounts_verified, payment_pending, paid, closed] }
 *                     aiVerification:
 *                       type: object
 *                       properties:
 *                         matchPercentage: { type: number }
 *                         risk: { type: string, enum: [LOW, MEDIUM, HIGH] }
 *                         recommendation: { type: string, enum: [APPROVE, MANUAL_REVIEW, REJECT] }
 *                         confidence: { type: number }
 *                         summary: { type: string }
 *                         verifiedAt: { type: string, format: date-time }
 *       400:
 *         description: No Bill is linked to this Purchase Order yet
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only Accounts, Super Admin, or Director can trigger AI verification
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Purchase Order not found, or the linked Bill was not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/:id/verify',
  authorize(ROLES.ACCOUNTS, ROLES.SUPER_ADMIN, ROLES.DIRECTOR),
  validate({ params: mongoIdParamSchema() }),
  purchaseOrderController.triggerAiVerification,
);

// Download PO PDF
/**
 * @openapi
 * /purchase-orders/{id}/pdf:
 *   get:
 *     tags: [Purchase Orders]
 *     summary: Download the Purchase Order as a generated PDF file
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: PDF file stream
 *         content:
 *           application/pdf:
 *             schema: { type: string, format: binary }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Purchase Order not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/:id/pdf',
  validate({ params: mongoIdParamSchema() }),
  purchaseOrderController.downloadPdf,
);

// Audit-only — records that a PO was shared (PDF / Email / WhatsApp / Print all happen
// on-device via the OS share sheet; there is nothing server-side to actually "send").
/**
 * @openapi
 * /purchase-orders/{id}/share:
 *   post:
 *     tags: [Purchase Orders]
 *     summary: Record that a Purchase Order was shared (PDF / Email / WhatsApp / Print) — audit only
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               channel: { type: string, example: whatsapp, description: Free-form — whichever share target the OS sheet reports, if any }
 *     responses:
 *       200:
 *         description: Share recorded
 *         content: { application/json: { schema: { type: object, properties: { success: { type: boolean }, message: { type: string }, data: { nullable: true } } } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Purchase Order not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/:id/share',
  validate({ params: mongoIdParamSchema() }),
  purchaseOrderController.share,
);

/**
 * @openapi
 * /purchase-orders/{id}/email:
 *   post:
 *     tags: [Purchase Orders]
 *     summary: >
 *       Email the generated Purchase Order PDF to the vendor (Phase 7). Unlike /share,
 *       this actually sends an email via SMTP. Never fails the request if SMTP isn't
 *       configured or the send fails — check `data.sent` in the response.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               recipientEmail: { type: string, format: email, description: Overrides the vendor's email on file, if provided }
 *     responses:
 *       200:
 *         description: Email attempt recorded — `data.sent` reflects whether it was actually sent
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Purchase Order emailed to vendor }
 *                 data:
 *                   type: object
 *                   properties:
 *                     sent: { type: boolean }
 *                     reason: { type: string, nullable: true, example: SMTP not configured }
 *                     recipientEmail: { type: string }
 *       400:
 *         description: Validation failed, or no recipient email is available (vendor has none on file and none was provided)
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User, HOD, or Super Admin can email a Purchase Order
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Purchase Order not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/:id/email',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: emailPurchaseOrderSchema }),
  purchaseOrderController.emailToVendor,
);

export default router;
