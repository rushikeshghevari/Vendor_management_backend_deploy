import { Schema, model, type Document, type Types } from 'mongoose';

import { OCR_STATUS, QUOTATION_STATUS, type OcrStatus, type QuotationStatus } from '@/constants/status';

export const QUOTATION_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export type QuotationPriority = (typeof QUOTATION_PRIORITIES)[number];

export const QUOTATION_CURRENCIES = ['INR', 'USD', 'EUR', 'GBP'] as const;
export type QuotationCurrency = (typeof QUOTATION_CURRENCIES)[number];

export interface IQuotationPdfVersion {
  version: number;
  fileName: string;
  url: string;
  uploadedAt: Date;
}

export interface IQuotationAttachmentVersion {
  version: number;
  fileName: string;
  url: string;
  mimeType: string;
  /** SHA-256 of the file contents — lets `uploadAttachment` reject an exact re-upload. */
  fileHash: string;
  uploadedAt: Date;
}

/** One structured line item OCR pulled out of the attachment — see quotationOcr.service.ts. */
export interface IQuotationOcrItem {
  description: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  amount?: number;
}

/** Best-effort structured fields parsed from the OCR raw text. Every field is optional —
 *  OCR of a real-world scanned quotation rarely finds all of them. */
export interface IQuotationOcrStructuredData {
  vendorName?: string;
  quotationNumber?: string;
  quotationDate?: string;
  currency?: string;
  subtotal?: number;
  gst?: number;
  discount?: number;
  grandTotal?: number;
  items: IQuotationOcrItem[];
}

/** OCR pipeline state for the quotation's latest attachment — Phase 3 foundation.
 *  Read-only from the outside; only `quotationOcr.service.ts` writes to it. */
export interface IQuotationOcr {
  status: OcrStatus;
  /** Which attachment version this result was extracted from — lets a later re-upload
   *  invalidate a stale result without an explicit migration. */
  attachmentVersion?: number;
  provider?: string;
  startedAt?: Date;
  completedAt?: Date;
  confidence?: number;
  extractedText?: string;
  structuredData?: IQuotationOcrStructuredData;
  error?: string;
}

export interface ITemporaryVendorInfo {
  name: string;
  contactPerson?: string;
  phone?: string;
  email?: string;
  address?: string;
}

export const DIRECTOR_DECISIONS = ['approved', 'negotiation', 'rejected'] as const;
export type DirectorDecision = (typeof DIRECTOR_DECISIONS)[number];

/**
 * One independent record per Director — never both required, never overwritten by another
 * Director's entry. "Pending" is never stored here; it's the absence of an entry for a given
 * Director, computed at read time (see quotationService.buildDirectorApprovalRoster).
 */
export interface IDirectorApproval {
  director: Types.ObjectId;
  decision: DirectorDecision;
  remarks?: string;
  decidedAt: Date;
}

