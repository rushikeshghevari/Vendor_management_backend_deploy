import { Schema, model, type Document, type Types } from 'mongoose';

export const VENDOR_STATUSES = ['active', 'inactive', 'blacklisted'] as const;
export type VendorStatus = (typeof VENDOR_STATUSES)[number];

export interface IBankDetails {
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  upiId?: string;
}

// Phase 6 — Vendor Registration. A vendor created via the Requirement → AI Comparison →
// Director Review pipeline attaches up to four supporting documents; MSME is the only one
// the spec marks optional, so `registrationStatus` only requires the other three to flip to
// "registered" (see vendorRegistration.service.ts).
export const VENDOR_DOCUMENT_TYPES = ['gst_certificate', 'pan_card', 'cancelled_cheque', 'msme_certificate'] as const;
export type VendorDocumentType = (typeof VENDOR_DOCUMENT_TYPES)[number];

export interface IVendorDocument {
  type: VendorDocumentType;
  fileName: string;
  url: string;
  mimeType: string;
  uploadedAt: Date;
}

export const VENDOR_REGISTRATION_STATUSES = ['pending_documents', 'registered'] as const;
export type VendorRegistrationStatus = (typeof VENDOR_REGISTRATION_STATUSES)[number];

export interface IVendor extends Document {
  name: string;
  code: string;
  department: Types.ObjectId;
  createdBy: Types.ObjectId;
  contactPerson: string;
  phone: string;
  email: string;
  gstNumber?: string;
  panNumber?: string;
  address: string;
  state: string;
  district: string;
  city: string;
  country: string;
  pincode: string;
  bankDetails: IBankDetails;
  category: string;
  status: VendorStatus;
  // Phase 6 — all optional/defaulted so a manually-created vendor (the pre-existing
  // POST /vendors flow, unchanged by this phase) never has to supply any of them.
  documents: IVendorDocument[];
  registrationStatus: VendorRegistrationStatus;
  createdFromRequirement?: Types.ObjectId;
  createdFromQuotation?: Types.ObjectId;
  approvedByDirector?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const bankDetailsSchema = new Schema<IBankDetails>(
  {
    bankName: { type: String, required: true, trim: true },
    accountHolderName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    ifscCode: { type: String, required: true, trim: true, uppercase: true },
    upiId: { type: String, trim: true },
  },
  { _id: false },
);

const vendorDocumentSchema = new Schema<IVendorDocument>(
  {
    type: { type: String, enum: VENDOR_DOCUMENT_TYPES, required: true },
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    mimeType: { type: String, required: true, trim: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const vendorSchema = new Schema<IVendor>(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    contactPerson: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    // sparse: multiple vendors with no GST/PAN are allowed; only *present* values must be unique.
    gstNumber: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    panNumber: { type: String, trim: true, uppercase: true, unique: true, sparse: true },
    address: { type: String, required: true, trim: true },
    state: { type: String, required: true, trim: true },
    district: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    country: { type: String, trim: true, default: 'India' },
    pincode: { type: String, required: true, trim: true },
    bankDetails: { type: bankDetailsSchema, required: true },
    category: { type: String, required: true, trim: true },
    status: { type: String, enum: VENDOR_STATUSES, default: 'active' },
    documents: { type: [vendorDocumentSchema], default: [] },
    registrationStatus: { type: String, enum: VENDOR_REGISTRATION_STATUSES, default: 'registered' },
    createdFromRequirement: { type: Schema.Types.ObjectId, ref: 'Requirement' },
    createdFromQuotation: { type: Schema.Types.ObjectId, ref: 'Quotation' },
    approvedByDirector: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

vendorSchema.index({ department: 1 });
vendorSchema.index({ status: 1 });
// Every Department User's list query is scoped by `createdBy` (see scopeToOwner) — without
// this, that's a full collection scan on every Department User's request.
vendorSchema.index({ createdBy: 1 });
// Phase 6 — a Requirement can only ever produce one registered vendor. Sparse: manually
// created vendors (the pre-existing POST /vendors flow) never set this field at all.
vendorSchema.index({ createdFromRequirement: 1 }, { unique: true, sparse: true });

export const Vendor = model<IVendor>('Vendor', vendorSchema);
