# In-store invoices

The **Create In-Store Invoice** action is in **Sales & Inventory**. Search active products,
bundles and courses by name only, adjust quantities, enter a customer name (phone/email optional), and
generate the invoice. Saved invoices can be reopened, downloaded and printed from the
same page. This feature does not create orders, deduct stock, send notifications or
record payments or enrol students. Products/courses use current `price` in Rand; bundles
use current `price_cents`. Course packages appear as separate named options at their stored
package prices. No promotions, deposits or payment processing are added.

Saved invoices sit in an expandable section, newest first, with five per page. Search
invoice numbers or customer names, then open an invoice to download/print it again.
This is intentionally a small invoice history, not an accounting/order-management screen.
Each saved invoice has a delete (trash) button with an inline "Yes, delete" confirmation.
Deletion is permanent: `DELETE ?id=` removes the header and, through the
`20261006_delete_in_store_invoices.sql` ON DELETE CASCADE foreign key, its item snapshots
in the same statement. Deleted numbers are not reused.

Speed: the page loads the whole active catalog once (`?action=catalog`, a few hundred
rows, cached for five minutes) and filters it in the browser, so results appear as staff
type; every typed word must match and names starting with the search rank first. Prices
are still re-validated by the server on save. History pages return full invoice rows (five
at a time), so opening a saved invoice renders from the list with no extra request.

Ease of use: the search box, the results list and the "On this invoice" list each use a
distinct shade. The highlighted result is tinted with a berry edge (↑/↓ + Enter also
add), and items already on the invoice show a green "On invoice (qty)" badge.

## Deployment

The migration was applied with explicit approval to the commerce project
`yvmnedjybrpvlupygusf` through Supabase MCP on 2026-10-05. Supabase recorded
`20261005182352_create_in_store_invoices`. The tables, constraints, RPC definition and
service-role-only permissions were verified; no live test invoices were created.
The Academy project was not changed. Admin deployment remains a separate step.
The follow-up `20261005_extend_in_store_invoice_catalog.sql` was also applied with
explicit approval, recorded as `20261005190450_extend_in_store_invoice_catalog`.
It adds item type/package metadata, replaces the same atomic RPC and indexes invoice
number/customer-name searches with the already-installed `pg_trgm` extension.

1. Apply `db/migrations/20261005_create_in_store_invoices.sql` to the commerce Supabase
   database before deploying the admin changes (already applied to the project above;
   do not apply it twice). It is transactional and creates three
   new tables plus one RPC; it does not modify the order or product schema.
   Apply the catalog-extension migration after it on new environments (both are already
   applied to BLOM commerce). No catalog tables or online orders are modified.
2. Deploy the admin frontend and Netlify functions together using the existing process.
   Existing `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `VITE_SUPABASE_URL`, and
   `VITE_SUPABASE_ANON_KEY` configuration is reused. Access is restricted to the existing
   `profiles.app_role` values `owner` and `staff`.
3. Invoices print BLOM's FNB account (Blom Cosmetics (Pty) Ltd, account 631 5993 7417,
   branch code 250655), set in `admin-in-store-invoices.ts`. No account type was supplied,
   so that line is omitted. To override, set **all** of `BLOM_BANK_NAME`,
   `BLOM_BANK_ACCOUNT_HOLDER`, `BLOM_BANK_ACCOUNT_NUMBER` and `BLOM_BANK_BRANCH_CODE`
   (`BLOM_BANK_ACCOUNT_TYPE` optional) in Netlify; a partial set is ignored so two
   accounts can never be mixed.

Banking details are saved with the invoice, so changing them affects only new invoices.
Invoices created before the real details were added keep their PLACEHOLDERS footer.
Manual PDFs show only **Total**, not Subtotal or VAT. The payment reference is separated
from bank details by a blank line and printed in bold black.
The customer/business header uses the Store Terms address (34 Horingbek Street,
Randfontein, 1759, South Africa) and existing invoice phone/email. Optional server variables
`BLOM_BUSINESS_ADDRESS`, `BLOM_BUSINESS_PHONE` and `BLOM_BUSINESS_EMAIL` override those
verified project defaults; no configuration is needed if they are still current.

## Storage, numbering and PDFs

`in_store_invoices` stores the customer, timestamps, totals, bank snapshot and invoice
number. `in_store_invoice_items` stores source catalog IDs/types/package indexes plus immutable names, SKUs, quantities,
unit prices and line totals. Product IDs are references for identification, without a
foreign key, so product deletion cannot erase invoice history. Both monetary columns and
snapshots use Rand, matching existing order-item conventions.

The service-role RPC reads and locks the existing products/bundles/courses, validates quantities and current prices,
then writes the header and items in one transaction. If a price changed after selection,
staff must remove and add that product again to review it. Browser totals are never trusted.

The format is `INV-YYMMDD-###` (e.g. `INV-261006-003`), using `Africa/Johannesburg` dates.
Invoices issued before `20261006_short_year_invoice_numbers.sql` keep their original
`INV-YYYYMMDD-###` numbers; the two formats cannot collide. An atomic daily counter
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
The isolated database suite loads PGlite's bundled `pg_trgm` extension and tests upgrading
existing invoices, mixed catalogs, package pricing, invalid types and deleted-course snapshots.

Supabase reports informational "RLS Enabled No Policy" notices for the three new tables.
This is intentional: browser roles have no table or RPC permissions, and the existing
authenticated Admin function uses the service role. No new security warnings were introduced.