export interface IQuotation extends Document {
  quotationCode: string;
  vendor?: Types.ObjectId;
  requirement?: Types.ObjectId;
  temporaryVendor?: ITemporaryVendorInfo;
  department: Types.ObjectId;
  createdBy: Types.ObjectId;
  quotationDate: Date;
  requiredDate: Date;
  amount: number;
  gst: number;
  currency: QuotationCurrency;
  paymentTerms: string;
  deliveryTerms: string;
  // Number of days of credit the vendor is extending on this quotation (0 = cash/no credit).
  // Compulsory here since it directly affects payment scheduling; carried onto the Bill too
  // (see Bill.creditPeriod), where it's editable in case the actual invoice differs.
  creditPeriod: number;
  // Vendor-dictated payment split, set when the quotation is filled in — how much must be
  // paid before the PO/goods (0 = nothing upfront). The rest (amount - advanceAmount) is due
  // per `creditPeriod` above; a vendor demanding 100% upfront is just advanceAmount === amount,
  // no separate flag needed.
  advanceAmount?: number;
  // The vendor's own promised delivery date for this quotation, set at quotation-fill time —
  // distinct from `requiredDate` (when the requester needs it by) and from a PurchaseOrder's
  // own dates (which don't exist yet at this stage).
  expectedDeliveryDate?: Date;
  priority: QuotationPriority;
  description?: string;
  pdfFiles: IQuotationPdfVersion[];
  attachments: IQuotationAttachmentVersion[];
  remarks?: string;
  // Director's feedback when returning a quotation for negotiation or rejecting it — kept
  // alongside `directorApprovals` so the existing single-decision workflow fields (which
  // still drive `status`) are completely unchanged in behavior.
  directorRemarks?: string;
  directorApprovals: IDirectorApproval[];
  status: QuotationStatus;
  /** Phase 3 — OCR pipeline state for the latest attachment. Absent on quotations created
   *  before Phase 3 or with no attachment yet; defaults to `not_started` once one exists. */
  ocr?: IQuotationOcr;
  isDeleted: boolean;
  submittedAt?: Date;
  // Distinct from `createdBy` when an HOD submits a quotation a Department User created —
  // ownershipFilter() in quotation.service.ts allows that, but until now nothing recorded it.
  submittedBy?: Types.ObjectId;
  decisionAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pdfVersionSchema = new Schema<IQuotationPdfVersion>(
  {
    version: { type: Number, required: true },
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const attachmentVersionSchema = new Schema<IQuotationAttachmentVersion>(
  {
    version: { type: Number, required: true },
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    mimeType: { type: String, required: true, trim: true },
    fileHash: { type: String, required: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const ocrItemSchema = new Schema<IQuotationOcrItem>(
  {
    description: { type: String, required: true, trim: true },
    quantity: { type: Number },
    unit: { type: String, trim: true },
    unitPrice: { type: Number },
    amount: { type: Number },
  },
  { _id: false },
);

const ocrStructuredDataSchema = new Schema<IQuotationOcrStructuredData>(
  {
    vendorName: { type: String, trim: true },
    quotationNumber: { type: String, trim: true },
    quotationDate: { type: String, trim: true },
    currency: { type: String, trim: true },
    subtotal: { type: Number },
    gst: { type: Number },
    discount: { type: Number },
    grandTotal: { type: Number },
    items: { type: [ocrItemSchema], default: [] },
  },
  { _id: false },
);

const ocrSchema = new Schema<IQuotationOcr>(
  {
    status: { type: String, enum: Object.values(OCR_STATUS), default: OCR_STATUS.NOT_STARTED },
    attachmentVersion: { type: Number },
    provider: { type: String, trim: true },
    startedAt: { type: Date },
    completedAt: { type: Date },
    confidence: { type: Number, min: 0, max: 100 },
    extractedText: { type: String },
    structuredData: { type: ocrStructuredDataSchema },
    error: { type: String, trim: true },
  },
  { _id: false },
);

const temporaryVendorSchema = new Schema<ITemporaryVendorInfo>(
  {
    name: { type: String, required: true, trim: true },
    contactPerson: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    address: { type: String, trim: true },
  },
  { _id: false },
);

const directorApprovalSchema = new Schema<IDirectorApproval>(
  {
    director: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    decision: { type: String, enum: DIRECTOR_DECISIONS, required: true },
    remarks: { type: String, trim: true },
    decidedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const quotationSchema = new Schema<IQuotation>(
  {
    quotationCode: { type: String, required: true, trim: true, uppercase: true, unique: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    requirement: { type: Schema.Types.ObjectId, ref: 'Requirement' },
    temporaryVendor: { type: temporaryVendorSchema },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    quotationDate: { type: Date, required: true },
    requiredDate: { type: Date, required: true },
    amount: { type: Number, required: true, min: 0 },
    gst: { type: Number, required: true, min: 0, max: 100 },
    currency: { type: String, enum: QUOTATION_CURRENCIES, default: 'INR' },
    paymentTerms: { type: String, required: true, trim: true },
    deliveryTerms: { type: String, required: true, trim: true },
    creditPeriod: { type: Number, required: true, min: 0 },
    advanceAmount: { type: Number, min: 0 },
    expectedDeliveryDate: { type: Date },
    priority: { type: String, enum: QUOTATION_PRIORITIES, default: 'medium' },
    description: { type: String, trim: true },
    // Never overwritten — every upload appends a new version; the last entry is the active one.
    pdfFiles: { type: [pdfVersionSchema], default: [] },
    attachments: { type: [attachmentVersionSchema], default: [] },
    remarks: { type: String, trim: true },
    directorRemarks: { type: String, trim: true },
    directorApprovals: { type: [directorApprovalSchema], default: [] },
    status: {
      type: String,
      enum: Object.values(QUOTATION_STATUS),
      default: QUOTATION_STATUS.DRAFT,
    },
    ocr: { type: ocrSchema },
    isDeleted: { type: Boolean, default: false },
    submittedAt: { type: Date },
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    decisionAt: { type: Date },
  },
  { timestamps: true },
);

quotationSchema.index({ department: 1, status: 1 });
quotationSchema.index({ vendor: 1 });
quotationSchema.index({ requirement: 1, createdAt: -1 });
// Every Department User's list/filter query is scoped by `createdBy` (see scopeToOwner) —
// without this, that's a full collection scan on every Department User's request.
quotationSchema.index({ createdBy: 1, status: 1 });

export const Quotation = model<IQuotation>('Quotation', quotationSchema);
