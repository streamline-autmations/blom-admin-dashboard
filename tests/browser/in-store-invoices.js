async page => {
  // Use the synthetic local server configuration documented in in-store-invoices.md.
  await page.unrouteAll();
  const user = { id: '11111111-1111-4111-8111-111111111111', email: 'staff@example.invalid', aud: 'authenticated', role: 'authenticated' };
  await page.addInitScript(({ user }) => {
    localStorage.setItem('blom-admin-auth', JSON.stringify({ access_token: 'synthetic-test-session', refresh_token: 'synthetic-refresh', token_type: 'bearer', expires_at: 4102444800, user }));
  }, { user });
  await page.route('**/*', route => {
    const url = route.request().url();
    return url.startsWith('http://localhost:5182/') || url.startsWith('https://example.invalid/') || url.startsWith('blob:') ? route.continue() : route.abort();
  });
  await page.route('https://example.invalid/**', route => route.fulfill({ json: route.request().url().includes('/profiles') ? { app_role: 'staff' } : [] }));
  const commonId = '22222222-2222-4222-8222-222222222222';
  const courseId = '33333333-3333-4333-8333-333333333333';
  const catalog = [
    { id: commonId, name: 'BLOM Rubber Base Coat 15ml', item_type: 'product', price: 125.55 },
    { id: commonId, name: 'BLOM Complete Starter Bundle', item_type: 'bundle', price: 499.50 },
    { id: courseId, name: 'BLOM Professional Acrylic Training — Standard', item_type: 'course', course_package_index: 0, price: 7600 },
    { id: courseId, name: 'BLOM Professional Acrylic Training — Deluxe', item_type: 'course', course_package_index: 1, price: 9900 },
  ];
  let saved;
  let posts = 0;
  const checks = [];
  const assert = (condition, label) => { if (!condition) throw new Error(label); checks.push(label); };
  const history = Array.from({ length: 12 }, (_, index) => ({ id: `aaaaaaaa-aaaa-4aaa-8aaa-${String(index + 1).padStart(12, '0')}`, invoice_number: `INV-20261001-${String(index + 1).padStart(3, '0')}`, created_at: '2026-10-01T09:00:00Z', customer_name: index === 0 ? 'Jane Historical Customer' : `Customer ${index + 1}`, total: 250 }));
  const paramsFor = url => Object.fromEntries((url.split('?')[1] || '').split('&').map(part => part.split('=').map(decodeURIComponent)));
  // Minimal valid PDF fixture for download/print-window plumbing. Real branding,
  // pagination and totals are covered by the isolated renderer tests.
  const content = 'BT /F1 16 Tf 50 750 Td (Synthetic invoice preview) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  await page.route('**/.netlify/functions/**', async route => {
    const url = route.request().url();
    if (!url.split('?')[0].endsWith('admin-in-store-invoices')) return route.fulfill({ json: { ok: true, data: [], counts: {} } });
    const params = paramsFor(url);
    if (params.action === 'products') return route.fulfill({ json: { data: catalog.filter(item => item.name.toLowerCase().includes((params.q || '').toLowerCase())) } });
    if (params.action === 'pdf') {
      return route.fulfill({ contentType: 'application/pdf', body: pdf });
    }
    if (route.request().method() === 'POST') {
      posts++;
      const body = route.request().postDataJSON();
      const lines = body.items.map((line, index) => {
        const source = catalog.find(item => item.id === line.product_id && item.item_type === line.item_type && (item.course_package_index ?? null) === line.course_package_index);
        if (!source) throw new Error('Incorrect catalog identity submitted');
        return { ...line, position: index + 1, product_name: source.name, unit_price: source.price, line_total: source.price * line.quantity };
      });
      saved = { id: '44444444-4444-4444-8444-444444444444', invoice_number: 'INV-20261005-001', created_at: '2026-10-05T09:00:00Z', ...body, banking_details: { is_placeholder: 'true' }, in_store_invoice_items: lines, total: lines.reduce((sum, item) => sum + item.line_total, 0) };
      return route.fulfill({ status: 201, json: { invoice: saved } });
    }
    if (params.id) return route.fulfill({ json: { invoice: saved } });
    const matches = (saved ? [saved, ...history] : history).filter(item => `${item.invoice_number} ${item.customer_name}`.toLowerCase().includes((params.q || '').toLowerCase()));
    const offset = (Number(params.page || 1) - 1) * 5;
    return route.fulfill({ json: { data: matches.slice(offset, offset + 5), count: matches.length, page_size: 5, banking_configured: false } });
  });
  await page.setViewportSize({ width: 1440, height: 1050 });
  await page.goto('http://localhost:5182/in-store-invoices');
  await page.locator('#invoice-name').waitFor();
  assert(!(await page.locator('details').last().getAttribute('open')), 'history starts compact and collapsed');
  await page.locator('#invoice-search').fill('BASE-15');
  await page.getByText('No items found. Try another name.').waitFor();
  assert(true, 'SKU-only query does not match product names');
  await page.locator('#invoice-search').fill('BLOM');
  for (const item of catalog) await page.getByRole('button', { name: `Add ${item.name}`, exact: true }).click();
  assert(await page.getByRole('spinbutton').count() === 4, 'product, bundle and two course packages have independent lines');
  await page.getByRole('button', { name: `Increase ${catalog[0].name} quantity`, exact: true }).click();
  assert(await page.getByRole('spinbutton', { name: `Quantity for ${catalog[0].name}` }).inputValue() === '2', 'plus quantity control increments once');
  assert(await page.getByRole('spinbutton', { name: `Quantity for ${catalog[1].name}` }).inputValue() === '1', 'same UUID in bundle catalog remains independent');
  await page.getByRole('button', { name: `Remove ${catalog[2].name}`, exact: true }).click();
  assert(await page.getByRole('spinbutton').count() === 3, 'removing one course package leaves the other selected');
  await page.locator('#invoice-name').fill('Jane Smith');
  await page.locator('#invoice-phone').fill('0820000000');
  await page.locator('#invoice-email').fill('jane@example.invalid');
  await page.locator('#invoice-search').fill('');
  assert((await page.locator('dl').innerText()).includes('R 10650.60'), 'running total uses all catalog prices');
  assert(!(await page.locator('dl').innerText()).includes('Subtotal'), 'form shows total only');
  await page.evaluate(() => { document.documentElement.classList.remove('dark'); document.documentElement.setAttribute('data-theme', 'light'); });
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/tmp/blom-invoices-updated-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(350);
  await page.screenshot({ path: '/tmp/blom-invoices-updated-mobile.png', fullPage: true });
  const overflow = await page.locator('.in-store-invoices').evaluate(el => el.getBoundingClientRect().right > innerWidth || el.scrollWidth > el.clientWidth + 1);
  assert(!overflow, '375px creator does not overflow or crop content');
  await page.getByRole('button', { name: 'Generate Invoice', exact: true }).click();
  await page.getByRole('heading', { name: 'INV-20261005-001', exact: true }).waitFor();
  assert(posts === 1, 'one mixed invoice submission');
  const details = page.locator('details').last();
  assert(await details.getAttribute('open') !== null, 'saving expands invoice history');
  assert(await details.locator('li').count() === 5, 'large history displays only five rows');
  const historySearchBox = await details.locator('form').boundingBox();
  assert(historySearchBox.height < 180, 'mobile history search has no oversized blank gaps');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await details.getByText('2 / 3', { exact: true }).waitFor();
  assert(await details.locator('li').count() === 5, 'next history page loads');
  await page.locator('#invoice-history-search').fill('Jane');
  await details.getByRole('button', { name: 'Search', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.in-store-invoices details ul')?.children.length === 2);
  assert(await details.getByRole('button', { name: 'Next', exact: true }).count() === 0, 'search resets pagination and finds customer matches');
  await page.locator('#invoice-history-search').fill('not-a-customer');
  await details.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByText('No invoices match this search.').waitFor();
  assert(true, 'history empty-search state is clear');
  await details.getByRole('button', { name: 'Clear', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('.in-store-invoices details ul')?.children.length === 5);
  assert(true, 'clearing search restores newest invoices');
  const downloadEvent = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download PDF', exact: true }).click();
  const download = await downloadEvent;
  assert(download.suggestedFilename() === 'INV-20261005-001.pdf', 'PDF download uses generated invoice number');
  await download.saveAs('/tmp/blom-updated-invoice-browser-download.pdf');
  const popupEvent = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Print Invoice', exact: true }).click();
  const popup = await popupEvent;
  await popup.locator('iframe').waitFor();
  assert(await popup.getByRole('button', { name: 'Print Invoice', exact: true }).isVisible(), 'print window has invoice iframe and explicit print action');
  await popup.close();
  await page.screenshot({ path: '/tmp/blom-invoices-updated-history-mobile.png', fullPage: true });
  await details.getByRole('link', { name: /INV-20261005-001 Jane Smith/ }).click();
  await page.getByRole('heading', { name: 'INV-20261005-001', exact: true }).waitFor();
  await page.reload();
  await page.getByRole('heading', { name: 'INV-20261005-001', exact: true }).waitFor();
  assert((await page.locator('dl').innerText()).includes('R 10650.60'), 'saved invoice reopens after reload');
  return { checks, posts, mobileOverflow: overflow };
}
