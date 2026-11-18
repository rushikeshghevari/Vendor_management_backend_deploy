import { ROLES, type Role } from '@/constants/roles';
import { GOODS_HANDOVER_STATUS } from '@/constants/status';
import { Department } from '@/modules/department/department.model';
import { GoodsHandover, type IGoodsHandover } from '@/modules/goodsHandover/goodsHandover.model';
import type { DistributeGoodsHandoverInput, GoodsHandoverListQuery } from '@/modules/goodsHandover/goodsHandover.validation';
import type { IGoodsReceipt } from '@/modules/goodsReceipt/goodsReceipt.model';
import { notificationService } from '@/modules/notification/notification.service';
import { Requirement } from '@/modules/requirement/requirement.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';

// Same roles that may record a Goods Receipt in the first place — the department that ran
// the PO is also the one confirming the physical hand-off.
const HANDOVER_ACT_ROLES: Role[] = [ROLES.DEPARTMENT_USER, ROLES.HOD, ROLES.SUPER_ADMIN];

function scopeToRole(actor: Actor, filter: Record<string, unknown>): void {
  if (actor.role === ROLES.DEPARTMENT_USER || actor.role === ROLES.HOD) {
    filter.$or = [{ fromDepartment: actor.department }, { toDepartment: actor.department }];
  }
  // Director, Accounts, Payment, CEO, Super Admin — see all (read-only).
}

const POPULATE_LIST = [
  { path: 'goodsReceipt', select: 'grnNumber receivedDate overallCondition' },
  { path: 'fromDepartment', select: 'name code' },
  { path: 'toDepartment', select: 'name code' },
  { path: 'handedOverBy', select: 'name email' },
  { path: 'receivedBy', select: 'name email' },
  { path: 'distributedToDepartment', select: 'name code' },
  { path: 'distributedToUser', select: 'name email' },
];

/** Finds the one Department meant by "Admin" in Phase 12's design — identified by name
 *  (confirmed decision: Admin is a specific, already-existing Department, not a role). */
async function findAdminDepartment() {
  return Department.findOne({ name: /^admin$/i, isActive: true }).select('_id name');
}

