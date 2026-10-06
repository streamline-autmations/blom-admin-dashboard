import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { requireAdminUser } from "./_lib/require-admin-user";
import { generateInvoiceDocument } from "./_lib/invoice-document";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (statusCode: number, data: unknown) => ({ statusCode, headers, body: JSON.stringify(data) });
const selectInvoice = "*,in_store_invoice_items(*)";
const pageSize = 5;
const itemTypes = new Set(["product", "bundle", "course"]);
const validPrice = (price: unknown) => (typeof price === 'number' || (typeof price === 'string' && !!price.trim()))
  && Number.isFinite(Number(price)) && Number(price) >= 0;
const searchLiteral = (value: string) => value.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
const catalogPage = 1000;

// PostgREST caps each response, so page through until a short page proves we have every row.
async function allRows(query: () => { range: (from: number, to: number) => PromiseLike<{ data: any[] | null; error: any }> }) {
  const rows: any[] = [];
  for (let from = 0; ; from += catalogPage) {
    const { data, error } = await query().range(from, from + catalogPage - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if ((data || []).length < catalogPage) return { data: rows, error: null };
  }
}

// BLOM's own account, printed on every manual invoice. A complete set of BLOM_BANK_*
// variables overrides it (account type is optional); a partial set is ignored so details
// from two different accounts can never be mixed on one invoice.
const blomBank = {
  bank_name: "FNB",
  account_holder: "Blom Cosmetics (Pty) Ltd",
  account_number: "631 5993 7417",
  account_type: "",
  branch_code: "250655",
};

function bankingDetails(): Record<string, string> {
  const details = {
    bank_name: process.env.BLOM_BANK_NAME?.trim(),
    account_holder: process.env.BLOM_BANK_ACCOUNT_HOLDER?.trim(),
    account_number: process.env.BLOM_BANK_ACCOUNT_NUMBER?.trim(),
    branch_code: process.env.BLOM_BANK_BRANCH_CODE?.trim(),
  };
  if (Object.values(details).every(value => value && value.length <= 160)) {
    return { ...details, account_type: (process.env.BLOM_BANK_ACCOUNT_TYPE || "").trim().slice(0, 160) } as Record<string, string>;
  }
  return { ...blomBank };
}

export const handler: Handler = async event => {
  if (!["GET", "POST", "DELETE"].includes(event.httpMethod)) return json(405, { error: "Method not allowed" });
  const auth = await requireAdminUser(event);
  if (auth.ok === false) return auth.response;
  const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const query = event.queryStringParameters || {};
    // Existing catalogs only. Bundles store cents; products/courses store Rand.
    // "catalog" returns every sellable item once so the browser can filter instantly;
    // "products" keeps the bounded server-side name search.
    if (event.httpMethod === "GET" && (query.action === "products" || query.action === "catalog")) {
      const full = query.action === "catalog";
      const search = (query.q || "").trim().slice(0, 100);
      if (!full && !search) return json(200, { data: [] });
      const pattern = `%${searchLiteral(search)}%`;
      const products = () => db.from("products").select("id,name,price").eq("is_active", true)
        .or("status.is.null,status.not.in.(archived,deleted)");
      const bundles = () => db.from("bundles").select("id,name,price_cents").eq("is_active", true)
        .or("status.is.null,status.not.in.(archived,deleted)");
      const courses = () => db.from("courses").select("id,title,price,packages").eq("is_active", true);
      const results = await Promise.all(full ? [
        allRows(() => products().order("name").order("id")),
        allRows(() => bundles().order("name").order("id")),
        allRows(() => courses().order("title").order("id")),
      ] : [
        products().ilike("name", pattern).order("name").limit(20),
        bundles().ilike("name", pattern).order("name").limit(20),
        courses().ilike("title", pattern).order("title").limit(20),
      ]);
      for (const result of results) if (result.error) throw result.error;
      const data = [
        ...(results[0].data || []).filter(product => validPrice(product.price)).map(product => ({ ...product, item_type: "product" })),
        ...(results[1].data || []).filter(bundle => validPrice(bundle.price_cents)).map(bundle => ({ id: bundle.id, name: bundle.name, price: Number(bundle.price_cents) / 100, item_type: "bundle" })),
        ...(results[2].data || []).flatMap(course => {
          if (Array.isArray(course.packages) && course.packages.length) {
            return course.packages.flatMap((pkg, index) => validPrice(pkg?.price) && typeof pkg?.name === "string" && pkg.name.trim()
              ? [{ id: course.id, name: `${course.title} — ${pkg.name}`, price: Number(pkg.price), item_type: "course", course_package_index: index }] : []);
          }
          return validPrice(course.price) ? [{ id: course.id, name: course.title, price: Number(course.price), item_type: "course" }] : [];
        }),
      ].sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { data });
    }

    // Items are removed by the ON DELETE CASCADE foreign key in the same statement.
    if (event.httpMethod === "DELETE") {
      if (!uuid.test(query.id || "")) return json(400, { error: "Invalid invoice ID" });
      const { data, error } = await db.from("in_store_invoices").delete().eq("id", query.id).select("id");
      if (error) throw error;
      if (!data?.length) return json(404, { error: "Invoice not found. It may already have been deleted." });
      return json(200, { deleted: query.id });
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
          || !itemTypes.has(item.item_type ?? "product")
          || (item.course_package_index != null && ((item.item_type ?? "product") !== "course"
            || !Number.isInteger(item.course_package_index) || item.course_package_index < 0 || item.course_package_index > 999))
          || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 9999
          || !Number.isSafeInteger(item.expected_price_cents) || item.expected_price_cents < 0)) {
        return json(400, { error: "Enter a customer name, valid contact details and product quantities (1–9999)." });
      }
      const bank = bankingDetails();
      const { data, error } = await db.rpc("create_in_store_invoice", {
        p_request_id: request_id, p_created_by: auth.userId,
        p_customer_name: customer_name.trim(), p_customer_phone: customer_phone.trim(),
        p_customer_email: customer_email.trim(),
        p_items: items.map(item => ({ product_id: item.product_id, item_type: item.item_type ?? "product",
          course_package_index: item.course_package_index ?? null, quantity: item.quantity, expected_price_cents: item.expected_price_cents })),
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
    let historyQuery = db.from("in_store_invoices")
      // Full rows (5 per page) so opening a saved invoice can render from this list instantly.
      .select(selectInvoice, { count: "exact" })
      .order("created_at", { ascending: false }).order("id");
    const historySearch = (query.q || "").trim().slice(0, 100);
    if (historySearch) {
      const pattern = `"%${searchLiteral(historySearch).replace(/"/g, '\\"')}%"`;
      historyQuery = historyQuery.or(`invoice_number.ilike.${pattern},customer_name.ilike.${pattern}`);
    }
    const { data, error, count } = await historyQuery.range((page - 1) * pageSize, page * pageSize - 1);
    if (error) throw error;
    for (const record of data || []) record.in_store_invoice_items?.sort((a, b) => a.position - b.position);
    return json(200, { data, count, page_size: pageSize, banking_configured: bankingDetails().is_placeholder !== "true" });
  } catch (error) {
    console.error("In-store invoice request failed:", error instanceof Error ? error.message : error);
    return json(500, { error: "Unable to load or save this invoice. Please try again. If this continues, check the invoice migration and server configuration." });
  }
};
