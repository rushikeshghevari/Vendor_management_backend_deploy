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
// Gemini Vision's image-OCR prompt (extractTextFromImage) writes "Not Present" for any
// field it couldn't find — without this guard that literal string gets captured as if it
// were the real value.
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
  return isNaN(num) ? undefined : num;
}

// ── Parse raw text into structured invoice data ────────────────────────────────
function parseInvoiceText(rawText: string): ExtractedInvoiceData {
  const text = rawText.replace(/\s+/g, ' ');

  const invoiceNumber = extractWithPattern(text, [
    /invoice[\s_]*(?:no|number|#)[:\s]+([A-Z0-9\-\/]+)/i,
    /inv[\s_]*no[:\s]+([A-Z0-9\-\/]+)/i,
    /bill[\s_]*no[:\s]+([A-Z0-9\-\/]+)/i,
  ]);

  const invoiceDate = extractWithPattern(text, [
    /invoice[\s_]*date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /date[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
    /dated[:\s]+(\d{1,2}[\-\/\.]\d{1,2}[\-\/\.]\d{2,4})/i,
  ]);

  const poNumber = extractWithPattern(text, [
    /p\.?o\.?[\s_]*(?:no|number|#)[:\s]+([A-Z0-9\-]+)/i,
    /purchase[\s_]*order[\s_]*(?:no|#)?[:\s]+([A-Z0-9\-]+)/i,
    /order[\s_]*ref[:\s]+([A-Z0-9\-]+)/i,
  ]);

  const vendorName = extractWithPattern(text, [
    // Gemini Vision's image OCR writes "VENDOR_NAME: ..." on its own line — matched to
    // end-of-line first, since underscore-joined labels don't fit the freeform
    // "vendor: X, GST ..." shape pdf-parse text tends to have (below).
    /vendor[\s_]*name[:\s]+([^\n]+)/i,
    /(?:from|supplier|vendor|seller)[:\s]+([A-Za-z0-9\s&.,Pvt.Ltd]+?)(?:\n|,|GST)/i,
    /company\s*name[:\s]+([A-Za-z0-9\s&.,]+?)(?:\n|,)/i,
  ]);

  const vendorGst = extractWithPattern(text, [
    /GSTIN?[:\s]+([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})/i,
    /GST[\s_]*(?:No|Number)[:\s]+([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})/i,
    /vendor[\s_]*gst[\s_]*(?:no|number)?[:\s]+([0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1})/i,
  ]);

  const grandTotal = extractNumber(text, [
    /grand[\s_]*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /total[\s_]*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /net[\s_]*payable[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /amount[\s_]*payable[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
  ]);

  const subtotal = extractNumber(text, [
    /sub[\s_]*total[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /taxable[\s_]*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
    /basic[\s_]*amount[:\s]+(?:INR|Rs\.?|₹)?\s*([\d,]+(?:\.\d{2})?)/i,
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
