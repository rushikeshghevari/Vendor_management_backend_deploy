import { z } from 'zod';

// Reused directly from Phase 6 — the public submission form collects exactly the same fields
// as the authenticated registration flow, so this is not forked.
export { registerVendorSchema, type RegisterVendorInput } from '@/modules/vendorRegistration/vendorRegistration.validation';

export const tokenParamSchema = z.object({
  token: z.string().trim().regex(/^[0-9a-f]{64}$/, 'Invalid token'),
});
