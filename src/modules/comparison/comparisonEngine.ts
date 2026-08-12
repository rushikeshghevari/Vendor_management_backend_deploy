import type {
  IComparisonItemComparison,
  IComparisonItemEntry,
  IComparisonObservation,
  IComparisonQuotationSnapshot,
  IComparisonRecommendation,
  IComparisonStatistics,
} from '@/modules/comparison/comparison.model';

/**
 * Pure, dependency-free comparison logic — no Mongoose, no DB access. `comparison.service.ts`
 * maps live documents into these plain shapes and hands them here, so every rule below is
 * unit-testable without a database (mirrors `quotationOcrParser.ts`'s split from
 * `quotationOcr.service.ts`).
 */

export interface RequirementItemInput {
  itemName: string;
  quantity: number;
  unit: string;
  estimatedRate: number;
  estimatedAmount: number;
}

export interface RequirementInput {
  budget: number;
  items: RequirementItemInput[];
}

export interface QuotationOcrItemInput {
  description: string;
  quantity?: number;
  unit?: string;
  unitPrice?: number;
  amount?: number;
}

export interface QuotationInput {
  id: string;
  quotationCode: string;
  vendorName: string;
  fileHashes: string[];
  amount: number;
  gst: number;
  currency: string;
  paymentTerms: string;
  deliveryTerms: string;
  quotationDate: string;
  ocrStatus: string;
  ocrConfidence?: number;
  ocrStructuredData?: {
    vendorName?: string;
    quotationDate?: string;
    currency?: string;
    discount?: number;
    grandTotal?: number;
    items: QuotationOcrItemInput[];
  };
}

export interface ComparisonResult {
  quotations: IComparisonQuotationSnapshot[];
  statistics: IComparisonStatistics;
  itemComparison: IComparisonItemComparison[];
  observations: IComparisonObservation[];
  recommendation: IComparisonRecommendation;
}

const SUSPICIOUS_PRICE_DEVIATION_PERCENT = 40;
const LOW_OCR_CONFIDENCE_THRESHOLD = 50;
const MISMATCH_TOLERANCE_PERCENT = 1;

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/[^\w\s]/g, '');
}

/** Best-effort delivery-days parse from a free-text field like "Within 2 Weeks" or "7 days".
 *  Not OCR — this reads a field the Department User typed in themselves at quotation creation. */
export function parseDeliveryDays(deliveryTerms: string): number | undefined {
  const match = deliveryTerms.match(/(\d+)\s*(day|days|week|weeks|month|months)?/i);
  if (!match || !match[1]) return undefined;
  const value = parseInt(match[1], 10);
  if (!Number.isFinite(value)) return undefined;
  const unit = (match[2] ?? 'day').toLowerCase();
  if (unit.startsWith('week')) return value * 7;
  if (unit.startsWith('month')) return value * 30;
  return value;
}

function isSignificantlyDifferent(a: number, b: number): boolean {
  const base = Math.max(Math.abs(a), Math.abs(b), 1);
  return Math.abs(a - b) / base * 100 > MISMATCH_TOLERANCE_PERCENT;
}

/** Snapshot a single quotation's comparable fields. `grandTotal` prefers the OCR-extracted
 *  total; if OCR never found one (low confidence, failed, not yet run), falls back to the
 *  quotation's own manually-entered `amount + amount * gst / 100` so a quotation without a
 *  clean OCR read still participates in price comparison rather than dropping out silently. */
function buildSnapshot(quotation: QuotationInput): IComparisonQuotationSnapshot {
  const structured = quotation.ocrStructuredData;
  const fallbackGrandTotal = quotation.amount + (quotation.amount * quotation.gst) / 100;
  const grandTotal = structured?.grandTotal ?? fallbackGrandTotal;
  const grandTotalSource: 'ocr' | 'quotation' = structured?.grandTotal !== undefined ? 'ocr' : 'quotation';

  return {
    quotation: quotation.id as never,
    quotationCode: quotation.quotationCode,
    vendorName: quotation.vendorName,
    hasAttachment: quotation.fileHashes.length > 0,
    ocrStatus: quotation.ocrStatus,
    ocrConfidence: quotation.ocrConfidence,
    currency: structured?.currency ?? quotation.currency,
    grandTotal,
    grandTotalSource,
    gstAmount: quotation.amount * (quotation.gst / 100),
    discount: structured?.discount,
    paymentTerms: quotation.paymentTerms,
    deliveryTerms: quotation.deliveryTerms,
    deliveryDays: parseDeliveryDays(quotation.deliveryTerms),
    quotationDate: quotation.quotationDate,
    validity: undefined,
    itemCount: structured?.items.length ?? 0,
  };
}

