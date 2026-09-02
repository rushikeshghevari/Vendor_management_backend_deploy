import { Schema, model, type Document, type Types } from 'mongoose';

import { AI_RECOMMENDATION, AI_RISK, BILL_STATUS, type AiRecommendation, type AiRisk, type BillStatus } from '@/constants/status';

export interface IBillFileVersion {
  version: number;
  fileName: string;
  url: string;
  uploadedAt: Date;
}

/** One entry per Accounts decision — keeps the full correction/rejection history. */
export interface IBillDecisionRecord {
  decision: BillStatus;
  remarks?: string;
  decidedBy: Types.ObjectId;
  decidedAt: Date;
}

/** Director Financial Approval decisions (Approval 2 — after 3-Way AI verification). */
export const DIRECTOR_FINANCIAL_DECISIONS = ['approved', 'rejected', 'correction_required'] as const;
export type DirectorFinancialDecision = (typeof DIRECTOR_FINANCIAL_DECISIONS)[number];

/** Append-only audit trail for events not already covered by `decisionHistory` (Accounts) or
 *  the single-value `directorFinancial*` fields — created/submitted/AI runs/retries, and every
 *  Director decision (including revisions, which the single-value fields overwrite). Powers the
 *  Bill Timeline API (GET /bills/:id/timeline), merged there with AiAuditLog + decisionHistory. */
export const BILL_HISTORY_EVENTS = [
  'created', 'submitted', 'resubmitted', 'invoice_uploaded', 'supporting_document_uploaded',
  'ai_processing_started', 'ai_verified', 'ai_failed', 'retry_ai_verification',
  'director_decision', 'accounts_decision', 'payment_status_changed', 'updated',
] as const;
export type BillHistoryEvent = (typeof BILL_HISTORY_EVENTS)[number];

export interface IDirectorApproval {
  directorId: Types.ObjectId;
  directorName: string;
  decision: 'approved' | 'rejected' | 'correction_required';
  remarks?: string;
  decidedAt: Date;
}

export interface IBillHistoryEntry {
  event: BillHistoryEvent;
  status?: BillStatus;
  remarks?: string;
  actorId?: Types.ObjectId;
  actorName?: string;
  actorRole?: string;
  at: Date;
  meta?: Record<string, unknown>;
}

