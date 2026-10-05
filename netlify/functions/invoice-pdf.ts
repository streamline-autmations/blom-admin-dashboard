import fetch from "node-fetch"
import { generateInvoiceDocument } from "./_lib/invoice-document"
import { createClient } from "@supabase/supabase-js"

const SUPABASE_URL = process.env.SUPABASE_URL!
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!
const SITE = process.env.SITE_BASE_URL || process.env.PUBLIC_SITE_URL || "https://blom-cosmetics.co.za"
const BUCKET = "invoices"
function safeParseJson(value: any) {
  if (value == null) return null
  if (typeof value === "object") return value
  if (typeof value !== "string") return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function toNumberLoose(value: any): number {
  if (value === undefined || value === null) return Number.NaN
  if (typeof value === "number") return value
  if (typeof value !== "string") return Number.NaN
  const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim()
  if (!cleaned) return Number.NaN
  const n = Number(cleaned)
  return Number.isFinite(n) ? n : Number.NaN
}

export const handler = async (event: any) => {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) {
      return { statusCode: 500, body: "Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }
    }

    const contentType = event.headers['content-type'] || '';
    let body: any = {};

    if (event.httpMethod === 'GET') {
      body = {};
    } else if (contentType.includes('application/json')) {
      body = event.body ? JSON.parse(event.body) : {};
    } else if (contentType.includes('application/x-www-form-urlencoded')) {
      body = Object.fromEntries(new URLSearchParams(event.body || ''));
    } else {
      try { body = event.body ? JSON.parse(event.body) : {}; } catch { body = {}; }
    }

    const q = event.queryStringParameters || {};
    let m_payment_id = body.m_payment_id || q.m_payment_id || event.headers['x-m-payment-id'];
    const order_id = body.order_id || q.order_id || event.headers['x-order-id'];
    const returnUrlOnly = q.return_url === '1' || body.return_url === true;

    const supabase = createClient(SUPABASE_URL, SERVICE_KEY, {
      auth: { persistSession: false },
      global: { fetch: fetch as any }
    })

    if (!m_payment_id && order_id) {
      const { data: idRow, error: idErr } = await supabase
        .from("orders")
        .select("m_payment_id")
        .eq("id", order_id)
        .maybeSingle()
      if (!idErr && idRow?.m_payment_id) m_payment_id = idRow.m_payment_id
    }

    if (!m_payment_id) {
      return { statusCode: 400, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'ID required' }) };
    }

    const { data: order, error: orderErr } = await supabase
      .from("orders")
      .select("*")
      .eq("m_payment_id", m_payment_id)
      .maybeSingle()

    if (orderErr) return { statusCode: 500, body: orderErr.message }
    if (!order) return { statusCode: 404, body: "ORDER_NOT_FOUND" }

    const { data: rawItems, error: itemsErr } = await supabase
      .from("order_items")
      .select("*")
      .eq("order_id", order.id)

    if (itemsErr) return { statusCode: 500, body: itemsErr.message }
    const items = rawItems || []

    // For course orders, look up the instructor from course_purchases
    let courseInstructor: string | null = null
    if (order.order_kind === "course") {
      const { data: purchase } = await supabase
        .from("course_purchases")
        .select("instructor")
        .eq("order_id", order.id)
        .maybeSingle()
      courseInstructor = purchase?.instructor || null
    }

    const unitFromItem = (it: any) => {
      const cents = it.unit_price_cents != null ? toNumberLoose(it.unit_price_cents) : Number.NaN
      if (Number.isFinite(cents) && cents > 0) return cents / 100
      const unit = it.unit_price != null ? toNumberLoose(it.unit_price) : Number.NaN
      if (Number.isFinite(unit) && unit > 0) return unit
      const price = it.price != null ? toNumberLoose(it.price) : Number.NaN
      if (Number.isFinite(price) && price > 0) return price
      return null
    }

    const lineFromItem = (it: any) => {
      const cents = it.line_total_cents != null ? toNumberLoose(it.line_total_cents) : Number.NaN
      if (Number.isFinite(cents) && cents > 0) return cents / 100
      const line = it.line_total != null ? toNumberLoose(it.line_total) : Number.NaN
      if (Number.isFinite(line) && line > 0) return line
      return null
    }

    const missingPriceIds = Array.from(
      new Set(
        items
          .filter((it: any) => unitFromItem(it) == null && it.product_id)
          .map((it: any) => it.product_id)
      )
    )

    const productById = new Map<string, any>()
    if (missingPriceIds.length) {
      const { data: products, error: pErr } = await supabase
        .from("products")
        .select("id, price_cents, price, variants")
        .in("id", missingPriceIds)
      if (!pErr && products?.length) {
        products.forEach((p: any) => productById.set(p.id, p))
      }
    }

    const unitFromProduct = (it: any) => {
      if (!it.product_id) return null
      const p = productById.get(it.product_id)
      if (!p) return null
      const variants = safeParseJson(p.variants) || p.variants
      if (variants && it.variant_index !== undefined && it.variant_index !== null && Array.isArray(variants)) {
        const v = variants[it.variant_index]
        const cents = v?.price_cents != null ? toNumberLoose(v.price_cents) : Number.NaN
        if (Number.isFinite(cents) && cents > 0) return cents / 100
        const price = v?.price != null ? toNumberLoose(v.price) : Number.NaN
        if (Number.isFinite(price) && price > 0) return price
      }
      const cents = p.price_cents != null ? toNumberLoose(p.price_cents) : Number.NaN
      if (Number.isFinite(cents) && cents > 0) return cents / 100
      const price = p.price != null ? toNumberLoose(p.price) : Number.NaN
      if (Number.isFinite(price) && price > 0) return price
      return null
    }

    const normalizedItems = items.map((it: any) => {
      const qty = Number(it.quantity ?? it.qty ?? 0) || 0
      const unit = unitFromItem(it) ?? unitFromProduct(it) ?? 0
      const lineTotal = lineFromItem(it) ?? (unit * qty)

      return {
        name: it.name || it.product_name || it.sku || "-",
        variant: it.variant || it.variant_title || "",
        sku: it.sku || "",
        quantity: qty,
        unit_price: unit,
        line_total: lineTotal
      }
    })

    const pdfBytes = await generateInvoiceDocument(order, normalizedItems, m_payment_id, courseInstructor)
    const version = q.v || Date.now().toString()
    const filename = `${m_payment_id}-${version}.pdf`
    
    const uploadRes = await supabase.storage
      .from(BUCKET)
      .upload(filename, Buffer.from(pdfBytes), { upsert: true, contentType: "application/pdf" })

    if (uploadRes.error) return { statusCode: 500, body: uploadRes.error.message }

    const publicUrl = supabase.storage.from(BUCKET).getPublicUrl(filename).data.publicUrl

    const { error: upErr } = await supabase
      .from("orders")
      .update({ invoice_url: publicUrl })
      .eq("id", order.id)

    if (upErr) return { statusCode: 500, body: upErr.message }

    if (returnUrlOnly) {
      return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ok: true, invoice_url: publicUrl })
      }
    }

    const disposition = (q.download === '1' || body.download === true) ? 'attachment' : 'inline'
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': `${disposition}; filename="Invoice-${m_payment_id}.pdf"`,
        'Cache-Control': 'public, max-age=3600'
      },
      body: Buffer.from(pdfBytes).toString('base64'),
      isBase64Encoded: true
    }
  } catch (e: any) {
    return { statusCode: 500, body: e?.message ?? "Error" }
  }
}
