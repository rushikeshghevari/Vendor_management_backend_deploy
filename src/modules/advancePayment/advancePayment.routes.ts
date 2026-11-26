import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { advancePaymentController } from '@/modules/advancePayment/advancePayment.controller';
import {
  accountsVerifyAdvancePaymentSchema,
  advancePaymentListQuerySchema,
  markAdvancePaymentPaidSchema,
} from '@/modules/advancePayment/advancePayment.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Advance Payments
 *   description: Tracks a Requirement's advance payment (Quotation.advanceAmount) from Director approval through Accounts verification to Payment Department payout — independent of the Bill/Payment lifecycle, since the advance is due before any PO/Bill exists.
 */

// Created only by directorReviewController.decide() (approved branch) — never via this router.
router.get('/', validate({ query: advancePaymentListQuerySchema }), advancePaymentController.list);

router.get('/:id', validate({ params: mongoIdParamSchema() }), advancePaymentController.getById);

router.patch(
  '/:id/verify',
  authorize(ROLES.ACCOUNTS),
  validate({ params: mongoIdParamSchema(), body: accountsVerifyAdvancePaymentSchema }),
  advancePaymentController.accountsVerify,
);

router.patch(
  '/:id/mark-paid',
  authorize(ROLES.PAYMENT_DEPARTMENT),
  validate({ params: mongoIdParamSchema(), body: markAdvancePaymentPaidSchema }),
  advancePaymentController.markPaid,
);

export default router;
