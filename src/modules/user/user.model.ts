import bcrypt from 'bcryptjs';
import { Schema, model, type Document, type Types } from 'mongoose';

import { env, isProduction } from '@/config/env';
import { ALL_ROLES, type Role } from '@/constants/roles';

export interface IFcmToken {
  token: string;
  deviceId: string;
  platform: 'android' | 'ios' | 'web';
  deviceName?: string;
  createdAt: Date;
  lastUsed: Date;
  isActive: boolean;
}

export interface IUser extends Document {
  id: string;
  name: string;
  email: string;
  password: string;
  role: Role;
  department?: Types.ObjectId;
  phone?: string;
  isActive: boolean;
  lastLoginAt?: Date;
  fcmTokens: IFcmToken[];
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidate: string): Promise<boolean>;
}

const fcmTokenSchema = new Schema<IFcmToken>(
  {
    token:      { type: String, required: true },
    deviceId:   { type: String, required: true },
    platform:   { type: String, enum: ['android', 'ios', 'web'], required: true },
    deviceName: { type: String },
    lastUsed:   { type: Date, default: Date.now },
    isActive:   { type: Boolean, default: true },
  },
  { _id: false, timestamps: { createdAt: true, updatedAt: false } },
);

const userSchema = new Schema<IUser>(
  {
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    // Weak passwords (e.g. the dev Super Admin password "1") are only permitted outside production.
    password: { type: String, required: true, select: false, minlength: isProduction ? 8 : 1 },
    role: { type: String, enum: ALL_ROLES, required: true },
    department: { type: Schema.Types.ObjectId, ref: 'Department' },
    // sparse: multiple users with no phone are allowed; only *present* values must be unique.
    phone: { type: String, trim: true, unique: true, sparse: true },
    isActive: { type: Boolean, default: true },
    lastLoginAt: { type: Date },
    fcmTokens: { type: [fcmTokenSchema], default: [] },
  },
  { timestamps: true },
);

userSchema.pre('save', async function hashPassword() {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, env.bcryptSaltRounds);
});

userSchema.methods.comparePassword = function comparePassword(candidate: string): Promise<boolean> {
  return bcrypt.compare(candidate, this.password);
};

// Every HOD-scoped query (see hod.service.ts) filters by department, and Super Admin's
// user list commonly filters by role — without these, both are full collection scans.
userSchema.index({ department: 1 });
userSchema.index({ role: 1 });

export const User = model<IUser>('User', userSchema);
