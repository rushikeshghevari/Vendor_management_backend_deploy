import { Schema, model, type Document, type Types } from 'mongoose';

import type { IVendorDocument } from '@/modules/vendor/vendor.model';
import { VENDOR_DOCUMENT_TYPES } from '@/modules/vendor/vendor.model';

export const VENDOR_REGISTRATION_LINK_STATUSES = ['pending', 'submitted', 'verified', 'expired'] as const;
export type VendorRegistrationLinkStatus = (typeof VENDOR_REGISTRATION_LINK_STATUSES)[number];

// Same field shape as RegisterVendorInput (vendorRegistration.validation.ts) — stored as
// plain data rather than applied immediately, since a public submission only becomes a real
// Vendor once a Department User/HOD explicitly verifies it (see vendorRegistrationLink.service.ts).
export interface ISubmittedVendorData {
  name: string;
  contactPerson: string;
  phone: string;
  email: string;
  gstNumber?: string;
  panNumber?: string;
  address: string;
  state: string;
  district: string;
  city: string;
  country?: string;
  pincode: string;
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  upiId?: string;
  category?: string;
}

export interface IVendorRegistrationLink extends Document {
  requirement: Types.ObjectId;
  token: string;
  status: VendorRegistrationLinkStatus;
  expiresAt: Date;
  submittedData?: ISubmittedVendorData;
  submittedDocuments: IVendorDocument[];
  submittedAt?: Date;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const submittedVendorDataSchema = new Schema<ISubmittedVendorData>(
  {
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    gstNumber: { type: String, trim: true, uppercase: true },
    panNumber: { type: String, trim: true, uppercase: true },
    address: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    district: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    country: { type: String, trim: true },
    pincode: { type: String, required: true, trim: true },
    bankName: { type: String, required: true, trim: true },
    accountHolderName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    ifscCode: { type: String, required: true, trim: true, uppercase: true },
    upiId: { type: String, trim: true },
    category: { type: String, trim: true },
  },
  { _id: false },
);

const submittedDocumentSchema = new Schema<IVendorDocument>(
  {
    type: { type: String, enum: VENDOR_DOCUMENT_TYPES, required: true },
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    mimeType: { type: String, required: true, trim: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const vendorRegistrationLinkSchema = new Schema<IVendorRegistrationLink>(
  {
    requirement: { type: Schema.Types.ObjectId, ref: 'Requirement', required: true },
    token: { type: String, required: true, unique: true },
    status: { type: String, enum: VENDOR_REGISTRATION_LINK_STATUSES, default: 'pending' },
    expiresAt: { type: Date, required: true },
    submittedData: { type: submittedVendorDataSchema },
    submittedDocuments: { type: [submittedDocumentSchema], default: [] },
    submittedAt: { type: Date },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

vendorRegistrationLinkSchema.index({ token: 1 }, { unique: true });
// "One active link per requirement" is enforced as one *live* (pending/submitted) link at a
// time, not a hard one-document-ever constraint — a requirement can get a fresh link after an
// earlier one expired or was verified. Partial unique index, same idiom as the dedupKey index
// in notification.model.ts.
vendorRegistrationLinkSchema.index(
  { requirement: 1 },
  { unique: true, partialFilterExpression: { status: { $in: ['pending', 'submitted'] } } },
);

export const VendorRegistrationLink = model<IVendorRegistrationLink>('VendorRegistrationLink', vendorRegistrationLinkSchema);
