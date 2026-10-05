// Optional isolated PostgreSQL check: set BLOM_TEST_PGLITE_MODULE to a disposable
// installation of @electric-sql/pglite's dist/index.js. No live credentials are used.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';

test('invoice migration: atomic snapshots, validation, retries, counters and access', {
  skip: !process.env.BLOM_TEST_PGLITE_MODULE,
}, async () => {
  const { PGlite } = await import(pathToFileURL(process.env.BLOM_TEST_PGLITE_MODULE).href);
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE products (id uuid PRIMARY KEY, name text, sku text, price numeric,
        is_active boolean, status text);
    `);
    await db.exec(await readFile(new URL('../db/migrations/20261005_create_in_store_invoices.sql', import.meta.url), 'utf8'));
    const product = randomUUID();
    const staff = randomUUID();
    const banking = { bank_name: 'To be confirmed', account_holder: 'To be confirmed',
      account_number: 'To be confirmed', account_type: 'To be confirmed', branch_code: 'To be confirmed', is_placeholder: 'true' };
    await db.query('INSERT INTO products VALUES ($1, $2, $3, 125.55, true, $4)', [product, 'Original name', 'SKU-1', 'active']);
    const items = [{ product_id: product, quantity: 2, expected_price_cents: 12555 }];
    const create = async (request = randomUUID(), lines = items) => {
      const result = await db.query('SELECT create_in_store_invoice($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb) AS id',
        [request, staff, 'Jane Smith', '', '', JSON.stringify(lines), JSON.stringify(banking)]);
      return result.rows[0].id;
    };
    const request = randomUUID();
    const first = await create(request);
    const date = (await db.query("SELECT to_char(now() AT TIME ZONE 'Africa/Johannesburg', 'YYYYMMDD') AS day")).rows[0].day;
    const invoice = (await db.query('SELECT * FROM in_store_invoices WHERE id=$1', [first])).rows[0];
    assert.equal(invoice.invoice_number, `INV-${date}-001`);
    assert.equal(Number(invoice.total), 251.10);
    assert.equal(invoice.customer_phone, null);

    const concurrentIds = await Promise.all(Array.from({ length: 20 }, () => create()));
    assert.equal(new Set(concurrentIds).size, 20);
    const numbers = (await db.query('SELECT invoice_number FROM in_store_invoices')).rows.map(row => row.invoice_number);
    assert.equal(new Set(numbers).size, 21);
    assert.equal(await create(request), first);
    const retries = await Promise.all(Array.from({ length: 10 }, () => create(request)));
    assert.ok(retries.every(value => value === first));
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM in_store_invoices')).rows[0].n), 21);

    await db.query('UPDATE products SET name=$2,price=999 WHERE id=$1', [product, 'Changed name']);
    const snapshot = (await db.query('SELECT * FROM in_store_invoice_items WHERE invoice_id=$1', [first])).rows[0];
    assert.equal(snapshot.product_name, 'Original name');
    assert.equal(Number(snapshot.unit_price), 125.55);
    await assert.rejects(create(), /price changed/);
    assert.equal((await db.query('SELECT last_number FROM in_store_invoice_sequences')).rows[0].last_number, 21);
    const currentItems = [{ ...items[0], expected_price_cents: 99900 }];
    for (const quantity of [0, -1, 1.5, 10000]) {
      await assert.rejects(create(randomUUID(), [{ ...currentItems[0], quantity }]), /Quantity/);
    }
    await assert.rejects(create(randomUUID(), []), /between 1 and 100/);
    await assert.rejects(create(randomUUID(), [...currentItems, ...currentItems]), /duplicate products/);
    await db.query('UPDATE products SET is_active=false WHERE id=$1', [product]);
    await assert.rejects(create(randomUUID(), currentItems), /no longer available/);
    await db.query('UPDATE products SET is_active=true,name=null WHERE id=$1', [product]);
    // A failure inserting items must roll back both the header and the daily counter.
    await assert.rejects(create(randomUUID(), currentItems), /null value/);
    assert.equal((await db.query('SELECT last_number FROM in_store_invoice_sequences')).rows[0].last_number, 21);
    await db.query('UPDATE products SET name=$2 WHERE id=$1', [product, 'Changed name']);
    await db.exec('UPDATE in_store_invoice_sequences SET last_number=999');
    const thousand = await create(randomUUID(), currentItems);
    assert.equal((await db.query('SELECT invoice_number FROM in_store_invoices WHERE id=$1', [thousand])).rows[0].invoice_number, `INV-${date}-1000`);

    await db.exec('SET ROLE authenticated');
    await assert.rejects(db.query('SELECT * FROM in_store_invoices'), /permission denied/);
    await assert.rejects(create(), /permission denied/);
    await db.exec('RESET ROLE');
    await db.query('DELETE FROM products WHERE id=$1', [product]);
    assert.equal(Number((await db.query('SELECT count(*) AS n FROM in_store_invoice_items WHERE invoice_id=$1', [first])).rows[0].n), 1);
    assert.equal(await create(request), first);
  } finally { await db.close(); }
});
