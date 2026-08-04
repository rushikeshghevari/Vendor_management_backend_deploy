import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { vendorController } from '@/modules/vendor/vendor.controller';
import {
  createVendorSchema,
  updateVendorSchema,
  updateVendorStatusSchema,
  vendorListQuerySchema,
} from '@/modules/vendor/vendor.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();

router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Vendors
 *   description: Vendor registration and management (Department User / HOD only for writes)
 */

// Vendor registration belongs ONLY to Department Users — Super Admin must never create,
// edit, or delete a vendor (read access is still open below, for the Dashboard vendor count).
/**
 * @openapi
 * /vendors:
 *   post:
 *     tags: [Vendors]
 *     summary: Register a new vendor (Department User / HOD only)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name, contactPerson, phone, email, address, state, district, city, pincode, bankDetails, category]
 *             properties:
 *               name: { type: string, minLength: 2, maxLength: 150, example: Acme Supplies }
 *               contactPerson: { type: string, minLength: 2, maxLength: 150, example: John Doe }
 *               phone: { type: string, pattern: '^[6-9][0-9]{9}$', example: "9876543210" }
 *               email: { type: string, format: email, example: vendor@example.com }
 *               gstNumber: { type: string, example: 27ABCDE1234F1Z5, description: 15-char GSTIN (optional) }
 *               panNumber: { type: string, example: ABCDE1234F, description: 10-char PAN (optional) }
 *               address: { type: string }
 *               state: { type: string }
 *               district: { type: string }
 *               city: { type: string }
 *               pincode: { type: string, pattern: '^[1-9][0-9]{5}$', example: "400001" }
 *               bankDetails:
 *                 type: object
 *                 required: [bankName, accountHolderName, accountNumber, ifscCode]
 *                 properties:
 *                   bankName: { type: string }
 *                   accountHolderName: { type: string }
 *                   accountNumber: { type: string, minLength: 4, maxLength: 20 }
 *                   ifscCode: { type: string, pattern: '^[A-Z]{4}0[A-Z0-9]{6}$', example: HDFC0001234 }
 *                   upiId: { type: string, example: vendor@okhdfcbank }
 *               category: { type: string, example: Raw Materials }
 *               status: { type: string, enum: [active, inactive, blacklisted] }
 *     responses:
 *       201:
 *         description: Vendor registered
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Vendor created }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string, example: 665f1c2b9b1d4c1a2c8e4a10 }
 *                     name: { type: string }
 *                     code: { type: string, example: VEN-0001 }
 *                     department: { type: string }
 *                     createdBy: { type: string }
 *                     contactPerson: { type: string }
 *                     phone: { type: string }
 *                     email: { type: string }
 *                     gstNumber: { type: string, nullable: true }
 *                     panNumber: { type: string, nullable: true }
 *                     address: { type: string }
 *                     state: { type: string }
 *                     district: { type: string }
 *                     city: { type: string }
 *                     pincode: { type: string }
 *                     bankDetails:
 *                       type: object
 *                       properties:
 *                         bankName: { type: string }
 *                         accountHolderName: { type: string }
 *                         accountNumber: { type: string }
 *                         ifscCode: { type: string }
 *                         upiId: { type: string, nullable: true }
 *                     category: { type: string }
 *                     status: { type: string, enum: [active, inactive, blacklisted] }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can register a vendor
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.post(
  '/',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ body: createVendorSchema }),
  vendorController.create,
);

// Directors (and any other role) have no standalone access to the Vendor module — a
// Director only ever sees vendor information embedded inside a submitted Quotation.
/**
 * @openapi
 * /vendors:
 *   get:
 *     tags: [Vendors]
 *     summary: List vendors visible to the caller (paginated, filterable)
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, minimum: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, minimum: 1, maximum: 100 }
 *       - in: query
 *         name: department
 *         schema: { type: string }
 *         description: Department id (24-char hex)
 *       - in: query
 *         name: category
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, inactive, blacklisted] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Free-text search across name, code, contact person, email
 *     responses:
 *       200:
 *         description: Paginated list of vendors
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Vendors fetched }
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id: { type: string }
 *                       name: { type: string }
 *                       code: { type: string }
 *                       department: { type: string }
 *                       contactPerson: { type: string }
 *                       phone: { type: string }
 *                       email: { type: string }
 *                       category: { type: string }
 *                       status: { type: string, enum: [active, inactive, blacklisted] }
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
 *       403:
 *         description: Caller's role has no access to the Vendor module
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/',
  authorize(ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ query: vendorListQuerySchema }),
  vendorController.list,
);

/**
 * @openapi
 * /vendors/{id}:
 *   get:
 *     tags: [Vendors]
 *     summary: Get a single vendor by id
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Vendor found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Vendor fetched }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     code: { type: string }
 *                     department: { type: string }
 *                     createdBy: { type: string }
 *                     contactPerson: { type: string }
 *                     phone: { type: string }
 *                     email: { type: string }
 *                     gstNumber: { type: string, nullable: true }
 *                     panNumber: { type: string, nullable: true }
 *                     address: { type: string }
 *                     state: { type: string }
 *                     district: { type: string }
 *                     city: { type: string }
 *                     pincode: { type: string }
 *                     bankDetails:
 *                       type: object
 *                       properties:
 *                         bankName: { type: string }
 *                         accountHolderName: { type: string }
 *                         accountNumber: { type: string }
 *                         ifscCode: { type: string }
 *                         upiId: { type: string, nullable: true }
 *                     category: { type: string }
 *                     status: { type: string, enum: [active, inactive, blacklisted] }
 *                     createdAt: { type: string, format: date-time }
 *                     updatedAt: { type: string, format: date-time }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Caller's role has no access to the Vendor module
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Vendor not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.get(
  '/:id',
  // Director included so a `vendor_registered` notification (sent when they approve the
  // Requirement that finalized this vendor) can actually be opened — previously Director had
  // no authorization here at all, on top of no frontend navigation path to reach it.
  authorize(ROLES.SUPER_ADMIN, ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.DIRECTOR),
  validate({ params: mongoIdParamSchema() }),
  vendorController.getById,
);

/**
 * @openapi
 * /vendors/{id}:
 *   patch:
 *     tags: [Vendors]
 *     summary: Update a vendor's details (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: false
 *       description: Partial update — all fields from vendor creation are optional here.
 *       content:
 *         application/json:
 *           schema:
 *             type: object
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
 *               pincode: { type: string }
 *               bankDetails:
 *                 type: object
 *                 properties:
 *                   bankName: { type: string }
 *                   accountHolderName: { type: string }
 *                   accountNumber: { type: string }
 *                   ifscCode: { type: string }
 *                   upiId: { type: string }
 *               category: { type: string }
 *               status: { type: string, enum: [active, inactive, blacklisted] }
 *     responses:
 *       200:
 *         description: Vendor updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Vendor updated }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     name: { type: string }
 *                     status: { type: string, enum: [active, inactive, blacklisted] }
 *                     updatedAt: { type: string, format: date-time }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can update a vendor
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Vendor not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema(), body: updateVendorSchema }),
  vendorController.update,
);

/**
 * @openapi
 * /vendors/{id}/status:
 *   patch:
 *     tags: [Vendors]
 *     summary: Change a vendor's status (Department User / HOD only)
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
 *               status: { type: string, enum: [active, inactive, blacklisted] }
 *     responses:
 *       200:
 *         description: Vendor status updated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Vendor status updated }
 *                 data:
 *                   type: object
 *                   properties:
 *                     id: { type: string }
 *                     status: { type: string, enum: [active, inactive, blacklisted] }
 *       400:
 *         description: Validation failed
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can change a vendor status
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Vendor not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.patch(
  '/:id/status',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema(), body: updateVendorStatusSchema }),
  vendorController.setStatus,
);

/**
 * @openapi
 * /vendors/{id}:
 *   delete:
 *     tags: [Vendors]
 *     summary: Deactivate (soft-delete) a vendor (Department User / HOD only)
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Vendor deactivated
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: Vendor deactivated }
 *                 data: { nullable: true, example: null }
 *       401:
 *         description: Missing, invalid, or expired access token
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       403:
 *         description: Only a Department User or HOD can delete a vendor
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 *       404:
 *         description: Vendor not found
 *         content: { application/json: { schema: { $ref: '#/components/schemas/ApiError' } } }
 */
router.delete(
  '/:id',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema() }),
  vendorController.remove,
);

export default router;
