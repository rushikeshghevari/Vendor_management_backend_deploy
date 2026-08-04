import { Schema, model, type Document, type Types } from 'mongoose';

import {
  PAYMENT_FAILURE_REASON,
  PAYMENT_METHOD,
  PAYMENT_STATUS,
  type PaymentFailureReason,
  type PaymentMethod,
  type PaymentStatus,
} from '@/constants/status';

export interface IPaymentHistoryEntry {
  status: PaymentStatus;
  remarks?: string;
  failureReason?: PaymentFailureReason;
  retryNumber?: number;
  changedBy: Types.ObjectId;
  changedAt: Date;
}

export interface IPayment extends Document {
  paymentCode: string;
  bill: Types.ObjectId;
  quotation: Types.ObjectId;
  vendor: Types.ObjectId;
  department: Types.ObjectId;
  amount: number;
  gst: number;
  invoiceNumber: string;
  invoiceDate: Date;
  paymentMethod?: PaymentMethod;
  bankName?: string;
  accountNumber?: string;
  ifsc?: string;
  upiId?: string;
  utrNumber?: string;
  transactionReference?: string;
  chequeNumber?: string;
  paymentDate?: Date;
  remarks?: string;
  status: PaymentStatus;
  retryCount: number;
  history: IPaymentHistoryEntry[];
  createdBy: Types.ObjectId;
  processedBy?: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const historyEntrySchema = new Schema<IPaymentHistoryEntry>(
  {
    status: { type: String, enum: Object.values(PAYMENT_STATUS), required: true },
    remarks: { type: String, trim: true },
    failureReason: { type: String, enum: Object.values(PAYMENT_FAILURE_REASON) },
    retryNumber: { type: Number },
    changedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    changedAt: { type: Date, required: true, default: Date.now },
  },
  { _id: false },
);

const paymentSchema = new Schema<IPayment>(
  {
    paymentCode: { type: String, required: true, trim: true, uppercase: true, unique: true },
    // One Verified Bill -> one Payment, enforced here plus the create() existence check —
    // a Failed payment is always retried in place, never as a second document.
    bill: { type: Schema.Types.ObjectId, ref: 'Bill', required: true, unique: true },
    quotation: { type: Schema.Types.ObjectId, ref: 'Quotation', required: true },
    vendor: { type: Schema.Types.ObjectId, ref: 'Vendor', required: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department', required: true },
    amount: { type: Number, required: true, min: 0 },
    gst: { type: Number, required: true, min: 0 },
    invoiceNumber: { type: String, required: true, trim: true },
    invoiceDate: { type: Date, required: true },
    paymentMethod: { type: String, enum: Object.values(PAYMENT_METHOD) },
    bankName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifsc: { type: String, trim: true, uppercase: true },
    upiId: { type: String, trim: true },
    utrNumber: { type: String, trim: true },
    transactionReference: { type: String, trim: true },
    chequeNumber: { type: String, trim: true },
    paymentDate: { type: Date },
    remarks: { type: String, trim: true },
    status: {
      type: String,
      enum: Object.values(PAYMENT_STATUS),
      default: PAYMENT_STATUS.PAYMENT_PENDING,
    },
    retryCount: { type: Number, default: 0 },
    history: { type: [historyEntrySchema], default: [] },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    processedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true },
);

paymentSchema.index({ department: 1, status: 1 });
paymentSchema.index({ vendor: 1 });
paymentSchema.index({ status: 1 });

export const Payment = model<IPayment>('Payment', paymentSchema);
