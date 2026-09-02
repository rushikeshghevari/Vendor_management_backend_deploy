import { Schema, model, type Document, type Types } from 'mongoose';

import { RECURRING_FREQUENCY, RECURRING_MODE, type RecurringFrequency, type RecurringMode } from '@/constants/status';

export interface IReimbursementBankDetails {
  bankName: string;
  accountHolderName: string;
  accountNumber: string;
  ifscCode: string;
  upiId?: string;
}

export interface IRecurringExpense extends Document {
  title: string;
  mode: RecurringMode;
  department: Types.ObjectId;
  // Set only for `vendor_bill` mode — the vendor being paid each cycle.
  vendor?: Types.ObjectId;
  // Set only for `reimbursement` mode — the employee being paid back each cycle.
  reimbursedTo?: Types.ObjectId;
  // Set only for `reimbursement` mode — captured once here (mirrors Vendor.bankDetails) since
  // there's no Vendor record to hold it for a reimbursement payee; Payment Department reads
  // this to actually transfer the money.
  reimbursementBankDetails?: IReimbursementBankDetails;
  frequency: RecurringFrequency;
  // The amount a Director approved for the very first cycle — every later cycle's
  // invoiceAmount is compared against this, not against the immediately-preceding cycle, so a
  // string of small increases can never creep past the threshold unnoticed.
  baselineAmount: number;
  // How much a cycle's amount may exceed `baselineAmount` before it needs a fresh Director
  // approval (see billService.processRecurringBillPipeline). Kept per-series rather than a
  // single global constant since different contracts reasonably tolerate different variance.
  thresholdPercent: number;
  // Lineage back to the one-time-approved Requirement/Quotation that established this expense
  // — optional, for audit only, never read by any gate.
  originRequirement?: Types.ObjectId;
  originQuotation?: Types.ObjectId;
  nextDueDate: Date;
  isActive: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const reimbursementBankDetailsSchema = new Schema<IReimbursementBankDetails>(
  {
    bankName: { type: String, required: true, trim: true },
    accountHolderName: { type: String, required: true, trim: true },
    accountNumber: { type: String, required: true, trim: true },
    ifscCode: { type: String, required: true, trim: true, uppercase: true },
    upiId: { type: String, trim: true },
  },
  { _id: false },
);

const recurringExpenseSchema = new Schema<IRecurringExpense>(
  {
    title: { type: String, required: true, trim: true },
    mode: { type: String, enum: Object.values(RECURRING_MODE), required: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor' },
    reimbursedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    reimbursementBankDetails: { type: reimbursementBankDetailsSchema },
    frequency: { type: String, enum: Object.values(RECURRING_FREQUENCY), required: true },
    baselineAmount: { type: Number, required: true, min: 0 },
    thresholdPercent: { type: Number, required: true, default: 20, min: 0 },
    originRequirement: { type: Schema.Types.ObjectId, ref: 'Requirement' },
    originQuotation: { type: Schema.Types.ObjectId, ref: 'Quotation' },
    nextDueDate: { type: Date, required: true },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

recurringExpenseSchema.index({ department: 1, isActive: 1 });
recurringExpenseSchema.index({ nextDueDate: 1, isActive: 1 });
recurringExpenseSchema.index({ createdBy: 1 });

export const RecurringExpense = model<IRecurringExpense>('RecurringExpense', recurringExpenseSchema);
