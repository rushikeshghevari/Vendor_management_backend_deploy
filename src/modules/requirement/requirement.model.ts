import { Schema, model, type Document, type Types } from 'mongoose';

import {
  REQUIREMENT_APPROVAL_STATUS,
  REQUIREMENT_PRIORITIES,
  REQUIREMENT_STATUS,
  type RequirementApprovalStatus,
  type RequirementPriority,
  type RequirementStatus,
} from '@/constants/status';

// ─── Sub-document: Routing History Entry (Phase 12) ───────────────────────────
// One entry per forward action — a department may forward at most once while it owns the
// Requirement (enforced in requirement.service.ts, not here). `editedAt` is set when the
// *latest* entry's `toDepartment` is corrected via the forward/edit action; there is no
// deadline on that correction (confirmed decision — see docs/
// PHASE12_DEPARTMENT_ROUTING_AND_GOODS_HANDOVER.md).
export interface IRoutingHistoryEntry {
  fromDepartment: Types.ObjectId;
  toDepartment: Types.ObjectId;
  forwardedBy: Types.ObjectId;
  forwardedAt: Date;
  editedAt?: Date;
}

const routingHistoryEntrySchema = new Schema<IRoutingHistoryEntry>(
  {
    fromDepartment: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    toDepartment:   { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    forwardedBy:    { type: Schema.Types.ObjectId, ref: 'User', required: true },
    forwardedAt:    { type: Date, required: true },
    editedAt:       { type: Date },
  },
  { _id: false },
);

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
  /** The requester's own department at creation time — always set, even when `department`
   *  (above) is a different, routed-to department via targetDepartment. Stored redundantly
   *  (rather than derived by populating createdBy.department) so requirement.service.ts's
   *  visibility/write-scope filters can query "was this routed in from elsewhere" directly,
   *  without an aggregation. Equal to `department` for every requirement created the normal
   *  way (own department, no targetDepartment). */
  requestedByDepartment: Types.ObjectId;
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
  /** The Department User/HOD's own pick among the quotations they've collected — purely
   *  informational (shown to the Director as a signal, never restricts what they can approve).
   *  Set/cleared via PATCH /requirements/:id/quotations/:quotationId/prepared. */
  preparedQuotation?: Types.ObjectId;
  /** When `preparedQuotation` was last set — lets a consumer (e.g. the external Payments API)
   *  show "picked on X" alongside "approved on Y" as two distinct dates, since marking a
   *  quotation prepared and a Director approving it are two separate events that can be days
   *  apart. Cleared alongside `preparedQuotation` when unmarked. */
  preparedQuotationAt?: Date;
  /** Phase 12 — set once the current owning department's HOD accepts the Requirement at the
   *  mandatory HOD_REVIEW gate (as opposed to forwarding it on). Overwritten on each
   *  acceptance if the Requirement was forwarded and later accepted by a different
   *  department's HOD — only the most recent acceptance matters operationally. */
  hodAcceptedBy?: Types.ObjectId;
  hodAcceptedAt?: Date;
  /** Phase 12 — append-only log of every forward (department hand-off) this Requirement has
   *  been through. `department` (above) always reflects the current owner; this array is the
   *  only record of how it got there. See docs/PHASE12_DEPARTMENT_ROUTING_AND_GOODS_HANDOVER.md. */
  routingHistory: IRoutingHistoryEntry[];
  createdAt: Date;
  updatedAt: Date;
}

const requirementSchema = new Schema<IRequirement>(
  {
    requirementNumber: { type: String, required: true, trim: true, uppercase: true, unique: true },
    department:  { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    requestedByDepartment: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
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
    preparedQuotation: { type: Schema.Types.ObjectId, ref: 'Quotation' },
    preparedQuotationAt: { type: Date },
    hodAcceptedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    hodAcceptedAt: { type: Date },
    routingHistory: { type: [routingHistoryEntrySchema], required: true, default: [] },
  },
  { timestamps: true },
);

requirementSchema.index({ department: 1, status: 1 });
// Every Department User's list/filter query is scoped by `createdBy` (see scopeToOwner in
// requirement.service.ts) — without this, that's a full collection scan on every request.
requirementSchema.index({ createdBy: 1, status: 1 });

export const Requirement = model<IRequirement>('Requirement', requirementSchema);
