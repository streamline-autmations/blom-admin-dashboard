# Local browser regressions

These are function-expression scripts for the existing Playwright CLI, not production
fixtures or a new application dependency. Start Vite from the Admin repository with
synthetic configuration (do not use live credentials):

```sh
VITE_SUPABASE_URL=https://example.invalid VITE_SUPABASE_ANON_KEY=test-only npm run dev -- --port 5182
```

In another terminal, open Chromium and run a script. Use absolute script paths when
running outside the repository so browser artifacts stay in a temporary directory:

```sh
cd /tmp
playwright-cli -s=blom-qa open http://localhost:5182 --browser=chromium
playwright-cli -s=blom-qa run-code --filename=/absolute/path/to/blom-admin/tests/browser/admin-session.js
playwright-cli -s=blom-qa run-code --filename=/absolute/path/to/blom-admin/tests/browser/in-store-invoices.js
playwright-cli -s=blom-qa run-code --filename=/absolute/path/to/blom-admin/tests/browser/analytics.js
```

Scripts install synthetic staff sessions and intercept Supabase/function requests.
External URLs are blocked. Invoices are saved only to an in-memory mock; the download
uses a minimal valid PDF fixture to check browser plumbing. Branding, saved totals and
multi-page real PDFs are covered by `tests/in-store-invoices.test.mjs` and visual PDF QA.

`admin-session.js` checks mounted inputs/caret/quantity during refresh, tab return and
temporary failures, plus revoked roles and stale responses after sign-out.
`in-store-invoices.js` checks name-only results, independent product/bundle/package
identities, totals, compact mobile history/search/pagination, download/print and reopening.
`analytics.js` checks quick/custom ranges, metrics, errors/retry, accessible trend data,
mobile bounds and light/dark surfaces with browser-derived calendar dates.

Screenshots/downloads are written to `/tmp`, never committed with the source.
