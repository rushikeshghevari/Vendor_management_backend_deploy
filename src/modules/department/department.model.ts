import { Schema, model, type Document, type Types } from 'mongoose';

export interface IDepartment extends Document {
  name: string;
  code: string;
  description?: string;
  departmentHead?: string;
  /** The department's current active HOD account, if one is assigned. See hod.service.ts / departmentService.transferHod. */
  hod?: Types.ObjectId;
  isActive: boolean;
  createdBy: Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const departmentSchema = new Schema<IDepartment>(
  {
    name: { type: String, required: true, trim: true, unique: true },
    code: { type: String, required: true, trim: true, uppercase: true, unique: true },
    description: { type: String, trim: true },
    departmentHead: { type: String, trim: true },
    hod: { type: Schema.Types.ObjectId, ref: 'User' },
    isActive: { type: Boolean, default: true },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: true },
);

// Used to check "is this user already the active HOD of another department" before
// assigning/transferring — see departmentService.create / transferHod.
departmentSchema.index({ hod: 1 });

export const Department = model<IDepartment>('Department', departmentSchema);
