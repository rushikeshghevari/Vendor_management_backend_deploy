import { Schema, model, type Document, type Types } from 'mongoose';

import type { Role } from '@/constants/roles';
import { ROLES } from '@/constants/roles';

export const NOTIFICATION_MODULES = ['requirement', 'quotation', 'bill', 'payment', 'purchase_order', 'vendor', 'system'] as const;
export type NotificationModule = (typeof NOTIFICATION_MODULES)[number];

export const NOTIFICATION_TYPES = [
  // Requirement
  'requirement_submitted',
  'quotation_added',
  'requirement_ready_for_review',
  'quotation_ocr_completed',
  'quotation_ocr_failed',
  'comparison_generated',
  'director_review_approved',
  'director_review_rejected',
  'director_review_sent_back',
  'vendor_registered',
  // Quotation
  'quotation_submitted',
  'quotation_reviewed',
  'review_pending',
  'quotation_negotiation',
  'quotation_rejected',
  'quotation_resubmitted',
  'quotation_approved',
  // FYI copy of 'quotation_approved' sent to Accounts/Payment/CEO — same event, a different
  // audience than the Department User's own "your quotation was approved" notification.
  'quotation_approved_fyi',
  // Bill — business lifecycle
  'bill_submitted',
  'bill_reviewed',
  'bill_review_pending',
  'bill_negotiation',
  'bill_rejected',
  'bill_resubmitted',
  'bill_approved',
  'bill_verified',
  // Bill — AI + Director Financial Approval (new 3-way workflow)
  'bill_ai_verified',
  'bill_financial_approval_required',
  'bill_financial_approved',
  'bill_financial_rejected',
  'bill_director_correction_required',
  'ai_high_risk_alert',
  'bill_ai_blocked',
  // Payment
  'payment_pending',
  'payment_created',
  'payment_processing',
  'payment_paid',
  'payment_completed',
  'payment_failed',
  // Purchase Order
  'po_generated',
  'po_bill_uploaded',
  'po_ai_verified',
  'po_accounts_verified',
  'po_closed',
  'po_emailed',
  'goods_receipt_recorded',
  // Vendor
  'vendor_created',
  'vendor_updated',
  'vendor_inactive',
  // HOD / Department user management
  'hod_assigned',
  'hod_transferred',
  'department_user_created',
  'department_user_disabled',
  // AI
  'ai_verification_started',
  'ai_verification_completed',
  // System / Broadcast / Escalation
  'system_announcement',
  'broadcast',
  'escalation',
  'reminder',
  // Recurring Expense
  'recurring_expense_due',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_PRIORITIES = ['low', 'medium', 'high', 'critical'] as const;
export type NotificationPriority = (typeof NOTIFICATION_PRIORITIES)[number];

export const NOTIFICATION_CATEGORIES = ['information', 'success', 'warning', 'error'] as const;
export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export const PUSH_DELIVERY_STATUSES = ['pending', 'sent', 'failed'] as const;
export type PushDeliveryStatus = (typeof PUSH_DELIVERY_STATUSES)[number];

// Overall delivery lifecycle of the notification record itself — distinct from
// `pushDeliveryStatus`, which only tracks the FCM push channel. `status` mirrors
// isRead/isDelivered so both can be queried directly without recomputing from flags.
export const NOTIFICATION_STATUSES = ['pending', 'sent', 'read', 'failed'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export interface INotification extends Document {
  title: string;
  message: string;
  module: NotificationModule;
  relatedRecord: Types.ObjectId;
  sender?: Types.ObjectId;
  receiver: Types.ObjectId;
  receiverRole: Role;
  notificationType: NotificationType;
  priority: NotificationPriority;
  category: NotificationCategory;
  isRead: boolean;
  isArchived: boolean;
  isPinned: boolean;
  isDeleted: boolean;
  isPushSent: boolean;
  pushDeliveryStatus: PushDeliveryStatus;
  pushSentAt?: Date;
  pushFailedAt?: Date;
  pushRetryCount: number;
  clickedAt?: Date;
  // Delivery tracking (enterprise-grade idempotency — see notification.service.ts)
  status: NotificationStatus;
  isDelivered: boolean;
  deliveryCount: number;
  lastSentAt?: Date;
  // Set only when a caller explicitly opts a notification into "send exactly once,
  // ever" semantics (e.g. escalation:24h:<quotationId>:<receiverId>). A partial unique
  // index below rejects a second insert with the same key at the database level, so a
  // scheduler that re-derives "should I notify" from mutable business state on every
  // run (or on every server restart) can never produce a duplicate.
  dedupKey?: string;
  // Follow-up reminder — the one deliberate exception to "send once": a single
  // reminder fires at followUpDate, then followUpSent latches true forever.
  followUpDate?: Date;
  followUpSent: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<INotification>(
  {
    title:            { type: String, required: true, trim: true },
    message:          { type: String, required: true, trim: true },
    module:           { type: String, enum: NOTIFICATION_MODULES, required: true },
    relatedRecord:    { type: Schema.Types.ObjectId, required: true },
    sender:           { type: Schema.Types.ObjectId, ref: 'User' },
    receiver:         { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receiverRole:     { type: String, enum: Object.values(ROLES), required: true },
    notificationType: { type: String, enum: NOTIFICATION_TYPES, required: true },
    priority:         { type: String, enum: NOTIFICATION_PRIORITIES, default: 'medium' },
    category:         { type: String, enum: NOTIFICATION_CATEGORIES, default: 'information' },
    isRead:              { type: Boolean, default: false },
    isArchived:          { type: Boolean, default: false },
    isPinned:            { type: Boolean, default: false },
    isDeleted:           { type: Boolean, default: false },
    isPushSent:          { type: Boolean, default: false },
    pushDeliveryStatus:  { type: String, enum: PUSH_DELIVERY_STATUSES, default: 'pending' },
    pushSentAt:          { type: Date },
    pushFailedAt:        { type: Date },
    pushRetryCount:      { type: Number, default: 0 },
    clickedAt:           { type: Date },
    status:              { type: String, enum: NOTIFICATION_STATUSES, default: 'pending' },
    isDelivered:         { type: Boolean, default: false },
    deliveryCount:       { type: Number, default: 0 },
    lastSentAt:          { type: Date },
    dedupKey:            { type: String },
    followUpDate:        { type: Date },
    followUpSent:        { type: Boolean, default: false },
  },
  { timestamps: true },
);

notificationSchema.index({ receiver: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ receiver: 1, isArchived: 1, createdAt: -1 });
notificationSchema.index({ receiver: 1, isPinned: 1, createdAt: -1 });
notificationSchema.index({ receiver: 1, isDeleted: 1, createdAt: -1 });
// Idempotency guard — a second insert with the same dedupKey is rejected by MongoDB
// itself (E11000), so this holds even across concurrent requests or process restarts.
// Partial (not sparse): only documents that actually set dedupKey participate, exactly
// equivalent for a String field, and consistent with this codebase's other partial
// unique indexes (see bill.model.ts) which use $exists rather than $ne (unsupported).
notificationSchema.index(
  { dedupKey: 1 },
  { unique: true, partialFilterExpression: { dedupKey: { $exists: true } } },
);
// Reminder scheduler's query: due, not-yet-sent follow-ups.
notificationSchema.index({ followUpDate: 1, followUpSent: 1 });

export const Notification = model<INotification>('Notification', notificationSchema);
