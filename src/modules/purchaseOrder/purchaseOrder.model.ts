import { Schema, model, type Document, type Types } from 'mongoose';

import { PO_STATUS, AI_RISK, AI_RECOMMENDATION, type PurchaseOrderStatus, type AiRisk, type AiRecommendation } from '@/constants/status';

// ─── Sub-document: PO Line Item ───────────────────────────────────────────────
export interface IPurchaseOrderItem {
  itemName: string;
  description?: string;
  quantity: number;
  unitPrice: number;
  gstRate: number;
  gstAmount: number;
  taxAmount: number;
  discount: number;
  total: number;
}

// ─── Sub-document: AI Difference Entry ────────────────────────────────────────
export interface IAiDifference {
  field: string;
  purchaseOrder: unknown;
  bill: unknown;
  difference: string;
  severity?: 'LOW' | 'MEDIUM' | 'HIGH';
}

// ─── Sub-document: AI Token Usage ─────────────────────────────────────────────
export interface IAiTokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// ─── Sub-document: AI Verification Result ─────────────────────────────────────
export interface IAiVerification {
  /** Weighted overall score: Rule Engine 40% + Gemini 60% */
  matchPercentage: number;
  /** How closely the Quotation matches the Bill (0-100) */
  quotationMatch?: number;
  /** How closely the Purchase Order matches the Bill (0-100) */
  purchaseOrderMatch?: number;
  risk: AiRisk;
  recommendation: AiRecommendation;
  confidence: number;
  summary: string;
  differences: IAiDifference[];
  ruleEngineScore: number;
  verifiedAt: Date;
  ocrExtractedData?: Record<string, unknown>;
  // Metadata added in v2 (Gemini 2.0 + new SDK)
  executionTimeMs?: number;
  promptVersion?: string;
  modelVersion?: string;
  tokenUsage?: IAiTokenUsage;
  aiProvider?: 'gemini' | 'rule_engine_only';
}