export const goodsHandoverService = {
  /**
   * Called from goodsReceiptService.create() right after a Goods Receipt is recorded. A
   * no-op unless the Requirement's routingHistory shows Admin as a genuine pass-through —
   * i.e. Admin appears in the chain, but the department that actually ran the PO isn't Admin
   * itself. See docs/PHASE12_DEPARTMENT_ROUTING_AND_GOODS_HANDOVER.md.
   */
  async createIfApplicable(receipt: IGoodsReceipt): Promise<IGoodsHandover | null> {
    if (!receipt.requirement) return null;

    const [requirement, adminDept] = await Promise.all([
      Requirement.findById(receipt.requirement).select('requirementNumber routingHistory'),
      findAdminDepartment(),
    ]);
    if (!requirement || !adminDept) return null;

    const adminDeptId = adminDept.id;
    if (receipt.department.toString() === adminDeptId) return null; // Admin ran the PO itself — not a pass-through.

    const adminWasInChain = requirement.routingHistory.some(
      (entry) => entry.fromDepartment.toString() === adminDeptId || entry.toDepartment.toString() === adminDeptId,
    );
    if (!adminWasInChain) return null;

    const handover = await GoodsHandover.create({
      goodsReceipt: receipt._id,
      grnNumber: receipt.grnNumber,
      requirement: requirement._id,
      requirementNumber: requirement.requirementNumber,
      fromDepartment: receipt.department,
      fromDepartmentName: receipt.departmentName,
      toDepartment: adminDept._id,
      toDepartmentName: adminDept.name,
      status: GOODS_HANDOVER_STATUS.PENDING,
    });

    try {
      const admins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
      await notificationService.notifyUsers(admins, {
        title: 'Goods Handover Pending',
        message: `${receipt.departmentName} will hand over goods for ${requirement.requirementNumber} (GRN ${receipt.grnNumber}) to Admin.`,
        module: 'purchase_order',
        relatedRecord: String(handover._id),
        notificationType: 'goods_handover_pending',
        dedupKey: `goods_handover_pending:${handover._id}`,
      });
    } catch { /* non-fatal */ }

    return handover;
  },

  async list(query: GoodsHandoverListQuery, actor: Actor) {
    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = { isDeleted: false };
    scopeToRole(actor, filter);

    if (query.search) {
      const re = escapeRegex(query.search);
      filter.$and = [
        ...(filter.$or ? [{ $or: filter.$or }] : []),
        { $or: [{ grnNumber: { $regex: re, $options: 'i' } }, { requirementNumber: { $regex: re, $options: 'i' } }] },
      ];
      delete filter.$or;
    }

    const total = await GoodsHandover.countDocuments(filter);
    const items = await GoodsHandover.find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate(POPULATE_LIST)
      .lean();

    return { items, meta: buildPaginationMeta(total, { page, limit, skip }) };
  },

  async getById(id: string, _actor: Actor) {
    const handover = await GoodsHandover.findOne({ _id: id, isDeleted: false }).populate(POPULATE_LIST).lean();
    if (!handover) throw ApiError.notFound('Goods Handover not found');
    return handover;
  },

  async getByGoodsReceipt(goodsReceiptId: string, _actor: Actor) {
    return GoodsHandover.findOne({ goodsReceipt: goodsReceiptId, isDeleted: false }).populate(POPULATE_LIST).lean();
  },

  /** The department that ran the PO confirms the physical hand-off to Admin. */
  async handOver(id: string, actor: Actor): Promise<IGoodsHandover> {
    if (!HANDOVER_ACT_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can confirm a handover');
    }

    const handover = await GoodsHandover.findOne({ _id: id, isDeleted: false });
    if (!handover) throw ApiError.notFound('Goods Handover not found');
    if (handover.status !== GOODS_HANDOVER_STATUS.PENDING) {
      throw ApiError.conflict('This handover has already been confirmed as handed over');
    }
    if (actor.role !== ROLES.SUPER_ADMIN && handover.fromDepartment.toString() !== actor.department) {
      throw ApiError.forbidden('Only the department that ran the Purchase Order can confirm this handover');
    }

    handover.status = GOODS_HANDOVER_STATUS.HANDED_OVER;
    handover.handedOverBy = actor.id as unknown as typeof handover.handedOverBy;
    handover.handedOverAt = new Date();
    await handover.save();

    try {
      const admins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
      await notificationService.notifyUsers(admins, {
        title: 'Goods Handed Over To Admin',
        message: `${handover.fromDepartmentName} handed over goods for ${handover.requirementNumber} — awaiting Admin confirmation.`,
        module: 'purchase_order',
        relatedRecord: String(handover._id),
        notificationType: 'goods_handover_pending',
      });
    } catch { /* non-fatal */ }

    return handover;
  },

  /** Admin confirms receipt — the second, independent side of the two-way confirmation. */
  async receive(id: string, actor: Actor): Promise<IGoodsHandover> {
    if (!HANDOVER_ACT_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can confirm receipt');
    }

    const handover = await GoodsHandover.findOne({ _id: id, isDeleted: false });
    if (!handover) throw ApiError.notFound('Goods Handover not found');
    if (handover.status !== GOODS_HANDOVER_STATUS.HANDED_OVER) {
      throw ApiError.conflict('This handover has not yet been marked as handed over');
    }
    if (actor.role !== ROLES.SUPER_ADMIN && handover.toDepartment.toString() !== actor.department) {
      throw ApiError.forbidden('Only Admin can confirm receipt of this handover');
    }

    handover.status = GOODS_HANDOVER_STATUS.RECEIVED;
    handover.receivedBy = actor.id as unknown as typeof handover.receivedBy;
    handover.receivedAt = new Date();
    await handover.save();

    try {
      const admins = await notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN);
      await notificationService.notifyUsers(admins, {
        title: 'Goods Handover Complete',
        message: `Admin confirmed receipt of goods for ${handover.requirementNumber} from ${handover.fromDepartmentName}.`,
        module: 'purchase_order',
        relatedRecord: String(handover._id),
        notificationType: 'goods_handover_received',
      });
    } catch { /* non-fatal */ }

    return handover;
  },

  /** Admin's final internal distribution record — a plain note/log, set once, no
   *  acknowledgment required from the receiving department/user (confirmed decision). */
  async distribute(id: string, input: DistributeGoodsHandoverInput, actor: Actor): Promise<IGoodsHandover> {
    if (!HANDOVER_ACT_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User, HOD, or Super Admin can log a distribution');
    }

    const handover = await GoodsHandover.findOne({ _id: id, isDeleted: false });
    if (!handover) throw ApiError.notFound('Goods Handover not found');
    if (handover.status !== GOODS_HANDOVER_STATUS.RECEIVED) {
      throw ApiError.conflict('Admin must confirm receipt before logging the final distribution');
    }
    if (handover.distributedAt) {
      throw ApiError.conflict('A distribution has already been logged for this handover');
    }
    if (actor.role !== ROLES.SUPER_ADMIN && handover.toDepartment.toString() !== actor.department) {
      throw ApiError.forbidden('Only Admin can log the final distribution for this handover');
    }

    const targetDept = await Department.findOne({ _id: input.distributedToDepartment, isActive: true }).select('_id');
    if (!targetDept) throw ApiError.badRequest('Selected department is not valid');

    handover.distributedToDepartment = targetDept._id as typeof handover.distributedToDepartment;
    if (input.distributedToUser) {
      handover.distributedToUser = input.distributedToUser as unknown as typeof handover.distributedToUser;
    }
    handover.distributionNote = input.note;
    handover.distributedAt = new Date();
    await handover.save();

    return handover;
  },
};
