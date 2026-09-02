import { Router } from 'express';

import { ROLES } from '@/constants/roles';
import { authenticate } from '@/middleware/auth.middleware';
import { authorize } from '@/middleware/rbac.middleware';
import { validate } from '@/middleware/validate.middleware';
import { recurringExpenseController } from '@/modules/recurringExpense/recurringExpense.controller';
import {
  createRecurringExpenseSchema,
  generateRecurringCycleSchema,
  recurringExpenseListQuerySchema,
  updateRecurringExpenseSchema,
} from '@/modules/recurringExpense/recurringExpense.validation';
import { mongoIdParamSchema } from '@/utils/commonValidation';

const router = Router();
router.use(authenticate);

/**
 * @openapi
 * tags:
 *   name: Recurring Expense
 *   description: Department-level recurring costs (subscriptions, hosting, reimbursements) approved once by a Director, then auto-fast-tracked to Payment each cycle unless the amount rises past the series' threshold.
 */

router.post(
  '/',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ body: createRecurringExpenseSchema }),
  recurringExpenseController.create,
);

router.get('/', validate({ query: recurringExpenseListQuerySchema }), recurringExpenseController.list);

router.get('/:id', validate({ params: mongoIdParamSchema() }), recurringExpenseController.getById);

router.patch(
  '/:id',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema(), body: updateRecurringExpenseSchema }),
  recurringExpenseController.update,
);

router.post(
  '/:id/generate-cycle',
  authorize(ROLES.DEPARTMENT_USER, ROLES.HOD),
  validate({ params: mongoIdParamSchema(), body: generateRecurringCycleSchema }),
  recurringExpenseController.generateCycle,
);

export default router;
