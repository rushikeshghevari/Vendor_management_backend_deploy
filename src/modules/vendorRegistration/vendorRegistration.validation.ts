import { z } from 'zod';

// Same regexes as vendor.validation.ts (deliberately duplicated, not imported — this
// codebase keeps each module's validation local, e.g. comparison/directorReview each have
// their own copies of near-identical logic rather than sharing a helper).
const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_REGEX = /^[1-9][0-9]{5}$/;
const PHONE_REGEX = /^[6-9][0-9]{9}$/;
const UPI_REGEX = /^[\w.+-]{2,256}@[a-zA-Z]{2,64}$/;

// Multipart/form-data fields always arrive as strings — no z.coerce needed since Vendor has
// no numeric fields. `category`/`country` are absent from the mobile form (which reuses the
// existing VendorForm/vendorSchema as-is) so both are optional here and defaulted server-side.
export const registerVendorSchema = z.object({
  name: z.string().trim().min(2).max(150),
  contactPerson: z.string().trim().min(2).max(150),
  phone: z.string().trim().regex(PHONE_REGEX, 'Enter a valid 10-digit mobile number'),
  email: z.string().trim().toLowerCase().email(),
  gstNumber: z.string().trim().toUpperCase().regex(GST_REGEX, 'Enter a valid GST number').optional().or(z.literal('')),
  panNumber: z.string().trim().toUpperCase().regex(PAN_REGEX, 'Enter a valid PAN number').optional().or(z.literal('')),
  address: z.string().trim().min(1, 'Address is required'),
  state: z.string().trim().min(1, 'State is required'),
  district: z.string().trim().min(1, 'District is required'),
  city: z.string().trim().min(1, 'City is required'),
  country: z.string().trim().min(1).optional(),
  pincode: z.string().trim().regex(PINCODE_REGEX, 'Enter a valid 6-digit pincode'),
  bankName: z.string().trim().min(1, 'Bank name is required'),
  accountHolderName: z.string().trim().min(1, 'Account holder name is required'),
  accountNumber: z.string().trim().min(4, 'Enter a valid account number').max(20),
  ifscCode: z.string().trim().toUpperCase().regex(IFSC_REGEX, 'Enter a valid IFSC code'),
  upiId: z.string().trim().regex(UPI_REGEX, 'Enter a valid UPI ID').optional().or(z.literal('')),
  category: z.string().trim().min(1).optional(),
});

export type RegisterVendorInput = z.infer<typeof registerVendorSchema>;

export const linkExistingVendorSchema = z.object({
  vendorId: z.string().trim().min(1, 'vendorId is required'),
});
