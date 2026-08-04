import fs from 'node:fs';
import path from 'node:path';

import PDFDocument from 'pdfkit';

import type { IPurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'purchase-orders');

function ensureDir(): void {
  if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  }
}

export interface GeneratedPdf {
  fileName: string;
  url: string;
  filePath: string;
}

function formatCurrency(amount: number): string {
  return new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(amount);
}

function formatDate(date: Date | string): string {
  return new Date(date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export async function generatePurchaseOrderPdf(po: IPurchaseOrder): Promise<GeneratedPdf> {
  ensureDir();

  const fileName = `${po.poNumber}-${Date.now()}.pdf`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  const url = `/uploads/purchase-orders/${fileName}`;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const stream = fs.createWriteStream(filePath);

    doc.pipe(stream);

    // ── Header ─────────────────────────────────────────────────────────────────
    doc.fontSize(22).font('Helvetica-Bold').text('PURCHASE ORDER', { align: 'center' });
    doc.moveDown(0.4);
    doc.fontSize(10).font('Helvetica').fillColor('#555555')
      .text('Vendor Management System', { align: 'center' });
    doc.moveDown(0.6);

    // Horizontal rule
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.6);

    // ── PO Meta (left) + Dates (right) ─────────────────────────────────────────
    const col2Start = 320;
    const yMeta = doc.y;

    doc.fontSize(10).font('Helvetica-Bold').text('PO Number:', 50, yMeta);
    doc.font('Helvetica').text(po.poNumber, 150, yMeta);

    doc.font('Helvetica-Bold').text('PO Date:', 50, yMeta + 18);
    doc.font('Helvetica').text(formatDate(po.poDate), 150, yMeta + 18);

    doc.font('Helvetica-Bold').text('Quotation Ref:', 50, yMeta + 36);
    doc.font('Helvetica').text(
      po.requirementNumber ? `${po.quotationCode} (Requirement: ${po.requirementNumber})` : po.quotationCode,
      150,
      yMeta + 36,
    );

    doc.font('Helvetica-Bold').text('Department:', col2Start, yMeta);
    doc.font('Helvetica').text(po.departmentName, col2Start + 90, yMeta);

    doc.font('Helvetica-Bold').text('Status:', col2Start, yMeta + 18);
    doc.font('Helvetica').text(po.status.toUpperCase().replace(/_/g, ' '), col2Start + 90, yMeta + 18);

    doc.moveDown(4);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.6);

    // ── Vendor Details ──────────────────────────────────────────────────────────
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a2e').text('Vendor Details');
    doc.moveDown(0.3);
    doc.fontSize(10).font('Helvetica').fillColor('#333333');
    doc.text(`Name: ${po.vendorName}`);
    doc.text(`GST: ${po.vendorGst}`);
    doc.text(`Address: ${po.vendorAddress}`);
    doc.moveDown(0.6);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).stroke('#cccccc');
    doc.moveDown(0.6);

    // ── Items Table ─────────────────────────────────────────────────────────────
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a2e').text('Line Items');
    doc.moveDown(0.4);

    const tableTop = doc.y;
    const colWidths = [180, 55, 70, 55, 55, 55, 70];
    const colHeaders = ['Item Name', 'Qty', 'Unit Price', 'GST%', 'GST Amt', 'Discount', 'Total'];
    const colX = colWidths.reduce<number[]>((acc, _w, i) => {
      acc.push(i === 0 ? 50 : (acc[i - 1] ?? 0) + (colWidths[i - 1] ?? 0));
      return acc;
    }, []);

    // Header row
    doc.rect(50, tableTop, 495, 20).fill('#1a1a2e');
    colHeaders.forEach((h, i) => {
      doc.fontSize(9).font('Helvetica-Bold').fillColor('#ffffff')
        .text(h, (colX[i] ?? 50) + 3, tableTop + 5, { width: (colWidths[i] ?? 70) - 6, align: i > 0 ? 'right' : 'left' });
    });

    // Data rows
    let rowY = tableTop + 20;
    po.items.forEach((item, idx) => {
      const bg = idx % 2 === 0 ? '#f8f9fa' : '#ffffff';
      doc.rect(50, rowY, 495, 18).fill(bg);
      doc.fontSize(9).font('Helvetica').fillColor('#333333')
        .text(item.itemName,                    (colX[0] ?? 50)  + 3, rowY + 4, { width: (colWidths[0] ?? 180) - 6 })
        .text(item.quantity.toString(),          (colX[1] ?? 230) + 3, rowY + 4, { width: (colWidths[1] ?? 55)  - 6, align: 'right' })
        .text(formatCurrency(item.unitPrice),    (colX[2] ?? 285) + 3, rowY + 4, { width: (colWidths[2] ?? 70)  - 6, align: 'right' })
        .text(`${item.gstRate}%`,               (colX[3] ?? 355) + 3, rowY + 4, { width: (colWidths[3] ?? 55)  - 6, align: 'right' })
        .text(formatCurrency(item.gstAmount),    (colX[4] ?? 410) + 3, rowY + 4, { width: (colWidths[4] ?? 55)  - 6, align: 'right' })
        .text(formatCurrency(item.discount),     (colX[5] ?? 465) + 3, rowY + 4, { width: (colWidths[5] ?? 55)  - 6, align: 'right' })
        .text(formatCurrency(item.total),        (colX[6] ?? 520) + 3, rowY + 4, { width: (colWidths[6] ?? 70)  - 6, align: 'right' });
      rowY += 18;
    });

    // Table border
    doc.rect(50, tableTop, 495, rowY - tableTop).stroke('#cccccc');
    doc.moveDown(0.3);

    // ── Totals ──────────────────────────────────────────────────────────────────
    const totY = rowY + 8;
    doc.fontSize(10).font('Helvetica').fillColor('#333333')
      .text(`Subtotal:`, 350, totY).text(formatCurrency(po.subtotal), 450, totY, { align: 'right', width: 90 });
    doc.text(`Total GST:`, 350, totY + 16).text(formatCurrency(po.totalGst), 450, totY + 16, { align: 'right', width: 90 });
    doc.text(`Total Tax:`, 350, totY + 32).text(formatCurrency(po.totalTax), 450, totY + 32, { align: 'right', width: 90 });
    doc.text(`Total Discount:`, 350, totY + 48).text(`- ${formatCurrency(po.totalDiscount)}`, 450, totY + 48, { align: 'right', width: 90 });
    doc.moveTo(350, totY + 66).lineTo(545, totY + 66).stroke('#333333');
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#1a1a2e')
      .text(`Grand Total:`, 350, totY + 70).text(formatCurrency(po.grandTotal), 450, totY + 70, { align: 'right', width: 90 });

    // ── Terms & Notes ───────────────────────────────────────────────────────────
    const termsY = totY + 100;
    if (po.terms) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a1a2e').text('Terms & Conditions:', 50, termsY);
      doc.font('Helvetica').fillColor('#555555').text(po.terms, 50, termsY + 14);
    }
    if (po.notes) {
      const notesY = po.terms ? termsY + 40 : termsY;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#1a1a2e').text('Notes:', 50, notesY);
      doc.font('Helvetica').fillColor('#555555').text(po.notes, 50, notesY + 14);
    }

    // ── Footer ──────────────────────────────────────────────────────────────────
    const pageHeight = doc.page.height;
    doc.fontSize(8).fillColor('#aaaaaa')
      .text(`Generated by Vendor Management System on ${formatDate(new Date())}`, 50, pageHeight - 50, {
        align: 'center', width: 495,
      });

    doc.end();
    stream.on('finish', () => resolve({ fileName, url, filePath }));
    stream.on('error', reject);
  });
}