// ─── Main Document Interface ───────────────────────────────────────────────────
export interface IPurchaseOrder extends Document {
  poNumber: string;
  poDate: Date;
  quotation: Types.ObjectId;
  quotationCode: string;
  vendor: Types.ObjectId;
  vendorName: string;
  vendorGst: string;
  vendorAddress: string;
  department: Types.ObjectId;
  departmentName: string;
  createdBy: Types.ObjectId;
  items: IPurchaseOrderItem[];
  subtotal: number;
  totalGst: number;
  totalTax: number;
  totalDiscount: number;
  grandTotal: number;
  terms?: string;
  notes?: string;
  status: PurchaseOrderStatus;
  bill?: Types.ObjectId;
  aiVerification?: IAiVerification;
  // Phase 7 — set only when this PO originated from the Requirement -> AI Comparison ->
  // Director Review -> Vendor Registration pipeline (Phases 1-6) rather than the original
  // "pick an Approved Quotation directly" flow. Both optional so the legacy path is
  // completely unaffected — `quotation`/`quotationCode` are still always populated even for
  // a Requirement-originated PO (from the registered Vendor's own winning quotation, see
  // purchaseOrder.service.ts), so nothing downstream (getById's payment lookup, the PDF's
  // "Quotation Ref" line, the one-PO-per-quotation unique index) needs special-casing.
  requirement?: Types.ObjectId;
  requirementNumber?: string;
  // Phase 8 — set once a Goods Receipt is recorded against this PO (goodsReceiptService.create()).
  // Mirrors how `bill` above is denormalized here once a Bill is created.
  goodsReceipt?: Types.ObjectId;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schemas ───────────────────────────────────────────────────────────────
const poItemSchema = new Schema<IPurchaseOrderItem>(
  {
    itemName:    { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    quantity:    { type: Number, required: true, min: 0 },
    unitPrice:   { type: Number, required: true, min: 0 },
    gstRate:     { type: Number, required: true, min: 0, max: 100 },
    gstAmount:   { type: Number, required: true, min: 0 },
    taxAmount:   { type: Number, required: true, min: 0 },
    discount:    { type: Number, required: true, min: 0 },
    total:       { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const aiDifferenceSchema = new Schema<IAiDifference>(
  {
    field:         { type: String, required: true },
    purchaseOrder: { type: Schema.Types.Mixed },
    bill:          { type: Schema.Types.Mixed },
    difference:    { type: String, required: true },
    severity:      { type: String, enum: ['LOW', 'MEDIUM', 'HIGH'] },
  },
  { _id: false },
);

const aiTokenUsageSchema = new Schema<IAiTokenUsage>(
  {
    inputTokens:  { type: Number, required: true, min: 0 },
    outputTokens: { type: Number, required: true, min: 0 },
    totalTokens:  { type: Number, required: true, min: 0 },
  },
  { _id: false },
);

const aiVerificationSchema = new Schema<IAiVerification>(
  {
    matchPercentage:    { type: Number, required: true, min: 0, max: 100 },
    quotationMatch:     { type: Number, min: 0, max: 100 },
    purchaseOrderMatch: { type: Number, min: 0, max: 100 },
    risk:             { type: String, enum: Object.values(AI_RISK), required: true },
    recommendation:   { type: String, enum: Object.values(AI_RECOMMENDATION), required: true },
    confidence:       { type: Number, required: true, min: 0, max: 100 },
    summary:          { type: String, required: true },
    differences:      { type: [aiDifferenceSchema], default: [] },
    ruleEngineScore:  { type: Number, required: true, min: 0, max: 100 },
    verifiedAt:       { type: Date, required: true },
    ocrExtractedData: { type: Schema.Types.Mixed },
    // v2 metadata fields
    executionTimeMs:  { type: Number, min: 0 },
    promptVersion:    { type: String, trim: true },
    modelVersion:     { type: String, trim: true },
    tokenUsage:       { type: aiTokenUsageSchema },
    aiProvider:       { type: String, enum: ['gemini', 'rule_engine_only'] },
  },
  { _id: false },
);

// ─── Main Schema ───────────────────────────────────────────────────────────────
const purchaseOrderSchema = new Schema<IPurchaseOrder>(
  {
    poNumber: {
      type: String, required: true, unique: true, uppercase: true, trim: true,
    },
    poDate: { type: Date, required: true, default: Date.now },
    // One Approved Quotation → one PO (same uniqueness constraint as Bill→Quotation).
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true, unique: true },
    quotationCode: { type: String, required: true, trim: true, uppercase: true },
    vendor:        { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    vendorName:    { type: String, required: true, trim: true },
    vendorGst:     { type: String, required: true, trim: true },
    vendorAddress: { type: String, required: true, trim: true },
    department:     { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    departmentName: { type: String, required: true, trim: true },
    createdBy:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    items:          { type: [poItemSchema], required: true },
    subtotal:       { type: Number, required: true, min: 0 },
    totalGst:       { type: Number, required: true, min: 0 },
    totalTax:       { type: Number, required: true, min: 0 },
    totalDiscount:  { type: Number, required: true, min: 0 },
    grandTotal:     { type: Number, required: true, min: 0 },
    terms:  { type: String, trim: true },
    notes:  { type: String, trim: true },
    status: {
      type: String,
      enum: Object.values(PO_STATUS),
      default: PO_STATUS.GENERATED,
    },
    bill:           { type: Schema.Types.ObjectId, ref: 'Bill' },
    aiVerification: { type: aiVerificationSchema },
    requirement:       { type: Schema.Types.ObjectId, ref: 'Requirement' },
    requirementNumber: { type: String, trim: true, uppercase: true },
    goodsReceipt:   { type: Schema.Types.ObjectId, ref: 'GoodsReceipt' },
    isDeleted:      { type: Boolean, default: false },
  },
  { timestamps: true },
);

// { quotation: 1 } index is created automatically by the unique:true on the field definition.
purchaseOrderSchema.index({ department: 1, status: 1 });
purchaseOrderSchema.index({ createdBy: 1, status: 1 });
purchaseOrderSchema.index({ vendor: 1 });
purchaseOrderSchema.index({ status: 1, createdAt: -1 });
// Not unique — uniqueness for the Requirement-originated path is already enforced
// transitively via the existing unique `quotation` index (one Requirement -> one registered
// Vendor -> one winning Quotation -> one PO). This index only serves the by-requirement
// lookup used by the mobile "does a PO already exist" check.
purchaseOrderSchema.index({ requirement: 1 });

export const PurchaseOrder = model<IPurchaseOrder>('PurchaseOrder', purchaseOrderSchema);
