import { registerVendorSchema } from '@/modules/vendorRegistration/vendorRegistration.validation';

const validInput = {
  name: 'Acme Supplies',
  contactPerson: 'John Doe',
  phone: '9876543210',
  email: 'vendor@example.com',
  gstNumber: '27ABCDE1234F1Z5',
  panNumber: 'ABCDE1234F',
  address: '221B Baker Street',
  state: 'Maharashtra',
  district: 'Pune',
  city: 'Pune',
  pincode: '411001',
  bankName: 'HDFC Bank',
  accountHolderName: 'Acme Supplies',
  accountNumber: '123456789012',
  ifscCode: 'HDFC0001234',
  upiId: 'vendor@okhdfcbank',
  category: 'Raw Materials',
};

describe('registerVendorSchema', () => {
  it('accepts a fully valid payload', () => {
    const result = registerVendorSchema.safeParse(validInput);
    expect(result.success).toBe(true);
  });

  it('accepts the payload with optional fields omitted (gstNumber, panNumber, upiId, country, category)', () => {
    const { gstNumber, panNumber, upiId, category, ...rest } = validInput;
    const result = registerVendorSchema.safeParse(rest);
    expect(result.success).toBe(true);
  });

  it.each(['name', 'contactPerson', 'phone', 'email', 'address', 'state', 'district', 'city', 'pincode', 'bankName', 'accountHolderName', 'accountNumber', 'ifscCode'])(
    'rejects a payload missing required field "%s"',
    (field) => {
      const { [field]: _omit, ...rest } = validInput as Record<string, string>;
      const result = registerVendorSchema.safeParse(rest);
      expect(result.success).toBe(false);
    },
  );

  it('rejects an invalid phone number', () => {
    const result = registerVendorSchema.safeParse({ ...validInput, phone: '12345' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid email address', () => {
    const result = registerVendorSchema.safeParse({ ...validInput, email: 'not-an-email' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid GST number when one is supplied', () => {
    const result = registerVendorSchema.safeParse({ ...validInput, gstNumber: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid PAN number when one is supplied', () => {
    const result = registerVendorSchema.safeParse({ ...validInput, panNumber: 'INVALID' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid IFSC code', () => {
    const result = registerVendorSchema.safeParse({ ...validInput, ifscCode: 'BADCODE' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid pincode', () => {
    const result = registerVendorSchema.safeParse({ ...validInput, pincode: '12' });
    expect(result.success).toBe(false);
  });

  it('rejects an invalid UPI id when one is supplied', () => {
    const result = registerVendorSchema.safeParse({ ...validInput, upiId: 'not-a-upi' });
    expect(result.success).toBe(false);
  });

  it('uppercases GST/PAN/IFSC and lowercases email on parse', () => {
    const result = registerVendorSchema.safeParse({
      ...validInput,
      gstNumber: validInput.gstNumber.toLowerCase(),
      panNumber: validInput.panNumber.toLowerCase(),
      ifscCode: validInput.ifscCode.toLowerCase(),
      email: 'Vendor@Example.com',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.gstNumber).toBe(validInput.gstNumber);
      expect(result.data.panNumber).toBe(validInput.panNumber);
      expect(result.data.ifscCode).toBe(validInput.ifscCode);
      expect(result.data.email).toBe('vendor@example.com');
    }
  });
});
