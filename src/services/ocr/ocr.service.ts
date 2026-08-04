import fs from 'node:fs';
import path from 'node:path';

import { PDFParse } from 'pdf-parse';

export interface OcrResult {
  rawText: string;
  extractedData: ExtractedInvoiceData;
  source: 'pdf-parse' | 'gemini-vision' | 'manual';
}

export interface ExtractedInvoiceData {
  invoiceNumber?: string;
  invoiceDate?: string;
  poNumber?: string;
  vendorName?: string;
  vendorGst?: string;
  itemNames?: string[];
  quantities?: number[];
  unitPrices?: number[];
  gstAmounts?: number[];
  taxAmounts?: number[];
  grandTotal?: number;
  subtotal?: number;
  confidence: number;
}

// ── Helper: extract values using patterns ─────────────────────────────────────
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
  return isNaN(num) ? undefined : num;
}

// ── Parse raw text into structured invoice data ────────────────────────────────
function parseInvoiceText(rawText: string): ExtractedInvoiceData {
  const text = rawText.replace(/\s+/g, ' ');

  const invoiceNumber = extractWithPattern(text, [
    /invoice\s*(?:no|number|#)[:\s]+([A-Z0-9\-\/]+)/i,
    /inv\s*no[:\s]+([A-Z0-9\-\/]+)/i,
    /bill\s*no[:\s]+([A-Z0-9\-\/]+)/i,
  ]);

  const invoiceDate = extractWithPattern(text, [
    /invoice\s*date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /dated[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
  ]);

  const poNumber = extractWithPattern(text, [
    /p\.?o\.?\s*(?:no|number|#)[:\s]+([A-Z0-9\-]+)/i,
    /purchase\s*order\s*(?:no|#)?[:\s]+([A-Z0-9\-]+)/i,
    /order\s*ref[:\s]+([A-Z0-9\-]+)/i,
  ]);

  const vendorName = extractWithPattern(text, [
    /(?:from|supplier|vendor|seller)[:\s]+([A-Za-z0-9\s&.,Pvt.Ltd]+?)(?:\n|,|GST)/i,
    /company\s*name[:\s]+([A-Za-z0-9\s&.,]+?)(?:\n|,)/i,
  ]);

  const vendorGst = extractWithPattern(text, [
    /GSTIN?[:\s]+([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})/i,
    /GST\s*(?:No|Number)[:\s]+([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})/i,
  ]);

  const grandTotal = extractNumber(text, [
    /grand\s*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /total\s*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /net\s*payable[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /amount\s*payable[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const subtotal = extractNumber(text, [
    /sub\s*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /taxable\s*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /basic\s*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  // Confidence score: +15 per field extracted
  const fieldsFound = [invoiceNumber, invoiceDate, poNumber, vendorName, vendorGst, grandTotal, subtotal]
    .filter(Boolean).length;
  const confidence = Math.min(100, fieldsFound * 15);

  return {
    invoiceNumber,
    invoiceDate,
    poNumber,
    vendorName,
    vendorGst,
    grandTotal,
    subtotal,
    confidence,
  };
}

// ── PDF extraction ─────────────────────────────────────────────────────────────
export async function extractFromPdf(filePath: string): Promise<OcrResult> {
  const absolutePath = filePath.startsWith('/') || filePath.match(/^[A-Za-z]:\\/)
    ? filePath
    : path.join(process.cwd(), filePath.replace(/^\//, ''));

  const buffer = fs.readFileSync(absolutePath);
  const parser = new PDFParse({ data: buffer });
  const pdfData = await parser.getText();
  await parser.destroy();
  const rawText = pdfData.text;
  const extractedData = parseInvoiceText(rawText);

  return { rawText, extractedData, source: 'pdf-parse' };
}

// ── Image extraction (via Gemini Vision — called from aiVerification.service) ──
export async function parseOcrResultFromGeminiText(geminiText: string): Promise<ExtractedInvoiceData> {
  // Gemini Vision returns structured text — we parse it with the same patterns
  return parseInvoiceText(geminiText);
}
