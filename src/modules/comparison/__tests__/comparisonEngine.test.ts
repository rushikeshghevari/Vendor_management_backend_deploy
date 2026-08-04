import { compare, parseDeliveryDays, type QuotationInput, type RequirementInput } from '@/modules/comparison/comparisonEngine';

function makeRequirement(overrides: Partial<RequirementInput> = {}): RequirementInput {
  return {
    budget: 500000,
    items: [
      { itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000, estimatedAmount: 300000 },
      { itemName: 'Mouse', quantity: 5, unit: 'pcs', estimatedRate: 500, estimatedAmount: 2500 },
    ],
    ...overrides,
  };
}

function makeQuotation(overrides: Partial<QuotationInput> = {}): QuotationInput {
  return {
    id: 'q1',
    quotationCode: 'DEPT-QTN001',
    vendorName: 'Vendor A',
    fileHashes: ['hash-a'],
    amount: 300000,
    gst: 18,
    currency: 'INR',
    paymentTerms: 'Net 30',
    deliveryTerms: 'Within 2 Weeks',
    quotationDate: '2026-07-01',
    ocrStatus: 'completed',
    ocrConfidence: 90,
    ocrStructuredData: {
      grandTotal: 302500,
      discount: 0,
      currency: 'INR',
      items: [
        { description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 60000, amount: 300000 },
        { description: 'Mouse', quantity: 5, unit: 'pcs', unitPrice: 500, amount: 2500 },
      ],
    },
    ...overrides,
  };
}

describe('parseDeliveryDays', () => {
  it('parses a plain day count', () => {
    expect(parseDeliveryDays('7 days')).toBe(7);
  });

  it('converts weeks to days', () => {
    expect(parseDeliveryDays('Within 2 Weeks')).toBe(14);
  });

  it('converts months to days', () => {
    expect(parseDeliveryDays('3 months')).toBe(90);
  });

  it('returns undefined when no number is present', () => {
    expect(parseDeliveryDays('As soon as possible')).toBeUndefined();
  });
});

describe('compare — price statistics', () => {
  it('computes lowest, highest, average price and cost difference across quotations', () => {
    const requirement = makeRequirement();
    const cheap = makeQuotation({ id: 'q1', quotationCode: 'Q1', ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 300000 } });
    const expensive = makeQuotation({ id: 'q2', quotationCode: 'Q2', fileHashes: ['hash-b'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 400000 } });

    const result = compare(requirement, [cheap, expensive]);

    expect(result.statistics.totalQuotations).toBe(2);
    expect(result.statistics.lowestPrice).toBe(300000);
    expect(result.statistics.highestPrice).toBe(400000);
    expect(result.statistics.averagePrice).toBe(350000);
    expect(result.statistics.costDifference).toBe(100000);
  });

  it('computes budget variance relative to the best-value quotation', () => {
    const requirement = makeRequirement({ budget: 500000 });
    const quotation = makeQuotation({ ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 300000 } });

    const result = compare(requirement, [quotation]);

    expect(result.statistics.budgetVarianceAmount).toBe(300000 - 500000);
    expect(result.statistics.budgetVariancePercent).toBeCloseTo(((300000 - 500000) / 500000) * 100);
  });

  it('falls back to the manually entered amount when OCR never extracted a grand total', () => {
    const requirement = makeRequirement();
    const quotation = makeQuotation({ amount: 100000, gst: 10, ocrStatus: 'not_started', ocrConfidence: undefined, ocrStructuredData: undefined });

    const result = compare(requirement, [quotation]);

    expect(result.quotations[0]!.grandTotal).toBe(110000);
    expect(result.quotations[0]!.grandTotalSource).toBe('quotation');
  });
});

