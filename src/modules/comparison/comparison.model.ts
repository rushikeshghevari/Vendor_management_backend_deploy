import { Schema, model, type Document, type Types } from 'mongoose';

/** One quotation's comparable fields at the time a comparison was generated — a snapshot,
 *  not a live reference, so a later edit to the quotation/OCR data never silently changes a
 *  past comparison's numbers (mirrors why `directorApprovals`/`AuditLog` also snapshot). */
export interface IComparisonQuotationSnapshot {
  quotation: Types.ObjectId;
  quotationCode: string;
  vendorName: string;
  hasAttachment: boolean;
  ocrStatus: string;
  ocrConfidence?: number;
  currency?: string;
  grandTotal?: number;
  grandTotalSource: 'ocr' | 'quotation';
  gstAmount?: number;
  discount?: number;
  paymentTerms?: string;
  deliveryTerms?: string;
  deliveryDays?: number;
  quotationDate?: string;
  /** Reserved — neither the Quotation model nor Phase 3's OCR structured data currently
   *  track a validity period. Always undefined today; see docs/PHASE4_AI_COMPARISON.md. */
  validity?: string;
  itemCount: number;
}

export interface IComparisonItemEntry {
  itemName: string;
  status: 'matched' | 'missing' | 'extra';
  requirementQuantity?: number;
  quotationQuantity?: number;
  quantityMismatch: boolean;
  requirementRate?: number;
  quotationUnitPrice?: number;
  unitPriceDifference?: number;
  requirementAmount?: number;
  quotationAmount?: number;
  amountMismatch: boolean;
}

export interface IComparisonItemComparison {
  quotation: Types.ObjectId;
  quotationCode: string;
  items: IComparisonItemEntry[];
  missingItemCount: number;
  extraItemCount: number;
  quantityMismatchCount: number;
}

export const COMPARISON_OBSERVATION_TYPES = [
  'lowest_quotation',
  'highest_quotation',
  'missing_documents',
  'suspicious_price_difference',
  'quantity_inconsistency',
  'duplicate_quotation',
  'ocr_confidence_warning',
] as const;
export type ComparisonObservationType = (typeof COMPARISON_OBSERVATION_TYPES)[number];

export const COMPARISON_OBSERVATION_SEVERITIES = ['info', 'warning', 'critical'] as const;
export type ComparisonObservationSeverity = (typeof COMPARISON_OBSERVATION_SEVERITIES)[number];

export interface IComparisonObservation {
  type: ComparisonObservationType;
  severity: ComparisonObservationSeverity;
  message: string;
  quotation?: Types.ObjectId;
}

export interface IComparisonStatistics {
  totalQuotations: number;
  lowestPrice?: number;
  highestPrice?: number;
  averagePrice?: number;
  costDifference?: number;
  budgetVarianceAmount?: number;
  budgetVariancePercent?: number;
}

export interface IComparisonRecommendation {
  quotation?: Types.ObjectId;
  quotationCode?: string;
  reason: string;
  /** Always true — a comparison is a recommendation, never an approval. Kept as a stored
   *  field (not just a UI label) so it survives even if the record is read outside the app. */
  isAdvisoryOnly: true;
}

export interface IComparison extends Document {
  requirement: Types.ObjectId;
  quotations: IComparisonQuotationSnapshot[];
  statistics: IComparisonStatistics;
  itemComparison: IComparisonItemComparison[];
  observations: IComparisonObservation[];
  recommendation: IComparisonRecommendation;
  generatedAt: Date;
  generatedBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const quotationSnapshotSchema = new Schema<IComparisonQuotationSnapshot>(
  {
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true },
    quotationCode: { type: String, required: true, trim: true },
    vendorName: { type: String, required: true, trim: true },
    hasAttachment: { type: Boolean, required: true, default: false },
    ocrStatus: { type: String, required: true },
    ocrConfidence: { type: Number, min: 0, max: 100 },
    currency: { type: String, trim: true },
    grandTotal: { type: Number },
    grandTotalSource: { type: String, enum: ['ocr', 'quotation'], required: true },
    gstAmount: { type: Number },
    discount: { type: Number },
    paymentTerms: { type: String, trim: true },
    deliveryTerms: { type: String, trim: true },
    deliveryDays: { type: Number },
    quotationDate: { type: String, trim: true },
    validity: { type: String, trim: true },
    itemCount: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const itemEntrySchema = new Schema<IComparisonItemEntry>(
  {
    itemName: { type: String, required: true, trim: true },
    status: { type: String, enum: ['matched', 'missing', 'extra'], required: true },
    requirementQuantity: { type: Number },
    quotationQuantity: { type: Number },
    quantityMismatch: { type: Boolean, required: true, default: false },
    requirementRate: { type: Number },
    quotationUnitPrice: { type: Number },
    unitPriceDifference: { type: Number },
    requirementAmount: { type: Number },
    quotationAmount: { type: Number },
    amountMismatch: { type: Boolean, required: true, default: false },
  },
  { _id: false },
);

const itemComparisonSchema = new Schema<IComparisonItemComparison>(
  {
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true },
    quotationCode: { type: String, required: true, trim: true },
    items: { type: [itemEntrySchema], default: [] },
    missingItemCount: { type: Number, required: true, default: 0 },
    extraItemCount: { type: Number, required: true, default: 0 },
    quantityMismatchCount: { type: Number, required: true, default: 0 },
  },
  { _id: false },
);

const observationSchema = new Schema<IComparisonObservation>(
  {
    type: { type: String, enum: COMPARISON_OBSERVATION_TYPES, required: true },
    severity: { type: String, enum: COMPARISON_OBSERVATION_SEVERITIES, required: true },
    message: { type: String, required: true, trim: true },
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation' },
  },
  { _id: false },
);

const statisticsSchema = new Schema<IComparisonStatistics>(
  {
    totalQuotations: { type: Number, required: true, default: 0 },
    lowestPrice: { type: Number },
    highestPrice: { type: Number },
    averagePrice: { type: Number },
    costDifference: { type: Number },
    budgetVarianceAmount: { type: Number },
    budgetVariancePercent: { type: Number },
  },
  { _id: false },
);

const recommendationSchema = new Schema<IComparisonRecommendation>(
  {
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation' },
    quotationCode: { type: String, trim: true },
    reason: { type: String, required: true, trim: true },
    isAdvisoryOnly: { type: Boolean, required: true, default: true },
  },
  { _id: false },
);

const comparisonSchema = new Schema<IComparison>(
  {
    requirement: { type: Schema.Types.ObjectId, ref: 'Requirement', required: true },
    quotations: { type: [quotationSnapshotSchema], default: [] },
    statistics: { type: statisticsSchema, required: true },
    itemComparison: { type: [itemComparisonSchema], default: [] },
    observations: { type: [observationSchema], default: [] },
    recommendation: { type: recommendationSchema, required: true },
    generatedAt: { type: Date, required: true, default: Date.now },
    generatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// Every read is "give me the latest comparison for this requirement" — never overwritten,
// each generate() call inserts a new row (same append-only idiom as ActivityLog/AuditLog).
comparisonSchema.index({ requirement: 1, generatedAt: -1 });

export const Comparison = model<IComparison>('Comparison', comparisonSchema);
