import { Schema, model, type Document, type Types } from 'mongoose';

import { ALL_ROLES, type Role } from '@/constants/roles';

/**
 * Generic action-audit trail — distinct from `AuditLog` (PO/Bill/Quotation 3-way AI-match
 * decisions) and `AiAuditLog` (Gemini verification run logs). This one records "who did what
 * to what, and from where" across department/HOD/user/vendor/quotation/PO/bill actions.
 */
export const ACTIVITY_ACTIONS = [
  'department_created',
  'department_updated',
  'hod_assigned',
  'hod_transferred',
  'hod_removed',
  'department_user_created',
  'department_user_updated',
  'department_user_deactivated',
  'department_user_reactivated',
  'vendor_created',
  'vendor_updated',
  'quotation_created',
  'quotation_submitted',
  'quotation_approved',
  'quotation_rejected',
  'purchase_order_created',
  'po_shared',
  'bill_uploaded',
  'ai_completed',
  'director_approved',
  'director_rejected',
  'accounts_approved',
  'payment_completed',
  'password_reset',
  'requirement_created',
  'requirement_updated',
  'requirement_submitted',
  'requirement_submitted_to_director',
  'quotation_ocr_completed',
  'quotation_ocr_failed',
  'comparison_generated',
  'director_review_viewed',
  'director_review_approved',
  'director_review_rejected',
  'director_review_sent_back',
  'director_review_remarks_updated',
  'vendor_registered',
  'po_emailed',
  'goods_receipt_created',
  'vendor_registration_link_generated',
  'vendor_registration_link_verified',
] as const;
export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

export interface IActivityLog extends Document {
  action: ActivityAction;
  performedBy: Types.ObjectId;
  performedByName: string;
  performedByRole: Role;
  department?: Types.ObjectId;
  targetId?: Types.ObjectId;
  targetType?: string;
  oldValue?: unknown;
  newValue?: unknown;
  ipAddress?: string;
  device?: string;
  createdAt: Date;
  updatedAt: Date;
}

const activityLogSchema = new Schema<IActivityLog>(
  {
    action:           { type: String, enum: ACTIVITY_ACTIONS, required: true },
    performedBy:      { type: Schema.Types.ObjectId, ref: 'User', required: true },
    performedByName:  { type: String, required: true, trim: true },
    performedByRole:  { type: String, enum: ALL_ROLES, required: true },
    department:       { type: Schema.Types.ObjectId, ref: 'Department' },
    targetId:         { type: Schema.Types.ObjectId },
    targetType:       { type: String, trim: true },
    oldValue:         { type: Schema.Types.Mixed },
    newValue:         { type: Schema.Types.Mixed },
    ipAddress:        { type: String, trim: true },
    device:            { type: String, trim: true },
  },
  { timestamps: true },
);

activityLogSchema.index({ department: 1, createdAt: -1 });
activityLogSchema.index({ performedBy: 1, createdAt: -1 });
activityLogSchema.index({ action: 1, createdAt: -1 });

export const ActivityLog = model<IActivityLog>('ActivityLog', activityLogSchema);
