import { z } from 'zod';

import { VENDOR_STATUSES } from '@/modules/vendor/vendor.model';

const GST_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const PINCODE_REGEX = /^[1-9][0-9]{5}$/;
const PHONE_REGEX = /^[6-9][0-9]{9}$/;
const UPI_REGEX = /^[\w.+-]{2,256}@[a-zA-Z]{2,64}$/;

const bankDetailsSchema = z.object({
  bankName: z.string().trim().min(1, 'Bank name is required'),
  accountHolderName: z.string().trim().min(1, 'Account holder name is required'),
  accountNumber: z.string().trim().min(4, 'Enter a valid account number').max(20),
  ifscCode: z.string().trim().toUpperCase().regex(IFSC_REGEX, 'Enter a valid IFSC code'),
  upiId: z.string().trim().regex(UPI_REGEX, 'Enter a valid UPI ID').optional().or(z.literal('')),
});

// `department` and `createdBy` are deliberately absent — both are always derived server-side
// from the authenticated department_user, never trusted from the request body.
export const createVendorSchema = z.object({
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
  pincode: z.string().trim().regex(PINCODE_REGEX, 'Enter a valid 6-digit pincode'),
  bankDetails: bankDetailsSchema,
  category: z.string().trim().min(1, 'Vendor category is required'),
  status: z.enum(VENDOR_STATUSES).optional(),
});

export const updateVendorSchema = createVendorSchema.partial();

export const updateVendorStatusSchema = z.object({
  status: z.enum(VENDOR_STATUSES),
});

export const vendorListQuerySchema = z.object({
  page: z.coerce.number().int().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  department: z.string().regex(/^[0-9a-fA-F]{24}$/).optional(),
  category: z.string().optional(),
  search: z.string().optional(),
  status: z.enum(VENDOR_STATUSES).optional(),
});

export type CreateVendorInput = z.infer<typeof createVendorSchema>;
export type UpdateVendorInput = z.infer<typeof updateVendorSchema>;
export type UpdateVendorStatusInput = z.infer<typeof updateVendorStatusSchema>;
