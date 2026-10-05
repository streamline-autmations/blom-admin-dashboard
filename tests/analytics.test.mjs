import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const dir = await mkdtemp(join(tmpdir(), 'blom-analytics-tests-'));
after(() => rm(dir, { recursive: true, force: true }));
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
const plugins = [{ name: 'test-db', setup(builder) {
  builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }));
  builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const createClient = () => globalThis.analyticsTestDb;', loader: 'js' }));
} }];
async function load(entry, filename) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', plugins });
  const file = join(dir, filename);
  await writeFile(file, result.outputFiles[0].contents);
  return import(pathToFileURL(file).href);
}
const { aggregateAnalytics, resolveAnalyticsRange, isPaidSale, amountCents } = await load('netlify/functions/_lib/analytics.ts', 'logic.mjs');
const { handler } = await load('netlify/functions/admin-analytics-advanced.ts', 'handler.mjs');
const now = new Date('2026-10-05T12:00:00Z');
const range = resolveAnalyticsRange({ start_date: '2026-10-01', end_date: '2026-10-05' }, now);
const order = (id, extra = {}) => ({ id, created_at: '2026-10-03T10:00:00+00:00', payment_status: 'paid', status: 'paid', total_cents: 10000, total: 80, fulfillment_method: 'delivery', ...extra });
const item = (orderId, extra = {}) => ({ id: `item-${orderId}`, order_id: orderId, product_id: 'p1', name: 'Saved product name', quantity: 2, line_total_cents: 8000, ...extra });

test('presets use Johannesburg calendar boundaries, including UTC date rollover', () => {
  const today = resolveAnalyticsRange({ period: 'today' }, new Date('2026-10-04T22:30:00Z'));
  assert.equal(today.from, '2026-10-04T22:00:00.000Z');
  assert.equal(today.to, '2026-10-05T22:00:00.000Z');
  assert.equal(resolveAnalyticsRange({ period: 'month' }, now).start, '2026-10-01');
  assert.equal(resolveAnalyticsRange({ period: '30' }, now).start, '2026-09-06');
  assert.equal(resolveAnalyticsRange({ period: 'lifetime' }, now).from, null);
  assert.equal(resolveAnalyticsRange({ period: '1' }, now).label, 'Today');
});

test('custom end dates are inclusive, and invalid or reversed dates are rejected', () => {
  assert.equal(range.from, '2026-09-30T22:00:00.000Z');
  assert.equal(range.to, '2026-10-05T22:00:00.000Z');
  assert.equal(range.days, 5);
  for (const params of [{ start_date: '2026-02-30', end_date: '2026-03-01' }, { start_date: '2026-10-06', end_date: '2026-10-05' }, { start_date: '2026-10-01' }, { period: 'NaN' }, { period: '-1' }, { period: '99999' }]) assert.throws(() => resolveAnalyticsRange(params, now), RangeError);
});

test('counts only paid, non-cancelled, non-refunded and non-archived sales', () => {
  const orders = [order('paid'), order('unpaid', { payment_status: 'unpaid', status: 'packed' }), order('refund', { payment_status: 'refunded' }), order('cancel', { status: 'cancelled' }), order('archive', { archived: true }), order('legacy', { payment_status: null, status: 'collected' })];
  assert.equal(orders.filter(isPaidSale).length, 2);
  const result = aggregateAnalytics(orders, orders.map(o => item(o.id)), [], range);
  assert.equal(result.summary.totalOrders, 2);
  assert.equal(result.summary.itemsSold, 4);
  assert.equal(result.summary.totalRevenueCents, 20000);
});

test('aggregates all items, distinct product orders, snapshots, bundles and customer emails', () => {
  const orders = [order('a', { customer_email: ' Jane@Example.com ', discount_cents: 200, shipping_cents: 1000 }), order('b', { buyer_email: 'jane@example.com', fulfillment_method: 'pickup', total_cents: null, total: 200 }), order('c', { fulfillment_method: 'digital', total_cents: 0, total: 50 })];
  const items = [item('a'), item('a', { id: 'variant', quantity: 3, line_total_cents: 12000 }), item('b', { product_id: null, bundle_id: 'b1', name: 'Saved bundle', quantity: 1, line_total_cents: 15000 }), item('c', { product_id: null, product_name: 'Saved course', name: null, quantity: null, qty: 1, line_total_cents: 0 })];
  const result = aggregateAnalytics(orders, items, [{ id: 'p1', name: 'Changed name' }], range);
  assert.equal(result.summary.itemsSold, 7);
  assert.equal(result.summary.totalRevenueCents, 30000);
  assert.equal(result.summary.avgOrderValue, 10000);
  assert.equal(result.summary.avgItemsPerOrder, 7 / 3);
  assert.equal(result.customers.totalCustomers, 1);
  assert.equal(result.customers.repeatCustomers, 1);
  assert.equal(result.customers.repeatCustomerRate, 100);
  assert.equal(result.allTopProducts[0].name, 'Saved product name');
  assert.equal(result.allTopProducts[0].totalOrders, 1);
  assert.equal(result.allTopProducts[0].totalUnitsSold, 5);
  assert.equal(result.fulfillment.other.count, 1);
  assert.equal(result.summary.totalDiscountCents, 200);
  assert.equal(result.summary.shippingRevenueCents, 1000);
  assert.equal(amountCents(0, 100), 0);
});

