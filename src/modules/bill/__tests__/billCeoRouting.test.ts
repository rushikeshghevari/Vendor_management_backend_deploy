import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { Bill } from '@/modules/bill/bill.model';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

function tokenFor(user: IUser): string {
  return signAccessToken({ sub: String(user._id), role: user.role, department: user.department?.toString() });
}

const PDF_BYTES = Buffer.from('%PDF-1.4 fake invoice document');

async function waitForBillStatus(billId: string, notStatus: string, maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const bill = await Bill.findById(billId).select('status').lean();
    if (bill && bill.status !== notStatus) return bill.status;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Bill ${billId} still "${notStatus}" after ${maxAttempts * 50}ms — background pipeline never completed`);
}

async function uploadAndSubmit(billId: string, duToken: string) {
  const uploadRes = await request(app)
    .post(`/api/v1/bills/${billId}/invoice`)
    .set('Authorization', `Bearer ${duToken}`)
    .attach('file', PDF_BYTES, { filename: 'invoice.pdf', contentType: 'application/pdf' });
  expect(uploadRes.status).toBe(200);

  const submitRes = await request(app).patch(`/api/v1/bills/${billId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
  expect(submitRes.status).toBe(200);
}

function vendorPayload(deptCode: string, overrides: Record<string, unknown> = {}) {
  return {
    name: `Routing Test Vendor ${deptCode}`,
    contactPerson: 'Ramesh Gupta',
    phone: '9876500000',
    email: `routing-vendor-${deptCode}@example.com`,
    address: 'Industrial Area',
    state: 'Maharashtra',
    district: 'Pune',
    city: 'Pune',
    pincode: '411001',
    bankDetails: { bankName: 'HDFC Bank', accountHolderName: `Routing Test Vendor ${deptCode}`, accountNumber: '222233334444', ifscCode: 'HDFC0001234' },
    category: 'Services',
    ...overrides,
  };
}

describe('Recurring Bill — CEO vs Director approval routing (resolveBillApprovalRoute)', () => {
  async function setupRecurringSeries(deptCode: string, baselineAmount: number) {
    const admin = await createTestUser({ email: `ceort-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: `CEO Routing Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
    const du = await createTestUser({ email: `ceort-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const director = await createTestUser({ email: `ceort-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });
    const ceo = await createTestUser({ email: `ceort-ceo-${deptCode}@vms.local`, role: ROLES.CEO });

    const duToken = tokenFor(du);

    const vendorRes = await request(app)
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${duToken}`)
      .send(vendorPayload(deptCode));
    expect(vendorRes.status).toBe(201);

    const seriesRes = await request(app)
      .post('/api/v1/recurring-expenses')
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        title: `AMC ${deptCode}`,
        mode: 'vendor_bill',
        vendor: vendorRes.body.data._id,
        frequency: 'yearly',
        baselineAmount,
        thresholdPercent: 10,
        nextDueDate: '2027-01-01',
      });
    expect(seriesRes.status).toBe(201);

    return { duToken, director, ceo, seriesId: seriesRes.body.data._id as string };
  }

  async function generateAndSubmitCycle(seriesId: string, duToken: string, invoiceAmount: number): Promise<string> {
    const cycleRes = await request(app)
      .post(`/api/v1/recurring-expenses/${seriesId}/generate-cycle`)
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        invoiceNumber: `AMC-INV-${Math.random().toString(36).slice(2, 10)}`,
        invoiceDate: '2026-11-01',
        invoiceAmount,
      });
    expect(cycleRes.status).toBe(201);
    const billId = cycleRes.body.data._id as string;

    await uploadAndSubmit(billId, duToken);
    const status = await waitForBillStatus(billId, 'submitted');
    expect(status).toBe('ai_verified');
    return billId;
  }

  it('routes a within-CEO-limit breach to the CEO — a Director is forbidden, the CEO can approve', async () => {
    const { duToken, director, ceo, seriesId } = await setupRecurringSeries('CEORT1', 10000);
    // 40,000 is far over the 10% threshold on a 10,000 baseline, and within the ₹50,000
    // default CEO Approval Limit.
    const billId = await generateAndSubmitCycle(seriesId, duToken, 40000);

    const directorAttempt = await request(app)
      .patch(`/api/v1/bills/${billId}/financial-decision`)
      .set('Authorization', `Bearer ${tokenFor(director)}`)
      .send({ decision: 'approved' });
    expect(directorAttempt.status).toBe(403);

    const ceoApproval = await request(app)
      .patch(`/api/v1/bills/${billId}/financial-decision`)
      .set('Authorization', `Bearer ${tokenFor(ceo)}`)
      .send({ decision: 'approved' });
    expect(ceoApproval.status).toBe(200);

    const bill = await Bill.findById(billId).select('status').lean();
    expect(bill!.status).toBe('verified');
  });

  it('routes an above-CEO-limit breach to the Director committee — the CEO is forbidden, a Director can approve', async () => {
    const { duToken, director, ceo, seriesId } = await setupRecurringSeries('CEORT2', 10000);
    // 60,000 is over the ₹50,000 default CEO Approval Limit.
    const billId = await generateAndSubmitCycle(seriesId, duToken, 60000);

    const ceoAttempt = await request(app)
      .patch(`/api/v1/bills/${billId}/financial-decision`)
      .set('Authorization', `Bearer ${tokenFor(ceo)}`)
      .send({ decision: 'approved' });
    expect(ceoAttempt.status).toBe(403);

    const directorApproval = await request(app)
      .patch(`/api/v1/bills/${billId}/financial-decision`)
      .set('Authorization', `Bearer ${tokenFor(director)}`)
      .send({ decision: 'approved' });
    expect(directorApproval.status).toBe(200);

    const bill = await Bill.findById(billId).select('status').lean();
    expect(bill!.status).toBe('verified');
  });
});

describe('Bill — held at Financial Approval instead of auto-forwarded when it mismatches its Quotation amount', () => {
  async function setupQuotationAndPo(deptCode: string, quotationAmount: number, poItemTotal: number) {
    const admin = await createTestUser({ email: `qmm-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: `Quotation Mismatch Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
    const du = await createTestUser({ email: `qmm-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    const ceo = await createTestUser({ email: `qmm-ceo-${deptCode}@vms.local`, role: ROLES.CEO });

    const duToken = tokenFor(du);

    const vendorRes = await request(app)
      .post('/api/v1/vendors')
      .set('Authorization', `Bearer ${duToken}`)
      .send(vendorPayload(deptCode, { category: 'Raw Materials' }));
    expect(vendorRes.status).toBe(201);

    const quotationRes = await request(app)
      .post('/api/v1/quotations')
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        vendor: vendorRes.body.data._id,
        quotationDate: '2026-07-01',
        requiredDate: '2026-08-01',
        amount: quotationAmount,
        gst: 0,
        currency: 'INR',
        paymentTerms: 'Net 30',
        creditPeriod: 30,
        deliveryTerms: 'Within 2 Weeks',
        priority: 'medium',
      });
    expect(quotationRes.status).toBe(201);
    const quotationId = quotationRes.body.data._id as string;

    await request(app).patch(`/api/v1/quotations/${quotationId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
    const decision = await request(app)
      .patch(`/api/v1/quotations/${quotationId}/decision`)
      .set('Authorization', `Bearer ${tokenFor(ceo)}`)
      .send({ decision: 'approved' });
    expect(decision.status).toBe(200);

    // A single item totalling `poItemTotal` — may legitimately differ from the Quotation's own
    // `amount` above, since PO items are re-entered (not copied) at generation time.
    const poRes = await request(app)
      .post('/api/v1/purchase-orders')
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        quotationId,
        items: [{ itemName: 'Annual Service', quantity: 1, unitPrice: poItemTotal, gstRate: 0, gstAmount: 0, taxAmount: 0, discount: 0, total: poItemTotal }],
      });
    expect(poRes.status).toBe(201);

    return { duToken, quotationId };
  }

  async function createAndSubmitBill(quotationId: string, duToken: string, invoiceAmount: number) {
    const billRes = await request(app)
      .post('/api/v1/bills')
      .set('Authorization', `Bearer ${duToken}`)
      .send({
        quotation: quotationId,
        invoiceNumber: `QMM-INV-${Math.random().toString(36).slice(2, 10)}`,
        invoiceDate: '2026-08-01',
        invoiceAmount,
        taxableAmount: invoiceAmount,
        gstAmount: 0,
        paymentTerms: 'Net 30',
        dueDate: '2026-09-01',
      });
    expect(billRes.status).toBe(201);
    const billId = billRes.body.data._id as string;

    await uploadAndSubmit(billId, duToken);
    const status = await waitForBillStatus(billId, 'submitted');
    return { billId, status };
  }

  it('auto-forwards straight to Accounts when the Bill matches both the PO and the Quotation', async () => {
    const { duToken, quotationId } = await setupQuotationAndPo('QMM1', 20000, 20000);
    const { status } = await createAndSubmitBill(quotationId, duToken, 20000);
    expect(status).toBe('director_approved');
  });

  it('holds at Financial Approval when the Bill matches the PO but drifts from the Quotation amount', async () => {
    // Quotation was for 20,000; the PO was later generated with different (re-entered) items
    // totalling 23,000 — the Bill matches the PO exactly (clean AI/PO match) but drifts from
    // the Quotation by far more than the ₹1 rounding tolerance.
    const { duToken, quotationId } = await setupQuotationAndPo('QMM2', 20000, 23000);
    const { billId, status } = await createAndSubmitBill(quotationId, duToken, 23000);
    expect(status).toBe('ai_verified');

    const bill = await Bill.findById(billId).lean();
    expect(
      bill!.history.some((h) => h.event === 'ai_verified' && h.remarks?.includes('does not match the Quotation amount')),
    ).toBe(true);
  });
});