describe('compare — observations', () => {
  it('flags the lowest and highest quotation', () => {
    const requirement = makeRequirement();
    const cheap = makeQuotation({ id: 'q1', quotationCode: 'Q1', ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 300000 } });
    const expensive = makeQuotation({ id: 'q2', quotationCode: 'Q2', fileHashes: ['hash-b'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 400000 } });

    const result = compare(requirement, [cheap, expensive]);

    expect(result.observations.some((o) => o.type === 'lowest_quotation' && o.message.includes('Q1'))).toBe(true);
    expect(result.observations.some((o) => o.type === 'highest_quotation' && o.message.includes('Q2'))).toBe(true);
  });

  it('flags a quotation with no uploaded document', () => {
    const requirement = makeRequirement();
    const quotation = makeQuotation({ fileHashes: [] });

    const result = compare(requirement, [quotation]);

    expect(result.quotations[0]!.hasAttachment).toBe(false);
    expect(result.observations.some((o) => o.type === 'missing_documents')).toBe(true);
  });

  it('flags a duplicate document uploaded to two different quotations', () => {
    const requirement = makeRequirement();
    const a = makeQuotation({ id: 'q1', quotationCode: 'Q1', fileHashes: ['same-hash'] });
    const b = makeQuotation({ id: 'q2', quotationCode: 'Q2', fileHashes: ['same-hash'] });

    const result = compare(requirement, [a, b]);

    const duplicateObservation = result.observations.find((o) => o.type === 'duplicate_quotation');
    expect(duplicateObservation).toBeDefined();
    expect(duplicateObservation!.severity).toBe('critical');
    expect(duplicateObservation!.message).toContain('Q1');
    expect(duplicateObservation!.message).toContain('Q2');
  });

  it('flags a suspicious price deviating far from the average', () => {
    const requirement = makeRequirement();
    const normal1 = makeQuotation({ id: 'q1', quotationCode: 'Q1', fileHashes: ['h1'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 300000 } });
    const normal2 = makeQuotation({ id: 'q2', quotationCode: 'Q2', fileHashes: ['h2'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 310000 } });
    const outlier = makeQuotation({ id: 'q3', quotationCode: 'Q3', fileHashes: ['h3'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 900000 } });

    const result = compare(requirement, [normal1, normal2, outlier]);

    expect(result.observations.some((o) => o.type === 'suspicious_price_difference' && o.message.includes('Q3'))).toBe(true);
  });

  it('flags low OCR confidence and OCR failure separately', () => {
    const requirement = makeRequirement();
    const lowConfidence = makeQuotation({ id: 'q1', quotationCode: 'Q1', fileHashes: ['h1'], ocrConfidence: 30 });
    const failed = makeQuotation({ id: 'q2', quotationCode: 'Q2', fileHashes: ['h2'], ocrStatus: 'failed', ocrConfidence: undefined, ocrStructuredData: undefined });
    const confident = makeQuotation({ id: 'q3', quotationCode: 'Q3', fileHashes: ['h3'], ocrConfidence: 95 });

    const result = compare(requirement, [lowConfidence, failed, confident]);

    const warnings = result.observations.filter((o) => o.type === 'ocr_confidence_warning');
    expect(warnings.some((w) => w.message.includes('Q1'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('Q2'))).toBe(true);
    expect(warnings.some((w) => w.message.includes('Q3'))).toBe(false);
  });
});

