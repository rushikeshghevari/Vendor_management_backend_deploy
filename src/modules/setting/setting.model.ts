import { Schema, model, type Document } from 'mongoose';

export interface ISystemSetting extends Document<string> {
  ceoApprovalLimit: number;
}

/** True singleton — always read/written via the fixed `_id: 'system'`, never listed/queried. */
const systemSettingSchema = new Schema<ISystemSetting>(
  {
    _id: { type: String, required: true },
    ceoApprovalLimit: { type: Number, required: true, min: 0, default: 50000 },
  },
  { timestamps: true },
);

export const SystemSetting = model<ISystemSetting>('SystemSetting', systemSettingSchema);
