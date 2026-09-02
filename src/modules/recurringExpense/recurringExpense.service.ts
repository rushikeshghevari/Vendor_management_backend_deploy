import { ROLES, type Role } from '@/constants/roles';
import { QUOTATION_STATUS, RECURRING_FREQUENCY, RECURRING_MODE, type RecurringFrequency, type RecurringMode } from '@/constants/status';
import { billService } from '@/modules/bill/bill.service';
import { Department } from '@/modules/department/department.model';
import { notificationService } from '@/modules/notification/notification.service';
import { generateQuotationCode, quotationService } from '@/modules/quotation/quotation.service';
import { Quotation } from '@/modules/quotation/quotation.model';
import type {
  CreateRecurringExpenseInput,
  GenerateRecurringCycleInput,
  RecurringExpenseListQuery,
  UpdateRecurringExpenseInput,
} from '@/modules/recurringExpense/recurringExpense.validation';
import { RecurringExpense, type IRecurringExpense } from '@/modules/recurringExpense/recurringExpense.model';
import { User } from '@/modules/user/user.model';
import { Vendor } from '@/modules/vendor/vendor.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';

const WRITE_ROLES: Role[] = [ROLES.DEPARTMENT_USER, ROLES.HOD];

function scopeToRole(actor: Actor, filter: Record<string, unknown>): void {
  if (actor.role === ROLES.DEPARTMENT_USER) {
    filter.createdBy = actor.id;
  } else if (actor.role === ROLES.HOD) {
    filter.department = actor.department;
  }
  // Director, CEO, Accounts, Payment, Super Admin — see all (read-only visibility mirrors
  // how those roles already see every other procurement stage).
}

function ownershipFilter(actor: Actor): Record<string, unknown> {
  return actor.role === ROLES.HOD ? { department: actor.department } : { createdBy: actor.id };
}

/** Advances a due date by one cycle of `frequency` — used both when a series is first created
 *  (to compute the first `nextDueDate`, if the caller wants it derived) and every time a cycle
 *  is generated. Calendar-month math (not a fixed day count), so e.g. Jan 31 + monthly lands on
 *  the last day of February rather than drifting. */
export function computeNextDueDate(from: Date, frequency: string): Date {
  const next = new Date(from);
  if (frequency === RECURRING_FREQUENCY.MONTHLY) {
    next.setMonth(next.getMonth() + 1);
  } else if (frequency === RECURRING_FREQUENCY.HALF_YEARLY) {
    next.setMonth(next.getMonth() + 6);
  } else {
    next.setFullYear(next.getFullYear() + 1);
  }
  return next;
}

const POPULATE_LIST = [
  { path: 'vendor', select: 'name code' },
  { path: 'reimbursedTo', select: 'name email' },
  { path: 'department', select: 'name code' },
  { path: 'createdBy', select: 'name email' },
];