/** Matches each Requirement item against this quotation's OCR line items by normalized name
 *  (exact match first, then substring), one-to-one — an OCR item already claimed by one
 *  Requirement item is never matched again. Anything left unclaimed on the quotation side is
 *  reported as an "extra" item. This is a best-effort text match, not a guaranteed pairing —
 *  see docs/PHASE4_AI_COMPARISON.md's Known Limitations. */
function compareItems(requirementItems: RequirementItemInput[], quotationItems: QuotationOcrItemInput[]): IComparisonItemComparison['items'] {
  const used = new Set<number>();
  const entries: IComparisonItemEntry[] = [];

  for (const reqItem of requirementItems) {
    const normReq = normalize(reqItem.itemName);
    let matchIndex = quotationItems.findIndex((qi, i) => !used.has(i) && normalize(qi.description) === normReq);
    if (matchIndex === -1) {
      matchIndex = quotationItems.findIndex((qi, i) => {
        if (used.has(i)) return false;
        const normQi = normalize(qi.description);
        return normQi.length > 0 && (normQi.includes(normReq) || normReq.includes(normQi));
      });
    }

    if (matchIndex === -1) {
      entries.push({
        itemName: reqItem.itemName,
        status: 'missing',
        requirementQuantity: reqItem.quantity,
        quantityMismatch: false,
        requirementRate: reqItem.estimatedRate,
        requirementAmount: reqItem.estimatedAmount,
        amountMismatch: false,
      });
      continue;
    }

    used.add(matchIndex);
    const matched = quotationItems[matchIndex]!;
    const quantityMismatch = matched.quantity !== undefined && isSignificantlyDifferent(reqItem.quantity, matched.quantity);
    const unitPriceDifference = matched.unitPrice !== undefined ? matched.unitPrice - reqItem.estimatedRate : undefined;
    const amountMismatch = matched.amount !== undefined && isSignificantlyDifferent(reqItem.estimatedAmount, matched.amount);

    entries.push({
      itemName: reqItem.itemName,
      status: 'matched',
      requirementQuantity: reqItem.quantity,
      quotationQuantity: matched.quantity,
      quantityMismatch,
      requirementRate: reqItem.estimatedRate,
      quotationUnitPrice: matched.unitPrice,
      unitPriceDifference,
      requirementAmount: reqItem.estimatedAmount,
      quotationAmount: matched.amount,
      amountMismatch,
    });
  }

  quotationItems.forEach((qi, i) => {
    if (used.has(i)) return;
    entries.push({
      itemName: qi.description,
      status: 'extra',
      quotationQuantity: qi.quantity,
      quantityMismatch: false,
      quotationUnitPrice: qi.unitPrice,
      quotationAmount: qi.amount,
      amountMismatch: false,
    });
  });

  return entries;
}

function buildItemComparison(requirement: RequirementInput, quotation: QuotationInput): IComparisonItemComparison {
  const items = compareItems(requirement.items, quotation.ocrStructuredData?.items ?? []);
  return {
    quotation: quotation.id as never,
    quotationCode: quotation.quotationCode,
    items,
    missingItemCount: items.filter((i) => i.status === 'missing').length,
    extraItemCount: items.filter((i) => i.status === 'extra').length,
    quantityMismatchCount: items.filter((i) => i.quantityMismatch).length,
  };
}

