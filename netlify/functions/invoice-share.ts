import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { renderInStoreInvoicePdf, verifyInvoiceShare } from "./_lib/in-store-invoice-share";

// Public, signed link to one in-store invoice PDF, sent to customers on WhatsApp or by email.
// Reached through the /invoice/:id/:sig redirect. No session: the signature is the access check.
const privateHeaders = { "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };
const notice = (statusCode: number, message: string) => ({
  statusCode,
  headers: { ...privateHeaders, "Content-Type": "text/html; charset=utf-8" },
  body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>BLOM Cosmetics invoice</title></head>`
    + `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;line-height:1.5"><h1 style="font-size:1.25rem">BLOM Cosmetics</h1><p>${message}</p>`
    + `<p>Questions? Contact us: shopblomcosmetics@gmail.com | +27 79 548 3317</p></body></html>`,
});

export const handler: Handler = async event => {
  if (event.httpMethod !== "GET" && event.httpMethod !== "HEAD") return notice(405, "This link only opens an invoice.");
  const { id, sig } = event.queryStringParameters || {};
  try {
    if (!verifyInvoiceShare(id, sig)) return notice(404, "This invoice link is not valid. Please ask us to send it again.");
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: invoice, error } = await db.from("in_store_invoices").select("*,in_store_invoice_items(*)").eq("id", id).maybeSingle();
    if (error) throw error;
    if (!invoice) return notice(404, "This invoice is no longer available. Please ask us to send it again.");
    invoice.in_store_invoice_items.sort((a: any, b: any) => a.position - b.position);
    const bytes = await renderInStoreInvoicePdf(invoice);
    return {
      statusCode: 200,
      headers: { ...privateHeaders, "Content-Type": "application/pdf", "Content-Disposition": `inline; filename="${invoice.invoice_number}.pdf"` },
      body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true,
    };
  } catch (failure) {
    console.error("Shared invoice request failed:", failure instanceof Error ? failure.message : failure);
    return notice(500, "We could not open this invoice right now. Please try again in a moment.");
  }
};
