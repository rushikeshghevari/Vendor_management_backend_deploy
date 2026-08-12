import { Router } from 'express';
import { z } from 'zod';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { uploadQuotationAttachment } from '@/middleware/upload.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { requirementController } from '@/modules/requirement/requirement.controller';
import { createRequirementQuotationSchema, quotationListQuerySchema } from '@/modules/quotation/quotation.validation';
import {
  createRequirementSchema,
  requirementListQuerySchema,
  updateRequirementSchema,
} from '@/modules/requirement/requirement.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Requirements
 *   description: >
 *     Phase 1 of the Enterprise Procurement Workflow — the new starting point of the
 *     procurement flow (Department User raises a Requirement before any Vendor or
 *     Quotation exists). Create/edit/delete are Department User (own) or Super Admin
 *     (any); HOD and Director have read-only visibility.
 */

/**
 * @openapi
 * /requirements:
 *   post:
 *     tags: [Requirements]
 *     summary: Create a requirement (Draft status) — Department User or Super Admin only
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, budget, requiredDate, items]
 *             properties:
 *               title: { type: string, minLength: 2, example: "Office laptops — Q3" }
 *               description: { type: string, maxLength: 2000 }
 *               priority: { type: string, enum: [low, medium, high, urgent], default: medium }
 *               budget: { type: number, minimum: 0.01 }
 *               requiredDate: { type: string, format: date }
 *               remarks: { type: string, maxLength: 1000 }
 *               items:
 *                 type: array
 *                 minItems: 1
 *                 items:
 *                   type: object
 *                   required: [itemName, quantity, unit, estimatedRate]
 *                   properties:
 *                     itemName: { type: string }
 *                     specification: { type: string }
 *                     quantity: { type: number, minimum: 0.01 }
 *                     unit: { type: string, example: "pcs" }
 *                     estimatedRate: { type: number, minimum: 0 }
 *                     estimatedAmount: { type: number, minimum: 0, description: "Auto-computed as quantity * estimatedRate if omitted" }
 *                     remarks: { type: string }
 *     responses:
 *       201: { description: Requirement created }
 *       400: { description: Validation failed, content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } } }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User or Super Admin }
 */
router.post(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER),
  validate({ body: createRequirementSchema }),
  requirementController.create,
);

/**
 * @openapi
 * /requirements:
 *   get:
 *     tags: [Requirements]
 *     summary: List requirements, scoped by role (Department User sees their own; HOD sees their department; Director/Super Admin see all)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: priority
 *         schema: { type: string, enum: [low, medium, high, urgent] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Matches against requirement number or title
 *     responses:
 *       200: { description: Paginated list of requirements }
 *       401: { description: Missing or invalid access token }
 */
router.get('/', validate({ query: requirementListQuerySchema }), requirementController.list);

/**
 * @openapi
 * /requirements/{id}:
 *   get:
 *     tags: [Requirements]
 *     summary: Get a single requirement by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Requirement found }
 *       400: { description: Invalid id format }
 *       401: { description: Missing or invalid access token }
 *       404: { description: Requirement not found }
 */
router.get('/:id', validate({ params: mongoIdParamSchema() }), requirementController.getById);

/**
 * @openapi
 * /requirements/{id}:
 *   put:
 *     tags: [Requirements]
 *     summary: Edit a requirement — only while it is still in Draft status, and only by its creator or Super Admin
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, description: "Same shape as POST /requirements, all fields optional" }
 *     responses:
 *       200: { description: Requirement updated }
 *       400: { description: Validation failed }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User or Super Admin }
 *       404: { description: Requirement not found, or it is no longer editable }
 */
router.put(
  '/:id',
  authorize(ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER),
  validate({ params: mongoIdParamSchema(), body: updateRequirementSchema }),
  requirementController.update,
);

