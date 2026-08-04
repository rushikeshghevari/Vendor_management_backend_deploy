import { computeOcrConfidence, parseQuotationText } from '@/services/ocr/quotationOcrParser';

const SAMPLE_QUOTATION_TEXT = `
Alpha Meditech Pvt Ltd
Quotation No: QTN-2026-0042
Quotation Date: 15-07-2026

Diagnostic Kit A     10   pcs   500.00   5000.00
Surgical Gloves Box  20   box   150.00   3000.00

Sub Total: INR 8000.00
Discount: INR 200.00
GST: INR 1404.00
Grand Total: INR 9204.00
`;

describe('parseQuotationText', () => {
  it('extracts vendor, quotation, and total fields from realistic OCR text', () => {
    const result = parseQuotationText(SAMPLE_QUOTATION_TEXT);

    expect(result.quotationNumber).toBe('QTN-2026-0042');
    expect(result.quotationDate).toBe('15-07-2026');
    expect(result.currency).toBe('INR');
    expect(result.subtotal).toBe(8000);
    expect(result.discount).toBe(200);
    expect(result.gst).toBe(1404);
    expect(result.grandTotal).toBe(9204);
  });

  it('extracts line items with quantity, unit, and rate', () => {
    const result = parseQuotationText(SAMPLE_QUOTATION_TEXT);

    expect(result.items.length).toBeGreaterThanOrEqual(2);
    const kit = result.items.find((i) => i.description.includes('Diagnostic Kit A'));
    expect(kit).toBeDefined();
    expect(kit?.quantity).toBe(10);
    expect(kit?.unit).toBe('pcs');
    expect(kit?.unitPrice).toBe(500);
  });

  it('returns all-undefined fields and an empty items array for unrecognizable text', () => {
    const result = parseQuotationText('this is not a quotation at all, just noise');

    expect(result.vendorName).toBeUndefined();
    expect(result.quotationNumber).toBeUndefined();
    expect(result.grandTotal).toBeUndefined();
    expect(result.items).toEqual([]);
  });
});

describe('computeOcrConfidence', () => {
  it('scores higher when more fields were found', () => {
    const rich = parseQuotationText(SAMPLE_QUOTATION_TEXT);
    const empty = parseQuotationText('no data here');

    expect(computeOcrConfidence(rich)).toBeGreaterThan(computeOcrConfidence(empty));
    expect(computeOcrConfidence(empty)).toBe(0);
  });

  it('never exceeds 100', () => {
    const rich = parseQuotationText(SAMPLE_QUOTATION_TEXT);
    expect(computeOcrConfidence(rich)).toBeLessThanOrEqual(100);
  });
});
