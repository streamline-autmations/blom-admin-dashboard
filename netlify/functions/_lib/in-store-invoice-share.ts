import { createHmac, timingSafeEqual } from "crypto";
import { generateInvoiceDocument } from "./invoice-document";

// Customer links to an in-store invoice PDF (sent on WhatsApp or by email) are signed with a
// server secret instead of being stored, so no migration is needed. Deleting the invoice kills
// its link; rotating INVOICE_SHARE_SECRET kills every link ever sent.
const linkPrefix = "/invoice";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function secret() {
  const value = process.env.INVOICE_SHARE_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!value) throw new Error("Invoice share secret is not configured");
  return value;
}

// 128 bits of HMAC-SHA256, base64url: short enough for a chat message, far too long to guess.
export function invoiceShareSignature(id: string) {
  return createHmac("sha256", secret()).update(`in-store-invoice:${id.toLowerCase()}`).digest("base64url").slice(0, 22);
}

export function invoiceSharePath(id: string) {
  return `${linkPrefix}/${id.toLowerCase()}/${invoiceShareSignature(id)}`;
}

export function verifyInvoiceShare(id: unknown, signature: unknown) {
  if (typeof id !== "string" || !uuid.test(id) || typeof signature !== "string") return false;
  const expected = Buffer.from(invoiceShareSignature(id));
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function renderInStoreInvoicePdf(invoice: any) {
  return generateInvoiceDocument({ ...invoice, shipping_cents: Math.round(Number(invoice.shipping || 0) * 100) },
    invoice.in_store_invoice_items.map((item: any) => ({ ...item, name: item.product_name })),
    invoice.invoice_number, null, invoice.banking_details);
}