/**
 * @openapi
 * /requirements/{id}:
 *   delete:
 *     tags: [Requirements]
 *     summary: Delete a requirement — soft delete, only while it is still in Draft status, and only by its creator or Super Admin
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Requirement deleted }
 *       400: { description: Invalid id format }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User or Super Admin }
 *       404: { description: Requirement not found, or only a Draft requirement can be deleted }
 */
router.delete(
  '/:id',
  authorize(ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER),
  validate({ params: mongoIdParamSchema() }),
  requirementController.remove,
);

/**
 * @openapi
 * /requirements/{id}/submit:
 *   patch:
 *     tags: [Requirements]
 *     summary: Submit a Draft requirement for review — notifies the department's HOD and all Super Admins
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Requirement submitted }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User or Super Admin }
 *       404: { description: Requirement not found, or it is not in Draft status }
 */
router.patch(
  '/:id/submit',
  authorize(ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER),
  validate({ params: mongoIdParamSchema() }),
  requirementController.submit,
);

/**
 * @openapi
 * /requirements/{id}/submit-to-director:
 *   patch:
 *     tags: [Requirements]
 *     summary: >
 *       The Department User or HOD currently working the requirement (its own department, or
 *       the receiving department if routed in) hands it over to the Director — the only way a
 *       requirement enters Director Review. Locks further quotation uploads and notifies all
 *       active Directors + Super Admins. Reachable again after a Director's "Send Back"
 *       decision returns the requirement to Quotation Collection (unlimited cycles).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Requirement submitted to Director }
 *       400: { description: No quotation has been added to this requirement yet }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User, HOD, or Super Admin with write access to this requirement }
 *       404: { description: Requirement not found, or it is not currently collecting quotations }
 */
router.patch(
  '/:id/submit-to-director',
  // HOD included alongside Department User — see requirementService.submitToDirector's own
  // departmentWriteFilter for why: HOD may submit a requirement routed into their department,
  // same as they can already add quotations to it.
  authorize(ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  requirementController.submitToDirector,
);

router.get(
  '/:id/quotations',
  validate({ params: mongoIdParamSchema(), query: quotationListQuerySchema.partial() }),
  requirementController.listQuotations,
);

router.post(
  '/:id/quotations',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema(), body: createRequirementQuotationSchema }),
  requirementController.createQuotation,
);

/**
 * @openapi
 * /requirements/{id}/quotations/{quotationId}/attachments:
 *   post:
 *     tags: [Requirements]
 *     summary: >
 *       Upload a PDF/PNG/JPG attachment to a requirement-linked quotation. Rejects an
 *       exact duplicate of an already-uploaded file, then automatically starts OCR
 *       processing on the new attachment in the background (Phase 3).
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: quotationId
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
 *               file: { type: string, format: binary, description: "PDF, PNG, or JPG, max 10MB" }
 *     responses:
 *       200: { description: Attachment uploaded; OCR started in the background }
 *       400: { description: Invalid file type/size, or this exact file was already uploaded }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User or HOD }
 *       404: { description: Quotation not found, or it is no longer editable }
 */
router.post(
  '/:id/quotations/:quotationId/attachments',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
    quotationId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
  }) }),
  uploadQuotationAttachment,
  requirementController.uploadQuotationAttachment,
);

/**
 * @openapi
 * /requirements/{id}/quotations/{quotationId}/ocr/retry:
 *   post:
 *     tags: [Requirements]
 *     summary: >
 *       Re-run OCR extraction against a quotation's latest attachment (Phase 3). Sets
 *       `ocr.status` to "processing" immediately; the result lands asynchronously and is
 *       readable via GET /quotations/{quotationId}.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: path
 *         name: quotationId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: OCR retry started }
 *       400: { description: This quotation has no attachment to run OCR against }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User, HOD, or Super Admin }
 *       404: { description: Quotation not found, or not visible to the caller }
 */
router.post(
  '/:id/quotations/:quotationId/ocr/retry',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN),
  validate({ params: z.object({
    id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
    quotationId: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id'),
  }) }),
  requirementController.retryOcr,
);

export default router;
