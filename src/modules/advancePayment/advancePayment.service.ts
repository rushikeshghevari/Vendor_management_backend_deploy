import type { Types } from 'mongoose';

import { ROLES } from '@/constants/roles';
import { ADVANCE_PAYMENT_STATUS } from '@/constants/status';
import { AdvancePayment, type IAdvancePayment } from '@/modules/advancePayment/advancePayment.model';
import type {
  AccountsVerifyAdvancePaymentInput,
  AdvancePaymentListQuery,
  MarkAdvancePaymentPaidInput,
} from '@/modules/advancePayment/advancePayment.validation';
import { notificationService } from '@/modules/notification/notification.service';
import { User } from '@/modules/user/user.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';

/** A minimal shape of the Requirement/Quotation this is created from — just what's actually
 *  read, so the caller (directorReview.controller.ts) doesn't need extra populates beyond what
 *  it already fetches for its own notification. */
interface ApprovedRequirementLike {
  _id: Types.ObjectId;
  requirementNumber: string;
  department: Types.ObjectId;
  createdBy: Types.ObjectId;
}
interface WinningQuotationLike {
  _id: Types.ObjectId;
  quotationCode: string;
  amount: number;
  advanceAmount?: number;
  expectedPODate?: Date;
  vendor?: unknown;
  temporaryVendor?: { name?: string };
}

function scopeToOwner(actor: Actor, filter: Record<string, unknown>) {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
  // Accounts, Payment Department, Super Admin see every Advance Payment — both roles need the
  // full history for reference, not just the ones currently in their own action queue.
}

async function getActorName(actorId: string): Promise<string> {
  const user = await User.findById(actorId).select('name').lean();
  return (user as { name?: string } | null)?.name ?? 'Unknown';
}