test('applies both date bounds and sums lifetime trend buckets without losing zero days', () => {
  const orders = [order('before', { created_at: '2026-09-30T21:59:59Z' }), order('start', { created_at: range.from }), order('end', { created_at: '2026-10-05T21:59:59Z' }), order('after', { created_at: '2026-10-05T22:00:00+00:00' })];
  const result = aggregateAnalytics(orders, orders.map(o => item(o.id)), [], range);
  assert.equal(result.summary.totalOrders, 2);
  assert.equal(result.trends.length, 5);
  assert.equal(result.trends[1].revenueCents, 0);
  const lifetime = aggregateAnalytics([order('old', { created_at: '2025-01-01T10:00:00Z' }), order('new')], [item('old'), item('new')], [], resolveAnalyticsRange({ period: 'lifetime' }, now));
  assert.equal(lifetime.period.bucket, 'month');
  assert.equal(lifetime.trends.reduce((sum, point) => sum + point.revenueCents, 0), lifetime.summary.totalRevenueCents);
  assert.equal(lifetime.trends.reduce((sum, point) => sum + point.itemsSold, 0), 4);
});

test('empty reports are finite and inventory is a current active-product snapshot', () => {
  const result = aggregateAnalytics([], [], [
    { is_active: true, status: 'active', stock_qty: 3, cost_price_cents: 200 },
    { is_active: true, status: 'active', stock_qty: 0, cost_price_cents: 100 },
    { is_active: false, status: 'archived', stock_qty: 10, cost_price_cents: 100 },
    { is_active: true, status: 'active', stock_qty: null },
  ], range);
  assert.equal(result.inventory.totalInventoryValue, 600);
  assert.equal(result.inventory.lowStockProducts, 1);
  assert.equal(result.inventory.outOfStockProducts, 1);
  assert.equal(result.summary.avgOrderValue, 0);
  assert.equal(result.customers.repeatCustomerRate, 0);
});

function mockDb({ role = 'staff', orders = [], items = [], fail = null } = {}) {
  const calls = [];
  globalThis.analyticsTestDb = {
    auth: { getUser: async () => ({ data: { user: { id: 'staff-id' } }, error: null }) },
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      const query = {
        select(value) { call.select = value; return query; },
        eq(...args) { call.filters.push(['eq', ...args]); return query; },
        or(...args) { call.filters.push(['or', ...args]); return query; },
        order(...args) { call.filters.push(['order', ...args]); return query; },
        lt(...args) { call.filters.push(['lt', ...args]); return query; },
        gte(...args) { call.filters.push(['gte', ...args]); return query; },
        in(...args) { call.filters.push(['in', ...args]); return query; },
        range(...args) { call.range = args; return query; },
        maybeSingle: async () => ({ data: { app_role: role }, error: null }),
        then(resolve, reject) {
          let rows = table === 'orders' ? orders : table === 'order_items' ? items : [];
          for (const [method, field, value] of call.filters) {
            if (method === 'in') rows = rows.filter(row => value.includes(row[field]));
            if (method === 'eq') rows = rows.filter(row => row[field] === value);
          }
          rows = rows.slice(call.range?.[0] || 0, (call.range?.[1] ?? 499) + 1);
          return Promise.resolve({ data: rows, error: fail && table === fail ? { message: 'Synthetic database error' } : null }).then(resolve, reject);
        },
      };
      return query;
    },
  };
  return calls;
}
const event = params => ({ httpMethod: 'GET', headers: { authorization: 'Bearer test-session' }, queryStringParameters: params });

test('endpoint requires staff authentication and validates dates and methods', async () => {
  let calls = mockDb();
  assert.equal((await handler({ ...event({}), headers: {} })).statusCode, 401);
  assert.equal(calls.length, 0);
  mockDb({ role: 'customer' });
  assert.equal((await handler(event({}))).statusCode, 403);
  calls = mockDb();
  assert.equal((await handler(event({ start_date: 'bad', end_date: 'bad' }))).statusCode, 400);
  assert.equal((await handler({ ...event({}), httpMethod: 'POST' })).statusCode, 405);
  assert.ok(calls.every(call => call.table === 'profiles'));
});

test('endpoint paginates orders and items beyond 1000 rows and passes both bounds', async () => {
  const orders = Array.from({ length: 1001 }, (_, i) => order(`order-${i}`));
  const items = [...orders.map(o => item(o.id)), ...Array.from({ length: 2001 }, (_, i) => item('order-0', { id: `extra-${i}` }))];
  const calls = mockDb({ orders, items });
  const response = await handler(event({ start_date: '2026-10-01', end_date: '2026-10-05' }));
  assert.equal(response.statusCode, 200);
  const result = JSON.parse(response.body).data;
  assert.equal(result.summary.totalOrders, 1001);
  assert.equal(result.summary.itemsSold, 6004);
  assert.equal(result.summary.totalRevenueCents, 10010000);
  assert.ok(calls.some(call => call.table === 'orders' && call.range[0] === 1000));
  assert.ok(calls.some(call => call.table === 'order_items' && call.range[0] >= 1000));
  const query = calls.find(call => call.table === 'orders');
  assert.deepEqual(query.filters.find(f => f[0] === 'gte'), ['gte', 'created_at', range.from]);
  assert.deepEqual(query.filters.find(f => f[0] === 'lt'), ['lt', 'created_at', range.to]);
  assert.ok(calls.every(call => ['profiles', 'products', 'orders', 'order_items'].includes(call.table)));
});

test('database errors are reported instead of presenting a false zero-sales report', async () => {
  mockDb({ fail: 'orders' });
  const response = await handler(event({ period: 'lifetime' }));
  assert.equal(response.statusCode, 500);
  assert.equal(JSON.parse(response.body).ok, false);
  assert.equal(JSON.parse(response.body).data, undefined);
});
