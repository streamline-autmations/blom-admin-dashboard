async page => {
  const setup = async page => {
  await page.unrouteAll();
  // Derive fixture dates from the browser without freezing animation clocks.
  const calendar = await page.evaluate(() => {
    const now = new Date(Date.now() + 2 * 3600000);
    return { today: now.toISOString().slice(0, 10), monthStart: `${now.toISOString().slice(0, 7)}-01`, last30: new Date(now.getTime() - 29 * 86400000).toISOString().slice(0, 10) };
  });
  await page.route('**/*', route => {
    const url = route.request().url();
    return url.startsWith('http://localhost:5182/') || url.startsWith('https://example.invalid/') ? route.continue() : route.abort();
  });
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'staff@example.invalid', aud: 'authenticated', role: 'authenticated' };
  await page.addInitScript(({ user }) => {
    localStorage.setItem('blom-admin-auth', JSON.stringify({ access_token: 'synthetic-test-session', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_at: 4102444800, user }));
    localStorage.setItem('theme', 'dark');
  }, { user });
  await page.route('https://example.invalid/**', async route => {
    const url = route.request().url();
    await route.fulfill({ json: url.includes('/profiles') ? { app_role: 'staff' } : url.includes('/auth/') ? user : [] });
  });
  await page.route('**/.netlify/functions/**', async route => {
    const url = route.request().url();
    if (!url.split('?')[0].endsWith('admin-analytics-advanced')) return route.fulfill({ json: { ok: true, data: [], counts: {} } });
    const params = Object.fromEntries((url.split('?')[1] || '').split('&').map(part => part.split('=')));
    const preset = params.period;
    const start = params.start_date || (preset === 'today' ? calendar.today : preset === 'month' ? calendar.monthStart : preset === '30' ? calendar.last30 : null);
    const end = params.end_date || calendar.today;
    const label = preset === 'today' ? 'Today' : preset === 'month' ? 'This month' : preset === 'lifetime' ? 'Lifetime' : preset === '30' ? 'Last 30 days' : `${start} to ${end}`;
    const multiplier = preset === 'lifetime' ? 10 : preset === 'today' ? 0 : 1;
    const data = {
      period: { start, end, label, bucket: preset === 'lifetime' ? 'month' : 'day' },
      summary: { totalRevenueCents: 157650 * multiplier, totalOrders: 12 * multiplier, itemsSold: 37 * multiplier, avgOrderValue: 13137.5 * (multiplier ? 1 : 0), avgItemsPerOrder: multiplier ? 3.1 : 0, totalDiscountCents: 3500 * multiplier, shippingRevenueCents: 12500 * multiplier },
      customers: { totalCustomers: 9 * multiplier, repeatCustomers: 3 * multiplier, repeatCustomerRate: multiplier ? 33.3 : 0 },
      fulfillment: { delivery: { count: 8 * multiplier, revenueCents: 110000 * multiplier }, collection: { count: 3 * multiplier, revenueCents: 40650 * multiplier }, other: { count: 1 * multiplier, revenueCents: 7000 * multiplier } },
      trends: ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'].map((date, index) => ({ date, revenueCents: (index + 1) * 10000 * multiplier, orders: index * multiplier, itemsSold: (index + 1) * 2 * multiplier })),
      allTopProducts: multiplier ? [{ id: 'p1', name: 'Professional Acrylic System — Cover Pink', totalUnitsSold: 18 * multiplier, totalOrders: 7 * multiplier, totalRevenueCents: 76500 * multiplier }, { id: 'b1', name: 'BLOM Complete Starter Kit', isBundle: true, totalUnitsSold: 12 * multiplier, totalOrders: 3 * multiplier, totalRevenueCents: 58150 * multiplier }, { id: 'p2', name: 'Cuticle Oil', totalUnitsSold: 7 * multiplier, totalOrders: 2 * multiplier, totalRevenueCents: 10500 * multiplier }] : [],
      inventory: { totalInventoryValue: 2595000, activeProducts: 235, lowStockProducts: 18, outOfStockProducts: 7 },
    };
    await route.fulfill({ json: { ok: true, data } });
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('http://localhost:5182/analytics');
  await page.locator('#analytics-title').waitFor();
  await page.getByText('Sales revenue', { exact: true }).waitFor();
  return { ready: true, nav: await page.locator('.nav-item').allTextContents() };
};
  const verify = async page => {
  const checks = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  const waitValue = async value => page.waitForFunction(value => document.querySelectorAll('.analytics-metric dd')[2]?.textContent === value, value);
  assert(!(await page.locator('.nav-item').allTextContents()).some(text => ['Featured', 'Specials', 'Price Updates', 'Sales'].includes(text)), 'archived links absent');
  assert(await page.locator('.analytics-metric dd').nth(2).textContent() === '37', 'items sold displayed');
  await page.getByRole('button', { name: 'Today', exact: true }).click();
  await waitValue('0');
  assert(await page.locator('.analytics-empty').isVisible(), 'today empty-state displayed');
  await page.getByRole('button', { name: 'Lifetime', exact: true }).click();
  await waitValue('370');
  assert(await page.getByText('Monthly totals for this range').isVisible(), 'lifetime switches to monthly trend');
  assert(await page.getByLabel('From', { exact: true }).inputValue() === '', 'lifetime does not imply a restricted start date');
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await waitValue('37');
  const expectedLast30 = await page.evaluate(() => new Date(Date.now() + 2 * 3600000 - 29 * 86400000).toISOString().slice(0, 10));
  assert(await page.getByLabel('From', { exact: true }).inputValue() === expectedLast30, 'last 30 days sets calendar dates');
  await page.getByLabel('From', { exact: true }).fill('2026-09-01');
  await page.getByLabel('To', { exact: true }).fill('2026-09-30');
  const custom = page.waitForRequest(request => request.url().includes('start_date=2026-09-01&end_date=2026-09-30'));
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  await custom;
  await page.locator('.analytics-range').filter({ hasText: '2026-09-01 to 2026-09-30' }).waitFor();
  assert(true, 'custom request passes both dates');
  await page.getByLabel('From', { exact: true }).fill('2026-10-10');
  await page.getByRole('button', { name: 'Apply range', exact: true }).click();
  assert(await page.locator('#analytics-date-error').isVisible(), 'reversed date range rejected');
  await page.getByRole('button', { name: 'This month', exact: true }).click();
  await page.locator('.analytics-range').filter({ hasText: 'This month:' }).waitFor();
  await page.getByRole('button', { name: 'Items sold', exact: true }).click();
  assert(await page.getByRole('button', { name: 'Items sold', exact: true }).getAttribute('aria-pressed') === 'true', 'trend metric switch works');
  await page.locator('.analytics-trend-data summary').click();
  assert(await page.locator('.analytics-trend-data table').isVisible(), 'accessible trend table available');
  await page.locator('.analytics-trend-data summary').click();
  await page.route('**/admin-analytics-advanced**', route => route.fulfill({ status: 500, json: { ok: false, error: 'Synthetic analytics failure' } }));
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page.locator('.analytics-error').waitFor();
  assert(await page.locator('.analytics-metrics').count() === 0, 'server failure does not show misleading zeros or stale totals');
  await page.unroute('**/admin-analytics-advanced**');
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await waitValue('37');
  assert(true, 'retry restores report');
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.setAttribute('data-theme', 'light'); });
  await page.waitForTimeout(350);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.analytics-page').parentElement).opacity) > 0.99);
  await page.screenshot({ path: '/tmp/blom-analytics-mobile-light.png', fullPage: true });
  const mobile = await page.locator('.analytics-page').boundingBox();
  assert(mobile.x >= 0 && mobile.x + mobile.width <= 376, '375px analytics content fits viewport');
  const overflow = await page.evaluate(() => [...document.querySelectorAll('.analytics-date-form input, .analytics-presets button, .analytics-metric, .analytics-panel')].filter(el => { const box = el.getBoundingClientRect(); return box.right > window.innerWidth + 1 || box.left < 0; }).map(el => el.className));
  assert(overflow.length === 0, 'mobile date inputs, filters and panels stay within viewport');
  const productStyle = await page.locator('.analytics-product-name').first().evaluate(el => ({ whiteSpace: getComputedStyle(el).whiteSpace, overflow: getComputedStyle(el).overflow, textOverflow: getComputedStyle(el).textOverflow }));
  assert(productStyle.whiteSpace === 'normal' && productStyle.textOverflow === 'clip', 'mobile product names wrap without truncation');
  const surface = await page.locator('.analytics-panel').first().evaluate(el => getComputedStyle(el).backgroundColor);
  assert(surface === 'rgb(255, 255, 255)', 'light panels use the existing surface token');
  await page.evaluate(() => { document.documentElement.classList.add('dark'); document.documentElement.setAttribute('data-theme', 'dark'); });
  await page.waitForTimeout(350);
  await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.analytics-page').parentElement).opacity) > 0.99);
  await page.screenshot({ path: '/tmp/blom-analytics-mobile-dark.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.setAttribute('data-theme', 'light'); });
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/tmp/blom-analytics-desktop-light.png', fullPage: true });
  return { checks };
};
  await setup(page);
  return verify(page);
}
