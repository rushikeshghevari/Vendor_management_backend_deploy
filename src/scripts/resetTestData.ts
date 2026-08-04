import { connectDB, disconnectDB } from '@/config/db';
import { ROLES } from '@/constants/roles';
import { AiAuditLog } from '@/modules/aiAuditLog/aiAuditLog.model';
import { ActivityLog } from '@/modules/activityLog/activityLog.model';
import { AuditLog } from '@/modules/auditLog/auditLog.model';
import { RefreshToken } from '@/modules/auth/refreshToken.model';
import { Bill } from '@/modules/bill/bill.model';
import { Comparison } from '@/modules/comparison/comparison.model';
import { Department } from '@/modules/department/department.model';
import { DirectorReview } from '@/modules/directorReview/directorReview.model';
import { GoodsReceipt } from '@/modules/goodsReceipt/goodsReceipt.model';
import { Notification } from '@/modules/notification/notification.model';
import { NotificationQueue } from '@/modules/notification/notificationQueue.model';
import { Payment } from '@/modules/payment/payment.model';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { Quotation } from '@/modules/quotation/quotation.model';
import { Requirement } from '@/modules/requirement/requirement.model';
import { User } from '@/modules/user/user.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import { VendorRegistrationLink } from '@/modules/vendorRegistrationLink/vendorRegistrationLink.model';
import { logger } from '@/utils/logger';

// One-off cleanup for UAT: wipes every collection except the Super Admin user.
// SystemSetting is deliberately left untouched — it holds real app config, not test data.
async function resetTestData(): Promise<void> {
  await connectDB();

  const clear = async (name: string, deleteAll: () => Promise<{ deletedCount?: number }>): Promise<void> => {
    const { deletedCount } = await deleteAll();
    logger.info(`Cleared ${name}: ${deletedCount ?? 0} removed`);
  };

  await clear('AiAuditLog', () => AiAuditLog.deleteMany({}));
  await clear('ActivityLog', () => ActivityLog.deleteMany({}));
  await clear('AuditLog', () => AuditLog.deleteMany({}));
  await clear('RefreshToken', () => RefreshToken.deleteMany({}));
  await clear('Bill', () => Bill.deleteMany({}));
  await clear('Comparison', () => Comparison.deleteMany({}));
  await clear('Department', () => Department.deleteMany({}));
  await clear('DirectorReview', () => DirectorReview.deleteMany({}));
  await clear('GoodsReceipt', () => GoodsReceipt.deleteMany({}));
  await clear('Notification', () => Notification.deleteMany({}));
  await clear('NotificationQueue', () => NotificationQueue.deleteMany({}));
  await clear('Payment', () => Payment.deleteMany({}));
  await clear('PurchaseOrder', () => PurchaseOrder.deleteMany({}));
  await clear('Quotation', () => Quotation.deleteMany({}));
  await clear('Requirement', () => Requirement.deleteMany({}));
  await clear('Vendor', () => Vendor.deleteMany({}));
  await clear('VendorRegistrationLink', () => VendorRegistrationLink.deleteMany({}));

  const { deletedCount: usersRemoved } = await User.deleteMany({ role: { $ne: ROLES.SUPER_ADMIN } });
  logger.info(`Cleared User (non-Super Admin): ${usersRemoved} removed`);

  await disconnectDB();
}

resetTestData()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Reset failed', error);
    process.exit(1);
  });
