import { decisionSchema, remarksSchema } from '@/modules/directorReview/directorReview.validation';

describe('decisionSchema', () => {
  it('rejects an approved decision without a selected quotation — no AI/earliest default anymore', () => {
    const result = decisionSchema.safeParse({ decision: 'approved' });
    expect(result.success).toBe(false);
  });

  it('accepts an approved decision without remarks when a quotation is selected', () => {
    const result = decisionSchema.safeParse({ decision: 'approved', selectedQuotationId: '507f1f77bcf86cd799439011' });
    expect(result.success).toBe(true);
  });

  it('requires remarks for a rejected decision', () => {
    const result = decisionSchema.safeParse({ decision: 'rejected' });
    expect(result.success).toBe(false);
  });

  it('requires remarks for a sent_back decision', () => {
    const result = decisionSchema.safeParse({ decision: 'sent_back' });
    expect(result.success).toBe(false);
  });

  it('accepts a rejected decision when remarks are provided', () => {
    const result = decisionSchema.safeParse({ decision: 'rejected', remarks: 'Budget exceeds approved limit' });
    expect(result.success).toBe(true);
  });

  it('rejects an unknown decision value', () => {
    const result = decisionSchema.safeParse({ decision: 'pending' });
    expect(result.success).toBe(false);
  });

  it('rejects a completely invalid decision string', () => {
    const result = decisionSchema.safeParse({ decision: 'approve_now' });
    expect(result.success).toBe(false);
  });
});

describe('remarksSchema', () => {
  it('rejects empty remarks', () => {
    const result = remarksSchema.safeParse({ remarks: '' });
    expect(result.success).toBe(false);
  });

  it('accepts non-empty remarks', () => {
    const result = remarksSchema.safeParse({ remarks: 'Looks good, verifying vendor references.' });
    expect(result.success).toBe(true);
  });

  it('rejects remarks over the max length', () => {
    const result = remarksSchema.safeParse({ remarks: 'a'.repeat(2001) });
    expect(result.success).toBe(false);
  });
});
