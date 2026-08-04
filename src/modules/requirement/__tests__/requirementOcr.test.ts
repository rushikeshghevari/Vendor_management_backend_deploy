import request from 'supertest';

import { createApp } from '@/app';
import { ROLES } from '@/constants/roles';
import { createTestDepartment, createTestUser } from '@/test/factories';

const app = createApp();

async function loginAs(email: string, password = 'Password123!') {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password });
  return res.body.data.accessToken as string;
}

const sampleItems = [{ itemName: 'Laptop', quantity: 5, unit: 'pcs', estimatedRate: 60000 }];

/** Not a real PDF — multer only checks the declared mimetype, so this is enough to reach
 *  the OCR pipeline and exercise its error handling without a network call or a real
 *  parseable file (pdf-parse will reject it, landing OCR in `failed`, which is exactly
 *  what these tests assert on — the pipeline's wiring, not extraction accuracy, which is
 *  covered separately by `quotationOcrParser.test.ts`). */
const FAKE_PDF_BYTES = Buffer.from('%PDF-1.4 not a real pdf, deliberately invalid for OCR error-path testing');

async function pollUntilOcrSettled(app_: typeof app, token: string, quotationId: string, maxAttempts = 20) {
  for (let i = 0; i < maxAttempts; i++) {
    const res = await request(app_).get(`/api/v1/quotations/${quotationId}`).set('Authorization', `Bearer ${token}`);
    if (res.body.data.ocr && res.body.data.ocr.status !== 'processing' && res.body.data.ocr.status !== 'not_started') {
      return res.body.data;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('OCR did not settle within the polling window');
}

async function setupSubmittedRequirementWithQuotation(email: string) {
  const token = await loginAs(email);
  const created = await request(app)
    .post('/api/v1/requirements')
    .set('Authorization', `Bearer ${token}`)
    .send({ title: 'OCR Test Requirement', budget: 400000, requiredDate: '2026-08-01', items: sampleItems });
  const requirementId = created.body.data._id;

  await request(app).patch(`/api/v1/requirements/${requirementId}/submit`).set('Authorization', `Bearer ${token}`).send();

  const quotationRes = await request(app)
    .post(`/api/v1/requirements/${requirementId}/quotations`)
    .set('Authorization', `Bearer ${token}`)
    .send({
      temporaryVendor: { name: 'OCR Vendor Co' },
      quotationDate: '2026-07-18',
      amount: 300000,
      gst: 18,
      currency: 'INR',
      paymentTerms: 'Net 30',
      deliveryTerms: 'Within 2 Weeks',
      priority: 'medium',
    });

  return { token, requirementId, quotationId: quotationRes.body.data._id as string };
}

describe('POST /api/v1/requirements/:id/quotations/:quotationId/attachments (Phase 3 OCR)', () => {
  it('uploads an attachment, auto-starts OCR, and settles to a terminal status', async () => {
    const admin = await createTestUser({ email: 'ocr-admin@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'OCR Dept', code: 'OCR', createdBy: admin.id });
    await createTestUser({ email: 'ocr-du@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const { token, requirementId, quotationId } = await setupSubmittedRequirementWithQuotation('ocr-du@vms.local');

    const uploadRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF_BYTES, { filename: 'quote.pdf', contentType: 'application/pdf' });

    expect(uploadRes.status).toBe(200);
    expect(uploadRes.body.data.attachments).toHaveLength(1);
    expect(uploadRes.body.data.attachments[0].fileHash).toBeDefined();

    const settled = await pollUntilOcrSettled(app, token, quotationId);
    expect(settled.ocr.attachmentVersion).toBe(1);
    expect(['completed', 'failed']).toContain(settled.ocr.status);
    // A hand-rolled non-PDF byte stream reliably fails pdf-parse — asserting `failed`
    // here (rather than just "settled") proves the error path actually persists an error.
    expect(settled.ocr.status).toBe('failed');
    expect(settled.ocr.error).toBeTruthy();
  }, 15000);

  it('rejects an exact duplicate re-upload to the same quotation', async () => {
    const admin = await createTestUser({ email: 'ocr-admin2@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'OCR Dept 2', code: 'OCR2', createdBy: admin.id });
    await createTestUser({ email: 'ocr-du2@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const { token, requirementId, quotationId } = await setupSubmittedRequirementWithQuotation('ocr-du2@vms.local');

    const first = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF_BYTES, { filename: 'quote.pdf', contentType: 'application/pdf' });
    expect(first.status).toBe(200);

    const duplicate = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF_BYTES, { filename: 'quote-copy.pdf', contentType: 'application/pdf' });

    expect(duplicate.status).toBe(400);
    expect(duplicate.body.message).toMatch(/already been uploaded/i);
  });

  it('rejects an unsupported file type', async () => {
    const admin = await createTestUser({ email: 'ocr-admin3@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'OCR Dept 3', code: 'OCR3', createdBy: admin.id });
    await createTestUser({ email: 'ocr-du3@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const { token, requirementId, quotationId } = await setupSubmittedRequirementWithQuotation('ocr-du3@vms.local');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', Buffer.from('plain text file'), { filename: 'notes.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
  });
});

describe('POST /api/v1/requirements/:id/quotations/:quotationId/ocr/retry', () => {
  it('re-runs OCR and immediately reports processing status', async () => {
    const admin = await createTestUser({ email: 'ocr-admin4@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'OCR Dept 4', code: 'OCR4', createdBy: admin.id });
    await createTestUser({ email: 'ocr-du4@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const { token, requirementId, quotationId } = await setupSubmittedRequirementWithQuotation('ocr-du4@vms.local');

    await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/attachments`)
      .set('Authorization', `Bearer ${token}`)
      .attach('file', FAKE_PDF_BYTES, { filename: 'quote.pdf', contentType: 'application/pdf' });
    await pollUntilOcrSettled(app, token, quotationId);

    const retryRes = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/ocr/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(retryRes.status).toBe(200);
    expect(retryRes.body.data.ocr.status).toBe('processing');

    const settled = await pollUntilOcrSettled(app, token, quotationId);
    expect(settled.ocr.status).toBe('failed');
  }, 15000);

  it('returns 400 when the quotation has no attachment yet', async () => {
    const admin = await createTestUser({ email: 'ocr-admin5@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'OCR Dept 5', code: 'OCR5', createdBy: admin.id });
    await createTestUser({ email: 'ocr-du5@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });

    const { token, requirementId, quotationId } = await setupSubmittedRequirementWithQuotation('ocr-du5@vms.local');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/ocr/retry`)
      .set('Authorization', `Bearer ${token}`)
      .send();

    expect(res.status).toBe(400);
  });

  it('forbids a Director from retrying OCR (read-only per Phase 3 role permissions)', async () => {
    const admin = await createTestUser({ email: 'ocr-admin6@vms.local', role: ROLES.SUPER_ADMIN });
    const dept = await createTestDepartment({ name: 'OCR Dept 6', code: 'OCR6', createdBy: admin.id });
    await createTestUser({ email: 'ocr-du6@vms.local', role: ROLES.DEPARTMENT_USER, department: dept._id.toString() });
    await createTestUser({ email: 'ocr-director6@vms.local', role: ROLES.DIRECTOR });

    const { requirementId, quotationId } = await setupSubmittedRequirementWithQuotation('ocr-du6@vms.local');
    const directorToken = await loginAs('ocr-director6@vms.local');

    const res = await request(app)
      .post(`/api/v1/requirements/${requirementId}/quotations/${quotationId}/ocr/retry`)
      .set('Authorization', `Bearer ${directorToken}`)
      .send();

    expect(res.status).toBe(403);
  });
});
