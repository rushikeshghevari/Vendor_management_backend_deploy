import { Router } from 'express';

import authRoutes from '@/modules/auth/auth.routes';
import activityLogRoutes from '@/modules/activityLog/activityLog.routes';
import aiAuditLogRoutes from '@/modules/aiAuditLog/aiAuditLog.routes';
import auditLogRoutes from '@/modules/auditLog/auditLog.routes';
import billRoutes from '@/modules/bill/bill.routes';
import comparisonRoutes from '@/modules/comparison/comparison.routes';
import departmentRoutes from '@/modules/department/department.routes';
import directorRoutes from '@/modules/director/director.routes';
import directorReviewRoutes from '@/modules/directorReview/directorReview.routes';
import goodsReceiptRoutes from '@/modules/goodsReceipt/goodsReceipt.routes';
import hodRoutes from '@/modules/hod/hod.routes';
import notificationRoutes from '@/modules/notification/notification.routes';
import paymentRoutes from '@/modules/payment/payment.routes';
import purchaseOrderRoutes from '@/modules/purchaseOrder/purchaseOrder.routes';
import quotationRoutes from '@/modules/quotation/quotation.routes';
import requirementRoutes from '@/modules/requirement/requirement.routes';
import settingRoutes from '@/modules/setting/setting.routes';
import userRoutes from '@/modules/user/user.routes';
import vendorRoutes from '@/modules/vendor/vendor.routes';
import vendorRegistrationRoutes from '@/modules/vendorRegistration/vendorRegistration.routes';
import vendorRegistrationLinkRoutes, { publicVendorRegistrationLinkRoutes } from '@/modules/vendorRegistrationLink/vendorRegistrationLink.routes';

import addressRoutes from '@/modules/address/address.routes';

const router = Router();

router.use('/auth', authRoutes);
router.use('/address', addressRoutes);
router.use('/departments', departmentRoutes);
router.use('/requirements', requirementRoutes);
router.use('/requirements', comparisonRoutes);
router.use('/requirements', directorReviewRoutes);
router.use('/requirements', vendorRegistrationRoutes);
router.use('/requirements', vendorRegistrationLinkRoutes);
router.use('/public/vendor-registration', publicVendorRegistrationLinkRoutes);
router.use('/hod', hodRoutes);
router.use('/users', userRoutes);
router.use('/vendors', vendorRoutes);
router.use('/quotations', quotationRoutes);
router.use('/bills', billRoutes);
router.use('/purchase-orders', purchaseOrderRoutes);
router.use('/goods-receipts', goodsReceiptRoutes);
router.use('/director', directorRoutes);
router.use('/audit-logs', auditLogRoutes);
router.use('/ai-audit-logs', aiAuditLogRoutes);
router.use('/activity-logs', activityLogRoutes);
router.use('/notifications', notificationRoutes);
router.use('/settings', settingRoutes);
router.use('/payments', paymentRoutes);

export default router;
