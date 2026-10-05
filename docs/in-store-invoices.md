# In-store invoices

The **Create In-Store Invoice** action is in **Sales & Inventory**. Search active products
by name or SKU, adjust quantities, enter a customer name (phone/email optional), and
generate the invoice. Saved invoices can be reopened, downloaded and printed from the
same page. This feature does not create orders, deduct stock, send notifications or
record payments. Prices are the product table's current `price` in Rand, without promotions.

## Deployment

The migration was applied with explicit approval to the commerce project
`yvmnedjybrpvlupygusf` through Supabase MCP on 2026-10-05. Supabase recorded
`20261005182352_create_in_store_invoices`. The tables, constraints, RPC definition and
service-role-only permissions were verified; no live test invoices were created.
The Academy project was not changed. Admin deployment remains a separate step.

1. Apply `db/migrations/20261005_create_in_store_invoices.sql` to the commerce Supabase
   database before deploying the admin changes (already applied to the project above;
   do not apply it twice). It is transactional and creates three
   new tables plus one RPC; it does not modify the order or product schema.
2. Deploy the admin frontend and Netlify functions together using the existing process.
   Existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, and
   `VITE_SUPABASE_ANON_KEY` configuration is reused. Access is restricted to the existing
   `profiles.app_role` values `owner` and `staff`.
3. Temporary banking placeholders were explicitly requested. To replace them, configure
   **all five** server-side Netlify environment variables with confirmed BLOM details:
   `BLOM_BANK_NAME`, `BLOM_BANK_ACCOUNT_HOLDER`, `BLOM_BANK_ACCOUNT_NUMBER`,
   `BLOM_BANK_ACCOUNT_TYPE`, and `BLOM_BANK_BRANCH_CODE`. Partial configuration uses
   placeholders for every field so incomplete details cannot appear as usable banking
   instructions. No real account information was found in the repository.

Banking details are saved with the invoice. Earlier invoices created with placeholders
retain their clearly marked placeholder footer when reopened; configuring bank details
affects newly created invoices. PDFs say **PLACEHOLDERS** when applicable, and the UI
warns staff to confirm banking details before sharing invoices for payment.

## Storage, numbering and PDFs

`in_store_invoices` stores the customer, timestamps, totals, bank snapshot and invoice
number. `in_store_invoice_items` stores product IDs plus immutable names, SKUs, quantities,
unit prices and line totals. Product IDs are references for identification, without a
foreign key, so product deletion cannot erase invoice history. Both monetary columns and
snapshots use Rand, matching existing order-item conventions.

The service-role RPC reads and locks products, validates quantities and current prices,
then writes the header and items in one transaction. If a price changed after selection,
staff must remove and add that product again to review it. Browser totals are never trusted.

The format is `INV-YYYYMMDD-###`, using `Africa/Johannesburg` dates. An atomic daily counter
UPSERT locks the day's counter row; unique constraints provide additional protection.
Numbers start at `001` each day and grow beyond `999` without truncation. An idempotent
submission UUID prevents duplicate invoices when an unchanged failed request is retried.

`netlify/functions/_lib/invoice-document.ts` is shared by the existing online-order
`invoice-pdf` function and the new `admin-in-store-invoices` endpoint. It reuses the
existing logo, A4 layout, fonts, line styling and contact details. Manual PDFs use the
saved snapshots exclusively and add the bank footer/payment reference. PDFs are generated
on demand through an authenticated endpoint, rather than creating another public storage
bucket. The browser downloads the PDF or opens it in a print window with a print button.
Browsers must permit that window; the PDF viewer's own print control is also available.

## Local verification

Run `node --test tests/in-store-invoices.test.mjs` for isolated endpoint/PDF checks.
Run `npm run lint` and `npm run build` for existing application checks. There is no
declared typecheck script. The optional isolated database suite is
`tests/in-store-invoices-db.test.mjs`: point `BLOM_TEST_PGLITE_MODULE` to a temporary
installation of `@electric-sql/pglite/dist/index.js`, then run it with `node --test`.
It checks the actual migration, transaction rollback, retries, snapshots, counters and
database permissions without accessing the live database.

Supabase reports informational "RLS Enabled No Policy" notices for the three new tables.
This is intentional: browser roles have no table or RPC permissions, and the existing
authenticated Admin function uses the service role. No new security warnings were introduced.
