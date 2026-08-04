import fs from 'node:fs';

import { PDFParse } from 'pdf-parse';

import type { OcrProvider, OcrProviderResult } from '@/services/ocr/ocrProvider.interface';

/** Local, offline text extraction for PDF attachments — same `pdf-parse` usage as the
 *  existing Bill-invoice OCR (`ocr.service.ts`'s `extractFromPdf`), just returning raw
 *  text instead of also parsing it (Quotation parsing is a separate, quotation-shaped
 *  concern — see `quotationOcrParser.ts`). */
export const pdfParseProvider: OcrProvider = {
  name: 'pdf-parse',

  supports(mimeType: string): boolean {
    return mimeType === 'application/pdf';
  },

  async extractRawText(filePath: string): Promise<OcrProviderResult> {
    const buffer = fs.readFileSync(filePath);
    const parser = new PDFParse({ data: buffer });
    const pdfData = await parser.getText();
    await parser.destroy();
    return { rawText: pdfData.text, provider: pdfParseProvider.name };
  },
};
