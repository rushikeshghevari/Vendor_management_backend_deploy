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

/** Gemini Vision's image-OCR prompt (`extractTextFromImage`) writes "Not Present" for any
 *  field it couldn't find on the document — without this guard that literal string gets
 *  captured as if it were the real value (e.g. vendorName = "Not Present"). */
const PLACEHOLDER_VALUE = /^(not\s*present|n\/?a|none|-)$/i;

function extractWithPattern(text: string, patterns: RegExp[]): string | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = match?.[1]?.trim();
    if (value && !PLACEHOLDER_VALUE.test(value)) return value;
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
  const match = text.match(/(₹|\$|€|£|\bINR\b|\bUSD\b|\bEUR\b|\bGBP\b|\bRs\b)/i);
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
    if (/^(sub[\s_]*total|grand[\s_]*total|gst|discount|tax|total)\b/i.test(line)) continue;
    // Gemini Vision's image OCR writes one structured "FIELD_NAME: value" line per field
    // (see extractTextFromImage's prompt) — never an item row, so skip it outright rather
    // than let the row pattern below mistake the label for a description.
    if (/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\s*:/.test(line)) continue;
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

/** Most quotation/invoice templates put the issuing company's name on the very first line
 *  (letterhead), with no explicit "Vendor:"/"From:" label at all — used as a fallback when
 *  the labelled patterns above find nothing. Rejected if it's implausibly short/long or is
 *  itself just the document's heading (e.g. "QUOTATION"), rather than a real name. */
const GENERIC_FIRST_LINE_WORDS = ['quotation', 'invoice', 'proforma', 'estimate', 'bill', 'receipt'];

function extractFirstLineAsVendorName(text: string): string | undefined {
  const firstLine = text.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
  if (!firstLine || firstLine.length < 3 || firstLine.length > 80) return undefined;
  if (GENERIC_FIRST_LINE_WORDS.some((word) => firstLine.toLowerCase().includes(word))) return undefined;
  return firstLine;
}

export function parseQuotationText(rawText: string): IQuotationOcrStructuredData {
  const text = rawText.replace(/[ \t]+/g, ' ');

  const vendorName = extractWithPattern(text, [
    // Gemini Vision's image OCR (extractTextFromImage) writes "VENDOR_NAME: ..." on its own
    // line — matched first, and up to end-of-line, since underscore-joined labels don't fit
    // the freeform "vendor: X, GST ..." shape pdf-parse text tends to have (below).
    /vendor[\s_]*name[:\s]+([^\n]+)/i,
    // Anchored to the start of a line with a required colon — "from"/"supplier"/"seller" are
    // common English words that show up mid-sentence in ordinary quotation prose (e.g. "valid
    // for 15 days from the date of issue"), so without the anchor+colon this used to grab
    // whatever followed the word "from" anywhere in the document as if it were a vendor label.
    /^\s*(?:from|supplier|vendor|seller|quoted\s*by)\s*:\s*([^\n]+)/im,
    /^\s*company\s*name\s*:\s*([^\n]+)/im,
  ]) ?? extractFirstLineAsVendorName(rawText);

  const quotationNumber = extractWithPattern(text, [
    /quotation\s*(?:no|number|#)[:\s]+([A-Z0-9\-\/]+)/i,
    /quote\s*(?:no|#)[:\s]+([A-Z0-9\-\/]+)/i,
    /ref(?:erence)?\s*(?:no|#)[:\s]+([A-Z0-9\-\/]+)/i,
    // Fallback for Gemini's image OCR, which only ever labels an "INVOICE_NUMBER" (its
    // prompt is shared with Bill/invoice verification) — close enough to use as-is when
    // nothing more quotation-specific was found.
    /invoice[\s_]*number[:\s]+([A-Z0-9\-\/]+)/i,
  ]);

  const quotationDate = extractWithPattern(text, [
    /quotation[\s_]*date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /invoice[\s_]*date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /dated[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
  ]);

  const subtotal = extractNumber(text, [
    /sub[\s_]*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /taxable[\s_]*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const gst = extractNumber(text, [
    /gst[\s_]*(?:total|amount)?(?:\s*\(?\d*%?\)?)?[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /tax[\s_]*(?:total|amount)?[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const discount = extractNumber(text, [
    /discount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const grandTotal = extractNumber(text, [
    /grand[\s_]*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /total[\s_]*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /net[\s_]*payable[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
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
