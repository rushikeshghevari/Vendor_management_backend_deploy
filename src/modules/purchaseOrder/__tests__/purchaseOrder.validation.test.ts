import { createPurchaseOrderSchema, emailPurchaseOrderSchema } from '@/modules/purchaseOrder/purchaseOrder.validation';

const validItem = {
  itemName: 'Laptop',
  quantity: 5,
  unitPrice: 60000,
  gstRate: 18,
  gstAmount: 54000,
  taxAmount: 0,
  discount: 0,
  total: 354000,
};

describe('createPurchaseOrderSchema', () => {
  it('accepts a valid quotationId-based payload (legacy path)', () => {
    const result = createPurchaseOrderSchema.safeParse({ quotationId: '507f1f77bcf86cd799439011', items: [validItem] });
    expect(result.success).toBe(true);
  });

  it('accepts a valid requirementId-based payload (Phase 7 path)', () => {
    const result = createPurchaseOrderSchema.safeParse({ requirementId: '507f1f77bcf86cd799439011', items: [validItem] });
    expect(result.success).toBe(true);
  });

  it('rejects a payload with neither quotationId nor requirementId', () => {
    const result = createPurchaseOrderSchema.safeParse({ items: [validItem] });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with BOTH quotationId and requirementId', () => {
    const result = createPurchaseOrderSchema.safeParse({
      quotationId: '507f1f77bcf86cd799439011',
      requirementId: '507f1f77bcf86cd799439022',
      items: [validItem],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a payload with no line items', () => {
    const result = createPurchaseOrderSchema.safeParse({ quotationId: '507f1f77bcf86cd799439011', items: [] });
    expect(result.success).toBe(false);
  });

  it('defaults gstRate/gstAmount/taxAmount/discount to 0 when omitted', () => {
    const result = createPurchaseOrderSchema.safeParse({
      quotationId: '507f1f77bcf86cd799439011',
      items: [{ itemName: 'Item', quantity: 1, unitPrice: 100, total: 100 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0]).toMatchObject({ gstRate: 0, gstAmount: 0, taxAmount: 0, discount: 0 });
    }
  });
});

describe('emailPurchaseOrderSchema', () => {
  it('accepts an empty body (recipientEmail is optional)', () => {
    expect(emailPurchaseOrderSchema.safeParse({}).success).toBe(true);
  });

  it('accepts and lowercases a valid email override', () => {
    const result = emailPurchaseOrderSchema.safeParse({ recipientEmail: 'Vendor@Example.COM' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.recipientEmail).toBe('vendor@example.com');
  });

  it('rejects an invalid email override', () => {
    expect(emailPurchaseOrderSchema.safeParse({ recipientEmail: 'not-an-email' }).success).toBe(false);
  });
});
