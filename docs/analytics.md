# Analytics and archived navigation

Featured, Specials, Price Updates and Sales are removed from the sidebar. Existing
routes, records and functionality remain intact for recovery or direct access.

Analytics offers Today, This month, Last 30 days, Lifetime and an inclusive custom
date range. Calendar boundaries use South African time (UTC+02:00), based on order
creation dates. Ranges over 90 days are charted monthly; shorter ranges daily.

Sales revenue uses stored `total_cents` (including shipping and discounts), falling
back to `total` in Rand only when cents are null. Items sold counts order-item
quantities, including bundles as one unit and course line quantities. Manual
in-store invoices are not paid orders and never enter these sales calculations.

Paid orders are included; explicitly unpaid, refunded, cancelled and archived
orders are excluded. For older orders with no payment status, paid/fulfilled order
statuses provide the existing legacy fallback. Order and item queries are paginated
to avoid Supabase's default result limit, including Lifetime.

Top sellers use saved item names and prices and distinct order counts. Item revenue
is before order-level discounts and shipping. Customers are identified by normalized
email (customer email, falling back to buyer email); repeat customers have more than
one paid order **within the selected range**, not necessarily lifetime repeats.
Orders without email still count towards revenue and units, but not customer counts.

Inventory remains a current snapshot of active products, independent of dates.
Its value uses current stored cost prices; missing costs contribute zero. No profit
or conversion estimates are invented. No migration or additional configuration is needed.

Run `node --test tests/analytics.test.mjs` for isolated date, aggregation, pagination,
authorization and failure-state checks. No live data is changed by these tests.
