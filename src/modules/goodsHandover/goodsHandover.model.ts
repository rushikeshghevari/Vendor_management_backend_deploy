import { Schema, model, type Document, type Types } from 'mongoose';

import { GOODS_HANDOVER_STATUS, type GoodsHandoverStatus } from '@/constants/status';

// ─── Main Document Interface ───────────────────────────────────────────────────
// Phase 12 — created once per Goods Receipt, only when the Requirement's routingHistory
// shows the Admin department as a pass-through (i.e. the department that ran the PO isn't
// Admin itself). Two-sided confirmation, mirroring the real-world hand-off: the department
// that ran the PO marks `handed_over`, then Admin separately marks `received`. Admin's
// final internal distribution (which department/user ultimately got the goods) is a plain
// log, filled in once, after `received` — no counter-acknowledgment required. See
// docs/PHASE12_DEPARTMENT_ROUTING_AND_GOODS_HANDOVER.md.
export interface IGoodsHandover extends Document {
  goodsReceipt: Types.ObjectId;
  grnNumber: string;
  requirement: Types.ObjectId;
  requirementNumber: string;
  fromDepartment: Types.ObjectId;
  fromDepartmentName: string;
  toDepartment: Types.ObjectId;
  toDepartmentName: string;
  status: GoodsHandoverStatus;
  handedOverBy?: Types.ObjectId;
  handedOverAt?: Date;
  receivedBy?: Types.ObjectId;
  receivedAt?: Date;
  distributedToDepartment?: Types.ObjectId;
  distributedToUser?: Types.ObjectId;
  distributionNote?: string;
  distributedAt?: Date;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Main Schema ───────────────────────────────────────────────────────────────
const goodsHandoverSchema = new Schema<IGoodsHandover>(
  {
    goodsReceipt: { type: Schema.Types.ObjectId, ref: 'GoodsReceipt', required: true, unique: true },
    grnNumber:    { type: String, required: true, trim: true, uppercase: true },
    requirement:       { type: Schema.Types.ObjectId, ref: 'Requirement', required: true },
    requirementNumber: { type: String, required: true, trim: true, uppercase: true },
    fromDepartment:     { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    fromDepartmentName: { type: String, required: true, trim: true },
    toDepartment:       { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    toDepartmentName:   { type: String, required: true, trim: true },
    status: {
      type: String,
      enum: Object.values(GOODS_HANDOVER_STATUS),
      default: GOODS_HANDOVER_STATUS.PENDING,
    },
    handedOverBy: { type: Schema.Types.ObjectId, ref: 'User' },
    handedOverAt: { type: Date },
    receivedBy:   { type: Schema.Types.ObjectId, ref: 'User' },
    receivedAt:   { type: Date },
    distributedToDepartment: { type: Schema.Types.ObjectId, ref: 'Department' },
    distributedToUser:       { type: Schema.Types.ObjectId, ref: 'User' },
    distributionNote:        { type: String, trim: true, maxlength: 1000 },
    distributedAt:           { type: Date },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

// { goodsReceipt: 1 } unique index is created automatically by unique:true above.
goodsHandoverSchema.index({ requirement: 1 });
goodsHandoverSchema.index({ toDepartment: 1, status: 1 });
goodsHandoverSchema.index({ fromDepartment: 1, status: 1 });

export const GoodsHandover = model<IGoodsHandover>('GoodsHandover', goodsHandoverSchema);
