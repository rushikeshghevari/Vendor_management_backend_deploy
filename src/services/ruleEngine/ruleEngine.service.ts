import type { IAiDifference, IPurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';
import type { IBill } from '@/modules/bill/bill.model';
import type { ExtractedInvoiceData } from '@/services/ocr/ocr.service';

export interface RuleEngineResult {
  score: number;              // 0-100: match percentage before AI
  differences: IAiDifference[];
  criticalMismatches: string[];
  warnings: string[];
  itemMatchSummary: ItemMatchSummary;
}

export interface ItemMatchSummary {
  totalPoItems: number;
  matchedItems: number;
  missingItems: string[];
  extraItems: string[];
  quantityMismatches: Array<{ item: string; poQty: number; billQty: number }>;
  priceMismatches: Array<{ item: string; poPrice: number; billPrice: number; diff: number }>;
}

// ── Numeric comparison with tolerance ─────────────────────────────────────────
function numDiff(a: number, b: number): number {
  if (a === 0 && b === 0) return 0;
  return Math.abs((a - b) / (Math.max(a, b) || 1)) * 100;
}

// ── Fuzzy string match (case-insensitive, normalised) ──────────────────────────
function fuzzyMatch(a: string, b: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return norm(a) === norm(b) || norm(a).includes(norm(b)) || norm(b).includes(norm(a));
}

// ── Main rule engine: compare PO and Bill ─────────────────────────────────────
export function runRuleEngine(
  po: IPurchaseOrder,
  bill: IBill & { vendorName?: string; vendorGst?: string },
  ocrData?: ExtractedInvoiceData,
): RuleEngineResult {
  const differences: IAiDifference[] = [];
  const criticalMismatches: string[] = [];
  const warnings: string[] = [];
  let deductions = 0;

  // ── 1. Vendor Name ───────────────────────────────────────────────────────────
  const billVendorName = (ocrData?.vendorName ?? bill.vendorName ?? '').trim();
  if (billVendorName && !fuzzyMatch(po.vendorName, billVendorName)) {
    differences.push({
      field: 'Vendor Name',
      purchaseOrder: po.vendorName,
      bill: billVendorName,
      difference: 'Vendor name mismatch',
    });
    criticalMismatches.push('Vendor Name mismatch');
    deductions += 20;
  }

  // ── 2. Vendor GST ────────────────────────────────────────────────────────────
  const billGst = (ocrData?.vendorGst ?? bill.vendorGst ?? '').toUpperCase();
  if (billGst && billGst !== po.vendorGst.toUpperCase()) {
    differences.push({
      field: 'Vendor GST',
      purchaseOrder: po.vendorGst,
      bill: billGst,
      difference: 'GST number mismatch — possible fraud indicator',
    });
    criticalMismatches.push('Vendor GST mismatch');
    deductions += 25;
  }

  // ── 3. PO Number on Invoice ──────────────────────────────────────────────────
  if (ocrData?.poNumber && !fuzzyMatch(po.poNumber, ocrData.poNumber)) {
    differences.push({
      field: 'PO Number',
      purchaseOrder: po.poNumber,
      bill: ocrData.poNumber,
      difference: 'PO number on invoice does not match',
    });
    criticalMismatches.push('PO Number mismatch on invoice');
    deductions += 15;
  }

  // ── 4. Grand Total ───────────────────────────────────────────────────────────
  const billTotal = ocrData?.grandTotal ?? bill.invoiceAmount;
  const totalDiffPct = numDiff(po.grandTotal, billTotal);

  if (totalDiffPct > 5) {
    const diff = billTotal - po.grandTotal;
    differences.push({
      field: 'Grand Total',
      purchaseOrder: po.grandTotal,
      bill: billTotal,
      difference: `${diff > 0 ? '+' : ''}${diff.toFixed(2)} (${totalDiffPct.toFixed(1)}%)`,
    });
    if (totalDiffPct > 15) {
      criticalMismatches.push('Grand Total exceeds 15% variance');
      deductions += 20;
    } else {
      warnings.push(`Grand Total variance: ${totalDiffPct.toFixed(1)}%`);
      deductions += 10;
    }
  }

  // ── 5. Item-level comparison ─────────────────────────────────────────────────
  const itemMatchSummary: ItemMatchSummary = {
    totalPoItems: po.items.length,
    matchedItems: 0,
    missingItems: [],
    extraItems: [],
    quantityMismatches: [],
    priceMismatches: [],
  };

  // Match PO items against OCR item names (best-effort)
  const matchedItemNames = new Set<string>();
  for (const poItem of po.items) {
    const ocrItemMatch = ocrData?.itemNames?.find((n) => fuzzyMatch(n, poItem.itemName));
    if (ocrItemMatch) {
      matchedItemNames.add(ocrItemMatch);
      itemMatchSummary.matchedItems++;

      // Quantity check
      const ocrQtyIdx = ocrData!.itemNames!.indexOf(ocrItemMatch);
      const ocrQty = ocrData?.quantities?.[ocrQtyIdx];
      if (ocrQty !== undefined && ocrQty !== poItem.quantity) {
        itemMatchSummary.quantityMismatches.push({
          item: poItem.itemName,
          poQty: poItem.quantity,
          billQty: ocrQty,
        });
        differences.push({
          field: `Quantity (${poItem.itemName})`,
          purchaseOrder: poItem.quantity,
          bill: ocrQty,
          difference: `${ocrQty - poItem.quantity > 0 ? '+' : ''}${(ocrQty - poItem.quantity)}`,
        });
        warnings.push(`Quantity mismatch on item: ${poItem.itemName}`);
        deductions += 5;
      }

      // Unit price check
      const ocrPrice = ocrData?.unitPrices?.[ocrQtyIdx];
      if (ocrPrice !== undefined) {
        const priceDiff = numDiff(poItem.unitPrice, ocrPrice);
        if (priceDiff > 2) {
          itemMatchSummary.priceMismatches.push({
            item: poItem.itemName,
            poPrice: poItem.unitPrice,
            billPrice: ocrPrice,
            diff: ocrPrice - poItem.unitPrice,
          });
          differences.push({
            field: `Unit Price (${poItem.itemName})`,
            purchaseOrder: poItem.unitPrice,
            bill: ocrPrice,
            difference: `${(ocrPrice - poItem.unitPrice) > 0 ? '+' : ''}${(ocrPrice - poItem.unitPrice).toFixed(2)} (${priceDiff.toFixed(1)}%)`,
          });
          warnings.push(`Price mismatch on item: ${poItem.itemName}`);
          deductions += 5;
        }
      }
    } else if (ocrData?.itemNames && ocrData.itemNames.length > 0) {
      // Only flag missing if OCR actually extracted items
      itemMatchSummary.missingItems.push(poItem.itemName);
      differences.push({
        field: 'Missing Item',
        purchaseOrder: poItem.itemName,
        bill: null,
        difference: 'Item present in PO but not found on invoice',
      });
      warnings.push(`Item missing from invoice: ${poItem.itemName}`);
      deductions += 8;
    } else {
      // OCR couldn't extract items — still count as matched (no penalty)
      itemMatchSummary.matchedItems++;
    }
  }

  // Extra items in OCR that don't exist in PO
  if (ocrData?.itemNames) {
    for (const ocrItem of ocrData.itemNames) {
      if (!matchedItemNames.has(ocrItem)) {
        const hasPoMatch = po.items.some((p) => fuzzyMatch(p.itemName, ocrItem));
        if (!hasPoMatch) {
          itemMatchSummary.extraItems.push(ocrItem);
          differences.push({
            field: 'Extra Item',
            purchaseOrder: null,
            bill: ocrItem,
            difference: 'Item on invoice not found in PO',
          });
          warnings.push(`Extra item on invoice: ${ocrItem}`);
          deductions += 5;
        }
      }
    }
  }

  // ── 6. Duplicate invoice check (same invoiceNumber) ──────────────────────────
  // Duplicate detection is done at service level — we just note the risk factor here.

  // ── 7. Invoice date check ────────────────────────────────────────────────────
  if (ocrData?.invoiceDate) {
    const parsedInvoiceDate = new Date(ocrData.invoiceDate);
    if (!isNaN(parsedInvoiceDate.getTime())) {
      const poDate = new Date(po.poDate);
      // Invoice date should not be before PO date
      if (parsedInvoiceDate < poDate) {
        differences.push({
          field: 'Invoice Date',
          purchaseOrder: po.poDate.toISOString(),
          bill: ocrData.invoiceDate,
          difference: 'Invoice dated before Purchase Order — suspicious',
        });
        criticalMismatches.push('Invoice date pre-dates Purchase Order');
        deductions += 15;
      }
    }
  }

  // ── Compute score ─────────────────────────────────────────────────────────────
  const score = Math.max(0, 100 - deductions);

  return { score, differences, criticalMismatches, warnings, itemMatchSummary };
}

// ── Risk level from score ─────────────────────────────────────────────────────
export function scoreToRisk(score: number): 'LOW' | 'MEDIUM' | 'HIGH' {
  if (score >= 95) return 'LOW';
  if (score >= 75) return 'MEDIUM';
  return 'HIGH';
}
