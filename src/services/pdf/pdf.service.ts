import fs from 'node:fs';
import path from 'node:path';

import PDFDocument from 'pdfkit';

import type { IPurchaseOrder } from '@/modules/purchaseOrder/purchaseOrder.model';

const UPLOAD_DIR = path.join(process.cwd(), 'uploads', 'purchase-orders');
const LOGO_PATH = path.join(process.cwd(), 'src', 'assets', 'logo.png');
// pdfkit's built-in Helvetica only supports WinAnsiEncoding, which has no glyph for ₹ (U+20B9) —
// it would silently render as a box/wrong character. Noto Sans is bundled here (OFL-licensed,
// freely redistributable) specifically so ₹ amounts render correctly on every platform.
const FONT_REGULAR_PATH = path.join(process.cwd(), 'src', 'assets', 'NotoSans-Regular.ttf');
const FONT_BOLD_PATH = path.join(process.cwd(), 'src', 'assets', 'NotoSans-Bold.ttf');

// Genericart Medicine's own letterhead details — this PO always originates from Genericart and
// always ships to Genericart's own address, so these are fixed, not pulled from any model.
const COMPANY = {
  name: 'GENERICART MEDICINE PVT LTD',
  addressLines: [
    'Opp. Reliance Petrol Pump, Sangli-Miraj Road,',
    'Bhokare Colony, Chandanwadi, Taluka-Miraj,',
    'District- Sangli, Maharashtra-416410',
  ],
  phone: '9867227898',
  gst: '27AAGCG2646H1ZK',
};

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

/** dd/mm/yyyy — matches Genericart's own PO template, distinct from the "02 Nov 2026" style
 *  used elsewhere in the app. */
