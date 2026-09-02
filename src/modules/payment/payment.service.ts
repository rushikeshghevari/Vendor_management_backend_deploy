import { ROLES } from '@/constants/roles';
import { BILL_STATUS, PAYMENT_STATUS, type PaymentMethod } from '@/constants/status';
import { Bill } from '@/modules/bill/bill.model';
import { PurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { billService } from '@/modules/bill/bill.service';
import { notificationService } from '@/modules/notification/notification.service';
import { Payment, type IPayment } from '@/modules/payment/payment.model';
import type {
  CreatePaymentInput,
  MarkFailedInput,
  MarkPaidInput,
  StartProcessingInput,
} from '@/modules/payment/payment.validation';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { escapeRegex } from '@/utils/escapeRegex';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';
import { nextSequence, seedSequenceFromExisting } from '@/utils/sequence.model';

const ONLINE_METHODS_REQUIRING_UTR = ['bank_transfer', 'upi', 'rtgs', 'neft', 'imps'];

/** Payment Date is a date-only value from the mobile date picker — the client sends it as
 *  midnight UTC of the selected calendar day (e.g. `2026-06-29T00:00:00.000Z`). Comparing that
 *  directly against a real timestamp like `now` or `bill.verifiedAt` (which carries a
 *  time-of-day) would reject same-day dates whenever the timestamp's time-of-day is later than
 *  midnight — true essentially every time. Truncating both sides to their UTC calendar day
 *  before comparing makes "today" always valid relative to "today", regardless of time-of-day. */
function toUtcDayStart(date: Date): number {
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

/** PAY-000001, PAY-000002, ... — a single global sequence (Payments aren't department-scoped). */
async function generatePaymentCode(): Promise<string> {
  const codePrefix = 'PAY-';
  const counterKey = 'payment';

  await seedSequenceFromExisting(counterKey, async () => {
    const existingCodes = await Payment.find({ paymentCode: new RegExp(`^${codePrefix}\\d+$`) })
      .select('paymentCode')
      .lean();
    return existingCodes.reduce((max, item) => {
      const num = parseInt(item.paymentCode.slice(codePrefix.length), 10);
      return Number.isFinite(num) && num > max ? num : max;
    }, 0);
  });

  const sequence = await nextSequence(counterKey);
  return `${codePrefix}${String(sequence).padStart(6, '0')}`;
}

/** Once a Payment reaches Completed, every mutation path is rejected — no edit, no retry, no status change. */
function assertNotCompleted(payment: IPayment) {
  if (payment.status === PAYMENT_STATUS.COMPLETED) {
    throw ApiError.conflict('Payment is Completed and cannot be modified');
  }
}

function scopeToOwner(actor: Actor, filter: Record<string, unknown>): Promise<void> | void {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    return Bill.find({ createdBy: actor.id })
      .distinct('_id')
      .then((billIds) => {
        filter.bill = { $in: billIds };
      });
  }
}

export const paymentService = {
  /** Payment Department-only. Creates the single Payment for a Verified Bill (1:1, enforced by the unique index plus this existence check). */
  async create(input: CreatePaymentInput, actor: Actor) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can create a payment');
    }

    const bill = await Bill.findOne({ _id: input.bill, isDeleted: { $ne: true } });
    if (!bill) throw ApiError.notFound('Bill not found');

    if (bill.status !== BILL_STATUS.VERIFIED) {
      throw ApiError.conflict('Only a Verified bill can enter the payment queue');
    }

    const existing = await Payment.findOne({ bill: bill.id });
    if (existing) throw ApiError.conflict('A payment already exists for this bill');

    const paymentCode = await generatePaymentCode();
    const now = new Date();

    const payment = await Payment.create({
      paymentCode,
      bill: bill.id,
      quotation: bill.quotation,
      vendor: bill.vendor,
      recurringExpense: bill.recurringExpense,
      reimbursedTo: bill.reimbursedTo,
      department: bill.department,
      amount: bill.invoiceAmount,
      gst: bill.gstAmount,
      invoiceNumber: bill.invoiceNumber,
      invoiceDate: bill.invoiceDate,
      status: PAYMENT_STATUS.PAYMENT_PENDING,
      history: [{ status: PAYMENT_STATUS.PAYMENT_PENDING, changedBy: actor.id, changedAt: now }],
      createdBy: actor.id,
      processedBy: actor.id,
    });

    // Reuses the existing Bill bridge purely to keep Bill.status in sync — the Payment module
    // owns the Department User notification itself, so the bridge's own legacy notification
    // is suppressed here to avoid sending a duplicate (see bill.service.ts updatePaymentStatus()).
    await billService.updatePaymentStatus(bill.id, { status: BILL_STATUS.PAYMENT_PENDING }, actor, { suppressNotifications: true });

    await notificationService.notifyUser(
      { id: bill.createdBy.toString(), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Payment Created',
        message: 'Payment Created.',
        module: 'payment',
        relatedRecord: payment.id,
        notificationType: 'payment_created',
        sender: actor.id,
      },
    );

    const [ceos, directors] = await Promise.all([
      notificationService.findActiveUsersByRole(ROLES.CEO),
      notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
    ]);
    await notificationService.notifyUsers([...ceos, ...directors], {
      title: 'Payment Created',
      message: `Payment ${paymentCode} created for Bill ${bill.billCode}.`,
      module: 'payment',
      relatedRecord: payment.id,
      notificationType: 'payment_created',
      sender: actor.id,
    });

    return payment;
  },

  async startProcessing(id: string, input: StartProcessingInput, actor: Actor) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can process a payment');
    }

    const payment = await Payment.findById(id);
    if (!payment) throw ApiError.notFound('Payment not found');
    assertNotCompleted(payment);

    if (payment.status !== PAYMENT_STATUS.PAYMENT_PENDING && payment.status !== PAYMENT_STATUS.FAILED) {
      throw ApiError.conflict('Payment can only be processed from Payment Pending or Failed');
    }

    const isRetry = payment.status === PAYMENT_STATUS.FAILED;
    const now = new Date();

    payment.paymentMethod = input.paymentMethod as PaymentMethod;
    payment.bankName = input.bankName;
    payment.accountNumber = input.accountNumber;
    payment.ifsc = input.ifsc;
    payment.upiId = input.upiId;
    payment.status = PAYMENT_STATUS.PROCESSING;
    payment.processedBy = actor.id as unknown as IPayment['processedBy'];
    if (isRetry) payment.retryCount += 1;
    payment.history.push({
      status: PAYMENT_STATUS.PROCESSING,
      changedBy: actor.id as unknown as IPayment['createdBy'],
      changedAt: now,
      ...(isRetry ? { retryNumber: payment.retryCount } : {}),
    });
    await payment.save();

    // Bill stays at Payment Pending throughout Processing/Failed/Retry — only Paid/Completed advance it further.

    await notificationService.notifyUser(
      { id: String((await Bill.findById(payment.bill).select('createdBy'))!.createdBy), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Payment Processing',
        message: 'Payment is being processed.',
        module: 'payment',
        relatedRecord: payment.id,
        notificationType: 'payment_processing',
        sender: actor.id,
      },
    );

    const [ceos, directors] = await Promise.all([
      notificationService.findActiveUsersByRole(ROLES.CEO),
      notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
    ]);
    await notificationService.notifyUsers([...ceos, ...directors], {
      title: 'Payment Processing',
      message: `Payment ${payment.paymentCode} is being processed${isRetry ? ' (retry)' : ''}.`,
      module: 'payment',
      relatedRecord: payment.id,
      notificationType: 'payment_processing',
      sender: actor.id,
    });

    return payment;
  },

  async markPaid(id: string, input: MarkPaidInput, actor: Actor) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can mark a payment as paid');
    }

    const payment = await Payment.findById(id);
    if (!payment) throw ApiError.notFound('Payment not found');
    assertNotCompleted(payment);
    if (payment.status !== PAYMENT_STATUS.PROCESSING) {
      throw ApiError.conflict('Payment must be Processing before it can be marked Paid');
    }

    if (payment.paymentMethod && ONLINE_METHODS_REQUIRING_UTR.includes(payment.paymentMethod) && !input.utrNumber) {
      throw ApiError.badRequest('UTR Number is required for this payment method');
    }
    if (payment.paymentMethod === 'cheque' && !input.chequeNumber) {
      throw ApiError.badRequest('Cheque Number is required for cheque payments');
    }

    const bill = await Bill.findById(payment.bill).select('createdBy verifiedAt');
    if (!bill) throw ApiError.notFound('Bill not found for this payment');

    const now = new Date();
    if (toUtcDayStart(input.paymentDate) > toUtcDayStart(now)) {
      throw ApiError.badRequest('Payment date cannot be a future date');
    }
    if (bill.verifiedAt && toUtcDayStart(input.paymentDate) < toUtcDayStart(bill.verifiedAt)) {
      throw ApiError.badRequest('Payment date cannot be before the Bill was Verified');
    }

    payment.utrNumber = input.utrNumber;
    payment.transactionReference = input.transactionReference;
    payment.chequeNumber = input.chequeNumber;
    payment.paymentDate = input.paymentDate;
    payment.remarks = input.remarks;
    payment.status = PAYMENT_STATUS.PAID;
    payment.processedBy = actor.id as unknown as IPayment['processedBy'];
    payment.history.push({
      status: PAYMENT_STATUS.PAID,
      remarks: input.remarks,
      changedBy: actor.id as unknown as IPayment['createdBy'],
      changedAt: now,
    });
    await payment.save();

    await billService.updatePaymentStatus(String(payment.bill), { status: BILL_STATUS.PAID }, actor, { suppressNotifications: true });

    await notificationService.notifyUser(
      { id: String(bill.createdBy), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Payment Successful',
        message: 'Payment Successful.',
        module: 'payment',
        relatedRecord: payment.id,
        notificationType: 'payment_paid',
        sender: actor.id,
      },
    );

    const [ceos, directors] = await Promise.all([
      notificationService.findActiveUsersByRole(ROLES.CEO),
      notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
    ]);
    await notificationService.notifyUsers([...ceos, ...directors], {
      title: 'Payment Successful',
      message: `Payment ${payment.paymentCode} has been marked Paid.`,
      module: 'payment',
      relatedRecord: payment.id,
      notificationType: 'payment_paid',
      sender: actor.id,
    });

    return payment;
  },

  async markCompleted(id: string, actor: Actor) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can mark a payment as completed');
    }

    const payment = await Payment.findById(id);
    if (!payment) throw ApiError.notFound('Payment not found');
    assertNotCompleted(payment);
    if (payment.status !== PAYMENT_STATUS.PAID) {
      throw ApiError.conflict('Payment must be Paid before it can be marked Completed');
    }

    const bill = await Bill.findById(payment.bill).select('createdBy');
    if (!bill) throw ApiError.notFound('Bill not found for this payment');

    const now = new Date();
    payment.status = PAYMENT_STATUS.COMPLETED;
    payment.processedBy = actor.id as unknown as IPayment['processedBy'];
    payment.history.push({
      status: PAYMENT_STATUS.COMPLETED,
      changedBy: actor.id as unknown as IPayment['createdBy'],
      changedAt: now,
    });
    await payment.save();

    await billService.updatePaymentStatus(String(payment.bill), { status: BILL_STATUS.COMPLETED }, actor, { suppressNotifications: true });

    // COMPLETED is a terminal payment status — never re-entered for the same payment —
    // so this notification is safe to dedupe strictly.
    await notificationService.notifyUser(
      { id: String(bill.createdBy), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Payment Completed',
        message: 'Payment Completed.',
        module: 'payment',
        relatedRecord: payment.id,
        notificationType: 'payment_completed',
        sender: actor.id,
        dedupKey: `payment_completed:${payment.id}`,
      },
    );

    const [superAdmins, ceos, directors] = await Promise.all([
      notificationService.findActiveUsersByRole(ROLES.SUPER_ADMIN),
      notificationService.findActiveUsersByRole(ROLES.CEO),
      notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
    ]);
    await notificationService.notifyUsers([...superAdmins, ...ceos, ...directors], {
      title: 'Payment Completed',
      message: `Payment ${payment.paymentCode} has been completed.`,
      module: 'payment',
      relatedRecord: payment.id,
      notificationType: 'payment_completed',
      sender: actor.id,
      dedupKey: `payment_completed:${payment.id}`,
    });

    // "Vendor (Future Ready)" notification intentionally not built — Vendor has no
    // login/portal/user account in this system, so there is no receiver to notify.

    return payment;
  },

  async markFailed(id: string, input: MarkFailedInput, actor: Actor) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT) {
      throw ApiError.forbidden('Only Payment Department can mark a payment as failed');
    }

    const payment = await Payment.findById(id);
    if (!payment) throw ApiError.notFound('Payment not found');
    assertNotCompleted(payment);
    if (payment.status !== PAYMENT_STATUS.PROCESSING) {
      throw ApiError.conflict('Payment must be Processing before it can be marked Failed');
    }

    const bill = await Bill.findById(payment.bill).select('createdBy');
    if (!bill) throw ApiError.notFound('Bill not found for this payment');

    const now = new Date();
    payment.status = PAYMENT_STATUS.FAILED;
    payment.remarks = input.remarks;
    payment.processedBy = actor.id as unknown as IPayment['processedBy'];
    payment.history.push({
      status: PAYMENT_STATUS.FAILED,
      remarks: input.remarks,
      failureReason: input.failureReason as IPayment['history'][number]['failureReason'],
      changedBy: actor.id as unknown as IPayment['createdBy'],
      changedAt: now,
    });
    await payment.save();

    // Bill stays at Payment Pending — a Failed payment is retried in place, never advances Bill.

    await notificationService.notifyUser(
      { id: String(bill.createdBy), role: ROLES.DEPARTMENT_USER },
      {
        title: 'Payment Failed',
        message: 'Payment Failed. Retry will be attempted.',
        module: 'payment',
        relatedRecord: payment.id,
        notificationType: 'payment_failed',
        sender: actor.id,
      },
    );

    const [ceos, directors] = await Promise.all([
      notificationService.findActiveUsersByRole(ROLES.CEO),
      notificationService.findActiveUsersByRole(ROLES.DIRECTOR),
    ]);
    await notificationService.notifyUsers([...ceos, ...directors], {
      title: 'Payment Failed',
      message: `Payment ${payment.paymentCode} failed. Retry will be attempted.`,
      module: 'payment',
      relatedRecord: payment.id,
      notificationType: 'payment_failed',
      sender: actor.id,
    });

    return payment;
  },

  async list(query: Record<string, unknown>, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = {};
    if (query.status) filter.status = query.status;
    if (query.vendor) filter.vendor = query.vendor;
    if (query.department) filter.department = query.department;
    if (query.paymentMethod) filter.paymentMethod = query.paymentMethod;
    if (query.search) {
      const pattern = new RegExp(escapeRegex(String(query.search)), 'i');
      filter.$or = [{ paymentCode: pattern }, { invoiceNumber: pattern }];
    }

    await scopeToOwner(actor, filter);

    const [items, total] = await Promise.all([
      Payment.find(filter)
        .populate('vendor', 'name')
        .populate('reimbursedTo', 'name email')
        .populate('recurringExpense', 'title mode reimbursementBankDetails')
        .populate('department', 'name')
        .populate('bill', 'billCode status')
        .populate('quotation', 'quotationCode')
        .sort({ createdAt: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      Payment.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  async getById(id: string, actor: Actor) {
    const filter: Record<string, unknown> = { _id: id };
    await scopeToOwner(actor, filter);

    const payment = await Payment.findOne(filter)
      .populate('vendor', 'name')
      .populate('reimbursedTo', 'name email')
      .populate('recurringExpense', 'title mode thresholdPercent baselineAmount reimbursementBankDetails')
      .populate('department', 'name')
      .populate('bill', 'billCode status verifiedBy verifiedAt requirementNumber grnNumber')
      .populate('quotation', 'quotationCode');
    if (!payment) throw ApiError.notFound('Payment not found');

    const po = await PurchaseOrder.findOne({ quotation: payment.quotation, isDeleted: false }).lean();
    const completedPayments = await Payment.find({
      quotation: payment.quotation,
      status: { $in: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.COMPLETED] }
    }).select('amount').lean();

    const paidAmount = completedPayments.reduce((sum, p) => sum + p.amount, 0);
    const poTotal = po?.grandTotal || 0;
    const outstandingBalance = poTotal ? (poTotal - paidAmount) : 0;

    return Object.assign(payment.toObject(), {
      poTotal,
      paidAmount,
      outstandingBalance,
    });
  },

  /** CEO/Director's only window into Payment data — a narrow, single-record, read-only lookup. */
  async getByQuotation(quotationId: string) {
    const payment = await Payment.findOne({ quotation: quotationId })
      .populate('vendor', 'name')
      .populate('reimbursedTo', 'name')
      .populate('bill', 'billCode status');
    if (!payment) throw ApiError.notFound('No payment exists for this quotation yet');
    return payment;
  },

  /** Payment Department-only dashboard counters. */
  async getPaymentDeptStats(actor: Actor) {
    if (actor.role !== ROLES.PAYMENT_DEPARTMENT && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only Payment Department can view this dashboard');
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const billsWithPayment = await Payment.distinct('bill');
    const [readyForPayment, paymentPending, processing, paidToday, completed, failed] = await Promise.all([
      Bill.countDocuments({ status: BILL_STATUS.VERIFIED, isDeleted: { $ne: true }, _id: { $nin: billsWithPayment } }),
      Payment.countDocuments({ status: PAYMENT_STATUS.PAYMENT_PENDING }),
      Payment.countDocuments({ status: PAYMENT_STATUS.PROCESSING }),
      Payment.countDocuments({ status: PAYMENT_STATUS.PAID, updatedAt: { $gte: startOfToday } }),
      Payment.countDocuments({ status: PAYMENT_STATUS.COMPLETED }),
      Payment.countDocuments({ status: PAYMENT_STATUS.FAILED }),
    ]);

    return { readyForPayment, paymentPending, processing, paidToday, completed, failed };
  },

  /** Accounts read-only dashboard counters. */
  async getAccountsPaymentStats(actor: Actor) {
    if (actor.role !== ROLES.ACCOUNTS && actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only Accounts can view this dashboard');
    }

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const billsWithPayment = await Payment.distinct('bill');
    const [paymentsReady, completedToday] = await Promise.all([
      Bill.countDocuments({ status: BILL_STATUS.VERIFIED, isDeleted: { $ne: true }, _id: { $nin: billsWithPayment } }),
      Payment.countDocuments({ status: PAYMENT_STATUS.COMPLETED, updatedAt: { $gte: startOfToday } }),
    ]);

    return { paymentsReady, completedToday };
  },

  /** Super Admin read-only dashboard counters. */
  async getSuperAdminPaymentStats(actor: Actor) {
    if (actor.role !== ROLES.SUPER_ADMIN) {
      throw ApiError.forbidden('Only Super Admin can view this dashboard');
    }

    const [total, completed, pending, failed] = await Promise.all([
      Payment.countDocuments({}),
      Payment.countDocuments({ status: PAYMENT_STATUS.COMPLETED }),
      Payment.countDocuments({ status: { $in: [PAYMENT_STATUS.PAYMENT_PENDING, PAYMENT_STATUS.PROCESSING] } }),
      Payment.countDocuments({ status: PAYMENT_STATUS.FAILED }),
    ]);

    return { total, completed, pending, failed };
  },

  /** Department User's own dashboard counters — scoped to Payments tied to Bills they created. */
  async getMyPaymentStats(actor: Actor) {
    if (actor.role !== ROLES.DEPARTMENT_USER) {
      throw ApiError.forbidden('Only a Department User can view this dashboard');
    }

    const billIds = await Bill.find({ createdBy: actor.id }).distinct('_id');
    const [myPayments, pending, completed] = await Promise.all([
      Payment.countDocuments({ bill: { $in: billIds } }),
      Payment.countDocuments({ bill: { $in: billIds }, status: { $in: [PAYMENT_STATUS.PAYMENT_PENDING, PAYMENT_STATUS.PROCESSING] } }),
      Payment.countDocuments({ bill: { $in: billIds }, status: PAYMENT_STATUS.COMPLETED }),
    ]);

    return { myPayments, pending, completed };
  },
};
