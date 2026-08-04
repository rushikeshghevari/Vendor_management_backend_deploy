import { ROLES, type Role } from '@/constants/roles';
import { GoodsReceipt, type IGoodsReceipt } from '@/modules/goodsReceipt/goodsReceipt.model';
import type { CreateGoodsReceiptInput, GoodsReceiptListQuery } from '@/modules/goodsReceipt/goodsReceipt.validation';
import { notificationService } from '@/modules/notification/notification.service';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import { nextSequence } from '@/utils/sequence.model';

// Same roles that may generate a Purchase Order in the first place (purchaseOrder.service.ts's
// PO_CREATE_ROLES) — the people who raised the PO are also the ones confirming what arrived.
const GRN_CREATE_ROLES: Role[] = [ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN];

// ── Scope to role (read-only for non-Dept-Users) — mirrors purchaseOrder.service.ts ─────────
function scopeToRole(actor: Actor, filter: Record<string, unknown>): void {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
  // Directors, Accounts, Payment, Super Admin — see all (read-only)
}

async function generateGrnNumber(): Promise<string> {
  const year = new Date().getFullYear();
  const seq = await nextSequence(`grn_${year}`);
  return `GRN-${year}-${String(seq).padStart(6, '0')}`;
}

const POPULATE_LIST = [
  { path: 'purchaseOrder', select: 'poNumber grandTotal status' },
  { path: 'vendor',     select: 'name code' },
  { path: 'department', select: 'name code' },
  { path: 'createdBy',  select: 'name email' },
];

export const goodsReceiptService = {

  async create(input: CreateGoodsReceiptInput, actor: Actor): Promise<IGoodsReceipt> {
    if (!GRN_CREATE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can record Goods Receipt');
    }

    const po = await PurchaseOrder.findOne({ _id: input.purchaseOrder, isDeleted: false });
    if (!po) throw ApiError.notFound('Purchase Order not found');

    if (actor.role === ROLES.DEPARTMENT_USER && po.createdBy.toString() !== actor.id) {
      throw ApiError.forbidden('You can only record Goods Receipt for a Purchase Order you generated');
    }
    if (actor.role === ROLES.HOD && po.department.toString() !== actor.department) {
      throw ApiError.forbidden('You can only record Goods Receipt for a Purchase Order in your department');
    }

    const existing = await GoodsReceipt.findOne({ purchaseOrder: po._id, isDeleted: false });
    if (existing) {
      throw ApiError.conflict('Goods Receipt has already been recorded for this Purchase Order');
    }

    const grnNumber = await generateGrnNumber();

    const receipt = await GoodsReceipt.create({
      grnNumber,
      purchaseOrder: po._id,
      poNumber: po.poNumber,
      requirement: po.requirement,
      requirementNumber: po.requirementNumber,
      vendor: po.vendor,
      vendorName: po.vendorName,
      department: po.department,
      departmentName: po.departmentName,
      createdBy: actor.id,
      receivedDate: input.receivedDate,
      items: input.items as IGoodsReceipt['items'],
      overallCondition: input.overallCondition as IGoodsReceipt['overallCondition'],
      remarks: input.remarks,
    });

    // Denormalized on the PO for quick "has Goods Receipt been recorded?" reads (mirrors how
    // `PurchaseOrder.bill` is set once a Bill is created against it).
    po.goodsReceipt = receipt._id as unknown as typeof po.goodsReceipt;
    await po.save();

    try {
      const [superAdmins, ceos, directors] = await Promise.all([
        notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN),
        notificationService.findActiveUsersByRole(ROLES.CEO),
        notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
      ]);
      const recipients = [...superAdmins, ...ceos, ...directors];
      if (recipients.length > 0) {
        await notificationService.notifyUsers(recipients, {
          title: 'Goods Receipt Recorded',
          message: `GRN ${grnNumber} recorded for PO ${po.poNumber}`,
          module: 'purchase_order',
          relatedRecord: String(receipt._id),
          notificationType: 'goods_receipt_recorded',
          // A Goods Receipt can only ever be created once per PO (unique index), so this
          // event is genuinely one-shot forever — safe to dedupe strictly.
          dedupKey: `goods_receipt_recorded:${receipt._id}`,
        });
      }
    } catch { /* non-fatal */ }

    return receipt;
  },

  async list(query: GoodsReceiptListQuery, actor: Actor): Promise<{ items: IGoodsReceipt[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = { isDeleted: false };

    scopeToRole(actor, filter);

    if (query.search) {
      const re = escapeRegex(query.search);
      filter.$or = [
        { grnNumber: { $regex: re, $options: 'i' } },
        { poNumber: { $regex: re, $options: 'i' } },
        { vendorName: { $regex: re, $options: 'i' } },
      ];
    }

    const total = await GoodsReceipt.countDocuments(filter);
    const items = await GoodsReceipt.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(POPULATE_LIST)
      .lean();

    return { items: items as IGoodsReceipt[], meta: buildPaginationMeta(total, { page, limit, skip }) };
  },

  async getById(id: string, _actor: Actor): Promise<IGoodsReceipt> {
    const receipt = await GoodsReceipt.findOne({ _id: id, isDeleted: false })
      .populate(POPULATE_LIST)
      .lean();
    if (!receipt) throw ApiError.notFound('Goods Receipt not found');
    return receipt as IGoodsReceipt;
  },

  /** Used by the mobile app to check whether a Goods Receipt already exists for a given
   *  Purchase Order before showing "Record Goods Receipt" vs "View Goods Receipt". */
  async getByPurchaseOrder(purchaseOrderId: string, _actor: Actor): Promise<IGoodsReceipt | null> {
    return GoodsReceipt.findOne({ purchaseOrder: purchaseOrderId, isDeleted: false })
      .populate(POPULATE_LIST)
      .lean() as Promise<IGoodsReceipt | null>;
  },
};
