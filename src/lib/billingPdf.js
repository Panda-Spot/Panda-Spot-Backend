import PDFDocument from "pdfkit";
import { computeItemsTotal, computePayable } from "./billingAccess.js";

const ACCENT = "#0e8a8a";
const DARK = "#122023";
const MUTED = "#637277";

const METHOD_LABELS = {
  CASH: "Cash",
  GPAY: "GPay",
  CARD: "Card",
  BANK_TRANSFER: "Bank Transfer",
  CHEQUE: "Cheque",
};

function money(value) {
  return `Rs. ${Number(value || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function dateStr(value) {
  return new Date(value).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

function drawLetterhead(doc, tenant, settings, label, number, createdAt) {
  doc.fillColor(DARK).fontSize(18).font("Helvetica-Bold").text(tenant.name || "PandaSpot Studio", 50, 50);
  doc.fontSize(9).font("Helvetica").fillColor(MUTED);
  if (tenant.email) doc.text(tenant.email, 50, 74, { width: 300 });
  if (settings?.gstinNumber) {
    doc.text(`GSTIN: ${settings.gstinNumber}${settings.gstState ? ` (${settings.gstState})` : ""}`, 50, doc.y);
  }

  doc.fontSize(20).font("Helvetica-Bold").fillColor(ACCENT).text(label, 300, 50, { width: 245, align: "right" });
  doc.fontSize(10).font("Helvetica").fillColor(DARK).text(`# ${number}`, 300, 78, { width: 245, align: "right" });
  doc.fillColor(MUTED).text(dateStr(createdAt), 300, 94, { width: 245, align: "right" });

  doc.moveTo(50, 130).lineTo(545, 130).strokeColor("#d8e1e3").stroke();
}

function drawClientBlock(doc, client, y = 145) {
  doc.fontSize(9).font("Helvetica-Bold").fillColor(MUTED).text("BILLED TO", 50, y);
  doc.fontSize(11).font("Helvetica-Bold").fillColor(DARK).text(client?.name || "Client", 50, y + 14);
  doc.fontSize(9).font("Helvetica").fillColor(MUTED).text(client?.email || "-", 50, y + 30);
  return y + 55;
}

function lineTotal(item) {
  return (Number(item.price) - Number(item.discountPerUnit || 0)) * Number(item.quantity || 1);
}

function drawItemsTable(doc, items, discountAmount, startY) {
  let y = startY;
  const cols = { name: 50, price: 290, qty: 370, disc: 420, total: 480 };

  doc.rect(50, y, 495, 22).fill("#eef6f6");
  doc.fontSize(8.5).font("Helvetica-Bold").fillColor(MUTED);
  doc.text("ITEM", cols.name + 8, y + 7);
  doc.text("PRICE", cols.price, y + 7, { width: 70, align: "right" });
  doc.text("QTY", cols.qty, y + 7, { width: 40, align: "right" });
  doc.text("DISC/UNIT", cols.disc, y + 7, { width: 55, align: "right" });
  doc.text("TOTAL", cols.total, y + 7, { width: 65, align: "right" });
  y += 22;

  doc.font("Helvetica").fontSize(9.5).fillColor(DARK);
  for (const [idx, item] of items.entries()) {
    const rowH = 24;
    if (idx % 2 === 1) doc.rect(50, y, 495, rowH).fill("#fafdfd").fillColor(DARK);
    doc.font("Helvetica").fontSize(9.5).fillColor(DARK);
    doc.text(item.name, cols.name + 8, y + 7, { width: 230 });
    doc.text(money(item.price), cols.price, y + 7, { width: 70, align: "right" });
    doc.text(String(item.quantity), cols.qty, y + 7, { width: 40, align: "right" });
    doc.text(money(item.discountPerUnit), cols.disc, y + 7, { width: 55, align: "right" });
    doc.text(money(lineTotal(item)), cols.total, y + 7, { width: 65, align: "right" });
    y += rowH;
  }

  doc.moveTo(50, y).lineTo(545, y).strokeColor("#d8e1e3").stroke();
  y += 10;

  const totalsX = 350;
  const itemsTotal = computeItemsTotal(items);
  const payable = computePayable(items, discountAmount);
  doc.fontSize(9.5).font("Helvetica").fillColor(MUTED).text("Items Total", totalsX, y, { width: 100 });
  doc.fillColor(DARK).text(money(itemsTotal), totalsX + 100, y, { width: 95, align: "right" });
  y += 16;
  doc.fillColor(MUTED).text("Discount", totalsX, y, { width: 100 });
  doc.fillColor(DARK).text(`- ${money(discountAmount)}`, totalsX + 100, y, { width: 95, align: "right" });
  y += 20;
  doc.moveTo(totalsX, y).lineTo(545, y).strokeColor("#d8e1e3").stroke();
  y += 8;
  doc.fontSize(12).font("Helvetica-Bold").fillColor(ACCENT).text("Payable Amount", totalsX, y, { width: 100 });
  doc.text(money(payable), totalsX + 100, y, { width: 95, align: "right" });

  return { y: y + 30, payable };
}

