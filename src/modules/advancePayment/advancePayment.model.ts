import { Schema, model, type Document, type Types } from 'mongoose';

import { ADVANCE_PAYMENT_STATUS, type AdvancePaymentStatus } from '@/constants/status';

export const ADVANCE_PAYMENT_HISTORY_EVENTS = ['created', 'accounts_verified', 'payment_made'] as const;
export type AdvancePaymentHistoryEvent = (typeof ADVANCE_PAYMENT_HISTORY_EVENTS)[number];

export interface IAdvancePaymentHistoryEntry {
  event: AdvancePaymentHistoryEvent;
  status: AdvancePaymentStatus;
  remarks?: string;
  actorId?: Types.ObjectId;
  actorName?: string;
  actorRole?: string;
  at: Date;
}

/**
 * One per Requirement whose Director-approved winning Quotation carries an `advanceAmount` —
 * created automatically the moment that approval happens (see directorReview.controller.ts).
 * Tracked independently of the Bill/Payment lifecycle: the advance is due to the vendor before
 * any Purchase Order, Goods Receipt, or Bill exists for this Requirement at all, so it can't
 * reuse that machinery. Status: pending_verification (Accounts) -> pending_payment (Payment
 * Department) -> paid.
 */
export interface IAdvancePayment extends Document {
  requirement: Types.ObjectId;
  requirementNumber: string;
  quotation: Types.ObjectId;
  quotationCode: string;
  department: Types.ObjectId;
  createdBy: Types.ObjectId;
  // Set once the real Vendor exists (registration can happen after this record is created) —
  // until then, `vendorName` alone (from the quotation's temporaryVendor) is all there is.
  vendor?: Types.ObjectId;
  vendorName: string;
  totalAmount: number;
  advanceAmount: number;
  // Always `totalAmount - advanceAmount` at creation time — a fixed snapshot, not recomputed
  // later, since the eventual real Bill is what actually reconciles the final amount due.
  balanceAmount: number;
  // The department's own planned PO-raise date (Quotation.expectedPODate) — the real deadline
  // for this advance, since a vendor typically won't confirm the order until it's paid.
  dueDate?: Date;
  status: AdvancePaymentStatus;
  accountsVerifiedBy?: Types.ObjectId;
  accountsVerifiedAt?: Date;
  accountsRemarks?: string;
  paidBy?: Types.ObjectId;
  paidAt?: Date;
  paymentReference?: string;
  paymentRemarks?: string;
  history: IAdvancePaymentHistoryEntry[];
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const historyEntrySchema = new Schema<IAdvancePaymentHistoryEntry>(
  {
    event: { type: String, enum: ADVANCE_PAYMENT_HISTORY_EVENTS, required: true },
    status: { type: String, enum: Object.values(ADVANCE_PAYMENT_STATUS), required: true },
    remarks: { type: String, trim: true },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorName: { type: String, trim: true },
    actorRole: { type: String, trim: true },
    at: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const advancePaymentSchema = new Schema<IAdvancePayment>(
  {
    requirement: { type: Schema.Types.ObjectId, ref: 'Requirement', required: true },
    requirementNumber: { type: String, required: true, trim: true, uppercase: true },
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true, unique: true },
    quotationCode: { type: String, required: true, trim: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    vendorName: { type: String, required: true, trim: true },
    totalAmount: { type: Number, required: true, min: 0 },
    advanceAmount: { type: Number, required: true, min: 0 },
    balanceAmount: { type: Number, required: true, min: 0 },
    dueDate: { type: Date },
    status: {
      type: String,
      enum: Object.values(ADVANCE_PAYMENT_STATUS),
      default: ADVANCE_PAYMENT_STATUS.PENDING_VERIFICATION,
    },
    accountsVerifiedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    accountsVerifiedAt: { type: Date },
    accountsRemarks: { type: String, trim: true },
    paidBy: { type: Schema.Types.ObjectId, ref: 'User' },
    paidAt: { type: Date },
    paymentReference: { type: String, trim: true },
    paymentRemarks: { type: String, trim: true },
    history: { type: [historyEntrySchema], default: [] },
    isDeleted: { type: Boolean, default: false },
  },
  { timestamps: true },
);

advancePaymentSchema.index({ department: 1, status: 1 });
advancePaymentSchema.index({ createdBy: 1 });
advancePaymentSchema.index({ requirement: 1 });
advancePaymentSchema.index({ status: 1 });

export const AdvancePayment = model<IAdvancePayment>('AdvancePayment', advancePaymentSchema);