export const recurringExpenseService = {
  async create(input: CreateRecurringExpenseInput, actor: Actor): Promise<IRecurringExpense> {
    if (!WRITE_ROLES.includes(actor.role) || !actor.department) {
      throw ApiError.forbidden('Only a Department User or HOD can set up a recurring expense');
    }

    if (input.mode === RECURRING_MODE.VENDOR_BILL) {
      const vendor = await Vendor.findById(input.vendor);
      if (!vendor) throw ApiError.badRequest('Vendor not found');
    } else {
      const employee = await User.findById(input.reimbursedTo);
      if (!employee) throw ApiError.badRequest('User to reimburse not found');
    }

    const series = await RecurringExpense.create({
      title: input.title,
      mode: input.mode as RecurringMode,
      department: actor.department,
      vendor: input.mode === RECURRING_MODE.VENDOR_BILL ? input.vendor : undefined,
      reimbursedTo: input.mode === RECURRING_MODE.REIMBURSEMENT ? input.reimbursedTo : undefined,
      reimbursementBankDetails: input.mode === RECURRING_MODE.REIMBURSEMENT ? input.reimbursementBankDetails : undefined,
      frequency: input.frequency as RecurringFrequency,
      baselineAmount: input.baselineAmount,
      thresholdPercent: input.thresholdPercent ?? 20,
      originRequirement: input.originRequirement,
      originQuotation: input.originQuotation,
      nextDueDate: input.nextDueDate,
      isActive: true,
      createdBy: actor.id,
    });

    return series;
  },

  async list(query: RecurringExpenseListQuery, actor: Actor) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = {};

    scopeToRole(actor, filter);
    if (query.isActive !== undefined) filter.isActive = query.isActive === 'true';
    if (query.search) filter.title = new RegExp(query.search.trim(), 'i');

    const [items, total] = await Promise.all([
      RecurringExpense.find(filter)
        .populate(POPULATE_LIST)
        .sort({ nextDueDate: 1 })
        .skip(pagination.skip)
        .limit(pagination.limit),
      RecurringExpense.countDocuments(filter),
    ]);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  async getById(id: string, actor: Actor): Promise<IRecurringExpense> {
    const filter: Record<string, unknown> = { _id: id };
    scopeToRole(actor, filter);

    const series = await RecurringExpense.findOne(filter).populate(POPULATE_LIST);
    if (!series) throw ApiError.notFound('Recurring expense not found');
    return series;
  },

  async update(id: string, input: UpdateRecurringExpenseInput, actor: Actor): Promise<IRecurringExpense> {
    if (!WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can update a recurring expense');
    }

    const series = await RecurringExpense.findOneAndUpdate(
      { _id: id, ...ownershipFilter(actor) },
      { $set: input },
      { new: true },
    );
    if (!series) throw ApiError.notFound('Recurring expense not found');
    return series;
  },

  /**
   * "Generate This Cycle" — the only way a recurring cycle's Bill ever comes into existence.
   * Clones a minimal Quotation (to satisfy Bill.quotation's required FK + one-Bill-per-Quotation
   * unique index) directly at Approved status — it is never routed through Director Review
   * again, since that approval already happened once for this series — then creates the Bill
   * via billService.createForRecurringExpense(). Advances `nextDueDate` so the reminder
   * scheduler doesn't nag again until the *next* cycle.
   */
  async generateCycle(id: string, input: GenerateRecurringCycleInput, actor: Actor) {
    if (!WRITE_ROLES.includes(actor.role)) {
      throw ApiError.forbidden('Only a Department User or HOD can generate a recurring bill cycle');
    }

    const series = await RecurringExpense.findOne({ _id: id, ...ownershipFilter(actor) });
    if (!series) throw ApiError.notFound('Recurring expense not found');
    if (!series.isActive) throw ApiError.badRequest('This recurring expense is no longer active');

    const department = await Department.findById(series.department).select('name');
    if (!department) throw ApiError.badRequest('Department not found for this recurring expense');

    const quotationCode = await generateQuotationCode(String(series.department));
    const now = new Date();

    let temporaryVendor: { name: string } | undefined;
    if (series.mode === RECURRING_MODE.REIMBURSEMENT) {
      const employee = await User.findById(series.reimbursedTo).select('name').lean();
      temporaryVendor = { name: `Reimbursement — ${(employee as { name?: string } | null)?.name ?? 'Employee'}` };
    }

    const quotation = await Quotation.create({
      quotationCode,
      vendor: series.mode === RECURRING_MODE.VENDOR_BILL ? series.vendor : undefined,
      temporaryVendor,
      department: series.department,
      createdBy: actor.id,
      quotationDate: now,
      requiredDate: now,
      amount: input.invoiceAmount,
      gst: 0,
      paymentTerms: input.paymentTerms ?? 'N/A',
      deliveryTerms: 'N/A',
      creditPeriod: 0,
      priority: 'medium',
      description: `Recurring cycle — ${series.title}`,
      status: QUOTATION_STATUS.APPROVED,
    });

    const bill = await billService.createForRecurringExpense(
      {
        recurringExpenseId: String(series._id),
        quotationId: String(quotation._id),
        invoiceNumber: input.invoiceNumber,
        invoiceDate: input.invoiceDate,
        invoiceAmount: input.invoiceAmount,
        taxableAmount: input.taxableAmount,
        gstAmount: input.gstAmount,
        paymentTerms: input.paymentTerms,
        remarks: input.remarks,
      },
      actor,
    );

    series.nextDueDate = computeNextDueDate(series.nextDueDate, series.frequency);
    await series.save();

    return bill;
  },

  /** Used by recurringExpenseReminder.service.ts — never called directly from a route. */
  async findDueSeries(now: Date): Promise<IRecurringExpense[]> {
    return RecurringExpense.find({ isActive: true, nextDueDate: { $lte: now } });
  },

  async notifyDue(series: IRecurringExpense): Promise<void> {
    const recipients = await User.find({
      role: { $in: [ROLES.DEPARTMENT_USER, ROLES.HOD] },
      department: series.department,
      isActive: true,
    }).select('_id role').lean();
    const targets = recipients.map((u) => ({ id: u._id.toString(), role: u.role }));
    if (targets.length === 0) return;

    await notificationService.notifyUsers(targets, {
      title: 'Recurring Bill Due',
      message: `"${series.title}" is due — generate this cycle's bill.`,
      module: 'bill',
      relatedRecord: String(series._id),
      notificationType: 'recurring_expense_due',
      sender: series.createdBy.toString(),
    });
  },
};