function buildStatistics(snapshots: IComparisonQuotationSnapshot[], budget: number, bestValue?: IComparisonQuotationSnapshot): IComparisonStatistics {
  const prices = snapshots.map((s) => s.grandTotal).filter((v): v is number => v !== undefined);
  if (prices.length === 0) {
    return { totalQuotations: snapshots.length };
  }

  const lowestPrice = Math.min(...prices);
  const highestPrice = Math.max(...prices);
  const averagePrice = prices.reduce((sum, v) => sum + v, 0) / prices.length;
  const referencePrice = bestValue?.grandTotal ?? lowestPrice;

  return {
    totalQuotations: snapshots.length,
    lowestPrice,
    highestPrice,
    averagePrice,
    costDifference: highestPrice - lowestPrice,
    // Guarded the same way as the percent below — an unset (0) budget means "no budget
    // constraint recorded yet" (see requirement.service.ts's auto-derived default), not
    // "everything exceeds a $0 budget", so both variance fields stay undefined together.
    budgetVarianceAmount: budget > 0 ? referencePrice - budget : undefined,
    budgetVariancePercent: budget > 0 ? ((referencePrice - budget) / budget) * 100 : undefined,
  };
}

/** Picks the lowest-priced quotation among those with no missing Requirement items — a cheap
 *  quotation that's silently missing half the requested items isn't actually "best value". If
 *  every quotation has at least one missing item, falls back to the overall lowest price so a
 *  best-value pick is still produced (with an observation already flagging the missing items). */
function pickBestValue(
  snapshots: IComparisonQuotationSnapshot[],
  itemComparisons: IComparisonItemComparison[],
): IComparisonQuotationSnapshot | undefined {
  const withPrice = snapshots.filter((s) => s.grandTotal !== undefined);
  if (withPrice.length === 0) return undefined;

  const missingByQuotation = new Map(itemComparisons.map((ic) => [ic.quotationCode, ic.missingItemCount]));
  const complete = withPrice.filter((s) => (missingByQuotation.get(s.quotationCode) ?? 0) === 0);
  const pool = complete.length > 0 ? complete : withPrice;

  return pool.reduce((best, current) => (current.grandTotal! < best.grandTotal! ? current : best));
}

