/**
 * Provider-independent OCR abstraction for Quotation attachments (Phase 3).
 *
 * A provider's only job is "give me the raw text out of this file" — it knows nothing
 * about quotations, business rules, or how that text gets parsed into structured fields.
 * That keeps `quotationOcr.service.ts` swappable to a different vendor (OpenAI, Azure
 * Document Intelligence, ...) by adding a new provider here and registering it in
 * `selectProvider()`, without touching the orchestration or parsing logic at all.
 *
 * This is a sibling of `src/services/ocr/ocr.service.ts` (the pre-existing Bill/PO
 * invoice OCR used by AI verification) — that file is untouched by Phase 3.
 */

export interface OcrProviderResult {
  rawText: string;
  /** Identifies which provider produced this text, stored on `Quotation.ocr.provider`. */
  provider: string;
}

export interface OcrProvider {
  readonly name: string;
  /** Whether this provider can handle a given attachment mime type. */
  supports(mimeType: string): boolean;
  /** Extracts raw, unstructured text from the file at `filePath`. */
  extractRawText(filePath: string, mimeType: string): Promise<OcrProviderResult>;
}
