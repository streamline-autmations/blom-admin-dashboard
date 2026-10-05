// Calendar ranges use BLOM's South African business day, not the server timezone.
const DAY = 86400000;
export const businessDate = (date: Date) => new Date(date.getTime() + 2 * 3600000).toISOString().slice(0, 10);
const midnight = (date: string) => new Date(`${date}T00:00:00+02:00`);
const nextDay = (date: string) => new Date(midnight(date).getTime() + DAY);

export function resolveAnalyticsRange(params: Record<string, string | undefined>, now = new Date()) {
  const today = businessDate(now);
  const period = params.period || '30';
  const start = params.start_date;
  const end = params.end_date;
  const validDate = (value: string) => /^20\d{2}-\d{2}-\d{2}$/.test(value)
    && !Number.isNaN(midnight(value).getTime()) && businessDate(midnight(value)) === value;
  if (start || end) {
    if (!start || !end || !validDate(start) || !validDate(end) || start > end) {
      throw new RangeError('Choose valid start and end dates, with the start on or before the end.');
    }
    return { from: midnight(start).toISOString(), to: nextDay(end).toISOString(), start, end, label: `${start} to ${end}`, days: Math.round((nextDay(end).getTime() - midnight(start).getTime()) / DAY) };
  }
  let first = today;
  let label = 'Today';
  if (period === 'lifetime') return { from: null, to: nextDay(today).toISOString(), start: null, end: today, label: 'Lifetime', days: null };
  if (period === 'month') { first = `${today.slice(0, 7)}-01`; label = 'This month'; }
  else if (period !== 'today') {
    if (!/^\d+$/.test(period) || Number(period) < 1 || Number(period) > 3660) throw new RangeError('Choose a supported date range.');
    const days = Number(period);
    first = businessDate(new Date(midnight(today).getTime() - (days - 1) * DAY));
    label = days === 1 ? 'Today' : `Last ${days} days`;
  }
  return { from: midnight(first).toISOString(), to: nextDay(today).toISOString(), start: first, end: today, label, days: Math.round((nextDay(today).getTime() - midnight(first).getTime()) / DAY) };
}

const number = (value: unknown) => Number.isFinite(Number(value)) ? Number(value) : 0;
// Explicit zero is valid; don't substitute the Rand column for a zero-cent price.
export const amountCents = (cents: unknown, rands: unknown) => cents != null ? number(cents) : Math.round(number(rands) * 100);
const paidStatuses = new Set(['paid', 'packed', 'collected', 'out_for_delivery', 'delivered']);
export function isPaidSale(order: any) {
  const payment = String(order.payment_status || '').toLowerCase();
  return !order.archived && !['cancelled', 'canceled', 'refunded'].includes(String(order.status).toLowerCase())
    && (payment === 'paid' || (!payment && paidStatuses.has(order.status)));
}

