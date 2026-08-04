import { Schema, model, type Document, type Types } from 'mongoose';

import { GRN_ITEM_CONDITION, GRN_OVERALL_CONDITION, type GrnItemCondition, type GrnOverallCondition } from '@/constants/status';

// ─── Sub-document: Received Line Item ─────────────────────────────────────────
export interface IGoodsReceiptItem {
  itemName: string;
  orderedQuantity: number;
  receivedQuantity: number;
  condition: GrnItemCondition;
  remarks?: string;
}

// ─── Main Document Interface ───────────────────────────────────────────────────
export interface IGoodsReceipt extends Document {
  grnNumber: string;
  // One Goods Receipt per Purchase Order (a single completion event, not partial/incremental
  // receipts — mirrors the one-PO-per-quotation simplicity already established for PO/Bill).
  purchaseOrder: Types.ObjectId;
  poNumber: string;
  // Set only when the linked PO is itself Requirement-originated (Phase 7). This is what
  // billService.create() checks to decide whether Goods Receipt is a mandatory gate — a
  // legacy quotation-only PO's Goods Receipt (if ever recorded) leaves these undefined and
  // has no effect on Bill creation.
  requirement?: Types.ObjectId;
  requirementNumber?: string;
  vendor: Types.ObjectId;
  vendorName: string;
  department: Types.ObjectId;
  departmentName: string;
  createdBy: Types.ObjectId;
  receivedDate: Date;
  items: IGoodsReceiptItem[];
  overallCondition: GrnOverallCondition;
  remarks?: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Sub-schema ─────────────────────────────────────────────────────────────────
const goodsReceiptItemSchema = new Schema<IGoodsReceiptItem>(
  {
    itemName:         { type: String, required: true, trim: true },
    orderedQuantity:  { type: Number, required: true, min: 0 },
    receivedQuantity: { type: Number, required: true, min: 0 },
    condition:        { type: String, enum: Object.values(GRN_ITEM_CONDITION), required: true },
    remarks:          { type: String, trim: true },
  },
  { _id: false },
);

// ─── Main Schema ───────────────────────────────────────────────────────────────
const goodsReceiptSchema = new Schema<IGoodsReceipt>(
  {
    grnNumber: {
      type: String, required: true, unique: true, uppercase: true, trim: true,
    },
    // One PO -> at most one Goods Receipt.
    purchaseOrder: { type: Schema.Types.ObjectId, ref: 'PurchaseOrder', required: true, unique: true },
    poNumber:       { type: String, required: true, trim: true, uppercase: true },
    requirement:       { type: Schema.Types.ObjectId, ref: 'Requirement' },
    requirementNumber: { type: String, trim: true, uppercase: true },
    vendor:        { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    vendorName:    { type: String, required: true, trim: true },
    department:     { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    departmentName: { type: String, required: true, trim: true },
    createdBy:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receivedDate:   { type: Date, required: true },
    items:          { type: [goodsReceiptItemSchema], required: true },
    overallCondition: { type: String, enum: Object.values(GRN_OVERALL_CONDITION), required: true },
    remarks:        { type: String, trim: true },
    isDeleted:      { type: Boolean, default: false },
  },
  { timestamps: true },
);

// { purchaseOrder: 1 } index is created automatically by the unique:true on the field definition.
goodsReceiptSchema.index({ requirement: 1 });
goodsReceiptSchema.index({ department: 1, createdAt: -1 });
goodsReceiptSchema.index({ createdBy: 1, createdAt: -1 });

export const GoodsReceipt = model<IGoodsReceipt>('GoodsReceipt', goodsReceiptSchema);
