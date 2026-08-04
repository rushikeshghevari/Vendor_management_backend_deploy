import nodemailer from 'nodemailer';

import type { IPurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';

let transporter: nodemailer.Transporter | null = null;
let hasWarned = false;

/** Lazily builds (and caches) the SMTP transporter — same "optional external integration,
 *  graceful no-op when unconfigured" shape as `firebase.service.ts`'s `getApp()`. Reads env
 *  vars directly (not via the central `env` object) for the same reason Firebase's config
 *  isn't centralized there either: it's a genuinely optional integration, not a required
 *  boot-time dependency. Only warns once; re-checks env vars on every call until a transporter
 *  is successfully built, so setting SMTP_* at runtime (or in a test) takes effect immediately. */
function getTransporter(): nodemailer.Transporter | null {
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    if (!hasWarned) {
      console.warn('[email] SMTP_HOST / SMTP_USER / SMTP_PASS not set — email sending disabled');
      hasWarned = true;
    }
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port: Number(process.env.SMTP_PORT ?? 587),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user, pass },
  });
  return transporter;
}

export interface SendMailResult {
  sent: boolean;
  reason?: string;
}

export interface SendMailInput {
  to: string;
  subject: string;
  text?: string;
  html?: string;
  attachments?: Array<{ filename: string; path: string }>;
}

export const emailService = {
  /** Never throws — a failed or skipped send is reported back as `{ sent: false, reason }` so
   *  callers can log/notify without the PO/PDF flow itself ever failing because email isn't
   *  configured or a send attempt failed. */
  async sendMail(input: SendMailInput): Promise<SendMailResult> {
    const client = getTransporter();
    if (!client) return { sent: false, reason: 'SMTP not configured' };

    try {
      await client.sendMail({
        from: process.env.SMTP_FROM || process.env.SMTP_USER,
        to: input.to,
        subject: input.subject,
        text: input.text,
        html: input.html,
        attachments: input.attachments,
      });
      return { sent: true };
    } catch (err) {
      console.error('[email] sendMail error:', err);
      return { sent: false, reason: err instanceof Error ? err.message : 'Unknown email error' };
    }
  },

  async sendPurchaseOrderEmail(params: {
    to: string;
    po: Pick<IPurchaseOrder, 'poNumber' | 'vendorName' | 'grandTotal'>;
    pdfPath: string;
  }): Promise<SendMailResult> {
    const { to, po, pdfPath } = params;
    return emailService.sendMail({
      to,
      subject: `Purchase Order ${po.poNumber}`,
      text:
        `Dear ${po.vendorName},\n\n` +
        `Please find attached Purchase Order ${po.poNumber} for a total of ` +
        `₹${po.grandTotal.toLocaleString('en-IN')}.\n\n` +
        `Regards,\nVendor Management System`,
      attachments: [{ filename: `${po.poNumber}.pdf`, path: pdfPath }],
    });
  },
};
