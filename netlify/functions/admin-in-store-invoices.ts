import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { requireAdminUser } from "./_lib/require-admin-user";
import { generateInvoiceDocument } from "./_lib/invoice-document";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (statusCode: number, data: unknown) => ({ statusCode, headers, body: JSON.stringify(data) });
const selectInvoice = "*,in_store_invoice_items(*)";

function bankingDetails() {
  const details = {
    bank_name: process.env.BLOM_BANK_NAME?.trim(),
    account_holder: process.env.BLOM_BANK_ACCOUNT_HOLDER?.trim(),
    account_number: process.env.BLOM_BANK_ACCOUNT_NUMBER?.trim(),
    account_type: process.env.BLOM_BANK_ACCOUNT_TYPE?.trim(),
    branch_code: process.env.BLOM_BANK_BRANCH_CODE?.trim(),
  };
  if (Object.values(details).every(value => value && value.length <= 160)) {
    return details as Record<string, string>;
  }
  // Temporary placeholders explicitly requested; never present guessed account numbers.
  return {
    bank_name: "To be confirmed", account_holder: "To be confirmed",
    account_number: "To be confirmed", account_type: "To be confirmed",
    branch_code: "To be confirmed", is_placeholder: "true",
  };
}

export const handler: Handler = async event => {
  if (!["GET", "POST"].includes(event.httpMethod)) return json(405, { error: "Method not allowed" });
  const auth = await requireAdminUser(event);
  if (auth.ok === false) return auth.response;
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const query = event.queryStringParameters || {};
    // Existing product table and Rand price contract; no parallel catalog or promotions.
    if (event.httpMethod === "GET" && query.action === "products") {
      const search = (query.q || "").trim().slice(0, 100);
      if (!search) return json(200, { data: [] });
      // Quote the PostgREST value and escape wildcard/filter syntax from user input.
      const literal = search.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[%_]/g, "\\$&");
      const pattern = `"%${literal}%"`;
      const { data, error } = await db.from("products").select("id,name,sku,price")
        .eq("is_active", true).or("status.is.null,status.not.in.(archived,deleted)")
        .or(`name.ilike.${pattern},sku.ilike.${pattern}`).order("name").limit(20);
      if (error) throw error;
      return json(200, { data: (data || []).filter(product =>
        product.price != null && Number.isFinite(Number(product.price)) && Number(product.price) >= 0
      ) });
    }

    let invoiceId = query.id;
    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return json(400, { error: "Invalid invoice submission" }); }
      const { request_id, customer_name, customer_phone = "", customer_email = "", items } = body || {};
      if (typeof request_id !== "string" || !uuid.test(request_id)
        || typeof customer_name !== "string" || !customer_name.trim() || customer_name.trim().length > 160
        || typeof customer_phone !== "string" || customer_phone.length > 40
        || typeof customer_email !== "string" || customer_email.length > 254
        || (customer_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(customer_email.trim()))
        || !Array.isArray(items) || items.length < 1 || items.length > 100
        || items.some(item => !item || !uuid.test(item.product_id || "")
          || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 9999
          || !Number.isSafeInteger(item.expected_price_cents) || item.expected_price_cents < 0)) {
        return json(400, { error: "Enter a customer name, valid contact details and product quantities (1–9999)." });
      }
      const bank = bankingDetails();
      const { data, error } = await db.rpc("create_in_store_invoice", {
        p_request_id: request_id, p_created_by: auth.userId,
        p_customer_name: customer_name.trim(), p_customer_phone: customer_phone.trim(),
        p_customer_email: customer_email.trim(),
        p_items: items.map(item => ({ product_id: item.product_id, quantity: item.quantity, expected_price_cents: item.expected_price_cents })),
        p_banking_details: bank,
      });
      if (error) {
        if (error.code === "P0001") return json(409, { error: error.message });
        if (["22023", "22P02", "22003"].includes(error.code)) return json(400, { error: error.message });
        throw error;
      }
      invoiceId = data;
    }

    if (invoiceId) {
      if (!uuid.test(invoiceId)) return json(400, { error: "Invalid invoice ID" });
      const { data: invoice, error } = await db.from("in_store_invoices").select(selectInvoice).eq("id", invoiceId).maybeSingle();
      if (error) throw error;
      if (!invoice) return json(404, { error: "Invoice not found" });
      invoice.in_store_invoice_items.sort((a, b) => a.position - b.position);
      if (event.httpMethod === "GET" && query.action === "pdf") {
        const bytes = await generateInvoiceDocument(invoice,
          invoice.in_store_invoice_items.map(item => ({ ...item, name: item.product_name })),
          invoice.invoice_number, null, invoice.banking_details);
        return {
          statusCode: 200,
          headers: {
            "Content-Type": "application/pdf", "Cache-Control": "no-store",
            "Content-Disposition": `inline; filename="${invoice.invoice_number}.pdf"`,
          },
          body: Buffer.from(bytes).toString("base64"), isBase64Encoded: true,
        };
      }
      return json(event.httpMethod === "POST" ? 201 : 200, { invoice });
    }

    const page = Math.max(1, Math.min(100000, Number.parseInt(query.page || "1", 10) || 1));
    const { data, error, count } = await db.from("in_store_invoices")
      .select("id,invoice_number,created_at,customer_name,total", { count: "exact" })
      .order("created_at", { ascending: false }).order("id")
      .range((page - 1) * 20, page * 20 - 1);
    if (error) throw error;
    return json(200, { data, count, banking_configured: bankingDetails().is_placeholder !== "true" });
  } catch (error) {
    console.error("In-store invoice request failed:", error instanceof Error ? error.message : error);
    return json(500, { error: "Unable to load or save this invoice. Please try again. If this continues, check the invoice migration and server configuration." });
  }
};
