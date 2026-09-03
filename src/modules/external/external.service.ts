import { BILL_STATUS } from '@/constants/status';
import { Bill } from '@/modules/bill/bill.model';
import type { ExternalBillListQuery, ExternalUpcomingPaymentsQuery } from '@/modules/external/external.validation';
import { formatQuotationApprovals } from '@/services/payment/paymentDueReminder.service';
import { RecurringExpense } from '@/modules/recurringExpense/recurringExpense.model';
import { buildPaginationMeta, parsePagination } from '@/utils/pagination';

interface ExternalBillItem {
  id: string;
  billCode: string;
  invoiceNumber: string;
  vendorName: string;
  amount: number;
  creditPeriod: number | null;
  invoiceDate: Date;
  // invoiceDate + creditPeriod days — null when creditPeriod was never set (nothing to add
  // to a calendar for reminder purposes in that case).
  creditPeriodDueDate: Date | null;
  status: string;
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export const externalService = {
  async listBills(query: ExternalBillListQuery) {
    const pagination = parsePagination(query);
    const filter: Record<string, unknown> = { isDeleted: { $ne: true } };
    if (query.status) filter.status = query.status;

    const [docs, total] = await Promise.all([
      Bill.find(filter)
        .populate('vendor', 'name')
        .populate('reimbursedTo', 'name')
        .sort({ invoiceDate: -1 })
        .skip(pagination.skip)
        .limit(pagination.limit)
        .lean(),
      Bill.countDocuments(filter),
    ]);

    let items: ExternalBillItem[] = docs.map((bill) => {
      const vendor = bill.vendor as unknown as { name?: string } | null;
      const reimbursedTo = bill.reimbursedTo as unknown as { name?: string } | null;
      const creditPeriodDueDate = bill.creditPeriod != null ? addDays(bill.invoiceDate, bill.creditPeriod) : null;

      return {
        id: String(bill._id),
        billCode: bill.billCode,
        invoiceNumber: bill.invoiceNumber,
        vendorName: vendor?.name ?? reimbursedTo?.name ?? 'Unknown',
        amount: bill.invoiceAmount,
        creditPeriod: bill.creditPeriod ?? null,
        invoiceDate: bill.invoiceDate,
        creditPeriodDueDate,
        status: bill.status,
      };
    });

    if (query.dueWithinDays !== undefined) {
      const cutoff = addDays(new Date(), query.dueWithinDays);
      items = items.filter((item) => item.creditPeriodDueDate !== null && item.creditPeriodDueDate <= cutoff);
    }

    return { items, meta: buildPaginationMeta(total, pagination) };
  },

  /**
   * GET /external/payments/upcoming — everything Payment Department needs to see coming due
   * within `withinDays` (overdue items included, never excluded), merged from two sources:
   *  - Bill (isTentative: false) — already VERIFIED/PAYMENT_PENDING, so invoiceAmount is real.
   *  - RecurringExpense (isTentative: true) — a cycle hasn't been generated yet, so amount is
   *    only the originally Director-approved baseline, not the eventual real invoice.
   * Pagination is applied after merging+sorting the two sources (both bounded by the same
   * `withinDays` window, so the combined set stays small) rather than at the DB-query level,
   * since there's no single collection to paginate across.
   */
  async listUpcomingPayments(query: ExternalUpcomingPaymentsQuery) {
    const pagination = parsePagination(query);
    const now = new Date();
    const cutoff = addDays(now, query.withinDays);

    const [bills, series] = await Promise.all([
      Bill.find({
        status: { $in: [BILL_STATUS.VERIFIED, BILL_STATUS.PAYMENT_PENDING] },
        isDeleted: { $ne: true },
        dueDate: { $lte: cutoff },
      })
        .populate('vendor', 'name')
        .populate('reimbursedTo', 'name')
        .populate({ path: 'quotation', populate: { path: 'directorApprovals.director', select: 'name' } })
        .lean(),
      RecurringExpense.find({ isActive: true, nextDueDate: { $lte: cutoff } })
        .populate('vendor', 'name')
        .populate('reimbursedTo', 'name')
        .populate({ path: 'originQuotation', populate: { path: 'directorApprovals.director', select: 'name' } })
        .lean(),
    ]);

    const dayMs = 24 * 60 * 60 * 1000;
    const daysRemaining = (date: Date) => Math.ceil((date.getTime() - now.getTime()) / dayMs);

    const billItems = bills.map((bill) => {
      const vendor = bill.vendor as unknown as { name?: string } | null;
      const reimbursedTo = bill.reimbursedTo as unknown as { name?: string } | null;
      return {
        id: String(bill._id),
        type: 'bill' as const,
        reference: bill.billCode,
        payee: vendor?.name ?? reimbursedTo?.name ?? 'Unknown',
        amount: bill.invoiceAmount,
        isTentative: false,
        dueDate: bill.dueDate,
        daysRemaining: daysRemaining(bill.dueDate),
        status: bill.status,
        quotationApproval: formatQuotationApprovals(bill.quotation as unknown as Parameters<typeof formatQuotationApprovals>[0]),
      };
    });

    const recurringItems = series.map((item) => {
      const vendor = item.vendor as unknown as { name?: string } | null;
      const reimbursedTo = item.reimbursedTo as unknown as { name?: string } | null;
      return {
        id: String(item._id),
        type: 'recurring_expense' as const,
        reference: item.title,
        payee: vendor?.name ?? reimbursedTo?.name ?? 'Unknown',
        amount: item.baselineAmount,
        isTentative: true,
        dueDate: item.nextDueDate,
        daysRemaining: daysRemaining(item.nextDueDate),
        status: 'upcoming',
        quotationApproval: formatQuotationApprovals(item.originQuotation as unknown as Parameters<typeof formatQuotationApprovals>[0]),
      };
    });

    const merged = [...billItems, ...recurringItems].sort(
      (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
    );

    const total = merged.length;
    const items = merged.slice(pagination.skip, pagination.skip + pagination.limit);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },
};