export function aggregateAnalytics(orders: any[], items: any[], products: any[], range: ReturnType<typeof resolveAnalyticsRange>) {
  const inRange = (order: any) => isPaidSale(order) && new Date(order.created_at).getTime() < new Date(range.to).getTime()
    && (!range.from || new Date(order.created_at).getTime() >= new Date(range.from).getTime());
  const sales = orders.filter(inRange);
  const orderMap = new Map(sales.map(order => [order.id, order]));
  const catalog = new Map(products.map(product => [product.id, product]));
  const customers = new Map<string, number>();
  const top = new Map<string, any>();
  const fulfillment: Record<string, any> = Object.fromEntries(['delivery', 'collection', 'other'].map(method => [method, { count: 0, revenueCents: 0 }]));
  const summary = { totalRevenueCents: 0, totalOrders: sales.length, itemsSold: 0, avgOrderValue: 0, avgItemsPerOrder: 0, totalDiscountCents: 0, shippingRevenueCents: 0 };
  const firstDate = range.start || (sales.length ? businessDate(new Date(sales.reduce((first, order) => order.created_at < first ? order.created_at : first, sales[0].created_at))) : range.end);
  const bucket = (Math.round((nextDay(range.end).getTime() - midnight(firstDate).getTime()) / DAY) > 90) ? 'month' : 'day';
  const trends = new Map<string, { date: string; revenueCents: number; orders: number; itemsSold: number }>();
  const keyFor = (date: string) => bucket === 'month' ? `${date.slice(0, 7)}-01` : date;
  let cursor = bucket === 'month' ? `${firstDate.slice(0, 7)}-01` : firstDate;
  while (cursor <= range.end) {
    trends.set(cursor, { date: cursor, revenueCents: 0, orders: 0, itemsSold: 0 });
    cursor = bucket === 'month' ? new Date(Date.UTC(Number(cursor.slice(0, 4)), Number(cursor.slice(5, 7)), 1)).toISOString().slice(0, 10) : businessDate(nextDay(cursor));
  }
  for (const order of sales) {
    const revenue = amountCents(order.total_cents, order.total);
    summary.totalRevenueCents += revenue;
    summary.totalDiscountCents += number(order.discount_cents);
    summary.shippingRevenueCents += number(order.shipping_cents);
    const email = String(order.customer_email || order.buyer_email || '').trim().toLowerCase();
    if (email) customers.set(email, (customers.get(email) || 0) + 1);
    const method = String(order.fulfillment_method || '').toLowerCase();
    const group = /delivery|courier/.test(method) ? 'delivery' : /collection|pickup|collect/.test(method) ? 'collection' : 'other';
    fulfillment[group].count++;
    fulfillment[group].revenueCents += revenue;
    const point = trends.get(keyFor(businessDate(new Date(order.created_at))));
    if (point) { point.revenueCents += revenue; point.orders++; }
  }
  for (const item of items) {
    const order = orderMap.get(item.order_id);
    if (!order) continue;
    const qty = number(item.quantity ?? item.qty);
    if (qty <= 0) continue;
    summary.itemsSold += qty;
    const point = trends.get(keyFor(businessDate(new Date(order.created_at))));
    if (point) point.itemsSold += qty;
    const name = item.product_name || item.name || catalog.get(item.product_id)?.name || 'Unnamed item';
    const key = item.product_id ? `product:${item.product_id}` : item.bundle_id ? `bundle:${item.bundle_id}` : `item:${item.sku || name}`;
    if (!top.has(key)) top.set(key, { id: item.product_id || item.bundle_id || key, key, name, isBundle: !!item.bundle_id && !item.product_id, totalUnitsSold: 0, totalRevenueCents: 0, orderIds: new Set() });
    const product = top.get(key);
    product.totalUnitsSold += qty;
    product.totalRevenueCents += item.line_total_cents != null || item.line_total != null
      ? amountCents(item.line_total_cents, item.line_total) : amountCents(item.unit_price_cents, item.unit_price) * qty;
    product.orderIds.add(order.id);
  }
  summary.avgOrderValue = sales.length ? summary.totalRevenueCents / sales.length : 0;
  summary.avgItemsPerOrder = sales.length ? summary.itemsSold / sales.length : 0;
  const repeats = [...customers.values()].filter(count => count > 1).length;
  const allTopProducts = [...top.values()].map(({ orderIds, ...product }) => ({ ...product, totalOrders: orderIds.size }))
    .sort((a, b) => b.totalUnitsSold - a.totalUnitsSold || b.totalRevenueCents - a.totalRevenueCents || a.name.localeCompare(b.name)).slice(0, 10);
  const active = products.filter(product => product.is_active === true && !['archived', 'deleted'].includes(product.status));
  return {
    period: { ...range, bucket }, summary, topProducts: allTopProducts.slice(0, 3), allTopProducts,
    customers: { totalCustomers: customers.size, repeatCustomers: repeats, repeatCustomerRate: customers.size ? repeats / customers.size * 100 : 0 },
    fulfillment, trends: [...trends.values()],
    inventory: { totalProducts: products.length, activeProducts: active.length, lowStockProducts: active.filter(p => p.stock_qty != null && number(p.stock_qty) > 0 && number(p.stock_qty) < 5).length,
      outOfStockProducts: active.filter(p => p.stock_qty != null && number(p.stock_qty) === 0).length,
      totalInventoryValue: active.reduce((total, product) => total + number(product.stock_qty) * number(product.cost_price_cents), 0) },
  };
}
