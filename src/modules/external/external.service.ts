import { BILL_STATUS, QUOTATION_STATUS } from '@/constants/status';
import { Bill } from '@/modules/bill/bill.model';
import type { ExternalBillListQuery, ExternalUpcomingPaymentsQuery } from '@/modules/external/external.validation';
import { loadDirectorReviewsByRequirement, resolveQuotationApproval } from '@/services/payment/paymentDueReminder.service';
import { RecurringExpense } from '@/modules/recurringExpense/recurringExpense.model';
import { Requirement } from '@/modules/requirement/requirement.model';
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
   * within `withinDays` (overdue items included, never excluded), merged from three sources,
   * ordered here from most to least certain:
   *  - Bill (isTentative: false) — already VERIFIED/PAYMENT_PENDING, so invoiceAmount is real.
   *  - RecurringExpense (isTentative: true) — a cycle hasn't been generated yet, so amount is
   *    only the originally Director-approved baseline, not the eventual real invoice.
   *  - Requirement.preparedQuotation (isTentative: true) — the department's own pick, before
   *    Director approval even exists. The earliest possible signal, so also the least certain:
   *    amount, vendor, and whether it happens at all can still change. No real due date exists
   *    this early either, so `dueDate` falls back to the Requirement's `requiredDate` (when the
   *    goods are needed, not a payment date) — an intentional approximation, not a promise.
   * Pagination is applied after merging+sorting all three sources (each bounded by the same
   * `withinDays` window, so the combined set stays small) rather than at the DB-query level,
   * since there's no single collection to paginate across.
   */
  async listUpcomingPayments(query: ExternalUpcomingPaymentsQuery) {
    const pagination = parsePagination(query);
    const now = new Date();
    const cutoff = addDays(now, query.withinDays);

    const [bills, series, requirements] = await Promise.all([
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
      Requirement.find({
        preparedQuotation: { $exists: true, $ne: null },
        isDeleted: { $ne: true },
        requiredDate: { $lte: cutoff },
      })
        .populate({
          path: 'preparedQuotation',
          populate: [
            { path: 'vendor', select: 'name' },
            { path: 'directorApprovals.director', select: 'name' },
          ],
        })
        .lean(),
    ]);

    const dayMs = 24 * 60 * 60 * 1000;
    const daysRemaining = (date: Date) => Math.ceil((date.getTime() - now.getTime()) / dayMs);

    // Requirement-linked quotations (the normal Requirement → Quotation → Dual Director
    // Approval flow) never populate their own `directorApprovals[]` — the real approval record
    // lives on a separate DirectorReview document keyed by `requirement`. Batch-load every
    // review this page could need in one query (see resolveQuotationApproval).
    type QuotationRequirementRef = { requirement?: unknown } | null | undefined;
    const reviewMap = await loadDirectorReviewsByRequirement([
      ...bills.map((bill) => (bill.quotation as unknown as QuotationRequirementRef)?.requirement),
      ...series.map((item) => (item.originQuotation as unknown as QuotationRequirementRef)?.requirement),
      ...requirements.map((req) => req._id),
    ]);

    const billItems = bills.map((bill) => {
      const vendor = bill.vendor as unknown as { name?: string } | null;
      const reimbursedTo = bill.reimbursedTo as unknown as { name?: string } | null;
      const approval = resolveQuotationApproval(
        bill.quotation as unknown as Parameters<typeof resolveQuotationApproval>[0],
        reviewMap,
      );
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
        quotationApproval: approval.approvalText,
        approvedAt: approval.approvedAt,
      };
    });

    const recurringItems = series.map((item) => {
      const vendor = item.vendor as unknown as { name?: string } | null;
      const reimbursedTo = item.reimbursedTo as unknown as { name?: string } | null;
      const approval = resolveQuotationApproval(
        item.originQuotation as unknown as Parameters<typeof resolveQuotationApproval>[0],
        reviewMap,
      );
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
        quotationApproval: approval.approvalText,
        approvedAt: approval.approvedAt,
      };
    });

    // Excludes a prepared quotation that already turned into a real Bill (billed) or that a
    // Director rejected — both are stale signals once the Bill/RecurringExpense tiers above
    // already cover (or definitively won't cover) the same spend.
    const preparedItems = requirements
      .filter((req) => {
        const quotation = req.preparedQuotation as unknown as { status?: string } | null;
        return quotation && quotation.status !== QUOTATION_STATUS.BILLED && quotation.status !== QUOTATION_STATUS.REJECTED;
      })
      .map((req) => {
        const quotation = req.preparedQuotation as unknown as {
          amount: number;
          status?: string;
          vendor?: { name?: string } | null;
          temporaryVendor?: { name?: string } | null;
        };
        // Keyed by the Requirement itself (not quotation.requirement) — same id, but this
        // avoids depending on that field having been populated onto preparedQuotation.
        const approval = resolveQuotationApproval({ requirement: req._id, amount: quotation.amount }, reviewMap);
        return {
          id: String(req._id),
          type: 'prepared_quotation' as const,
          reference: `${req.requirementNumber} - ${req.title}`,
          payee: quotation.vendor?.name ?? quotation.temporaryVendor?.name ?? 'Unknown',
          // The amount a Director actually approved (which may be a different quotation than
          // the department's own "prepared" pick, if a Director overrode it) once approved;
          // the prepared pick's own amount until then.
          amount: approval.approvedAt ? approval.approvedAmount : quotation.amount,
          isTentative: true,
          dueDate: req.requiredDate,
          daysRemaining: daysRemaining(req.requiredDate),
          // Reflects the Requirement's real, live Dual Director Approval status — flips from
          // pending to approved only once EVERY Director has approved, with no separate
          // update step (see approvedAt below).
          status: approval.approvedAt ? 'prepared_approved' : 'prepared_pending_approval',
          quotationApproval: approval.approvalText,
          // Two distinct events, often days apart: when the department picked this quotation,
          // and when every Director actually approved it (null until that happens).
          preparedAt: req.preparedQuotationAt ?? null,
          approvedAt: approval.approvedAt,
        };
      });

    const merged = [...billItems, ...recurringItems, ...preparedItems].sort(
      (a, b) => a.dueDate.getTime() - b.dueDate.getTime(),
    );

    const total = merged.length;
    const items = merged.slice(pagination.skip, pagination.skip + pagination.limit);

    return { items, meta: buildPaginationMeta(total, pagination) };
  },
};
