import type { Handler } from '@netlify/functions';
import { createClient } from '@supabase/supabase-js';
import { withAdminAuth } from './_lib/with-admin-auth';
import { aggregateAnalytics, isPaidSale, resolveAnalyticsRange } from './_lib/analytics';

// Explicit pagination avoids Supabase's default row limit for lifetime reports.
async function readAll(query: () => any) {
  const rows: any[] = [];
  for (let offset = 0; ; offset += 500) {
    const { data, error } = await query().range(offset, offset + 499);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < 500) return rows;
  }
}

const baseHandler: Handler = async event => {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'Method not allowed' }) };
  try {
    const params = event.queryStringParameters || {};
    const range = resolveAnalyticsRange(params);
    const productId = params.product_id;
    if (productId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(productId)) throw new RangeError('Invalid product ID.');
    const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
    const [orders, products] = await Promise.all([
      readAll(() => {
        let query = db.from('orders').select('id,created_at,status,payment_status,archived,total_cents,total,discount_cents,shipping_cents,customer_email,buyer_email,fulfillment_method')
          .or('payment_status.eq.paid,status.in.(paid,packed,collected,out_for_delivery,delivered)')
          .or('archived.is.null,archived.eq.false').lt('created_at', range.to).order('created_at').order('id');
        if (range.from) query = query.gte('created_at', range.from);
        return query;
      }),
      readAll(() => db.from('products').select('id,name,is_active,status,stock_qty,cost_price_cents').order('id')),
    ]);
    const paid = orders.filter(isPaidSale);
    const items: any[] = [];
    for (let offset = 0; offset < paid.length; offset += 100) {
      items.push(...await readAll(() => {
        let query = db.from('order_items').select('id,order_id,product_id,bundle_id,product_name,name,sku,quantity,qty,unit_price_cents,unit_price,line_total_cents,line_total')
          .in('order_id', paid.slice(offset, offset + 100).map(order => order.id)).order('id');
        if (productId) query = query.eq('product_id', productId);
        return query;
      }));
    }
    const matchingOrders = productId ? new Set(items.map(item => item.order_id)) : null;
    const data = aggregateAnalytics(matchingOrders ? paid.filter(order => matchingOrders.has(order.id)) : paid, items, products, range);
    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, data }) };
  } catch (error) {
    console.error('Analytics request failed:', error instanceof Error ? error.message : error);
    return { statusCode: error instanceof RangeError ? 400 : 500, headers,
      body: JSON.stringify({ ok: false, error: error instanceof RangeError ? error.message : 'Unable to load analytics. Please try again.' }) };
  }
};

export const handler = withAdminAuth(baseHandler);
