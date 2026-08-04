import { SystemSetting } from '@/modules/setting/setting.model';
import type { UpdateSettingInput } from '@/modules/setting/setting.validation';

const SETTING_ID = 'system';
const DEFAULT_CEO_APPROVAL_LIMIT = 50000;

export const settingService = {
  async get() {
    const setting = await SystemSetting.findById(SETTING_ID);
    return setting ?? { ceoApprovalLimit: DEFAULT_CEO_APPROVAL_LIMIT };
  },

  async update(input: UpdateSettingInput) {
    return SystemSetting.findByIdAndUpdate(
      SETTING_ID,
      { ceoApprovalLimit: input.ceoApprovalLimit },
      { new: true, upsert: true },
    );
  },

  /** Used internally by quotation.service.ts's approval-routing logic — no document fetch
   *  when nothing has ever been configured, just the documented default. */
  async getCeoApprovalLimit(): Promise<number> {
    const setting = await SystemSetting.findById(SETTING_ID).select('ceoApprovalLimit').lean();
    return setting?.ceoApprovalLimit ?? DEFAULT_CEO_APPROVAL_LIMIT;
  },
};
