import { Bill } from '@/modules/bill/bill.model';
import type { ExternalBillListQuery } from '@/modules/external/external.validation';
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
};