function buildObservations(
  snapshots: IComparisonQuotationSnapshot[],
  itemComparisons: IComparisonItemComparison[],
  quotations: QuotationInput[],
  statistics: IComparisonStatistics,
): IComparisonObservation[] {
  const observations: IComparisonObservation[] = [];
  const byCode = new Map(quotations.map((q) => [q.quotationCode, q]));

  const withPrice = snapshots.filter((s) => s.grandTotal !== undefined);
  if (withPrice.length > 0) {
    const lowest = withPrice.reduce((min, s) => (s.grandTotal! < min.grandTotal! ? s : min));
    const highest = withPrice.reduce((max, s) => (s.grandTotal! > max.grandTotal! ? s : max));
    observations.push({
      type: 'lowest_quotation',
      severity: 'info',
      message: `${lowest.quotationCode} (${lowest.vendorName}) has the lowest grand total at ${lowest.currency ?? ''} ${lowest.grandTotal!.toLocaleString()}.`,
      quotation: byCode.get(lowest.quotationCode)!.id as never,
    });
    if (highest.quotationCode !== lowest.quotationCode) {
      observations.push({
        type: 'highest_quotation',
        severity: 'info',
        message: `${highest.quotationCode} (${highest.vendorName}) has the highest grand total at ${highest.currency ?? ''} ${highest.grandTotal!.toLocaleString()}.`,
        quotation: byCode.get(highest.quotationCode)!.id as never,
      });
    }
  }

  for (const snapshot of snapshots) {
    const quotation = byCode.get(snapshot.quotationCode)!;

    if (!snapshot.hasAttachment) {
      observations.push({
        type: 'missing_documents',
        severity: 'warning',
        message: `${snapshot.quotationCode} (${snapshot.vendorName}) has no uploaded document.`,
        quotation: quotation.id as never,
      });
    }

    if (snapshot.ocrStatus === 'failed' || (snapshot.ocrConfidence !== undefined && snapshot.ocrConfidence < LOW_OCR_CONFIDENCE_THRESHOLD)) {
      observations.push({
        type: 'ocr_confidence_warning',
        severity: 'warning',
        message: snapshot.ocrStatus === 'failed'
          ? `OCR failed for ${snapshot.quotationCode} — figures shown are from the manually entered amount, not the document.`
          : `OCR confidence is low for ${snapshot.quotationCode} (${snapshot.ocrConfidence}%) — verify the extracted figures manually.`,
        quotation: quotation.id as never,
      });
    }

    if (statistics.averagePrice && snapshot.grandTotal !== undefined) {
      const deviationPercent = Math.abs(snapshot.grandTotal - statistics.averagePrice) / statistics.averagePrice * 100;
      if (deviationPercent > SUSPICIOUS_PRICE_DEVIATION_PERCENT) {
        observations.push({
          type: 'suspicious_price_difference',
          severity: 'warning',
          message: `${snapshot.quotationCode} deviates ${deviationPercent.toFixed(0)}% from the average quotation price — worth a manual check.`,
          quotation: quotation.id as never,
        });
      }
    }
  }

  for (const itemComparison of itemComparisons) {
    if (itemComparison.quantityMismatchCount > 0) {
      observations.push({
        type: 'quantity_inconsistency',
        severity: 'warning',
        message: `${itemComparison.quotationCode} has ${itemComparison.quantityMismatchCount} item(s) with a quantity that doesn't match the requirement.`,
        quotation: byCode.get(itemComparison.quotationCode)!.id as never,
      });
    }
  }

  // Duplicate documents — the same file hash uploaded to two different quotations in this
  // requirement. `quotation.service.ts` already blocks a duplicate re-upload to the *same*
  // quotation; this catches the same document being submitted as if it were two vendors.
  const hashOwners = new Map<string, QuotationInput[]>();
  for (const quotation of quotations) {
    for (const hash of quotation.fileHashes) {
      const owners = hashOwners.get(hash) ?? [];
      owners.push(quotation);
      hashOwners.set(hash, owners);
    }
  }
  const flaggedPairs = new Set<string>();
  for (const owners of hashOwners.values()) {
    const uniqueQuotations = [...new Map(owners.map((o) => [o.id, o])).values()];
    if (uniqueQuotations.length < 2) continue;
    const pairKey = uniqueQuotations.map((o) => o.quotationCode).sort().join('|');
    if (flaggedPairs.has(pairKey)) continue;
    flaggedPairs.add(pairKey);
    observations.push({
      type: 'duplicate_quotation',
      severity: 'critical',
      message: `${uniqueQuotations.map((o) => o.quotationCode).join(' and ')} share an identical uploaded document — verify these are genuinely separate quotations.`,
    });
  }

  return observations;
}

function buildRecommendation(bestValue: IComparisonQuotationSnapshot | undefined, itemComparisons: IComparisonItemComparison[]): IComparisonRecommendation {
  if (!bestValue) {
    return { reason: 'No quotation has a comparable price yet — upload and process at least one attachment before a recommendation can be made.', isAdvisoryOnly: true };
  }

  const missingCount = itemComparisons.find((ic) => ic.quotationCode === bestValue.quotationCode)?.missingItemCount ?? 0;
  const caveat = missingCount > 0 ? ` Note: this quotation is missing ${missingCount} requested item(s) — confirm before proceeding.` : '';

  return {
    quotation: bestValue.quotation,
    quotationCode: bestValue.quotationCode,
    reason: `${bestValue.quotationCode} (${bestValue.vendorName}) offers the best value at ${bestValue.currency ?? ''} ${bestValue.grandTotal?.toLocaleString()}, based on price and item completeness.${caveat} This is a recommendation only — final selection requires Director review.`,
    isAdvisoryOnly: true,
  };
}

export function compare(requirement: RequirementInput, quotations: QuotationInput[]): ComparisonResult {
  const snapshots = quotations.map(buildSnapshot);
  const itemComparisons = quotations.map((q) => buildItemComparison(requirement, q));
  const bestValue = pickBestValue(snapshots, itemComparisons);
  const statistics = buildStatistics(snapshots, requirement.budget, bestValue);
  const observations = buildObservations(snapshots, itemComparisons, quotations, statistics);
  const recommendation = buildRecommendation(bestValue, itemComparisons);

  return { quotations: snapshots, statistics, itemComparison: itemComparisons, observations, recommendation };
}
