import { Router } from 'express';

import { apiKeyAuth } from '@/middleware/apiKey.middleware';
import { validate } from '@/middleware/validate.middleware';
import { externalController } from '@/modules/external/external.controller';
import { externalBillListQuerySchema } from '@/modules/external/external.validation';

const router = Router();

/**
 * @openapi
 * tags:
 *   name: External
 *   description: Read-only API for other, separate projects (e.g. a Payment-department calendar-reminder integration). Authenticated by a shared X-API-Key header, not user login.
 */

router.use(apiKeyAuth);

router.get('/bills', validate({ query: externalBillListQuerySchema }), externalController.listBills);

export default router;
