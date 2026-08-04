import { z } from 'zod';

import { ACTIVITY_ACTIONS } from '@/modules/activityLog/activityLog.model';
import { paginationQuerySchema } from '@/utils/commonValidation';

const objectId = z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid id');

export const activityLogListQuerySchema = paginationQuerySchema.extend({
  action:      z.enum(ACTIVITY_ACTIONS).optional(),
  department:  objectId.optional(),
  performedBy: objectId.optional(),
  from:        z.string().datetime().optional(),
  to:          z.string().datetime().optional(),
});