function formatDateSlash(date: Date | string): string {
  const d = new Date(date);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}/${mm}/${d.getFullYear()}`;
}

const PAGE_LEFT = 40;
const PAGE_RIGHT = 555;
const CONTENT_WIDTH = PAGE_RIGHT - PAGE_LEFT;
const PAGE_BOTTOM = 800;

/** Decorative peach + black double border, redrawn on every page (including ones added mid-table
 *  for a long item list) so a multi-page PO still looks like Genericart's letterhead throughout. */
function drawPageFrame(doc: PDFKit.PDFDocument): void {
  doc.save();
  doc.lineWidth(5).strokeColor('#f3c9a0');
  doc.roundedRect(14, 14, 567, 814, 10).stroke();
  doc.lineWidth(1.25).strokeColor('#1a1a1a');
  doc.roundedRect(22, 22, 551, 798, 5).stroke();
  doc.restore();
}

/** Table column header row, redrawn at the top of every page the item table spans. Returns the
 *  y position directly below the header row, ready for the first data row. */
function drawItemsTableHeader(doc: PDFKit.PDFDocument, y: number, colX: number[], colWidths: number[]): number {
  const headers = ['ITEM', 'DESCRIPTION', 'QTY', 'UNIT PRICE', 'GST%', 'GST AMT', 'TOTAL'];
  const aligns: ('left' | 'center' | 'right')[] = ['center', 'left', 'center', 'right', 'center', 'right', 'right'];
  doc.rect(PAGE_LEFT, y, CONTENT_WIDTH, 22).fillAndStroke('#d9d9d9', '#999999');
  headers.forEach((h, i) => {
    doc.fontSize(9).font('Body-Bold').fillColor('#1a1a1a')
      .text(h, (colX[i] ?? 0) + 4, y + 7, { width: (colWidths[i] ?? 0) - 8, align: aligns[i] });
  });
  return y + 22;
}

export async function generatePurchaseOrderPdf(po: IPurchaseOrder): Promise<GeneratedPdf> {
  ensureDir();

  const fileName = `${po.poNumber}-${Date.now()}.pdf`;
  const filePath = path.join(UPLOAD_DIR, fileName);
  const url = `/uploads/purchase-orders/${fileName}`;
  const hasLogo = fs.existsSync(LOGO_PATH);

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 30, size: 'A4', bufferPages: true });
    const stream = fs.createWriteStream(filePath);
    doc.pipe(stream);

    doc.registerFont('Body', FONT_REGULAR_PATH);
    doc.registerFont('Body-Bold', FONT_BOLD_PATH);
    doc.font('Body');

    drawPageFrame(doc);
    doc.on('pageAdded', () => drawPageFrame(doc));

    // ── Header: logo (left) + "PURCHASE ORDER" yellow box (right) ───────────────
    const headerY = 40;
    if (hasLogo) {
      doc.image(LOGO_PATH, PAGE_LEFT, headerY, { width: 150 });
    } else {
      doc.fontSize(14).font('Body-Bold').fillColor('#1a1a2e').text(COMPANY.name, PAGE_LEFT, headerY);
    }
    const poBoxW = 180;
    const poBoxH = 30;
    doc.rect(PAGE_RIGHT - poBoxW, headerY + 8, poBoxW, poBoxH).fill('#ffff00');
    doc.fontSize(15).font('Body-Bold').fillColor('#1a1a1a')
      .text('PURCHASE ORDER', PAGE_RIGHT - poBoxW, headerY + 17, { width: poBoxW, align: 'center' });

    // ── Company letterhead (left) + Date / PO No. table (right) ─────────────────
    let y = 128;
    const metaX = 335;
    const metaW = PAGE_RIGHT - metaX;

    doc.fontSize(11).font('Body-Bold').fillColor('#1a1a2e').text(COMPANY.name, PAGE_LEFT, y, { width: metaX - PAGE_LEFT - 16 });
    y += 16;
    doc.fontSize(9).font('Body').fillColor('#333333');
    COMPANY.addressLines.forEach((line) => {
      doc.text(line, PAGE_LEFT, y, { width: metaX - PAGE_LEFT - 16 });
      y += 13;
    });
    doc.text(`Phone: ${COMPANY.phone}`, PAGE_LEFT, y, { width: metaX - PAGE_LEFT - 16 });
    y += 13;
    doc.text(`GST: ${COMPANY.gst}`, PAGE_LEFT, y, { width: metaX - PAGE_LEFT - 16 });

    const metaRows: [string, string][] = [
      ['Date:-', formatDateSlash(po.poDate)],
      ['PO no.:-', po.poNumber],
    ];
    const metaRowH = 22;
    metaRows.forEach(([label, value], idx) => {
      const ry = 128 + idx * metaRowH;
      doc.rect(metaX, ry, 72, metaRowH).fillAndStroke('#eeeeee', '#999999');
      doc.rect(metaX + 72, ry, metaW - 72, metaRowH).stroke('#999999');
      doc.fontSize(9).font('Body-Bold').fillColor('#1a1a1a').text(label, metaX + 5, ry + 7, { width: 62 });
      doc.font('Body').text(value, metaX + 78, ry + 7, { width: metaW - 83 });
    });

    y = Math.max(y + 10, 128 + metaRows.length * metaRowH + 10);

    // ── Vendor (left) + Ship To (right) ──────────────────────────────────────────
    const colGap = 18;
    const colW = (CONTENT_WIDTH - colGap) / 2;
    const shipX = PAGE_LEFT + colW + colGap;

    doc.rect(PAGE_LEFT, y, colW, 18).fill('#e5e5e5');
    doc.rect(shipX, y, colW, 18).fill('#e5e5e5');
    doc.fontSize(9).font('Body-Bold').fillColor('#1a1a1a')
      .text('VENDOR', PAGE_LEFT + 6, y + 5)
      .text('SHIP TO', shipX + 6, y + 5);

    const blockTop = y + 24;
    let vendorY = blockTop;
    doc.fontSize(10).font('Body-Bold').fillColor('#1a1a2e').text(po.vendorName, PAGE_LEFT, vendorY, { width: colW });
    vendorY += doc.heightOfString(po.vendorName, { width: colW }) + 3;
    doc.fontSize(9).font('Body').fillColor('#333333').text(po.vendorAddress, PAGE_LEFT, vendorY, { width: colW });
    vendorY += doc.heightOfString(po.vendorAddress, { width: colW }) + 3;
    if (po.vendorGst) {
      doc.text(`GST: ${po.vendorGst}`, PAGE_LEFT, vendorY, { width: colW });
      vendorY += 13;
    }

    let shipY = blockTop;
    doc.fontSize(10).font('Body-Bold').fillColor('#1a1a2e').text(COMPANY.name, shipX, shipY, { width: colW });
    shipY += doc.heightOfString(COMPANY.name, { width: colW }) + 3;
    doc.fontSize(9).font('Body').fillColor('#333333');
    COMPANY.addressLines.forEach((line) => {
      doc.text(line, shipX, shipY, { width: colW });
      shipY += 13;
    });
    doc.text(`Phone: ${COMPANY.phone}`, shipX, shipY, { width: colW });
    shipY += 13;

    y = Math.max(vendorY, shipY) + 14;

    // ── Items Table ───────────────────────────────────────────────────────────────
    const colWidths = [36, 174, 50, 70, 45, 65, 75];
    const colX = colWidths.reduce<number[]>((acc, _w, i) => {
      acc.push(i === 0 ? PAGE_LEFT : (acc[i - 1] ?? 0) + (colWidths[i - 1] ?? 0));
      return acc;
    }, []);

    let rowY = drawItemsTableHeader(doc, y, colX, colWidths);
    const tableTop = y;

    po.items.forEach((item, idx) => {
      const descWidth = (colWidths[1] ?? 180) - 8;
      const descText = item.description && item.description !== item.itemName
        ? `${item.itemName}\n${item.description}`
        : item.itemName;
      const rowHeight = Math.max(18, doc.heightOfString(descText, { width: descWidth }) + 8);

      if (rowY + rowHeight > PAGE_BOTTOM) {
        doc.addPage();
        rowY = drawItemsTableHeader(doc, 40, colX, colWidths);
      }

      const bg = idx % 2 === 0 ? '#f8f9fa' : '#ffffff';
      doc.rect(PAGE_LEFT, rowY, CONTENT_WIDTH, rowHeight).fill(bg);
      doc.fontSize(9).font('Body').fillColor('#333333')
        .text(String(idx + 1), (colX[0] ?? 0) + 4, rowY + 5, { width: (colWidths[0] ?? 0) - 8, align: 'center' })
        .text(descText, (colX[1] ?? 0) + 4, rowY + 5, { width: descWidth })
        .text(item.quantity.toString(), (colX[2] ?? 0) + 4, rowY + 5, { width: (colWidths[2] ?? 0) - 8, align: 'center' })
        .text(formatCurrency(item.unitPrice), (colX[3] ?? 0) + 4, rowY + 5, { width: (colWidths[3] ?? 0) - 8, align: 'right' })
        .text(item.gstRate ? `${item.gstRate}%` : '-', (colX[4] ?? 0) + 4, rowY + 5, { width: (colWidths[4] ?? 0) - 8, align: 'center' })
        .text(item.gstAmount ? formatCurrency(item.gstAmount) : '-', (colX[5] ?? 0) + 4, rowY + 5, { width: (colWidths[5] ?? 0) - 8, align: 'right' })
        .text(formatCurrency(item.total), (colX[6] ?? 0) + 4, rowY + 5, { width: (colWidths[6] ?? 0) - 8, align: 'right' });
      rowY += rowHeight;
    });

    doc.lineWidth(1).rect(PAGE_LEFT, tableTop, CONTENT_WIDTH, rowY - tableTop).stroke('#999999');
    colX.slice(1).forEach((x) => doc.moveTo(x, tableTop).lineTo(x, rowY).stroke('#cccccc'));

    // ── Totals ──────────────────────────────────────────────────────────────────
    let totY = rowY + 12;
    if (totY + 100 > PAGE_BOTTOM) {
      doc.addPage();
      totY = 40;
    }
    const totLabelX = 350;
    const totValueX = 450;
    doc.fontSize(10).font('Body').fillColor('#333333')
      .text('Subtotal:', totLabelX, totY).text(formatCurrency(po.subtotal), totValueX, totY, { align: 'right', width: 90 });
    doc.text('Total GST:', totLabelX, totY + 16).text(formatCurrency(po.totalGst), totValueX, totY + 16, { align: 'right', width: 90 });
    doc.text('Total Tax:', totLabelX, totY + 32).text(formatCurrency(po.totalTax), totValueX, totY + 32, { align: 'right', width: 90 });
    doc.text('Total Discount:', totLabelX, totY + 48).text(`- ${formatCurrency(po.totalDiscount)}`, totValueX, totY + 48, { align: 'right', width: 90 });
    doc.moveTo(totLabelX, totY + 66).lineTo(PAGE_RIGHT, totY + 66).stroke('#333333');
    doc.fontSize(11).font('Body-Bold').fillColor('#1a1a2e')
      .text('Grand Total:', totLabelX, totY + 70).text(formatCurrency(po.grandTotal), totValueX, totY + 70, { align: 'right', width: 90 });

    // ── Terms & Notes ───────────────────────────────────────────────────────────
    let noteY = totY + 100;
    if (po.terms) {
      doc.fontSize(10).font('Body-Bold').fillColor('#1a1a2e').text('Terms & Conditions:', PAGE_LEFT, noteY, { width: CONTENT_WIDTH });
      noteY += 14;
      doc.font('Body').fillColor('#555555').text(po.terms, PAGE_LEFT, noteY, { width: CONTENT_WIDTH });
      noteY += doc.heightOfString(po.terms, { width: CONTENT_WIDTH }) + 10;
    }
    if (po.notes) {
      doc.fontSize(10).font('Body-Bold').fillColor('#1a1a2e').text('Notes:', PAGE_LEFT, noteY, { width: CONTENT_WIDTH });
      noteY += 14;
      doc.font('Body').fillColor('#555555').text(po.notes, PAGE_LEFT, noteY, { width: CONTENT_WIDTH });
    }

    doc.end();
    stream.on('finish', () => resolve({ fileName, url, filePath }));
    stream.on('error', reject);
  });
}
