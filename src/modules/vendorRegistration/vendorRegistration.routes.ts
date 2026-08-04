import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { uploadVendorDocuments } from '@/middleware/upload.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { vendorRegistrationController } from '@/modules/vendorRegistration/vendorRegistration.controller';
import { linkExistingVendorSchema, registerVendorSchema } from '@/modules/vendorRegistration/vendorRegistration.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Vendor Registration
 *   description: >
 *     Phase 6 of the Enterprise Procurement Workflow — the only way a Vendor can be created
 *     from a Requirement (Approved Requirement + its AI Comparison + its Director Review).
 *     Manual vendor creation for this pipeline is not allowed; the pre-existing generic
 *     POST /vendors endpoint (used by the standalone Quotation flow) is untouched by this
 *     module. Department User (own) / Super Admin can register; HOD and Director are
 *     read-only.
 */

/**
 * @openapi
 * /requirements/{id}/vendor-registration:
 *   get:
 *     tags: [Vendor Registration]
 *     summary: Get the vendor already registered for this requirement, if any
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Registered vendor found }
 *       401: { description: Missing or invalid access token }
 *       404: { description: Requirement not found, or no vendor has been registered for it yet }
 */
router.get(
  '/:id/vendor-registration',
  // Read-only pipeline visibility (additive) — CEO/Accounts/Payment Department never gain
  // any write access here, only GET.
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.DIRECTOR, ROLES.SUPER_ADMIN, ROLES.CEO, ROLES.ACCOUNTS, ROLES.PAYMENT_DEPARTMENT),
  validate({ params: mongoIdParamSchema() }),
  vendorRegistrationController.getRegisteredVendor,
);

/**
 * @openapi
 * /requirements/{id}/vendor-registration/status:
 *   get:
 *     tags: [Vendor Registration]
 *     summary: >
 *       Check whether the Director-approved winning quotation's vendor is already registered
 *       in the system (by a direct vendor reference, or by matching email/phone against the
 *       Vendor collection) — used to skip Register/Generate Link when it already exists.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Vendor status checked }
 *       400: { description: Requirement is not yet Director-approved }
 *       401: { description: Missing or invalid access token }
 *       404: { description: Requirement not found }
 */
router.get(
  '/:id/vendor-registration/status',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.DIRECTOR, ROLES.SUPER_ADMIN, ROLES.CEO, ROLES.ACCOUNTS, ROLES.PAYMENT_DEPARTMENT),
  validate({ params: mongoIdParamSchema() }),
  vendorRegistrationController.checkVendorStatus,
);

/**
 * @openapi
 * /requirements/{id}/vendor-registration/link-existing:
 *   post:
 *     tags: [Vendor Registration]
 *     summary: >
 *       Finalize this requirement against a Vendor that already exists — either the
 *       auto-detected match (per GET .../vendor-registration/status) or any active vendor the
 *       caller picked manually from the full Vendor list ("Show Vendors") — instead of
 *       registering a duplicate. Sets Requirement.status = vendor_finalized, same as a fresh
 *       registration.
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
 *             required: [vendorId]
 *             properties:
 *               vendorId: { type: string }
 *     responses:
 *       200: { description: Vendor linked; requirement advanced to vendor_finalized }
 *       400: { description: Requirement is not Director-approved, or vendorId does not refer to an existing vendor }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User or Super Admin }
 *       404: { description: Requirement not found }
 *       409: { description: A vendor was already registered/linked for this requirement }
 */
router.post(
  '/:id/vendor-registration/link-existing',
  authorize(ROLES.DEPARTMENT_USER, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema(), body: linkExistingVendorSchema }),
  vendorRegistrationController.linkExistingVendor,
);

/**
 * @openapi
 * /requirements/{id}/vendor-registration:
 *   post:
 *     tags: [Vendor Registration]
 *     summary: >
 *       Register a vendor from an Approved requirement — reads the AI Comparison's
 *       recommended (winning) quotation and the Director Review's approval server-side;
 *       the winning quotation is never accepted from the client. Sets
 *       Requirement.status = vendor_finalized on success.
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
 *             required: [name, contactPerson, phone, email, address, state, district, city, pincode, bankName, accountHolderName, accountNumber, ifscCode]
 *             properties:
 *               name: { type: string }
 *               contactPerson: { type: string }
 *               phone: { type: string }
 *               email: { type: string, format: email }
 *               gstNumber: { type: string }
 *               panNumber: { type: string }
 *               address: { type: string }
 *               state: { type: string }
 *               district: { type: string }
 *               city: { type: string }
 *               country: { type: string, default: India }
 *               pincode: { type: string }
 *               bankName: { type: string }
 *               accountHolderName: { type: string }
 *               accountNumber: { type: string }
 *               ifscCode: { type: string }
 *               upiId: { type: string }
 *               category: { type: string }
 *               gstCertificate: { type: string, format: binary }
 *               panCard: { type: string, format: binary }
 *               cancelledCheque: { type: string, format: binary }
 *               msmeCertificate: { type: string, format: binary, description: Optional }
 *     responses:
 *       201: { description: Vendor registered; requirement advanced to vendor_finalized }
 *       400: { description: Requirement is not Director-approved, has no comparison, or validation failed }
 *       401: { description: Missing or invalid access token }
 *       403: { description: Caller is not a Department User or Super Admin }
 *       404: { description: Requirement not found }
 *       409: { description: A vendor was already registered for this requirement, or a duplicate GST/PAN/email exists }
 */
router.post(
  '/:id/vendor-registration',
  authorize(ROLES.DEPARTMENT_USER, ROLES.SUPER_ADMIN),
  validate({ params: mongoIdParamSchema() }),
  uploadVendorDocuments,
  validate({ body: registerVendorSchema }),
  vendorRegistrationController.register,
);

export default router;