export const advancePaymentService = {
  /**
   * Fired once, right after a Requirement's winning Quotation is Director-approved — a no-op
   * unless that Quotation actually carries an advanceAmount. Idempotent against the unique
   * index on `quotation` (a second call for the same Requirement/round is a conflict the
   * caller safely ignores, since Director approval for a given quotation only ever happens
   * once per requirement in practice).
   */
  async createForApprovedQuotation(
    requirement: ApprovedRequirementLike,
    quotation: WinningQuotationLike,
    actor: Actor,
  ): Promise<IAdvancePayment | null> {
    if (!quotation.advanceAmount || quotation.advanceAmount <= 0) return null;

    const existing = await AdvancePayment.findOne({ quotation: quotation._id });
    if (existing) return existing;

    const vendorName =
      (quotation.vendor as { name?: string } | undefined)?.name ?? quotation.temporaryVendor?.name ?? 'Unknown Vendor';
    const actorName = await getActorName(actor.id);
    const now = new Date();

    const advancePayment = await AdvancePayment.create({
      requirement: requirement._id,
      requirementNumber: requirement.requirementNumber,
      quotation: quotation._id,
      quotationCode: quotation.quotationCode,
      department: requirement.department,
      createdBy: requirement.createdBy,
      vendorName,
      totalAmount: quotation.amount,
      advanceAmount: quotation.advanceAmount,
      balanceAmount: Math.max(quotation.amount - quotation.advanceAmount, 0),
      dueDate: quotation.expectedPODate,
      status: ADVANCE_PAYMENT_STATUS.PENDING_VERIFICATION,
      history: [{
        event: 'created',
        status: ADVANCE_PAYMENT_STATUS.PENDING_VERIFICATION,
        actorId: actor.id,
        actorName,
        actorRole: actor.role,
        at: now,
      }],
    });

    const accountsUsers = await notificationService.findActiveUsersByRole(ROLES.ACCOUNTS);
    if (accountsUsers.length > 0) {
      await notificationService.notifyUsers(accountsUsers, {
        title: 'Advance Payment Needs Verification',
        message: `${requirement.requirementNumber} — ₹${quotation.advanceAmount.toLocaleString('en-IN')} advance due to ${vendorName}. Please verify.`,
        module: 'requirement',
        relatedRecord: String(advancePayment._id),
        notificationType: 'advance_payment_due',
        priority: 'high',
        sender: actor.id,
      });
    }

    return advancePayment;
  },

  /** Backfills the real Vendor once registration completes — called from
   *  vendorRegistration.service.ts / vendorRegistrationLink.service.ts. A no-op if this
   *  Requirement never had an advance (most common case), or it's already backfilled. */
  async backfillVendor(requirementId: string, vendorId: string, vendorName: string): Promise<void> {
    await AdvancePayment.updateOne(
      { requirement: requirementId, vendor: { $exists: false } },
      { vendor: vendorId, vendorName },
    );
  },

  async list(query: AdvancePaymentListQuery, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
    if (query.status) filter.status = query.status;
    if (query.department) filter.department = query.department;
    if (query.search) {
      filter.$or = [
        { requirementNumber: new RegExp(query.search, 'i') },
        { quotationCode: new RegExp(query.search, 'i') },
        { vendorName: new RegExp(query.search, 'i') },
      ];
    }
    scopeToOwner(actor, filter);

    const [items, total] = await Promise.all([
      AdvancePayment.find(filter)
        .populate('department', 'name code')
        .populate('createdBy', 'name email')
        .populate('vendor', 'name code')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      AdvancePayment.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  async getById(id: string, actor: Actor) {
    const filter: Record<string, unknown> = { _id: id, isDeleted: { $ne: true } };
    scopeToOwner(actor, filter);

    const advancePayment = await AdvancePayment.findOne(filter)
      .populate('department', 'name code')
      .populate('createdBy', 'name email')
      .populate('vendor', 'name code')
      .populate('accountsVerifiedBy', 'name email')
      .populate('paidBy', 'name email');
    if (!advancePayment) throw ApiError.notFound('Advance Payment not found');

    return advancePayment;
  },

  /** Accounts-only — confirms the advance amount/vendor are correct and sends it on to
   *  Payment Department. */
  async accountsVerify(id: string, input: AccountsVerifyAdvancePaymentInput, actor: Actor): Promise<IAdvancePayment> {
    if (actor.role !== ROLES.ACCOUNTS) {
      throw ApiError.forbidden('Only Accounts can verify an advance payment');
    }

    const advancePayment = await AdvancePayment.findOne({
      _id: id,
      status: ADVANCE_PAYMENT_STATUS.PENDING_VERIFICATION,
      isDeleted: { $ne: true },
    });
    if (!advancePayment) {
      throw ApiError.notFound('Advance Payment not found, or it is not awaiting verification');
    }

    const now = new Date();
    const actorName = await getActorName(actor.id);

    advancePayment.status = ADVANCE_PAYMENT_STATUS.PENDING_PAYMENT;
    advancePayment.accountsVerifiedBy = actor.id as unknown as IAdvancePayment['accountsVerifiedBy'];
    advancePayment.accountsVerifiedAt = now;
    advancePayment.accountsRemarks = input.remarks;
    advancePayment.history.push({
      event: 'accounts_verified',
      status: ADVANCE_PAYMENT_STATUS.PENDING_PAYMENT,
      remarks: input.remarks,
      actorId: actor.id as unknown as IAdvancePayment['createdBy'],
      actorName,
      actorRole: actor.role,
      at: now,
    });
    await advancePayment.save();

    const paymentUsers = await notificationService.findActiveUsersByRole(ROLES.PAYMENT_DEPARTMENT);
    if (paymentUsers.length > 0) {
      await notificationService.notifyUsers(paymentUsers, {
        title: 'Advance Payment Ready',
        message: `${advancePayment.requirementNumber} — ₹${advancePayment.advanceAmount.toLocaleString('en-IN')} advance to ${advancePayment.vendorName} has been verified by Accounts. Please pay.`,
        module: 'requirement',
        relatedRecord: String(advancePayment._id),
        notificationType: 'advance_payment_verified',
        priority: 'high',
        sender: actor.id,
      });
    }
    await notificationService.notifyUser(
      { id: advancePayment.createdBy.toString(), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Advance Payment Verified',
        message: `${advancePayment.requirementNumber} — the ₹${advancePayment.advanceAmount.toLocaleString('en-IN')} advance to ${advancePayment.vendorName} was verified by Accounts and sent to Payment Department.`,
        module: 'requirement',
        relatedRecord: String(advancePayment._id),
        notificationType: 'advance_payment_verified',
        sender: actor.id,
      },
    );

    return advancePayment;
  },

  /** Payment Department-only — records that the advance has actually been paid out. */
  async markPaid(id: string, input: MarkAdvancePaymentPaidInput, actor: Actor): Promise<IAdvancePayment> {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can mark an advance payment as paid');
    }

    const advancePayment = await AdvancePayment.findOne({
      _id: id,
      status: ADVANCE_PAYMENT_STATUS.PENDING_PAYMENT,
      isDeleted: { $ne: true },
    });
    if (!advancePayment) {
      throw ApiError.notFound('Advance Payment not found, or it is not awaiting payment');
    }

    const now = new Date();
    const actorName = await getActorName(actor.id);

    advancePayment.status = ADVANCE_PAYMENT_STATUS.PAID;
    advancePayment.paidBy = actor.id as unknown as IAdvancePayment['paidBy'];
    advancePayment.paidAt = now;
    advancePayment.paymentReference = input.paymentReference;
    advancePayment.paymentRemarks = input.remarks;
    advancePayment.history.push({
      event: 'payment_made',
      status: ADVANCE_PAYMENT_STATUS.PAID,
      remarks: input.remarks ? `${input.remarks} (Ref: ${input.paymentReference})` : `Ref: ${input.paymentReference}`,
      actorId: actor.id as unknown as IAdvancePayment['createdBy'],
      actorName,
      actorRole: actor.role,
      at: now,
    });
    await advancePayment.save();

    const department = await import('@/modules/department/department.model').then(({ Department }) =>
      Department.findById(advancePayment.department).select('hod').lean(),
    );
    const receivers: Array<{ id: string; role: (typeof ROLES)[keyof typeof ROLES] }> = [
      { id: advancePayment.createdBy.toString(), role: ROLES.DEPARTMENT_USER },
    ];
    if (department?.hod) receivers.push({ id: String(department.hod), role: ROLES.HOD });

    await notificationService.notifyUsers(receivers, {
      title: 'Advance Payment Paid',
      message: `${advancePayment.requirementNumber} — ₹${advancePayment.advanceAmount.toLocaleString('en-IN')} advance to ${advancePayment.vendorName} has been paid. Remaining balance: ₹${advancePayment.balanceAmount.toLocaleString('en-IN')}.`,
      module: 'requirement',
      relatedRecord: String(advancePayment._id),
      notificationType: 'advance_payment_paid',
      sender: actor.id,
    });

    return advancePayment;
  },
};
