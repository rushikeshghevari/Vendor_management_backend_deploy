import type { IQuotationOcrItem, IQuotationOcrStructuredData } from '@/modules/quotation/quotation.model';

/**
 * Best-effort regex extraction of Quotation-shaped fields from OCR raw text.
 *
 * Deliberately separate from `ocr.service.ts`'s `parseInvoiceText` — that one is shaped
 * for Bill/invoice verification (invoiceNumber, poNumber, ...); this one targets the
 * Quotation fields Phase 3 asks for (quotationNumber, discount, line items, ...). Real
 * scanned documents vary wildly, so this never claims full accuracy — `confidence`
 * reflects how many of the top-level fields were actually found, and every field is
 * optional on the stored result.
 */

function extractWithPattern(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match?.[1]) return match[1].trim();
  }
  return undefined;
}

function extractNumber(text: string, patterns: RegExp[]): number | undefined {
  const val = extractWithPattern(text, patterns);
  if (!val) return undefined;
  const num = parseFloat(val.replace(/[,\s]/g, ''));
  return Number.isNaN(num) ? undefined : num;
}

const CURRENCY_SYMBOLS: Record<string, string> = { '₹': 'INR', 'rs': 'INR', 'inr': 'INR', '$': 'USD', '€': 'EUR', '£': 'GBP' };

function extractCurrency(text: string): string | undefined {
  const match = text.match(/(₹|\$|€|£|\bINR\b|\bUSD\b|\bEUR\b|\bGBP\b)/i);
  const symbol = match?.[1];
  if (!symbol) return undefined;
  return CURRENCY_SYMBOLS[symbol.toLowerCase()] ?? symbol.toUpperCase();
}

/**
 * Line items are the least reliable part of OCR — this looks for lines shaped like
 * "<description> <qty> <unit>? <rate> <amount>" (the common tabular layout once a PDF's
 * columns collapse into one text stream) and only keeps lines with at least a
 * description and one numeric value, so a false match still surfaces *something* for a
 * human to correct rather than silently dropping the row.
 */
function extractItems(text: string): IQuotationOcrItem[] {
  const items: IQuotationOcrItem[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

  const rowPattern = /^(.{3,60}?)\s+(\d+(?:\.\d+)?)\s*(pcs|nos|units?|kg|box(?:es)?|set|ea)?\s*(?:x|@)?\s*(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)\s*(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d+)?)?$/i;

  for (const line of lines) {
    if (/^(sub\s*total|grand\s*total|gst|discount|tax|total)\b/i.test(line)) continue;
    const match = line.match(rowPattern);
    if (!match) continue;

    const [, description, qty, unit, rate, amount] = match;
    if (!description || !qty || !rate) continue;
    const quantity = parseFloat(qty);
    const unitPrice = parseFloat(rate.replace(/,/g, ''));
    if (Number.isNaN(quantity) || Number.isNaN(unitPrice)) continue;

    items.push({
      description: description.trim(),
      quantity,
      unit: unit?.trim(),
      unitPrice,
      amount: amount ? parseFloat(amount.replace(/,/g, '')) : quantity * unitPrice,
    });
  }

  return items;
}

export function parseQuotationText(rawText: string): IQuotationOcrStructuredData {
  const text = rawText.replace(/[ \t]+/g, ' ');

  const vendorName = extractWithPattern(text, [
    /(?:from|supplier|vendor|seller|quoted\s*by)[:\s]+([A-Za-z0-9\s&.,Pvt.Ltd]+?)(?:\n|,|GST)/i,
    /company\s*name[:\s]+([A-Za-z0-9\s&.,]+?)(?:\n|,)/i,
  ]);

  const quotationNumber = extractWithPattern(text, [
    /quotation\s*(?:no|number|#)[:\s]+([A-Z0-9\-\/]+)/i,
    /quote\s*(?:no|#)[:\s]+([A-Z0-9\-\/]+)/i,
    /ref(?:erence)?\s*(?:no|#)[:\s]+([A-Z0-9\-\/]+)/i,
  ]);

  const quotationDate = extractWithPattern(text, [
    /quotation\s*date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /dated[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
  ]);

  const subtotal = extractNumber(text, [
    /sub\s*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /taxable\s*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const gst = extractNumber(text, [
    /gst(?:\s*\(?\d*%?\)?)?[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /tax(?:\s*amount)?[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const discount = extractNumber(text, [
    /discount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const grandTotal = extractNumber(text, [
    /grand\s*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /total\s*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /net\s*payable[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const currency = extractCurrency(text);
  const items = extractItems(text);

  return { vendorName, quotationNumber, quotationDate, currency, subtotal, gst, discount, grandTotal, items };
}

/** +12 per top-level field found, +1 per item line (capped) — mirrors the existing
 *  invoice parser's simple "how much did we actually find" confidence heuristic. */
export function computeOcrConfidence(data: IQuotationOcrStructuredData): number {
  const topLevelFields = [data.vendorName, data.quotationNumber, data.quotationDate, data.currency, data.subtotal, data.gst, data.discount, data.grandTotal];
  const found = topLevelFields.filter((f) => f !== undefined && f !== '').length;
  const itemBonus = Math.min(data.items.length * 2, 10);
  return Math.min(100, found * 11 + itemBonus);
}
