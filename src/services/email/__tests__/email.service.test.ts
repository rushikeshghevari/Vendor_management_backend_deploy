const ORIGINAL_ENV = { ...process.env };

function clearSmtpEnv() {
  delete process.env.SMTP_HOST;
  delete process.env.SMTP_PORT;
  delete process.env.SMTP_SECURE;
  delete process.env.SMTP_USER;
  delete process.env.SMTP_PASS;
  delete process.env.SMTP_FROM;
}

describe('emailService', () => {
  beforeEach(() => {
    jest.resetModules();
    clearSmtpEnv();
  });

  afterAll(() => {
    process.env = ORIGINAL_ENV;
  });

  it('no-ops gracefully when SMTP is not configured — never calls nodemailer.createTransport', async () => {
    const createTransport = jest.fn();
    jest.doMock('nodemailer', () => ({ createTransport }));

    const { emailService } = require('@/services/email/email.service');
    const result = await emailService.sendMail({ to: 'vendor@example.com', subject: 'Hi' });

    expect(result).toEqual({ sent: false, reason: 'SMTP not configured' });
    expect(createTransport).not.toHaveBeenCalled();
  });

  it('sends mail successfully once SMTP_HOST/SMTP_USER/SMTP_PASS are all set', async () => {
    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.SMTP_USER = 'user@test.local';
    process.env.SMTP_PASS = 'secret';

    const sendMailMock = jest.fn().mockResolvedValue({ messageId: '123' });
    jest.doMock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: sendMailMock })) }));

    const { emailService } = require('@/services/email/email.service');
    const result = await emailService.sendMail({ to: 'vendor@example.com', subject: 'Hi', text: 'Body' });

    expect(result).toEqual({ sent: true });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'vendor@example.com', subject: 'Hi', text: 'Body' }),
    );
  });

  it('reports a failed send as { sent: false, reason } instead of throwing', async () => {
    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.SMTP_USER = 'user@test.local';
    process.env.SMTP_PASS = 'secret';

    const sendMailMock = jest.fn().mockRejectedValue(new Error('Connection refused'));
    jest.doMock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: sendMailMock })) }));

    const { emailService } = require('@/services/email/email.service');
    const result = await emailService.sendMail({ to: 'vendor@example.com', subject: 'Hi' });

    expect(result).toEqual({ sent: false, reason: 'Connection refused' });
  });

  it('sendPurchaseOrderEmail builds a PO-specific subject/body and attaches the generated PDF', async () => {
    process.env.SMTP_HOST = 'smtp.test.local';
    process.env.SMTP_USER = 'user@test.local';
    process.env.SMTP_PASS = 'secret';

    const sendMailMock = jest.fn().mockResolvedValue({});
    jest.doMock('nodemailer', () => ({ createTransport: jest.fn(() => ({ sendMail: sendMailMock })) }));

    const { emailService } = require('@/services/email/email.service');
    const result = await emailService.sendPurchaseOrderEmail({
      to: 'vendor@example.com',
      po: { poNumber: 'PO-0001', vendorName: 'Acme Supplies', grandTotal: 50000 },
      pdfPath: '/tmp/PO-0001.pdf',
    });

    expect(result).toEqual({ sent: true });
    expect(sendMailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'vendor@example.com',
        subject: 'Purchase Order PO-0001',
        attachments: [{ filename: 'PO-0001.pdf', path: '/tmp/PO-0001.pdf' }],
      }),
    );
    expect(sendMailMock.mock.calls[0][0].text).toContain('Acme Supplies');
  });
});
