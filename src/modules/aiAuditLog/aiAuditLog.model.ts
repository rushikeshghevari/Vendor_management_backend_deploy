import { Schema, model, type Document, type Types } from 'mongoose';

import { AI_RISK, AI_RECOMMENDATION, type AiRisk, type AiRecommendation } from '@/constants/status';

export interface IAiAuditLog extends Document {
  purchaseOrder: Types.ObjectId;
  bill: Types.ObjectId;
  triggeredBy: Types.ObjectId;
  triggeredByRole: string;
  // Prompt and raw Gemini response (truncated for storage)
  promptSnapshot: string;
  rawResponse: string;
  // Execution metrics
  executionTimeMs: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  // Result summary
  matchPercentage: number;
  risk: AiRisk;
  recommendation: AiRecommendation;
  confidence: number;
  differenceCount: number;
  // Version info
  modelVersion: string;
  promptVersion: string;
  // Status
  success: boolean;
  errorMessage?: string;
  usedFallback: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const aiAuditLogSchema = new Schema<IAiAuditLog>(
  {
    purchaseOrder:   { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true },
    bill:            { type: Schema.Types.ObjectId, ref: 'Bill',          required: true },
    triggeredBy:     { type: Schema.Types.ObjectId, ref: 'User',          required: true },
    triggeredByRole: { type: String, required: true },

    // Store truncated prompt/response — full prompts can be ~4 k chars; responses ~2 k
    promptSnapshot: { type: String, maxlength: 8000 },
    rawResponse:    { type: String, maxlength: 5000 },

    executionTimeMs: { type: Number, required: true, min: 0 },
    inputTokens:     { type: Number, required: true, min: 0 },
    outputTokens:    { type: Number, required: true, min: 0 },
    totalTokens:     { type: Number, required: true, min: 0 },

    matchPercentage:  { type: Number, required: true, min: 0, max: 100 },
    risk:             { type: String, enum: Object.values(AI_RISK), required: true },
    recommendation:   { type: String, enum: Object.values(AI_RECOMMENDATION), required: true },
    confidence:       { type: Number, required: true, min: 0, max: 100 },
    differenceCount:  { type: Number, required: true, min: 0 },

    modelVersion:  { type: String, required: true },
    promptVersion: { type: String, required: true },

    success:       { type: Boolean, required: true },
    errorMessage:  { type: String, trim: true },
    usedFallback:  { type: Boolean, required: true, default: false },
  },
  { timestamps: true },
);

aiAuditLogSchema.index({ purchaseOrder: 1 });
aiAuditLogSchema.index({ bill: 1 });
aiAuditLogSchema.index({ triggeredBy: 1 });
aiAuditLogSchema.index({ createdAt: -1 });
aiAuditLogSchema.index({ success: 1, createdAt: -1 });
aiAuditLogSchema.index({ usedFallback: 1 });

export const AiAuditLog = model<IAiAuditLog>('AiAuditLog', aiAuditLogSchema);
