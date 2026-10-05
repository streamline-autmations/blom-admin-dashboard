import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';
import { build } from 'esbuild';
import { PDFDocument, PDFArray } from 'pdf-lib';

const dir = await mkdtemp(join(tmpdir(), 'blom-invoice-tests-'));
after(() => rm(dir, { recursive: true, force: true }));
process.env.SUPABASE_URL = 'https://example.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-only';
const bankVariables = ['BLOM_BANK_NAME', 'BLOM_BANK_ACCOUNT_HOLDER', 'BLOM_BANK_ACCOUNT_NUMBER', 'BLOM_BANK_ACCOUNT_TYPE', 'BLOM_BANK_BRANCH_CODE'];
bankVariables.forEach(key => { delete process.env[key]; });

const mockedServices = {
  name: 'isolated-services',
  setup(builder) {
    builder.onResolve({ filter: /^@supabase\/supabase-js$/ }, () => ({ path: 'db', namespace: 'test' }));
    builder.onResolve({ filter: /^node-fetch$/ }, () => ({ path: 'fetch', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, args => ({ contents: args.path === 'db'
      ? 'export const createClient = () => globalThis.invoiceTestDb;'
      : 'export default async function fetch() { return {ok:false}; }', loader: 'js' }));
  },
};
async function load(entry) {
  const result = await build({ entryPoints: [entry], bundle: true, write: false, platform: 'node', format: 'esm', plugins: [mockedServices] });
  const file = join(dir, `${entry.split('/').pop()}.mjs`);
  await writeFile(file, result.outputFiles[0].contents);
  return import(pathToFileURL(file).href);
}
const manual = await load('netlify/functions/admin-in-store-invoices.ts');
const online = await load('netlify/functions/invoice-pdf.ts');
const renderer = await load('netlify/functions/_lib/invoice-document.ts');
const id = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';
const bank = { bank_name: 'To be confirmed', account_holder: 'To be confirmed', account_number: 'To be confirmed', account_type: 'To be confirmed', branch_code: 'To be confirmed', is_placeholder: 'true' };
const invoice = {
  id, invoice_number: 'INV-20261005-001', created_at: '2026-10-05T08:00:00Z',
  customer_name: 'Jane Smith', customer_email: 'jane@example.com', customer_phone: '0820000000',
  subtotal: 250, total: 250, banking_details: bank,
  in_store_invoice_items: [{ position: 1, product_id: productId, product_name: 'Saved product name', quantity: 2, unit_price: 125, line_total: 250 }],
};

function mockDb({ role = 'staff', responses = {}, rpcResult = { data: id, error: null } } = {}) {
  const calls = [];
  globalThis.invoiceTestDb = {
    auth: { getUser: async () => ({ data: { user: { id } }, error: null }) },
    from(table) {
      const call = { table, filters: [] }; calls.push(call);
      const result = () => table === 'profiles' ? { data: { app_role: role }, error: null }
        : responses[table] || { data: ['products', 'bundles', 'courses'].includes(table) ? [] : invoice, error: null };
      const query = {
        select(value) { call.select = value; return query; },
        eq(...args) { call.filters.push(['eq', ...args]); return query; },
        or(value) { call.filters.push(['or', value]); return query; },
        ilike(...args) { call.filters.push(['ilike', ...args]); return query; },
        order(...args) { call.filters.push(['order', ...args]); return query; },
        limit(value) { call.limit = value; return query; },
        range(...args) { call.range = args; return query; },
        in(...args) { call.filters.push(['in', ...args]); return query; },
        update(value) { call.update = value; return query; },
        maybeSingle: async () => result(),
        then(resolve, reject) { return Promise.resolve(result()).then(resolve, reject); },
      };
      return query;
    },
    rpc: async (name, args) => { calls.push({ rpc: name, args }); return rpcResult; },
    storage: { from: () => ({ upload: async () => ({ error: null }), getPublicUrl: () => ({ data: { publicUrl: 'https://example.invalid/receipt.pdf' } }) }) },
  };
  return calls;
}
const event = (method = 'GET', query = {}, body) => ({ httpMethod: method, headers: { authorization: 'Bearer test-session', 'content-type': 'application/json' }, queryStringParameters: query, body: body && JSON.stringify(body) });
const submission = { request_id: id, customer_name: 'Jane Smith', items: [{ product_id: productId, quantity: 2, expected_price_cents: 12500 }], total: 1, invoice_number: 'FORGED' };

async function pdfText(bytes) {
  const pdf = await PDFDocument.load(bytes);
  const pages = pdf.getPages().map(page => {
    const contents = page.node.Contents();
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    return refs.map(ref => {
      const stream = pdf.context.lookup(ref);
      const text = inflateSync(stream.getContents()).toString();
      return [...text.matchAll(/<([0-9A-F]+)>\s*Tj/gi)].map(match => Buffer.from(match[1], 'hex').toString('latin1')).join('\n');
    }).join('\n');
  });
  return { pdf, text: pages.join('\n'), pages };
}

test('requires a session and an existing owner/staff role for invoice access', async () => {
  const calls = mockDb();
  assert.equal((await manual.handler({ ...event(), headers: {} })).statusCode, 401);
  assert.equal(calls.length, 0);
  mockDb({ role: 'customer' });
  assert.equal((await manual.handler(event())).statusCode, 403);
  assert.equal((await manual.handler(event('DELETE'))).statusCode, 405);
});

test('searches catalog names only with literal filter input and excludes invalid prices', async () => {
  const calls = mockDb({ responses: { products: { data: [
    { id: productId, name: 'Product', price: 125 }, { id, name: 'Unpriced', price: null },
  ], error: null } } });
  const response = await manual.handler(event('GET', { action: 'products', q: 'shade,sku).eq."_%' }));
  assert.equal(response.statusCode, 200);
  assert.equal(JSON.parse(response.body).data.length, 1);
  const productCall = calls.find(call => call.table === 'products');
  assert.equal(productCall.limit, 20);
  assert.deepEqual(productCall.filters.find(filter => filter[0] === 'ilike'), ['ilike', 'name', '%shade,sku).eq."\\_\\%%']);
  assert.ok(!productCall.select.includes('sku'));
  assert.ok(!productCall.filters.some(filter => String(filter).includes('sku.ilike')));
});

test('includes existing bundles and courses with package prices and catalog types', async () => {
  mockDb({ responses: {
    products: { data: [{ id: productId, name: 'Acrylic powder', price: 125 }], error: null },
    bundles: { data: [{ id: productId, name: 'Acrylic kit', price_cents: 54950 }, { id, name: 'Unpriced kit', price_cents: null }], error: null },
    courses: { data: [
      { id, title: 'Acrylic training', price: 7600, packages: [{ name: 'Standard', price: 7600 }, { name: 'Deluxe', price: 9900 }] },
      { id: productId, title: 'Acrylic workshop', price: 1850, packages: null },
    ], error: null },
  } });
  const data = JSON.parse((await manual.handler(event('GET', { action: 'products', q: 'Acrylic' }))).body).data;
  assert.equal(data.length, 5);
  assert.equal(data.find(item => item.item_type === 'bundle').price, 549.5);
  assert.deepEqual(data.filter(item => item.course_package_index != null).map(item => [item.name, item.price, item.course_package_index]), [
    ['Acrylic training — Deluxe', 9900, 1], ['Acrylic training — Standard', 7600, 0],
  ]);
  assert.equal(data.find(item => item.name === 'Acrylic workshop').item_type, 'course');
});

test('invoice history uses bounded pages and safely searches number/customer only', async () => {
  const calls = mockDb({ responses: { in_store_invoices: { data: [], count: 150, error: null } } });
  const result = JSON.parse((await manual.handler(event('GET', { page: '3', q: 'Jane,"_%' }))).body);
  const query = calls.find(call => call.table === 'in_store_invoices');
  assert.deepEqual(query.range, [10, 14]);
  assert.equal(result.page_size, 5);
  assert.equal(result.count, 150);
  assert.match(query.filters.find(filter => filter[0] === 'or')[1], /^invoice_number\.ilike\./);
  assert.match(query.filters.find(filter => filter[0] === 'or')[1], /customer_name\.ilike\./);
  assert.match(query.filters.find(filter => filter[0] === 'or')[1], /\\"\\_\\%/);
});

test('validates requests, strips browser totals and uses the atomic snapshot RPC', async () => {
  const calls = mockDb();
  assert.equal((await manual.handler(event('POST', {}, { ...submission, items: [{ ...submission.items[0], quantity: 1.5 }] }))).statusCode, 400);
  assert.equal((await manual.handler(event('POST', {}, { ...submission, customer_email: 'invalid' }))).statusCode, 400);
  const response = await manual.handler(event('POST', {}, submission));
  assert.equal(response.statusCode, 201);
  const rpc = calls.find(call => call.rpc);
  assert.equal(rpc.rpc, 'create_in_store_invoice');
  assert.equal(rpc.args.p_created_by, id);
  assert.equal(rpc.args.p_request_id, id);
  assert.equal(rpc.args.total, undefined);
  assert.equal(rpc.args.invoice_number, undefined);
  assert.deepEqual(rpc.args.p_items, submission.items.map(item => ({ ...item, item_type: 'product', course_package_index: null })));
  assert.equal(rpc.args.p_banking_details.is_placeholder, 'true');
  assert.equal(JSON.parse(response.body).invoice.total, 250);
  assert.ok(!calls.some(call => ['orders', 'stock_movements', 'payments'].includes(call.table)));
});

test('typed lines preserve bundle/course identity and reject forged types/packages', async () => {
  const typed = [{ ...submission.items[0], item_type: 'bundle' }, { ...submission.items[0], item_type: 'course', course_package_index: 1 }];
  const calls = mockDb();
  assert.equal((await manual.handler(event('POST', {}, { ...submission, items: typed }))).statusCode, 201);
  assert.deepEqual(calls.find(call => call.rpc).args.p_items, typed.map(item => ({ ...item, course_package_index: item.course_package_index ?? null })));
  for (const fields of [{ item_type: 'payment' }, { item_type: 'bundle', course_package_index: 0 }, { item_type: 'course', course_package_index: -1 }, { item_type: 'course', course_package_index: 0.5 }]) {
    assert.equal((await manual.handler(event('POST', {}, { ...submission, items: [{ ...submission.items[0], ...fields }] }))).statusCode, 400);
  }
});

test('reports stale prices and invalid invoice IDs without saving or rendering', async () => {
  mockDb({ rpcResult: { data: null, error: { code: 'P0001', message: 'A product price changed.' } } });
  assert.equal((await manual.handler(event('POST', {}, submission))).statusCode, 409);
  assert.equal((await manual.handler(event('GET', { id: 'bad' }))).statusCode, 400);
  mockDb({ responses: { in_store_invoices: { data: null, error: null } } });
  assert.equal((await manual.handler(event('GET', { id }))).statusCode, 404);
});

test('bank configuration must be complete before replacing the explicit placeholders', async () => {
  try {
    process.env.BLOM_BANK_NAME = 'Synthetic test bank';
    let calls = mockDb();
    await manual.handler(event('POST', {}, submission));
    assert.equal(calls.find(call => call.rpc).args.p_banking_details.is_placeholder, 'true');
    bankVariables.forEach(key => { process.env[key] = 'Synthetic test value'; });
    calls = mockDb();
    await manual.handler(event('POST', {}, submission));
    const snapshot = calls.find(call => call.rpc).args.p_banking_details;
    assert.equal(snapshot.is_placeholder, undefined);
    assert.equal(snapshot.account_number, 'Synthetic test value');
  } finally { bankVariables.forEach(key => { delete process.env[key]; }); }
});

test('manual PDF uses saved names/prices, branding, placeholder banking and actual payment reference', async () => {
  const calls = mockDb();
  const response = await manual.handler(event('GET', { action: 'pdf', id }));
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['Content-Type'], 'application/pdf');
  assert.equal(response.headers['Cache-Control'], 'no-store');
  const { text } = await pdfText(Buffer.from(response.body, 'base64'));
  for (const value of ['INVOICE', 'INV-20261005-001', 'Jane Smith', 'Saved product name', 'R 125.00', 'R 250.00', 'BLOM Cosmetics', 'PLACEHOLDERS', 'Account number: To be confirmed', 'Please use INV-20261005-001 as your payment reference']) assert.ok(text.includes(value), value);
  assert.ok(!text.includes('FREE SHIPPING'));
  assert.ok(!text.includes('Fulfillment'));
  assert.ok(!text.includes('Subtotal'));
  assert.ok(text.includes('34 Horingbek Street'));
  assert.ok(text.includes('+27 79 548 3317'));
  assert.ok(!calls.some(call => call.table === 'products'));
});

test('long manual invoices paginate with complete product names and a single bank footer', async () => {
  const items = Array.from({ length: 100 }, (_, index) => ({ name: `Product ${index + 1} with a complete long descriptive name that wraps onto the next line`, quantity: 1, unit_price: 50, line_total: 50 }));
  const bytes = await renderer.generateInvoiceDocument({ ...invoice, total: 5000, subtotal: 5000 }, items, invoice.invoice_number, null, bank);
  const { pdf, text, pages } = await pdfText(bytes);
  assert.ok(pdf.getPageCount() > 1);
  assert.ok(text.includes('Product 100'));
  assert.equal((text.match(/PLACEHOLDERS/g) || []).length, 1);
  assert.ok(pages.at(-1).includes('payment reference'));
  assert.ok(!text.includes('FREE SHIPPING'));
  assert.ok(text.includes('R 5000.00'));
});

test('existing online invoice handler still renders, uploads and returns the receipt URL', async () => {
  const order = { id, m_payment_id: 'BL-ONLINE', created_at: invoice.created_at, buyer_name: 'Online Buyer', delivery_method: 'delivery', subtotal_cents: 300000, total: 3000 };
  const calls = mockDb({ responses: {
    orders: { data: order, error: null },
    order_items: { data: [{ product_name: 'Online product', quantity: 2, unit_price: 1500, line_total: 3000 }], error: null },
  } });
  const response = await online.handler(event('POST', {}, { m_payment_id: 'BL-ONLINE' }));
  assert.equal(response.statusCode, 200);
  const { text } = await pdfText(Buffer.from(response.body, 'base64'));
  for (const value of ['RECEIPT', 'BL-ONLINE', 'Online Buyer', 'Online product', 'Fulfillment', 'FREE SHIPPING - Order over R2800', 'R 3000.00']) assert.ok(text.includes(value), value);
  assert.ok(!text.includes('PLACEHOLDERS'));
  assert.equal(calls.find(call => call.update).update.invoice_url, 'https://example.invalid/receipt.pdf');
  const urlResponse = await online.handler(event('POST', { return_url: '1' }, { m_payment_id: 'BL-ONLINE' }));
  assert.equal(JSON.parse(urlResponse.body).invoice_url, 'https://example.invalid/receipt.pdf');
});