describe('compare — item comparison', () => {
  it('detects a missing requirement item', () => {
    const requirement = makeRequirement();
    const quotation = makeQuotation({
      ocrStructuredData: {
        grandTotal: 300000,
        discount: 0,
        currency: 'INR',
        items: [{ description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 60000, amount: 300000 }],
      },
    });

    const result = compare(requirement, [quotation]);
    const itemComparison = result.itemComparison[0]!;

    expect(itemComparison.missingItemCount).toBe(1);
    expect(itemComparison.items.find((i) => i.itemName === 'Mouse')?.status).toBe('missing');
  });

  it('detects an extra item not requested in the requirement', () => {
    const requirement = makeRequirement();
    const quotation = makeQuotation({
      ocrStructuredData: {
        grandTotal: 305000,
        discount: 0,
        currency: 'INR',
        items: [
          { description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 60000, amount: 300000 },
          { description: 'Mouse', quantity: 5, unit: 'pcs', unitPrice: 500, amount: 2500 },
          { description: 'Keyboard', quantity: 5, unit: 'pcs', unitPrice: 500, amount: 2500 },
        ],
      },
    });

    const result = compare(requirement, [quotation]);
    const itemComparison = result.itemComparison[0]!;

    expect(itemComparison.extraItemCount).toBe(1);
    expect(itemComparison.items.find((i) => i.itemName === 'Keyboard')?.status).toBe('extra');
  });

  it('detects a quantity mismatch on a matched item', () => {
    const requirement = makeRequirement();
    const quotation = makeQuotation({
      ocrStructuredData: {
        grandTotal: 302500,
        discount: 0,
        currency: 'INR',
        items: [
          { description: 'Laptop', quantity: 3, unit: 'pcs', unitPrice: 60000, amount: 180000 },
          { description: 'Mouse', quantity: 5, unit: 'pcs', unitPrice: 500, amount: 2500 },
        ],
      },
    });

    const result = compare(requirement, [quotation]);
    const itemComparison = result.itemComparison[0]!;
    const laptopEntry = itemComparison.items.find((i) => i.itemName === 'Laptop')!;

    expect(laptopEntry.status).toBe('matched');
    expect(laptopEntry.quantityMismatch).toBe(true);
    expect(itemComparison.quantityMismatchCount).toBe(1);
    expect(result.observations.some((o) => o.type === 'quantity_inconsistency')).toBe(true);
  });

  it('reports the unit price difference on a matched item', () => {
    const requirement = makeRequirement();
    const quotation = makeQuotation({
      ocrStructuredData: {
        grandTotal: 327500,
        discount: 0,
        currency: 'INR',
        items: [
          { description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 65000, amount: 325000 },
          { description: 'Mouse', quantity: 5, unit: 'pcs', unitPrice: 500, amount: 2500 },
        ],
      },
    });

    const result = compare(requirement, [quotation]);
    const laptopEntry = result.itemComparison[0]!.items.find((i) => i.itemName === 'Laptop')!;

    expect(laptopEntry.unitPriceDifference).toBe(5000);
    expect(laptopEntry.amountMismatch).toBe(true);
  });

  it('does not flag a mismatch when quantities and prices match exactly', () => {
    const requirement = makeRequirement();
    const quotation = makeQuotation();

    const result = compare(requirement, [quotation]);
    const itemComparison = result.itemComparison[0]!;

    expect(itemComparison.quantityMismatchCount).toBe(0);
    expect(itemComparison.items.every((i) => !i.amountMismatch)).toBe(true);
  });
});

describe('compare — recommendation', () => {
  it('recommends the lowest-priced quotation when it has no missing items', () => {
    const requirement = makeRequirement();
    const cheapComplete = makeQuotation({ id: 'q1', quotationCode: 'Q1', fileHashes: ['h1'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 300000 } });
    const expensiveComplete = makeQuotation({ id: 'q2', quotationCode: 'Q2', fileHashes: ['h2'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 400000 } });

    const result = compare(requirement, [cheapComplete, expensiveComplete]);

    expect(result.recommendation.quotationCode).toBe('Q1');
    expect(result.recommendation.isAdvisoryOnly).toBe(true);
    expect(result.recommendation.reason).toMatch(/recommendation only/i);
    expect(result.recommendation.reason).toMatch(/Director review/i);
  });

  it('skips a cheaper quotation with missing items in favor of a complete, pricier one', () => {
    const requirement = makeRequirement();
    const cheapIncomplete = makeQuotation({
      id: 'q1',
      quotationCode: 'Q1',
      fileHashes: ['h1'],
      ocrStructuredData: {
        grandTotal: 250000,
        discount: 0,
        currency: 'INR',
        items: [{ description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 50000, amount: 250000 }],
      },
    });
    const pricierComplete = makeQuotation({ id: 'q2', quotationCode: 'Q2', fileHashes: ['h2'], ocrStructuredData: { ...makeQuotation().ocrStructuredData!, grandTotal: 302500 } });

    const result = compare(requirement, [cheapIncomplete, pricierComplete]);

    expect(result.recommendation.quotationCode).toBe('Q2');
  });

  it('still produces a recommendation (with a caveat) when every quotation is missing items', () => {
    const requirement = makeRequirement();
    const onlyLaptop = makeQuotation({
      ocrStructuredData: {
        grandTotal: 300000,
        discount: 0,
        currency: 'INR',
        items: [{ description: 'Laptop', quantity: 5, unit: 'pcs', unitPrice: 60000, amount: 300000 }],
      },
    });

    const result = compare(requirement, [onlyLaptop]);

    expect(result.recommendation.quotationCode).toBe('DEPT-QTN001');
    expect(result.recommendation.reason).toMatch(/missing/i);
  });
});
