import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { uploadVendorDocuments } from '@/middleware/upload.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { vendorRegistrationLinkController } from '@/modules/vendorRegistrationLink/vendorRegistrationLink.controller';
import { registerVendorSchema, tokenParamSchema } from '@/modules/vendorRegistrationLink/vendorRegistrationLink.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

// Authenticated routes — mounted at `/requirements`, same convention as vendorRegistration.routes.ts.
const router = Router();
router.use(authenticate);

const LINK_ROLES = [ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN] as const;

/**
 * @openapi
 * /requirements/{id}/vendor-registration-link:
 *   post:
 *     tags: [Vendor Registration Link]
 *     summary: Generate (or re-fetch) a public self-registration link for an Approved requirement
 *     responses:
 *       200: { description: An existing live link was returned }
 *       201: { description: A new link was generated }
 *       400: { description: Requirement is not Director-approved }
 *       403: { description: Caller is not a Department User, HOD, or Super Admin }
 *       404: { description: Requirement not found }
 */
router.post(
  '/:id/vendor-registration-link',
  authorize(...LINK_ROLES),
  validate({ params: mongoIdParamSchema() }),
  vendorRegistrationLinkController.generate,
);

/**
 * @openapi
 * /requirements/{id}/vendor-registration-link:
 *   get:
 *     tags: [Vendor Registration Link]
 *     summary: Get the current vendor registration link status for this requirement
 *     responses:
 *       200: { description: Link found }
 *       404: { description: Requirement not found, or no link has been generated yet }
 */
router.get(
  '/:id/vendor-registration-link',
  authorize(...LINK_ROLES),
  validate({ params: mongoIdParamSchema() }),
  vendorRegistrationLinkController.getStatus,
);

/**
 * @openapi
 * /requirements/{id}/vendor-registration-link/verify:
 *   post:
 *     tags: [Vendor Registration Link]
 *     summary: Verify & finalize a submitted public vendor registration — creates the Vendor
 *     responses:
 *       200: { description: Vendor created from the link submission }
 *       400: { description: No submitted link is awaiting verification, or the requirement isn't Approved }
 *       403: { description: Caller is not a Department User, HOD, or Super Admin }
 *       404: { description: Requirement not found }
 *       409: { description: A vendor was already registered for this requirement, or a duplicate GST/PAN/email exists }
 */
router.post(
  '/:id/vendor-registration-link/verify',
  authorize(...LINK_ROLES),
  validate({ params: mongoIdParamSchema() }),
  vendorRegistrationLinkController.verify,
);

export default router;

// Public routes — no `authenticate`/`authorize` at all, only the unguessable token itself
// gates access. Mounted at `/public/vendor-registration` in routes/index.ts.
export const publicVendorRegistrationLinkRoutes = Router();

// Public — vendor's browser reads the link's safe header info before rendering the form.
publicVendorRegistrationLinkRoutes.get(
  '/:token',
  validate({ params: tokenParamSchema }),
  vendorRegistrationLinkController.getPublicInfo,
);

// Public — vendor's own submission. multipart/form-data, same shape as registerVendorSchema.
publicVendorRegistrationLinkRoutes.post(
  '/:token',
  validate({ params: tokenParamSchema }),
  uploadVendorDocuments,
  validate({ body: registerVendorSchema }),
  vendorRegistrationLinkController.submitPublic,
);
