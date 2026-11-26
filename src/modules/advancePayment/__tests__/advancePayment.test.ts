import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { AdvancePayment } from '@/modules/advancePayment/advancePayment.model';
import type { IUser } from '@/modules/user/user.model';
import { createTestDepartment, createTestUser } from '@/test/factories';
import { signAccessToken } from '@/utils/jwt';

const app = createApp();

function tokenFor(user: IUser): string {
  return signAccessToken({ sub: String(user._id), role: user.role, department: user.department?.toString() });
}

const sampleItems = [{ itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 }];

async function waitForAdvancePayment(quotationId: string, maxAttempts = 60): Promise<string> {
  for (let i = 0; i < maxAttempts; i++) {
    const record = await AdvancePayment.findOne({ quotation: quotationId }).select('_id').lean();
    if (record) return String(record._id);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`No AdvancePayment created for quotation ${quotationId} after ${maxAttempts * 50}ms`);
}

interface Fixture {
  duToken: string;
  accountsToken: string;
  paymentToken: string;
  requirementId: string;
  quotationId: string;
}

/** Drives a fresh requirement to Director approval with a winning quotation that carries an
 *  advanceAmount — the only trigger that ever creates an AdvancePayment. Stops right there
 *  (never registers a vendor or generates a PO), since that's all this module cares about. */
async function setupApprovedRequirementWithAdvance(deptCode: string, advanceAmount: number): Promise<Fixture> {
  const admin = await createTestUser({ email: `adv-admin-${deptCode}@vms.local`, role: ROLES.SUPER_ADMIN });
  const dept = await createTestDepartment({ name: `Advance Payment Dept ${deptCode}`, code: deptCode, createdBy: admin.id });
  const du = await createTestUser({ email: `adv-du-${deptCode}@vms.local`, role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
  const director = await createTestUser({ email: `adv-director-${deptCode}@vms.local`, role: ROLES.DIRECTOR });
  const accounts = await createTestUser({ email: `adv-accounts-${deptCode}@vms.local`, role: ROLES.ACCOUNTS });
  const payment = await createTestUser({ email: `adv-payment-${deptCode}@vms.local`, role: ROLES.PAYMENT_DEPARTMENT });

  const duToken = tokenFor(du);
  const directorToken = tokenFor(director);

  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${duToken}`)
    .send({ title: `Advance Payment Req ${deptCode}`, budget: 500000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id as string;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).patch(`/api/v1/requirements/${requirementId}/hod-accept`).set('Authorization', `Bearer ${tokenFor(admin)}`).send();

  const quotationRes = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${duToken}`)
    .send({
      temporaryVendor: { name: `Advance Vendor ${deptCode}`, contactPerson: 'Ramesh', phone: '9876543210' },
      quotationDate: '2026-07-18',
      amount: 300000,
      advanceAmount,
      expectedPODate: '2026-08-10',
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      creditPeriod: 30,
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });
  expect(quotationRes.status).toBe(201);
  const quotationId = quotationRes.body.data._id as string;

  await request(app).post(`/api/v1/requirements/${requirementId}/comparison`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).patch(`/api/v1/requirements/${requirementId}/submit-to-director`).set('Authorization', `Bearer ${duToken}`).send();
  await request(app).get(`/api/v1/requirements/${requirementId}/director-review`).set('Authorization', `Bearer ${directorToken}`).send();
  const decision = await request(app)
    .post(`/api/v1/requirements/${requirementId}/director-review/decision`)
    .set('Authorization', `Bearer ${directorToken}`)
    .send({ decision: 'approved', selectedQuotationId: quotationId });
  expect(decision.status).toBe(200);

  return { duToken, accountsToken: tokenFor(accounts), paymentToken: tokenFor(payment), requirementId, quotationId };
}

describe('Advance Payment — auto-created on Director approval, Accounts verifies, Payment Department pays', () => {
  it('creates nothing when the winning quotation has no advanceAmount', async () => {
    const { quotationId } = await setupApprovedRequirementWithAdvance('ADV1', 0);
    // Give the fire-and-forget hook a moment, then confirm it genuinely never ran.
    await new Promise((resolve) => setTimeout(resolve, 300));
    const record = await AdvancePayment.findOne({ quotation: quotationId });
    expect(record).toBeNull();
  });

  it('walks pending_verification -> pending_payment -> paid, with the right role gated at each step', async () => {
    const { accountsToken, paymentToken, quotationId } = await setupApprovedRequirementWithAdvance('ADV2', 50000);
    const advanceId = await waitForAdvancePayment(quotationId);

    const created = await AdvancePayment.findById(advanceId).lean();
    expect(created!.status).toBe('pending_verification');
    expect(created!.advanceAmount).toBe(50000);
    expect(created!.balanceAmount).toBe(250000); // 300000 - 50000

    // Payment Department can't act before Accounts verifies.
    const earlyPay = await request(app)
      .patch(`/api/v1/advance-payments/${advanceId}/mark-paid`)
      .set('Authorization', `Bearer ${paymentToken}`)
      .send({ paymentReference: 'TXN-TOO-EARLY' });
    expect(earlyPay.status).toBe(404);

    // Accounts verifies.
    const verify = await request(app)
      .patch(`/api/v1/advance-payments/${advanceId}/verify`)
      .set('Authorization', `Bearer ${accountsToken}`)
      .send({ remarks: 'Amount matches the quotation' });
    expect(verify.status).toBe(200);
    expect(verify.body.data.status).toBe('pending_payment');

    // Accounts can't also mark it paid.
    const accountsPayAttempt = await request(app)
      .patch(`/api/v1/advance-payments/${advanceId}/mark-paid`)
      .set('Authorization', `Bearer ${accountsToken}`)
      .send({ paymentReference: 'TXN-SHOULD-FAIL' });
    expect(accountsPayAttempt.status).toBe(403);

    // Payment Department pays.
    const pay = await request(app)
      .patch(`/api/v1/advance-payments/${advanceId}/mark-paid`)
      .set('Authorization', `Bearer ${paymentToken}`)
      .send({ paymentReference: 'TXN-98765', remarks: 'Paid via NEFT' });
    expect(pay.status).toBe(200);
    expect(pay.body.data.status).toBe('paid');
    expect(pay.body.data.balanceAmount).toBe(250000);

    const finalRecord = await AdvancePayment.findById(advanceId).lean();
    expect(finalRecord!.history.map((h) => h.event)).toEqual(['created', 'accounts_verified', 'payment_made']);
  });

  it('is visible to the Department User (owner), Accounts, and Payment Department', async () => {
    const { duToken, accountsToken, paymentToken, quotationId } = await setupApprovedRequirementWithAdvance('ADV3', 20000);
    const advanceId = await waitForAdvancePayment(quotationId);

    for (const token of [duToken, accountsToken, paymentToken]) {
      const res = await request(app)
        .get(`/api/v1/advance-payments/${advanceId}`)
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(res.body.data.advanceAmount).toBe(20000);
    }
  });
});
