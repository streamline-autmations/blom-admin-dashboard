import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { requireAdminUser } from "./_lib/require-admin-user";
import { generateInvoiceDocument } from "./_lib/invoice-document";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const headers = { "Content-Type": "application/json", "Cache-Control": "no-store" };
const json = (statusCode: number, data: unknown) => ({ statusCode, headers, body: JSON.stringify(data) });
const selectInvoice = "*,in_store_invoice_items(*)";
const pageSize = 5;
const itemTypes = new Set(["product", "bundle", "course", "extra"]);
const validPrice = (price: unknown) => (typeof price === 'number' || (typeof price === 'string' && !!price.trim()))
  && Number.isFinite(Number(price)) && Number(price) >= 0;
const searchLiteral = (value: string) => value.replace(/\\/g, "\\\\").replace(/[%_]/g, "\\$&");
const catalogPage = 1000;
const tierSlug = /^[a-z0-9_]{2,40}$/;
// Items staff type in at the till (a Coke, a bottle of water) are saved as invoice-only items
// whose code starts with this prefix, so they can be told apart from the price-sheet extras.
const customPrefix = "CUSTOM-";
const maxCustomPriceCents = 100_000_00;
const maxShippingCents = 10_000_00;

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
      const tier = (query.tier || "").trim();
      if (tier && !tierSlug.test(tier)) return json(400, { error: "Invalid price list" });
      const search = (query.q || "").trim().slice(0, 100);
      if (!full && !search) return json(200, { data: [] });
      const pattern = `%${searchLiteral(search)}%`;
      const products = () => db.from("products").select("id,name,price").eq("is_active", true)
        .or("status.is.null,status.not.in.(archived,deleted)");
      const bundles = () => db.from("bundles").select("id,name,price_cents").eq("is_active", true)
        .or("status.is.null,status.not.in.(archived,deleted)");
      // Sheet-only reseller items that are not sold on the website.
      const extras = () => db.from("invoice_only_items").select("id,code,name,retail_price_cents").eq("is_active", true);
      const courses = () => db.from("courses").select("id,title,price,packages").eq("is_active", true);
      const results = await Promise.all(full ? [
        allRows(() => products().order("name").order("id")),
        allRows(() => bundles().order("name").order("id")),
        allRows(() => courses().order("title").order("id")),
        allRows(() => extras().order("name").order("id")),
      ] : [
        products().ilike("name", pattern).order("name").limit(20),
        bundles().ilike("name", pattern).order("name").limit(20),
        courses().ilike("title", pattern).order("title").limit(20),
        extras().ilike("name", pattern).order("name").limit(20),
      ]);
      for (const result of results) if (result.error) throw result.error;
      // Reseller price lists: active tiers for the picker, plus the chosen tier's explicit prices.
      const tiersResult = await db.from("price_tiers").select("slug,name").eq("is_active", true).order("sort_order");
      if (tiersResult.error) throw tiersResult.error;
      const tiers = tiersResult.data || [];
      const tierPrices = new Map<string, number>();
      if (tier) {
        if (!tiers.some(row => row.slug === tier)) return json(400, { error: "That price list is not available" });
        const priced = await allRows(() => db.from("tier_prices").select("item_type,item_id,price_cents")
          .eq("tier_slug", tier).order("item_type").order("item_id"));
        if (priced.error) throw priced.error;
        for (const row of priced.data || []) tierPrices.set(`${row.item_type}:${row.item_id}`, Number(row.price_cents) / 100);
      }
      // Items missing from the chosen list keep their retail price and are flagged for the UI.
      const applyTier = (item: any) => {
        if (!tier || item.item_type === "course" || item.is_custom) return item;
        const tierPrice = tierPrices.get(`${item.item_type}:${item.id}`);
        return tierPrice === undefined ? { ...item, tier_priced: false }
          : { ...item, retail_price: item.price, price: tierPrice, tier_priced: true };
      };
      const data = [
        ...(results[0].data || []).filter(product => validPrice(product.price)).map(product => ({ ...product, item_type: "product" })),
        ...(results[1].data || []).filter(bundle => validPrice(bundle.price_cents)).map(bundle => ({ id: bundle.id, name: bundle.name, price: Number(bundle.price_cents) / 100, item_type: "bundle" })),
        ...(results[3].data || []).filter(extra => validPrice(extra.retail_price_cents))
          .map(extra => ({ id: extra.id, name: extra.name, price: Number(extra.retail_price_cents) / 100, item_type: "extra",
            ...(String(extra.code).startsWith(customPrefix) ? { is_custom: true } : {}) })),
        ...(results[2].data || []).flatMap(course => {
          if (Array.isArray(course.packages) && course.packages.length) {
            return course.packages.flatMap((pkg, index) => validPrice(pkg?.price) && typeof pkg?.name === "string" && pkg.name.trim()
              ? [{ id: course.id, name: `${course.title} — ${pkg.name}`, price: Number(pkg.price), item_type: "course", course_package_index: index }] : []);
          }
          return validPrice(course.price) ? [{ id: course.id, name: course.title, price: Number(course.price), item_type: "course" }] : [];
        }),
      ].map(applyTier).sort((a, b) => a.name.localeCompare(b.name));
      return json(200, { data, tiers });
    }

    // Saved custom items are only hidden: old invoices keep their own name/price snapshots.
    if (event.httpMethod === "DELETE" && query.custom_item) {
      if (!uuid.test(query.custom_item)) return json(400, { error: "Invalid item ID" });
      const { data, error } = await db.from("invoice_only_items").update({ is_active: false })
        .eq("id", query.custom_item).like("code", `${customPrefix}%`).select("id");
      if (error) throw error;
      if (!data?.length) return json(404, { error: "Saved item not found. It may already have been removed." });
      return json(200, { removed: query.custom_item });
    }

    // Items are removed by the ON DELETE CASCADE foreign key in the same statement.
    if (event.httpMethod === "DELETE") {
      if (!uuid.test(query.id || "")) return json(400, { error: "Invalid invoice ID" });
      const { data, error } = await db.from("in_store_invoices").delete().eq("id", query.id).select("id");
      if (error) throw error;
      if (!data?.length) return json(404, { error: "Invoice not found. It may already have been deleted." });
      return json(200, { deleted: query.id });
    }

    // Create (or update the price of) a custom item. Saving a name that already exists updates
    // that item instead of adding a duplicate; passing `id` edits that exact item.
    if (event.httpMethod === "POST" && query.action === "custom-item") {
      let body: any;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return json(400, { error: "Invalid item" }); }
      const name = typeof body?.name === "string" ? body.name.trim().replace(/\s+/g, " ") : "";
      const priceCents = validPrice(body?.price) ? Math.round(Number(body.price) * 100) : NaN;
      if (!name || name.length > 160 || !Number.isSafeInteger(priceCents) || priceCents > maxCustomPriceCents
        || (body?.id != null && (typeof body.id !== "string" || !uuid.test(body.id)))) {
        return json(400, { error: "Enter an item name and a price between R0 and R100 000." });
      }
      const customItem = (row: any) => ({ id: row.id, name: row.name, price: Number(row.retail_price_cents) / 100, item_type: "extra", is_custom: true });
      let targetId: string | undefined = body?.id ?? undefined;
      if (!targetId) {
        // Compare in code: PostgREST pattern filters treat characters like * as wildcards, which
        // could let "Water*" match (and overwrite) "Water 500ml".
        const existing = await allRows(() => db.from("invoice_only_items").select("id,name").eq("is_active", true)
          .like("code", `${customPrefix}%`).order("id"));
        if (existing.error) throw existing.error;
        targetId = existing.data?.find(row => String(row.name).trim().toLowerCase() === name.toLowerCase())?.id;
      }
      const saved = targetId
        ? await db.from("invoice_only_items").update({ name, retail_price_cents: priceCents })
          .eq("id", targetId).eq("is_active", true).like("code", `${customPrefix}%`).select("id,name,retail_price_cents")
        : await db.from("invoice_only_items").insert({ code: `${customPrefix}${randomUUID().slice(0, 8).toUpperCase()}`,
          name, retail_price_cents: priceCents }).select("id,name,retail_price_cents");
      if (saved.error) throw saved.error;
      if (!saved.data?.length) return json(404, { error: "That saved item no longer exists. Search again." });
      return json(targetId ? 200 : 201, { item: customItem(saved.data[0]) });
    }

    let invoiceId = query.id;
    if (event.httpMethod === "POST") {
      let body;
      try { body = JSON.parse(event.body || "{}"); }
      catch { return json(400, { error: "Invalid invoice submission" }); }
      const { request_id, customer_name, customer_phone = "", customer_email = "", items, price_tier = null, shipping = null, shipping_label = null } = body || {};
      // Shipping / courier cost is optional: empty means none.
      const hasShipping = shipping !== null && shipping !== "" && shipping !== undefined;
      const shippingCents = hasShipping && validPrice(shipping) ? Math.round(Number(shipping) * 100) : hasShipping ? NaN : 0;
      if (typeof request_id !== "string" || !uuid.test(request_id)
        || typeof customer_name !== "string" || !customer_name.trim() || customer_name.trim().length > 160
        || typeof customer_phone !== "string" || customer_phone.length > 40
        || typeof customer_email !== "string" || customer_email.length > 254
        || !Number.isSafeInteger(shippingCents) || shippingCents < 0 || shippingCents > maxShippingCents
        || (shipping_label !== null && (typeof shipping_label !== "string" || shipping_label.trim().length > 60))
        || (price_tier !== null && (typeof price_tier !== "string" || !tierSlug.test(price_tier)))
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
      const { data, error } = await db.rpc("create_in_store_invoice_with_shipping", {
        p_request_id: request_id, p_created_by: auth.userId,
        p_customer_name: customer_name.trim(), p_customer_phone: customer_phone.trim(),
        p_customer_email: customer_email.trim(),
        p_items: items.map(item => ({ product_id: item.product_id, item_type: item.item_type ?? "product",
          course_package_index: item.course_package_index ?? null, quantity: item.quantity, expected_price_cents: item.expected_price_cents })),
        p_banking_details: bank, p_price_tier: price_tier,
        p_shipping_cents: shippingCents, p_shipping_label: shippingCents > 0 ? (shipping_label || "").trim() || null : null,
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
        const bytes = await generateInvoiceDocument({ ...invoice, shipping_cents: Math.round(Number(invoice.shipping || 0) * 100) },
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
