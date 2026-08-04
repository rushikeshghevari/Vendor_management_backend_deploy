import { Schema, model, type Document, type Types } from 'mongoose';

import { AI_RISK, AI_RECOMMENDATION, type AiRisk, type AiRecommendation } from '@/constants/status';
import { BILL_STATUS } from '@/constants/status';
import type { IAiDifference } from '@/modules/purchaseOrder/purchaseOrder.model';

export const ACCOUNTS_AUDIT_DECISIONS = [
  BILL_STATUS.VERIFIED,
  BILL_STATUS.CORRECTION_REQUESTED,
  BILL_STATUS.REJECTED,
] as const;
export type AccountsAuditDecision = (typeof ACCOUNTS_AUDIT_DECISIONS)[number];

export interface IAuditLog extends Document {
  purchaseOrder: Types.ObjectId;
  bill: Types.ObjectId;
  quotation: Types.ObjectId;
  // 3-Way AI analysis snapshot at the time of Accounts decision
  aiRecommendation: AiRecommendation;
  aiConfidence: number;
  matchPercentage: number;
  quotationMatch?: number;
  purchaseOrderMatch?: number;
  risk: AiRisk;
  differenceCount: number;
  differences: IAiDifference[];
  // Director Financial Approval snapshot (Approval 2)
  directorFinancialDecision?: string;
  directorFinancialBy?: Types.ObjectId;
  directorFinancialRemarks?: string;
  directorFinancialAt?: Date;
  // Accounts decision
  accountsDecision: AccountsAuditDecision;
  reason?: string;
  decidedBy: Types.ObjectId;
  decidedByName: string;
  decidedByRole: string;
  decidedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const auditDifferenceSchema = new Schema<IAiDifference>(
  {
    field:         { type: String, required: true },
    purchaseOrder: { type: Schema.Types.Mixed },
    bill:          { type: Schema.Types.Mixed },
    difference:    { type: String, required: true },
  },
  { _id: false },
);

const auditLogSchema = new Schema<IAuditLog>(
  {
    purchaseOrder: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
    bill:          { type: Schema.Types.ObjectId, ref: 'Bill',          required: true },
    quotation:     { type: Schema.Types.ObjectId, ref: 'Quotation',     required: true },
    aiRecommendation:    { type: String, enum: Object.values(AI_RECOMMENDATION), required: true },
    aiConfidence:        { type: Number, required: true, min: 0, max: 100 },
    matchPercentage:     { type: Number, required: true, min: 0, max: 100 },
    quotationMatch:      { type: Number, min: 0, max: 100 },
    purchaseOrderMatch:  { type: Number, min: 0, max: 100 },
    risk:                { type: String, enum: Object.values(AI_RISK), required: true },
    differenceCount:     { type: Number, required: true, min: 0 },
    differences:         { type: [auditDifferenceSchema], default: [] },
    // Director Financial Approval snapshot
    directorFinancialDecision: { type: String, trim: true },
    directorFinancialBy:       { type: Schema.Types.ObjectId, ref: 'User' },
    directorFinancialRemarks:  { type: String, trim: true },
    directorFinancialAt:       { type: Date },
    accountsDecision:  { type: String, enum: ACCOUNTS_AUDIT_DECISIONS, required: true },
    reason:            { type: String, trim: true },
    decidedBy:         { type: Schema.Types.ObjectId, ref: 'User', required: true },
    decidedByName:     { type: String, required: true },
    decidedByRole:     { type: String, required: true },
    decidedAt:         { type: Date, required: true, default: Date.now },
  },
  { timestamps: true },
);

auditLogSchema.index({ purchaseOrder: 1 });
auditLogSchema.index({ bill: 1 });
auditLogSchema.index({ decidedAt: -1 });
auditLogSchema.index({ accountsDecision: 1, decidedAt: -1 });

export const AuditLog = model<IAuditLog>('AuditLog', auditLogSchema);
