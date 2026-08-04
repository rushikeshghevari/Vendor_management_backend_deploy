import { ROLES } from '@/constants/roles';
import { AuditLog, type IAuditLog, type AccountsAuditDecision } from '@/modules/auditLog/auditLog.model';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { PO_STATUS } from '@/constants/status';
import { User } from '@/modules/user/user.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';

interface CreateAuditLogInput {
  purchaseOrderId: string;
  billId: string;
  quotationId: string;
  accountsDecision: AccountsAuditDecision;
  reason?: string;
  actor: Actor;
}

export const auditLogService = {

  async create(input: CreateAuditLogInput): Promise<IAuditLog> {
    const po = await PurchaseOrder.findById(input.purchaseOrderId);
    if (!po || !po.aiVerification) {
      throw ApiError.badRequest('Purchase Order must have AI Verification results before creating an audit log');
    }

    const actor = await User.findById(input.actor.id).select('name role').lean();
    if (!actor) throw ApiError.notFound('User not found');

    const log = await AuditLog.create({
      purchaseOrder: input.purchaseOrderId,
      bill: input.billId,
      quotation: input.quotationId,
      aiRecommendation: po.aiVerification.recommendation,
      aiConfidence: po.aiVerification.confidence,
      matchPercentage: po.aiVerification.matchPercentage,
      risk: po.aiVerification.risk,
      differenceCount: po.aiVerification.differences.length,
      differences: po.aiVerification.differences,
      accountsDecision: input.accountsDecision,
      reason: input.reason,
      decidedBy: input.actor.id,
      decidedByName: (actor as { name: string }).name,
      decidedByRole: input.actor.role,
      decidedAt: new Date(),
    });

    // Update PO status to accounts_verified on a positive decision
    if (input.accountsDecision === 'verified') {
      po.status = PO_STATUS.ACCOUNTS_VERIFIED;
      await po.save();
    }

    return log;
  },

  async listByPurchaseOrder(purchaseOrderId: string, _actor: Actor): Promise<IAuditLog[]> {
    return AuditLog.find({ purchaseOrder: purchaseOrderId })
      .sort({ decidedAt: -1 })
      .populate('decidedBy', 'name email')
      .lean() as Promise<IAuditLog[]>;
  },

  async list(query: Record<string, unknown>, actor: Actor): Promise<{ items: IAuditLog[]; meta: ReturnType<typeof buildPaginationMeta> }> {
    if (actor.role !== ROLES.SUPER_ADMIN && actor.role !== ROLES.ACCOUNTS) {
      throw ApiError.forbidden('Access denied');
    }

    const { page, limit, skip } = parsePagination(query);
    const filter: Record<string, unknown> = {};

    if (query.purchaseOrderId) filter.purchaseOrder = query.purchaseOrderId;
    if (query.accountsDecision) filter.accountsDecision = query.accountsDecision;
    if (query.risk) filter.risk = query.risk;

    const total = await AuditLog.countDocuments(filter);
    const items = await AuditLog.find(filter)
      .sort({ decidedAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('decidedBy', 'name email')
      .populate('purchaseOrder', 'poNumber')
      .populate('bill', 'billCode')
      .lean();

    return { items: items as IAuditLog[], meta: buildPaginationMeta(total, { page, limit, skip }) };
  },
};
