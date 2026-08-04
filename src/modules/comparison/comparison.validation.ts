import { mongoIdParamSchema } from '@/utils/commonValidation';

// Both routes are scoped by the Requirement id only — a comparison has no separate id of
// its own that a client ever supplies (see comparison.service.ts: always "the latest one").
export const comparisonParamsSchema = mongoIdParamSchema('id');
