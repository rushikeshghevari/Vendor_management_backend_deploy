import { Schema, model, type Document } from 'mongoose';

export type QueueStatus = 'pending' | 'processing' | 'done' | 'dead';

export interface INotificationQueue extends Document {
  token:      string;
  userId:     string;
  payload:    Record<string, unknown>;
  retryCount: number;
  maxRetries: number;
  nextRetryAt: Date;
  lastError?:  string;
  status:      QueueStatus;
  createdAt:   Date;
  updatedAt:   Date;
}

const notificationQueueSchema = new Schema<INotificationQueue>(
  {
    token:       { type: String, required: true },
    userId:      { type: String, required: true },
    payload:     { type: Schema.Types.Mixed, required: true },
    retryCount:  { type: Number, default: 0 },
    maxRetries:  { type: Number, default: 5 },
    nextRetryAt: { type: Date, required: true },
    lastError:   { type: String },
    status:      { type: String, enum: ['pending', 'processing', 'done', 'dead'], default: 'pending' },
  },
  { timestamps: true },
);

// Efficiently find items ready to retry
notificationQueueSchema.index({ status: 1, nextRetryAt: 1 });
// Expire dead/done items after 7 days
notificationQueueSchema.index({ updatedAt: 1 }, { expireAfterSeconds: 604800 });

export const NotificationQueue = model<INotificationQueue>('NotificationQueue', notificationQueueSchema);
