import { Bill, type IBill } from '@/modules/bill/bill.model';
import { Payment } from '@/modules/payment/payment.model';
import { PurchaseOrder, type IAiDifference, type IAiVerification, type IPurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import { Quotation, type IQuotation } from '@/modules/quotation/quotation.model';
import { User } from '@/modules/user/user.model';
import type { Actor } from '@/types/actor';
import { ApiError } from '@/utils/ApiError';

// ── Types ──────────────────────────────────────────────────────────────────────

type ComparisonStatus = 'matched' | 'low' | 'medium' | 'high' | 'not_tracked' | 'not_verified';

interface ComparisonRow {
  field: string;
  quotation: unknown;
  purchaseOrder: unknown;
  bill: unknown;
  status: ComparisonStatus;
  note?: string;
}

interface TimelineEvent {
  key: string;
  label: string;
  status: 'completed' | 'pending';
  timestamp: Date | null;
  actor?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Loosely matches an AI difference entry to a canonical row label (case-insensitive, either direction). */
function findDifference(differences: IAiDifference[], aliases: string[]): IAiDifference | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return differences.find((d) => {
    const df = norm(d.field);
    return aliases.some((a) => {
      const na = norm(a);
      return df === na || df.includes(na) || na.includes(df);
    });
  });
}

function severityToStatus(severity: IAiDifference['severity']): ComparisonStatus {
  if (severity === 'HIGH') return 'high';
  if (severity === 'MEDIUM') return 'medium';
  return 'low';
}

/** Builds one comparison-table row. `trackable` fields default to "matched" when the AI ran but
 * didn't flag them; `not_tracked` fields (no data captured by the pipeline) never claim a match. */
function buildRow(
  field: string,
  values: { quotation?: unknown; purchaseOrder?: unknown; bill?: unknown },
  aliases: string[],
  aiVerification: IAiVerification | null,
  trackable: boolean,
  note?: string,
): ComparisonRow {
  const row: ComparisonRow = {
    field,
    quotation: values.quotation ?? null,
    purchaseOrder: values.purchaseOrder ?? null,
    bill: values.bill ?? null,
    status: 'not_verified',
    note,
  };

  if (!aiVerification) {
    row.status = 'not_verified';
    return row;
  }

  const diff = findDifference(aiVerification.differences, aliases);
  if (diff) {
    row.status = severityToStatus(diff.severity);
    return row;
  }

  row.status = trackable ? 'matched' : 'not_tracked';
  if (!trackable && !note) {
    row.note = 'Not captured by the current AI verification pipeline';
  }
  return row;
}

function buildComparisonTable(
  quotation: IQuotation | null,
  po: IPurchaseOrder | null,
  bill: IBill,
  billVendor: { name?: string; gstNumber?: string; panNumber?: string; bankDetails?: { bankName?: string; accountNumber?: string; ifscCode?: string } } | null,
  quotationVendor: { name?: string; gstNumber?: string; panNumber?: string } | null,
  aiVerification: IAiVerification | null,
  ocrData: Record<string, unknown> | undefined,
): ComparisonRow[] {
  const quotationGrandTotal = quotation
    ? Math.round(quotation.amount * (1 + (quotation.gst ?? 0) / 100))
    : null;
  const quotationGstAmount = quotation
    ? Math.round(quotation.amount * ((quotation.gst ?? 0) / 100))
    : null;

  const rows: ComparisonRow[] = [
    buildRow('Vendor Name',
      { quotation: quotationVendor?.name, purchaseOrder: po?.vendorName, bill: billVendor?.name },
      ['Vendor Name'], aiVerification, true),

    buildRow('Vendor GST',
      { quotation: quotationVendor?.gstNumber, purchaseOrder: po?.vendorGst, bill: billVendor?.gstNumber },
      ['Vendor GST', 'GST Number', 'GSTIN'], aiVerification, true),

    buildRow('Vendor PAN',
      { quotation: quotationVendor?.panNumber, purchaseOrder: null, bill: billVendor?.panNumber },
      ['Vendor PAN', 'PAN Number'], aiVerification, false,
      'Purchase Order does not store a vendor PAN field'),

    buildRow('Department',
      { quotation: null, purchaseOrder: po?.departmentName, bill: null },
      ['Department', 'Department Name'], aiVerification, true),

    buildRow('Bank Name',
      { quotation: billVendor?.bankDetails?.bankName, purchaseOrder: null, bill: billVendor?.bankDetails?.bankName },
      ['Bank Name'], aiVerification, false,
      'Bank details are not part of the Quotation/PO/Bill AI comparison — shown from the Vendor record for reference'),

    buildRow('Account Number',
      { quotation: billVendor?.bankDetails?.accountNumber, purchaseOrder: null, bill: billVendor?.bankDetails?.accountNumber },
      ['Account Number'], aiVerification, false,
      'Not part of the AI comparison — shown from the Vendor record for reference'),

    buildRow('IFSC',
      { quotation: billVendor?.bankDetails?.ifscCode, purchaseOrder: null, bill: billVendor?.bankDetails?.ifscCode },
      ['IFSC', 'IFSC Code'], aiVerification, false,
      'Not part of the AI comparison — shown from the Vendor record for reference'),

    buildRow('Taxable Amount',
      { quotation: quotation?.amount, purchaseOrder: po?.subtotal, bill: bill.taxableAmount },
      ['Taxable Amount', 'Subtotal'], aiVerification, true),

    buildRow('GST Amount',
      { quotation: quotationGstAmount, purchaseOrder: po?.totalGst, bill: bill.gstAmount },
      ['GST Amount', 'GST Rate and GST Amount', 'Tax Amount'], aiVerification, true),

    buildRow('CGST',
      { quotation: null, purchaseOrder: null, bill: null },
      ['CGST'], aiVerification, false,
      'CGST/SGST/IGST split is not captured — only a combined GST amount is tracked'),

    buildRow('SGST',
      { quotation: null, purchaseOrder: null, bill: null },
      ['SGST'], aiVerification, false,
      'CGST/SGST/IGST split is not captured — only a combined GST amount is tracked'),

    buildRow('IGST',
      { quotation: null, purchaseOrder: null, bill: null },
      ['IGST'], aiVerification, false,
      'CGST/SGST/IGST split is not captured — only a combined GST amount is tracked'),

    buildRow('Grand Total',
      { quotation: quotationGrandTotal, purchaseOrder: po?.grandTotal, bill: bill.invoiceAmount },
      ['Grand Total', 'Bill Grand Total', 'PO Grand Total', 'Total'], aiVerification, true),

    buildRow('Invoice Number',
      { quotation: null, purchaseOrder: null, bill: bill.invoiceNumber },
      ['Invoice Number'], aiVerification, false,
      'Bill-only identifier — no counterpart on the Quotation or PO'),

    buildRow('Invoice Date',
      { quotation: quotation?.quotationDate, purchaseOrder: po?.poDate, bill: bill.invoiceDate },
      ['Invoice Date'], aiVerification, true),

    buildRow('PO Number',
      { quotation: null, purchaseOrder: po?.poNumber, bill: (ocrData?.poNumber as string | undefined) ?? null },
      ['PO Number'], aiVerification, true),

    buildRow('Currency',
      { quotation: quotation?.currency, purchaseOrder: 'INR', bill: null },
      ['Currency'], aiVerification, false,
      'Bill currency is not separately captured by OCR'),

    buildRow('Payment Terms',
      { quotation: quotation?.paymentTerms, purchaseOrder: po?.terms ?? null, bill: bill.paymentTerms },
      ['Payment Terms'], aiVerification, true),
  ];

  return rows;
}

function groupDifferencesBySeverity(differences: IAiDifference[]) {
  return {
    high: differences.filter((d) => d.severity === 'HIGH'),
    medium: differences.filter((d) => d.severity === 'MEDIUM'),
    low: differences.filter((d) => !d.severity || d.severity === 'LOW'),
  };
}

function recommendationBand(matchPercentage: number | undefined): 'green' | 'warning' | 'red' | null {
  if (matchPercentage === undefined || matchPercentage === null) return null;
  if (matchPercentage >= 95) return 'green';
  if (matchPercentage >= 80) return 'warning';
  return 'red';
}

async function buildTimeline(
  quotation: IQuotation | null,
  po: IPurchaseOrder | null,
  bill: IBill,
): Promise<TimelineEvent[]> {
  const approvedEntry = quotation?.directorApprovals?.find((a) => a.decision === 'approved');
  const payment = await Payment.findOne({ bill: bill._id }).select('status paymentDate updatedAt').lean();

  const events: TimelineEvent[] = [
    { key: 'quotation_created', label: 'Quotation Created', status: quotation ? 'completed' : 'pending', timestamp: quotation?.createdAt ?? null },
    { key: 'director_approved', label: 'Director Approved (Quotation)', status: approvedEntry ? 'completed' : 'pending', timestamp: approvedEntry?.decidedAt ?? null },
    { key: 'po_generated', label: 'Purchase Order Generated', status: po ? 'completed' : 'pending', timestamp: po?.createdAt ?? null },
    { key: 'bill_uploaded', label: 'Bill Uploaded', status: 'completed', timestamp: bill.submittedAt ?? bill.createdAt },
    { key: 'ai_verified', label: 'AI Verified', status: po?.aiVerification ? 'completed' : 'pending', timestamp: po?.aiVerification?.verifiedAt ?? null },
    { key: 'director_review', label: 'Director Review', status: bill.directorFinancialAt ? 'completed' : 'pending', timestamp: bill.directorFinancialAt ?? null },
    { key: 'accounts', label: 'Accounts', status: bill.verifiedAt || bill.decisionHistory.length > 0 ? 'completed' : 'pending', timestamp: bill.verifiedAt ?? bill.decisionHistory[bill.decisionHistory.length - 1]?.decidedAt ?? null },
    { key: 'payment', label: 'Payment', status: payment && payment.status === 'paid' ? 'completed' : 'pending', timestamp: payment?.paymentDate ?? (payment?.status === 'paid' ? payment.updatedAt : null) },
  ];

  return events;
}

// ── Service ────────────────────────────────────────────────────────────────────

export const directorService = {
  async getBillReview(billId: string, _actor: Actor) {
    const bill = await Bill.findOne({ _id: billId, isDeleted: { $ne: true } })
      .populate('vendor')
      .populate('reimbursedTo', 'name email')
      .populate('recurringExpense', 'title mode frequency thresholdPercent baselineAmount reimbursementBankDetails')
      .populate('department', 'name code')
      .populate('createdBy', 'name email')
      .populate('directorFinancialBy', 'name email')
      .populate('verifiedBy', 'name email')
      .populate('decisionHistory.decidedBy', 'name email');

    if (!bill) throw ApiError.notFound('Bill not found');

    const [quotation, po] = await Promise.all([
      Quotation.findById(bill.quotation)
        .populate('vendor')
        .populate('department', 'name code')
        .populate('createdBy', 'name email')
        .populate('submittedBy', 'name email')
        .populate('directorApprovals.director', 'name email'),
      PurchaseOrder.findOne({ quotation: bill.quotation, isDeleted: false })
        .populate('createdBy', 'name email'),
    ]);

    const billVendor = bill.vendor as unknown as {
      _id: unknown; name?: string; gstNumber?: string; panNumber?: string;
      bankDetails?: { bankName?: string; accountHolderName?: string; accountNumber?: string; ifscCode?: string; upiId?: string };
    } | null;
    const quotationVendor = quotation?.vendor as unknown as {
      name?: string; gstNumber?: string; panNumber?: string;
    } | null;

    const aiVerification = po?.aiVerification ?? null;
    const ocrData = aiVerification?.ocrExtractedData;

    // Already-billed / remaining balance against the PO (see billService.create — 1 active
    // Bill per PO today; the partial unique index on Bill.quotation allows a *new* one after
    // an old one is soft-deleted, so "previousBills" below can be non-empty even though only
    // one Bill is ever active at once).
    let alreadyBilled = 0;
    let remainingBalance: number | null = null;
    let previousBills: unknown[] = [];
    if (po) {
      const agg = await Bill.aggregate<{ total: number }>([
        { $match: { quotation: po.quotation, isDeleted: { $ne: true } } },
        { $group: { _id: null, total: { $sum: '$invoiceAmount' } } },
      ]);
      alreadyBilled = agg[0]?.total ?? 0;
      remainingBalance = po.grandTotal - alreadyBilled;

      previousBills = await Bill.find({ quotation: po.quotation, _id: { $ne: bill._id } })
        .select('billCode invoiceNumber invoiceAmount status isDeleted createdAt directorFinancialDecision')
        .sort({ createdAt: -1 })
        .lean();
    }

    const comparisonTable = buildComparisonTable(
      quotation, po ?? null, bill, billVendor, quotationVendor, aiVerification, ocrData,
    );

    const differences = aiVerification?.differences ?? [];
    const timeline = await buildTimeline(quotation, po ?? null, bill);

    const approvedEntry = quotation?.directorApprovals?.find((a) => a.decision === 'approved');

    // Fetch all active directors for the roster
    const activeDirectors = await User.find({ role: 'director', isActive: true }).select('name isActive role createdAt').lean();
    const decidedByDirectorId = new Map(bill.directorApprovals.map((entry) => [entry.directorId.toString(), entry]));
    const roster = activeDirectors
      .filter((dir) => dir.isActive || decidedByDirectorId.has(String(dir._id)))
      .map((dir) => {
        const entry = decidedByDirectorId.get(String(dir._id));
        return {
          directorId: dir._id,
          directorName: dir.name,
          directorCreatedAt: dir.createdAt,
          decision: entry?.decision ?? 'pending',
          remarks: entry?.remarks,
          decidedAt: entry?.decidedAt ?? null,
        };
      });

    roster.sort((a, b) => {
      if (!a.decidedAt && !b.decidedAt) return 0;
      if (!a.decidedAt) return 1;
      if (!b.decidedAt) return -1;
      return new Date(b.decidedAt).getTime() - new Date(a.decidedAt).getTime();
    });

    return {
      bill: {
        id: String(bill._id),
        billCode: bill.billCode,
        invoiceNumber: bill.invoiceNumber,
        invoiceDate: bill.invoiceDate,
        invoiceAmount: bill.invoiceAmount,
        taxableAmount: bill.taxableAmount,
        gstAmount: bill.gstAmount,
        grandTotal: bill.invoiceAmount,
        paymentTerms: bill.paymentTerms,
        dueDate: bill.dueDate,
        status: bill.status,
        vendor: billVendor,
        department: bill.department,
        uploadedBy: bill.createdBy,
        invoiceFiles: bill.invoiceFiles,
        supportingDocuments: bill.supportingDocuments,
        remarks: bill.remarks,
        directorFinancialDecision: bill.directorFinancialDecision ?? null,
        directorFinancialBy: bill.directorFinancialBy ?? null,
        directorFinancialAt: bill.directorFinancialAt ?? null,
        directorFinancialRemarks: bill.directorFinancialRemarks ?? null,
        directorApprovals: roster,
        recurringExpense: bill.recurringExpense as unknown as
          { _id: unknown; title: string; mode: string; thresholdPercent: number; baselineAmount: number } | null,
        reimbursedTo: bill.reimbursedTo ?? null,
      },
      quotation: quotation ? {
        id: String(quotation._id),
        quotationCode: quotation.quotationCode,
        amount: quotation.amount,
        gst: quotation.gst,
        grandTotal: Math.round(quotation.amount * (1 + (quotation.gst ?? 0) / 100)),
        currency: quotation.currency,
        paymentTerms: quotation.paymentTerms,
        vendor: quotationVendor,
        department: quotation.department,
        createdBy: quotation.createdBy,
        submittedBy: quotation.submittedBy ?? quotation.createdBy,
        approvalDate: approvedEntry?.decidedAt ?? null,
        approvedBy: approvedEntry?.director ?? null,
        pdfFiles: quotation.pdfFiles,
      } : null,
      purchaseOrder: po ? {
        id: String(po._id),
        poNumber: po.poNumber,
        poDate: po.poDate,
        grandTotal: po.grandTotal,
        createdBy: po.createdBy,
        alreadyBilled,
        remainingBalance,
        availableBalance: remainingBalance,
        status: po.status,
        pdfDownloadPath: `/api/v1/purchase-orders/${String(po._id)}/pdf`,
        previousBills,
      } : null,
      aiVerification: aiVerification ? {
        available: true,
        matchPercentage: aiVerification.matchPercentage,
        quotationMatch: aiVerification.quotationMatch ?? null,
        purchaseOrderMatch: aiVerification.purchaseOrderMatch ?? null,
        risk: aiVerification.risk,
        recommendation: aiVerification.recommendation,
        confidence: aiVerification.confidence,
        summary: aiVerification.summary,
        ruleEngineScore: aiVerification.ruleEngineScore,
        verifiedAt: aiVerification.verifiedAt,
        executionTimeMs: aiVerification.executionTimeMs ?? null,
        modelVersion: aiVerification.modelVersion ?? null,
        promptVersion: aiVerification.promptVersion ?? null,
        tokenUsage: aiVerification.tokenUsage ?? null,
        aiProvider: aiVerification.aiProvider ?? null,
      } : { available: false },
      comparisonTable,
      differences,
      differencesBySeverity: groupDifferencesBySeverity(differences),
      timeline,
      approvalHistory: {
        quotationApprovals: quotation?.directorApprovals ?? [],
        directorFinancial: bill.directorFinancialDecision ? {
          decision: bill.directorFinancialDecision,
          by: bill.directorFinancialBy,
          at: bill.directorFinancialAt,
          remarks: bill.directorFinancialRemarks,
        } : null,
        accountsDecisions: bill.decisionHistory,
      },
      recommendationBand: recommendationBand(aiVerification?.matchPercentage),
      canDecide: bill.status === 'ai_verified',
      canTriggerAiVerification: !aiVerification && !!po,
    };
  },
};
