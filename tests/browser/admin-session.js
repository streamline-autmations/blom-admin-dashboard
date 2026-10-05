async page => {
  // Run against a local Vite server with synthetic Supabase env only (see docs).
  await page.unrouteAll();
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'staff@example.invalid', aud: 'authenticated', role: 'authenticated' };
  await page.addInitScript(({ user }) => {
    localStorage.setItem('blom-admin-auth', JSON.stringify({ access_token: 'synthetic-test-session', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_at: 4102444800, user }));
  }, { user });
  await page.route('**/*', route => {
    const url = route.request().url();
    return url.startsWith('http://localhost:5182/') || url.startsWith('https://example.invalid/') ? route.continue() : route.abort();
  });
  await page.route('https://example.invalid/**', route => route.fulfill({ json: route.request().url().includes('/profiles') ? { app_role: 'staff' } : [] }));
  await page.route('**/.netlify/functions/**', route => route.fulfill({ status: route.request().url().includes('admin-analytics-advanced') ? 500 : 200, json: { ok: false, error: 'Analytics is not mocked in this session test', data: [], counts: {} } }));

  const checks = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  let role = 'staff';
  let profileStatus = 200;
  const delay = 400;
  let profileReads = 0;
  let writes = 0;
  await page.route('https://example.invalid/rest/v1/profiles**', async route => {
    profileReads++;
    await page.waitForTimeout(delay);
    await route.fulfill({ status: profileStatus, json: profileStatus === 200 ? { app_role: role } : { message: 'Synthetic unavailable profile service' } });
  });
  const product = { id: '22222222-2222-4222-8222-222222222222', name: 'Retention test acrylic', price: 125, sku: 'TEST-RETENTION' };
  await page.route('**/admin-in-store-invoices**', route => {
    if (route.request().method() !== 'GET') { writes++; return route.abort(); }
    return route.fulfill({ json: { ok: true, data: route.request().url().includes('action=products') ? [product] : [], count: 0, banking_configured: false } });
  });
  await page.goto('http://localhost:5182/analytics');
  await page.locator('#analytics-title').waitFor();
  await page.goto('http://localhost:5182/in-store-invoices');
  await page.locator('#invoice-name').fill('Unfinished customer name');
  await page.locator('#invoice-phone').fill('0821234567');
  await page.locator('#invoice-email').fill('customer@example.invalid');
  await page.locator('#invoice-search').fill('acrylic');
  await page.getByRole('button', { name: `Add ${product.name}`, exact: true }).click();
  await page.getByRole('button', { name: `Increase ${product.name} quantity`, exact: true }).click();
  await page.getByRole('spinbutton', { name: `Quantity for ${product.name}` }).fill('2');
  // Preserve the exact input node, caret and focus, not only its restored value.
  await page.locator('#invoice-name').focus();
  await page.evaluate(() => {
    window.__retentionInput = document.querySelector('#invoice-name');
    window.__retentionInput.setSelectionRange(10, 10);
  });
  const notify = event => page.evaluate(async event => {
    const { supabase } = await import('/src/lib/supabase.ts');
    const { data } = await supabase.auth.getSession();
    await supabase.auth._notifyAllSubscribers(event, event === 'SIGNED_OUT' ? null : data.session, false);
  }, event);
  const retained = async label => {
    assert(await page.evaluate(() => window.__retentionInput === document.querySelector('#invoice-name') && window.__retentionInput.isConnected), `${label}: screen stays mounted`);
    assert(await page.locator('#invoice-name').inputValue() === 'Unfinished customer name', `${label}: typed name retained`);
    assert(await page.locator('#invoice-phone').inputValue() === '0821234567' && await page.locator('#invoice-email').inputValue() === 'customer@example.invalid', `${label}: optional customer details retained`);
    assert(await page.getByRole('spinbutton', { name: `Quantity for ${product.name}` }).inputValue() === '2', `${label}: item and quantity retained`);
    assert(await page.evaluate(() => document.activeElement === window.__retentionInput && window.__retentionInput.selectionStart === 10), `${label}: caret and focus retained`);
  };
  // Supabase emits SIGNED_IN on focus and TOKEN_REFRESHED during renewal.
  for (const event of ['SIGNED_IN', 'TOKEN_REFRESHED', 'USER_UPDATED']) {
    const request = page.waitForRequest(request => request.url().includes('/profiles'));
    const response = page.waitForResponse(response => response.url().includes('/profiles'));
    await notify(event);
    await request;
    await retained(`${event} while checking`);
    await response;
    await page.waitForTimeout(80);
    await retained(`${event} completed`);
  }
  const other = await page.context().newPage();
  await other.goto('about:blank');
  await other.bringToFront();
  await page.bringToFront();
  await other.close();
  await retained('browser tab return');
  profileStatus = 503;
  const failedResponse = page.waitForResponse(response => response.url().includes('/profiles') && response.status() === 503);
  await notify('TOKEN_REFRESHED');
  await failedResponse;
  await page.waitForTimeout(100);
  await retained('temporary background role lookup failure');
  profileStatus = 200;
  role = 'customer';
  const revokedResponse = page.waitForResponse(response => response.url().includes('/profiles') && response.status() === 200);
  await notify('SIGNED_IN');
  await revokedResponse;
  await page.locator('#invoice-name').waitFor({ state: 'detached' });
  assert(await page.getByRole('button', { name: /sign in/i }).isVisible(), 'revoked staff access still removes protected screens');
  role = 'staff';
  await notify('SIGNED_IN');
  await page.locator('#invoice-name').waitFor();
  await page.locator('#invoice-name').fill('Second unfinished draft');
  const lateResponse = page.waitForResponse(response => response.url().includes('/profiles'));
  const lateRequest = page.waitForRequest(request => request.url().includes('/profiles'));
  await notify('TOKEN_REFRESHED');
  await lateRequest;
  await notify('SIGNED_OUT');
  await page.locator('#invoice-name').waitFor({ state: 'detached' });
  await lateResponse;
  await page.waitForTimeout(100);
  assert(await page.getByRole('button', { name: /sign in/i }).isVisible(), 'late validation cannot restore a signed-out screen');
  assert(writes === 0, 'no invoice or database writes during verification');
  await page.unroute('https://example.invalid/rest/v1/profiles**');
  await page.unroute('**/admin-in-store-invoices**');
  await page.goto('http://localhost:5182/analytics');
  await page.locator('#analytics-title').waitFor();
  return { checks, profileReads, writes };
}