function startPdf(res, filename) {
  const doc = new PDFDocument({ size: "A4", margin: 50 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  doc.pipe(res);
  return doc;
}

export function streamQuotationPdf(res, { tenant, settings, quotation }) {
  const doc = startPdf(res, `Quotation-${quotation.quotationNumber}.pdf`);
  drawLetterhead(doc, tenant, settings, "QUOTATION", quotation.quotationNumber, quotation.createdAt);
  const afterClient = drawClientBlock(doc, quotation.client);
  drawItemsTable(doc, quotation.items || [], quotation.discountAmount, afterClient);
  doc.fontSize(8).fillColor(MUTED).text(
    "This is a price quotation and not a demand for payment. Prices are valid as listed above until formally confirmed.",
    50,
    760,
    { width: 495, align: "center" }
  );
  doc.end();
}

export function streamBillPdf(res, { tenant, settings, bill }) {
  const doc = startPdf(res, `Bill-${bill.billNumber}.pdf`);
  drawLetterhead(doc, tenant, settings, "BILL", bill.billNumber, bill.createdAt);
  const afterClient = drawClientBlock(doc, bill.client);
  const { y, payable } = drawItemsTable(doc, bill.items || [], bill.discountAmount, afterClient);
  const paid = (bill.payments || []).reduce((sum, p) => sum + Number(p.amount), 0);
  const balance = Math.max(0, payable - paid);

  let noteY = y + 10;
  doc.fontSize(9.5).font("Helvetica").fillColor(MUTED).text("Paid", 350, noteY, { width: 100 });
  doc.fillColor("#0f8f5f").text(money(paid), 450, noteY, { width: 95, align: "right" });
  noteY += 16;
  doc.fillColor(MUTED).text("Balance Due", 350, noteY, { width: 100 });
  doc.fillColor(balance > 0 ? "#c23b32" : DARK).text(money(balance), 450, noteY, { width: 95, align: "right" });

  doc.fontSize(8).fillColor(MUTED).text("Thank you for your business. Please retain this bill for your records.", 50, 760, {
    width: 495,
    align: "center",
  });
  doc.end();
}

export function streamReceiptPdf(res, { tenant, settings, payment, bill, balanceAfter }) {
  const doc = startPdf(res, `Receipt-${payment.receiptNumber}.pdf`);
  drawLetterhead(doc, tenant, settings, "RECEIPT", payment.receiptNumber, payment.createdAt);
  let y = drawClientBlock(doc, bill.client);

  doc.fontSize(9).font("Helvetica-Bold").fillColor(MUTED).text("AGAINST BILL", 320, 145);
  doc.fontSize(11).font("Helvetica-Bold").fillColor(DARK).text(`#${bill.billNumber}`, 320, 159);
  doc.rect(50, y, 495, 90).fill("#fafdfd");
  doc.fontSize(9.5).font("Helvetica").fillColor(MUTED).text("Amount Received", 70, y + 18);
  doc.fontSize(20).font("Helvetica-Bold").fillColor(ACCENT).text(money(payment.amount), 70, y + 34);
  doc.fontSize(9.5).font("Helvetica").fillColor(MUTED).text("Payment Method", 320, y + 18);
  doc.fontSize(12).font("Helvetica-Bold").fillColor(DARK).text(METHOD_LABELS[payment.method] || payment.method, 320, y + 34);
  y += 105;

  if (payment.remark) {
    doc.fontSize(9).font("Helvetica-Bold").fillColor(MUTED).text("REMARK", 50, y);
    doc.fontSize(9.5).font("Helvetica").fillColor(DARK).text(payment.remark, 50, y + 13, { width: 495 });
    y += 40;
  }

  doc.moveTo(50, y).lineTo(545, y).strokeColor("#d8e1e3").stroke();
  y += 12;
  doc.fontSize(9.5).font("Helvetica").fillColor(MUTED).text("Balance remaining on this bill after this payment", 50, y, { width: 350 });
  doc.font("Helvetica-Bold").fillColor(balanceAfter > 0 ? "#c23b32" : "#0f8f5f").text(money(balanceAfter), 400, y, {
    width: 145,
    align: "right",
  });

  doc.fontSize(8).fillColor(MUTED).text("This receipt is computer-generated and does not require a signature.", 50, 760, {
    width: 495,
    align: "center",
  });
  doc.end();
}
