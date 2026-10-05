import type { Handler } from "@netlify/functions";
import { createClient } from "@supabase/supabase-js";
import { withAdminAuth } from "./_lib/with-admin-auth";
const s = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const baseHandler: Handler = async (e) => {
  try {
    // Handle PATCH request for order status updates and archiving
    if (e.httpMethod === 'PATCH') {
      const body = JSON.parse(e.body || '{}');
      const { id, status, archived } = body;

      if (!id) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing order id" }) };
      }

      // Handle archiving
      if (archived !== undefined) {
        console.log('📦 Archiving order:', { id, archived });

        const { data: updatedOrder, error: archiveError } = await s
          .from("orders")
          .update({ 
            archived: archived,
            updated_at: new Date().toISOString()
          })
          .eq("id", id)
          .select()
          .single();

        if (archiveError) {
          throw new Error(`Failed to archive order: ${archiveError.message}`);
        }

        console.log(`✅ Order ${id} ${archived ? 'archived' : 'unarchived'} successfully`);

        return {
          statusCode: 200,
          headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
          body: JSON.stringify({ 
            ok: true, 
            order: updatedOrder,
            archived: archived
          })
        };
      }

      // Handle status updates (existing logic)
      if (!status) {
        return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing status" }) };
      }

      console.log('🔄 Updating order status:', { id, status });

      // Get current order status
      const { data: currentOrder, error: fetchError } = await s
        .from("orders")
        .select('status, paid_at, m_payment_id, invoice_url, order_kind, payment_status')
        .eq("id", id)
        .single();

      if (fetchError) {
        throw new Error(`Failed to fetch current order: ${fetchError.message}`);
      }

      const oldStatus = currentOrder?.status;
      console.log(`📊 Order ${id} status change: ${oldStatus} → ${status}`);

      // Prepare update data
      const updateData: any = {
        status,
        updated_at: new Date().toISOString()
      };

      // Set timestamps based on status
      if (status === 'paid' && oldStatus !== 'paid') {
        updateData.paid_at = new Date().toISOString();
        console.log('💰 Order marked as paid - will trigger stock deduction');
      }
      if (status === 'packed') {
        updateData.order_packed_at = new Date().toISOString();
      }
      if (status === 'out_for_delivery') {
        updateData.order_out_for_delivery_at = new Date().toISOString();
      }
      if (status === 'collected') {
        updateData.order_collected_at = new Date().toISOString();
        updateData.fulfilled_at = new Date().toISOString();
      }
      if (status === 'delivered') {
        updateData.order_delivered_at = new Date().toISOString();
        updateData.fulfilled_at = new Date().toISOString();
      }

      // Update the order
      const { data: updatedOrder, error: updateError } = await s
        .from("orders")
        .update(updateData)
        .eq("id", id)
        .select()
        .single();

      if (updateError) {
        throw new Error(`Failed to update order: ${updateError.message}`);
      }

      let invoiceGenerated = false;
      let invoiceUrl: string | null = null;
      let invoiceError: string | null = null;

      const shouldGenerateInvoice =
        status === 'paid' &&
        oldStatus !== 'paid' &&
        !currentOrder?.invoice_url &&
        currentOrder?.m_payment_id;

      if (shouldGenerateInvoice) {
        try {
          const base = process.env.URL || process.env.SITE_URL || 'https://blom-cosmetics.co.za';
          const fnUrl = `${base.replace(/\/$/, '')}/.netlify/functions/invoice-pdf`;
          const ac = new AbortController();
          const t = setTimeout(() => ac.abort(), 20000);
          try {
            const invRes = await fetch(fnUrl, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ m_payment_id: currentOrder.m_payment_id, order_id: id }),
              signal: ac.signal
            });
            if (!invRes.ok) {
              const detail = await invRes.text().catch(() => '');
              invoiceError = `invoice-pdf failed: ${invRes.status} ${detail}`;
            } else {
              invoiceGenerated = true;
              const { data: invRow } = await s
                .from("orders")
                .select("invoice_url")
                .eq("id", id)
                .maybeSingle();
              invoiceUrl = invRow?.invoice_url || null;
            }
          } finally {
            clearTimeout(t);
          }
        } catch (err: any) {
          invoiceError = err?.message || String(err);
        }
      }

      console.log('✅ Order status updated successfully');

      return {
        statusCode: 200,
        headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
        body: JSON.stringify({ 
          ok: true, 
          order: updatedOrder,
          statusChanged: oldStatus !== status,
          webhookCalled: false,
          webhookOk: false,
          invoiceGenerated,
          invoiceUrl,
          invoiceError
        })
      };
    }

    // Handle GET request for fetching order details
    const id = new URL(e.rawUrl).searchParams.get("id");
    if (!id) {
      return { statusCode: 400, body: JSON.stringify({ ok: false, error: "Missing id" }) };
    }

    // 1. Get Order with specific columns - include all pricing fields and invoice URL
    const { data: order, error: oErr } = await s.from("orders")
      .select(`
        *,
        shipping_address,
        fulfillment_type,
        buyer_name, buyer_email, buyer_phone,
        customer_name, customer_email, customer_phone,
        total_cents, subtotal_cents, shipping_cents, discount_cents,
        total, subtotal, shipping, discount,
        invoice_url
      `)
      .eq("id", id).single();

    if (oErr) throw oErr;

    // 2. Get Items with correct column names - include variant information
    const { data: items, error: iErr } = await s.from("order_items")
      .select(`
        name, product_name, quantity, 
        unit_price_cents, line_total_cents, 
        price, unit_price, line_total,
        variant, sku, product_id, variant_index, customization
      `)
      .eq("order_id", id)
      .order("name", { ascending: true });

    if (iErr) throw iErr;

    const safeParseJson = (value: any) => {
      if (value == null) return null;
      if (typeof value === "object") return value;
      if (typeof value !== "string") return null;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    };

    const toNumberLoose = (value: any) => {
      if (value === undefined || value === null) return Number.NaN;
      if (typeof value === "number") return value;
      if (typeof value !== "string") return Number.NaN;
      const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim();
      if (!cleaned) return Number.NaN;
      const n = Number(cleaned);
      return Number.isFinite(n) ? n : Number.NaN;
    };

    const asCents = (value: any) => {
      if (value === undefined || value === null || value === "") return null;
      const n = typeof value === "string" ? toNumberLoose(value) : Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.round(n);
    };

    const asRandsToCents = (value: any) => {
      if (value === undefined || value === null || value === "") return null;
      const n = typeof value === "string" ? toNumberLoose(value) : Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.round(n * 100);
    };

    let enrichedItems = (items || []).map((it: any) => {
      const qty = Number(it.quantity ?? 0) || 0;
      // A stored unit_price_cents of 0 means "not populated" (create-order.ts only
      // writes the Rands column), not "this item is free" — a real free item would
      // also have unit_price 0/null and fall through to the same 0 result anyway.
      const unitCentsRaw = asCents(it.unit_price_cents);
      const unitCents =
        (unitCentsRaw && unitCentsRaw > 0 ? unitCentsRaw : null) ??
        asRandsToCents(it.unit_price) ??
        asRandsToCents(it.price) ??
        null;
      const lineCentsRaw = asCents(it.line_total_cents);
      const lineCents =
        (lineCentsRaw && lineCentsRaw > 0 ? lineCentsRaw : null) ??
        asRandsToCents(it.line_total) ??
        (unitCents != null ? unitCents * qty : null);

      return {
        ...it,
        quantity: qty,
        unit_price_cents: unitCents,
        line_total_cents: lineCents,
      };
    });

    if (enrichedItems.length === 1) {
      const only = enrichedItems[0];
      const orderSubtotalCents = asCents(order?.subtotal_cents) ?? asRandsToCents(order?.subtotal) ?? null;
      const qty = Number(only.quantity ?? 0) || 1;
      const unitMissing = only.unit_price_cents == null || Number(only.unit_price_cents) <= 0;
      const lineMissing = only.line_total_cents == null || Number(only.line_total_cents) <= 0;
      const inconsistent = orderSubtotalCents != null && Number(only.line_total_cents || 0) !== orderSubtotalCents;
      if (orderSubtotalCents != null && (unitMissing || lineMissing || inconsistent) && (order?.order_kind === "course" || order?.order_kind == null)) {
        only.unit_price_cents = Math.round(orderSubtotalCents / qty);
        only.line_total_cents = orderSubtotalCents;
      }
    }

    const missingPriceProductIds = Array.from(
      new Set(
        enrichedItems
          .filter((it: any) => (it.unit_price_cents == null || it.unit_price_cents <= 0) && it.product_id)
          .map((it: any) => it.product_id)
      )
    );

    if (missingPriceProductIds.length) {
      const { data: products, error: pErr } = await s
        .from("products")
        .select("id, price_cents, price, variants")
        .in("id", missingPriceProductIds);
      if (!pErr && products?.length) {
        const byId = new Map(products.map((p: any) => [p.id, p]));
        enrichedItems = enrichedItems.map((it: any) => {
          if (it.unit_price_cents != null && it.unit_price_cents > 0) return it;
          const p = byId.get(it.product_id);
          if (!p) return it;

          let unitCents: number | null = null;
          const variants = safeParseJson(p.variants) || p.variants;
          if (variants && it.variant_index !== undefined && it.variant_index !== null && Array.isArray(variants)) {
            const v = variants[it.variant_index];
            unitCents =
              asCents(v?.price_cents) ??
              asCents(v?.priceCents) ??
              asRandsToCents(v?.price) ??
              null;
          }

          if (unitCents == null) {
            unitCents = asCents(p.price_cents) ?? asRandsToCents(p.price) ?? null;
          }

          if (unitCents == null) return it;
          const qty = Number(it.quantity ?? 0) || 0;
          return { ...it, unit_price_cents: unitCents, line_total_cents: unitCents * qty };
        });
      }
    }

    const paid = order?.status === "paid" || order?.payment_status === "paid" || order?.payment_status === "complete";
    if (paid && !order?.invoice_url && order?.m_payment_id) {
      try {
        const base = process.env.URL || process.env.SITE_URL || "https://blom-cosmetics.co.za";
        const fnUrl = `${base.replace(/\/$/, "")}/.netlify/functions/invoice-pdf?return_url=1`;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 20000);
        try {
          const invRes = await fetch(fnUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ m_payment_id: order.m_payment_id, order_id: order.id, return_url: true }),
            signal: ac.signal,
          });
          if (invRes.ok) {
            const data = await invRes.json().catch(() => null);
            if (data?.invoice_url) order.invoice_url = data.invoice_url;
          }
        } finally {
          clearTimeout(t);
        }
      } catch {}
    }

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: true, order, items: enrichedItems })
    };
  } catch (err:any) {
    console.error('❌ Order handler error:', err);
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
      body: JSON.stringify({ ok: false, error: err.message || String(err) })
    };
  }
};

export const handler = withAdminAuth(baseHandler);
