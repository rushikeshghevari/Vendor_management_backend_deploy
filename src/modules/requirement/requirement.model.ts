import { Schema, model, type Document, type Types } from 'mongoose';

import {
  REQUIREMENT_APPROVAL_STATUS,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUS,
  type RequirementApprovalStatus,
  type RequirementPriority,
  type RequirementStatus,
} from '@/constants/status';

// ─── Sub-document: Requirement Item ───────────────────────────────────────────
export interface IRequirementItem {
  itemName: string;
  specification?: string;
  quantity: number;
  unit: string;
  estimatedRate: number;
  estimatedAmount: number;
  remarks?: string;
}

const requirementItemSchema = new Schema<IRequirementItem>(
  {
    itemName:       { type: String, required: true, trim: true },
    specification:  { type: String, trim: true },
    quantity:       { type: Number, required: true, min: 0 },
    unit:           { type: String, required: true, trim: true },
    estimatedRate:  { type: Number, required: true, min: 0 },
    estimatedAmount:{ type: Number, required: true, min: 0 },
    remarks:        { type: String, trim: true },
  },
  { _id: false },
);

export interface IRequirement extends Document {
  requirementNumber: string;
  department: Types.ObjectId;
  createdBy: Types.ObjectId;
  title: string;
  description?: string;
  priority: RequirementPriority;
  budget: number;
  requiredDate: Date;
  status: RequirementStatus;
  remarks?: string;
  approvalStatus: RequirementApprovalStatus;
  items: IRequirementItem[];
  isDeleted: boolean;
  submittedAt?: Date;
  submittedBy?: Types.ObjectId;
  /** Set once this requirement's vendor step is done — whether a fresh Vendor was created for
   *  it (`Vendor.createdFromRequirement` also points back here) or an already-registered Vendor
   *  was reused (`vendorRegistrationService.linkExistingVendor`, where `createdFromRequirement`
   *  still points at whichever requirement originally created that Vendor). This field is the
   *  single lookup every later stage (PO generation) should use, since `createdFromRequirement`
   *  alone can't resolve a reused vendor back to a Requirement it wasn't created from. */
  finalizedVendor?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const requirementSchema = new Schema<IRequirement>(
  {
    requirementNumber: { type: String, required: true, trim: true, uppercase: true, unique: true },
    department:  { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    createdBy:   { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title:       { type: String, required: true, trim: true },
    description: { type: String, trim: true },
    priority:    { type: String, enum: REQUIREMENT_PRIORITIES, default: 'medium' },
    budget:      { type: Number, required: true, min: 0 },
    requiredDate:{ type: Date, required: true },
    status: {
      type: String,
      enum: Object.values(REQUIREMENT_STATUS),
      default: REQUIREMENT_STATUS.DRAFT,
    },
    remarks: { type: String, trim: true },
    approvalStatus: {
      type: String,
      enum: Object.values(REQUIREMENT_APPROVAL_STATUS),
      default: REQUIREMENT_APPROVAL_STATUS.PENDING,
    },
    items:      { type: [requirementItemSchema], required: true, default: [] },
    isDeleted:  { type: Boolean, default: false },
    submittedAt:{ type: Date },
    submittedBy:{ type: Schema.Types.ObjectId, ref: 'User' },
    finalizedVendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
  },
  { timestamps: true },
);

requirementSchema.index({ department: 1, status: 1 });
// Every Department User's list/filter query is scoped by `createdBy` (see scopeToOwner in
// requirement.service.ts) — without this, that's a full collection scan on every request.
requirementSchema.index({ createdBy: 1, status: 1 });

export const Requirement = model<IRequirement>('Requirement', requirementSchema);