export interface IBill extends Document {
  billCode: string;
  quotation: Types.ObjectId;
  purchaseOrder?: Types.ObjectId;
  // Phase 9 — set only when the linked PO is itself Requirement-originated (Phase 7),
  // mirroring PurchaseOrder's own optional requirement/requirementNumber pair. Pure
  // denormalization for lineage/audit — never read by any existing gate.
  requirement?: Types.ObjectId;
  requirementNumber?: string;
  // Phase 9 — the linked PO's own `goodsReceipt` (guaranteed to exist by Phase 8's gate
  // whenever `requirement` above is set), denormalized here for the same reason.
  goodsReceipt?: Types.ObjectId;
  grnNumber?: string;
  // Optional only for a `reimbursement`-mode recurring expense (see `recurringExpense` below),
  // where there's no vendor at all — the payee is `reimbursedTo` instead. Every other Bill
  // (including `vendor_bill`-mode recurring ones) always has this set; billService.create()
  // and .createForRecurringExpense() are the only two places that construct a Bill, and both
  // enforce that "vendor or reimbursedTo, never neither" at the application level.
  vendor?: Types.ObjectId;
  department: Types.ObjectId;
  createdBy: Types.ObjectId;
  // Set only when this Bill is one cycle of a RecurringExpense (see recurringExpense.model.ts)
  // — created via billService.createForRecurringExpense() instead of the normal .create(),
  // skipping the PO/Goods-Receipt gate and routed through processRecurringBillPipeline()
  // instead of the AI 3-way pipeline. Never set for an ordinary one-off Bill.
  recurringExpense?: Types.ObjectId;
  // Denormalized from RecurringExpense.reimbursedTo — who actually gets paid, for a
  // `reimbursement`-mode recurring Bill. Payment Department reads this instead of `vendor`.
  reimbursedTo?: Types.ObjectId;
  // Denormalized snapshot of the uploader — mirrors the vendorName/departmentName pattern
  // already used on PurchaseOrder, so list views never need an extra populate/lookup.
  uploadedByName: string;
  uploadedByRole: string;
  invoiceNumber: string;
  invoiceDate: Date;
  invoiceAmount: number;
  taxableAmount: number;
  gstAmount: number;
  paymentTerms: string;
  // Days of credit on this specific invoice — usually carried over from the Quotation's
  // creditPeriod, but editable here since the actual invoice can state different terms.
  creditPeriod?: number;
  dueDate: Date;
  invoiceFiles: IBillFileVersion[];
  supportingDocuments: IBillFileVersion[];
  remarks?: string;
  // Director Financial Approval (Approval 2 — after 3-Way AI, before Accounts).
  directorFinancialDecision?: DirectorFinancialDecision;
  directorFinancialBy?: Types.ObjectId;
  directorFinancialAt?: Date;
  directorFinancialRemarks?: string;
  directorApprovals: IDirectorApproval[];
  // Accounts feedback — latest remark plus full history.
  accountsRemarks?: string;
  verifiedBy?: Types.ObjectId;
  verifiedAt?: Date;
  decisionHistory: IBillDecisionRecord[];
  // Denormalized snapshot of PurchaseOrder.aiVerification essentials — set once AI verification
  // completes, so list/dashboard views can show score/status without an extra PO lookup.
  // The canonical, full aiVerification result stays on PurchaseOrder (see aiVerification.service.ts).
  aiMatchPercentage?: number;
  aiRisk?: AiRisk;
  aiRecommendation?: AiRecommendation;
  aiVerifiedAt?: Date;
  aiFailureReason?: string;
  // Atomic claim guard — prevents the automatic (fire-and-forget, from submit()) pipeline run
  // and a manual "Retry AI Verification" call from both executing concurrently for the same
  // bill, which previously produced duplicate notifications (bill_financial_approval_required,
  // ai_high_risk_alert, bill_ai_verified all sent twice).
  aiPipelineRunning?: boolean;
  history: IBillHistoryEntry[];
  status: BillStatus;
  isDeleted: boolean;
  submittedAt?: Date;
  decisionAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const fileVersionSchema = new Schema<IBillFileVersion>(
  {
    version: { type: Number, required: true },
    fileName: { type: String, required: true },
    url: { type: String, required: true },
    uploadedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const directorApprovalSchema = new Schema<IDirectorApproval>(
  {
    directorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    directorName: { type: String, required: true, trim: true },
    decision: { type: String, enum: ['approved', 'rejected', 'correction_required'], required: true },
    remarks: { type: String, trim: true },
    decidedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const decisionRecordSchema = new Schema<IBillDecisionRecord>(
  {
    decision: { type: String, enum: Object.values(BILL_STATUS), required: true },
    remarks: { type: String, trim: true },
    decidedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    decidedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const historyEntrySchema = new Schema<IBillHistoryEntry>(
  {
    event:     { type: String, enum: BILL_HISTORY_EVENTS, required: true },
    status:    { type: String, enum: Object.values(BILL_STATUS) },
    remarks:   { type: String, trim: true },
    actorId:   { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, trim: true },
    actorRole: { type: String, trim: true },
    at:        { type: Date, required: true, default: Date.now },
    meta:      { type: Schema.Types.Mixed },
  },
  { _id: false },
);

const billSchema = new Schema<IBill>(
  {
    billCode: { type: String, required: true, trim: true, uppercase: true, unique: true },
    // No inline `unique: true` here — see the partial index below. A plain unique index would
    // reject a new Bill for a quotation whose only prior Bill was soft-deleted (isDeleted:
    // true), since Mongo unique indexes count every document regardless of that flag.
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true },
    purchaseOrder: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder' },
    requirement:       { type: Schema.Types.ObjectId, ref: 'Requirement' },
    requirementNumber: { type: String, trim: true, uppercase: true },
    goodsReceipt:      { type: Schema.Types.ObjectId, ref: 'GoodsReceipt' },
    grnNumber:         { type: String, trim: true, uppercase: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recurringExpense: { type: Schema.Types.ObjectId, ref: 'RecurringExpense' },
    reimbursedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    uploadedByName: { type: String, required: true, trim: true },
    uploadedByRole: { type: String, required: true, trim: true },
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, required: true },
    invoiceAmount: { type: Number, required: true, min: 0 },
    taxableAmount: { type: Number, required: true, min: 0 },
    gstAmount: { type: Number, required: true, min: 0 },
    paymentTerms: { type: String, required: true, trim: true },
    creditPeriod: { type: Number, min: 0 },
    dueDate: { type: Date, required: true },
    invoiceFiles: { type: [fileVersionSchema], default: [] },
    supportingDocuments: { type: [fileVersionSchema], default: [] },
    remarks: { type: String, trim: true },
    // Director Financial Approval (Approval 2 — after 3-Way AI, before Accounts).
    directorFinancialDecision: { type: String, enum: DIRECTOR_FINANCIAL_DECISIONS },
    directorFinancialBy:       { type: Schema.Types.ObjectId, ref: 'User' },
    directorFinancialAt:       { type: Date },
    directorFinancialRemarks:  { type: String, trim: true },
    directorApprovals:         { type: [directorApprovalSchema], default: [] },
    accountsRemarks: { type: String, trim: true },
    verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    verifiedAt: { type: Date },
    decisionHistory: { type: [decisionRecordSchema], default: [] },
    aiMatchPercentage: { type: Number, min: 0, max: 100 },
    aiRisk:            { type: String, enum: Object.values(AI_RISK) },
    aiRecommendation:  { type: String, enum: Object.values(AI_RECOMMENDATION) },
    aiVerifiedAt:      { type: Date },
    aiFailureReason:   { type: String, trim: true },
    aiPipelineRunning: { type: Boolean, default: false },
    history: { type: [historyEntrySchema], default: [] },
    status: {
      type: String,
      enum: Object.values(BILL_STATUS),
      default: BILL_STATUS.DRAFT,
    },
    isDeleted: { type: Boolean, default: false },
    submittedAt: { type: Date },
    decisionAt: { type: Date },
  },
  { timestamps: true },
);

billSchema.index({ department: 1, status: 1 });
billSchema.index({ vendor: 1 });
// One active Bill per Quotation — partial so a soft-deleted Draft (see billService.remove)
// doesn't permanently block a fresh Bill being created for the same Quotation afterward.
// MongoDB partial index filters only support a limited operator subset — $ne is NOT one of
// them (silently fails index creation, logged but not thrown, if used); isDeleted always has
// a schema default of false so every document has it explicitly set, hence plain equality.
billSchema.index(
  { quotation: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false } },
);
// Every Department User's list/filter query is scoped by `createdBy` (see scopeToOwner) —
// without this, that's a full collection scan on every Department User's request.
billSchema.index({ createdBy: 1, status: 1 });
// Not unique — one-Bill-per-Quotation is already enforced by the partial unique index above;
// this only serves lineage lookups (mirrors PurchaseOrder's own `{ requirement: 1 }` index).
billSchema.index({ requirement: 1 });
// DB-level backstop for the same-invoice-twice-for-one-vendor check in bill.service.ts —
// closes the race window between the application check and the insert (partial so a
// soft-deleted bill never blocks reusing its invoice number).
// `vendor: { $exists: true }` added to the filter (on top of the existing isDeleted: false) —
// `vendor` is optional now (reimbursement-mode recurring bills have none), and a partial index
// can't enforce uniqueness across documents where the indexed field is absent anyway; this
// keeps the guarantee scoped to bills that actually have a vendor, same as before this changed.
billSchema.index(
  { vendor: 1, invoiceNumber: 1 },
  { unique: true, partialFilterExpression: { isDeleted: false, vendor: { $exists: true } } },
);
billSchema.index({ recurringExpense: 1 });

export const Bill = model<IBill>('Bill', billSchema);
