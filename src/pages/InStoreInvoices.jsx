import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, FileText, Minus, Plus, Printer, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { moneyZAR, dateTime } from '@/components/formatUtils';
import { invoiceRequest, openInvoicePdf } from '@/lib/inStoreInvoices';
import './InStoreInvoices.css';

const money = value => moneyZAR(Math.round(Number(value) * 100));
const itemKey = item => `${item.item_type || 'product'}:${item.product_id || item.id}:${item.course_package_index ?? ''}`;
const itemLabel = type => ({ product: 'Product', bundle: 'Bundle', course: 'Course' })[type || 'product'];
const normalise = value => value.toLocaleLowerCase('en-ZA').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const maxResults = 40;

// Every typed word must appear in the name; names starting with the search rank first.
function searchCatalog(catalog, search) {
  const words = normalise(search).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const phrase = words.join(' ');
  return catalog
    .map(item => ({ item, name: normalise(item.name) }))
    .filter(({ name }) => words.every(word => name.includes(word)))
    .sort((a, b) => Number(!a.name.startsWith(phrase)) - Number(!b.name.startsWith(phrase)))
    .slice(0, maxResults)
    .map(({ item }) => item);
}

export default function InStoreInvoices() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', customer_email: '' });
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [activeResult, setActiveResult] = useState(0);
  const [lastAdded, setLastAdded] = useState('');
  const [saved, setSaved] = useState(null);
  const [page, setPage] = useState(1);
  const [historySearch, setHistorySearch] = useState('');
  const [historyFilter, setHistoryFilter] = useState('');
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleting, setDeleting] = useState(false);
  const requestId = useRef(null);
  const submission = useRef(null);
  const submitting = useRef(false);
  const errorRef = useRef(null);
  const savedRef = useRef(null);
  const historyRef = useRef(null);
  const searchRef = useRef(null);
  const resultsRef = useRef(null);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => {
    if (saved) {
      savedRef.current?.focus();
      if (historyRef.current) historyRef.current.open = true;
    }
  }, [saved]);
  useEffect(() => {
    if (id) {
      setSaved(null); setItems([]); setSearch(''); setLastAdded(''); setError('');
      setCustomer({ customer_name: '', customer_phone: '', customer_email: '' });
      requestId.current = null; submission.current = null;
    }
  }, [id]);

  const history = useQuery({
    queryKey: ['inStoreInvoices', page, historyFilter],
    queryFn: ({ signal }) => invoiceRequest(`?page=${page}&q=${encodeURIComponent(historyFilter)}`, { signal }),
    staleTime: 30_000,
    placeholderData: previous => previous,
  });
  // The whole catalog is a few hundred rows: load it once and search it locally so
  // results appear as she types. The server still re-checks prices on save.
  const catalog = useQuery({
    queryKey: ['invoiceCatalog'],
    queryFn: ({ signal }) => invoiceRequest('?action=catalog', { signal }),
    staleTime: 5 * 60_000,
    enabled: !saved && !id,
  });
  // Saved invoices never change, so the copy already in the history list is enough to open one.
  const cachedInvoice = invoiceId => queryClient.getQueriesData({ queryKey: ['inStoreInvoices'] })
    .flatMap(([, data]) => data?.data || []).find(record => record.id === invoiceId && record.in_store_invoice_items);
  const detail = useQuery({
    queryKey: ['inStoreInvoice', id],
    queryFn: () => invoiceRequest(`?id=${encodeURIComponent(id)}`),
    enabled: !!id,
    staleTime: Infinity,
    initialData: () => {
      const record = id && cachedInvoice(id);
      return record ? { invoice: record } : undefined;
    },
  });
  const prefetchInvoice = invoiceId => {
    if (cachedInvoice(invoiceId)) return;
    queryClient.prefetchQuery({ queryKey: ['inStoreInvoice', invoiceId],
      queryFn: () => invoiceRequest(`?id=${encodeURIComponent(invoiceId)}`), staleTime: Infinity });
  };
  // A failed refetch keeps old data; never offer (or Enter-add) results that are not on screen.
  const results = useMemo(() => catalog.isError ? [] : searchCatalog(catalog.data?.data || [], search), [catalog.data, catalog.isError, search]);
  useEffect(() => { setActiveResult(0); }, [search]);
  useEffect(() => {
    resultsRef.current?.querySelector(`[data-result-index="${activeResult}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [activeResult]);
  const invoice = id ? detail.data?.invoice : saved;
  const readOnly = !!invoice || !!id;
  const lines = invoice?.in_store_invoice_items || items;
  const total = invoice ? Number(invoice.total) : items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0) / 100;
  const currentCustomer = invoice || customer;

  const quantities = new Map(items.map(item => [itemKey(item), item.quantity]));
  const addProduct = product => {
    if (items.length >= 100 && !quantities.has(itemKey(product))) return;
    setLastAdded(`Added ${product.name}`);
    setItems(previous => {
      const existing = previous.find(item => itemKey(item) === itemKey(product));
      if (existing) return previous.map(item => item === existing ? { ...item, quantity: Math.min(9999, item.quantity + 1) } : item);
      if (previous.length >= 100) return previous;
      return [...previous, { product_id: product.id, product_name: product.name, item_type: product.item_type || 'product',
        course_package_index: product.course_package_index ?? null,
        price_cents: Math.round(Number(product.price) * 100), quantity: 1 }];
    });
  };
  const onSearchKeyDown = event => {
    if (event.key === 'ArrowDown' && results.length) { event.preventDefault(); setActiveResult(index => Math.min(results.length - 1, index + 1)); }
    else if (event.key === 'ArrowUp' && results.length) { event.preventDefault(); setActiveResult(index => Math.max(0, index - 1)); }
    else if (event.key === 'Enter') { event.preventDefault(); if (results[activeResult]) addProduct(results[activeResult]); }
    else if (event.key === 'Escape' && search) { event.preventDefault(); setSearch(''); }
  };
  const changeQuantity = (key, quantity) => {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) return;
    setItems(previous => previous.map(item => itemKey(item) === key ? { ...item, quantity } : item));
  };

  const createInvoice = async event => {
    event.preventDefault();
    if (submitting.current) return;
    if (!items.length) { setError('Search for an item and add it to the invoice.'); return; }
    const body = { ...customer, items: items.map(item => ({ product_id: item.product_id,
      item_type: item.item_type, course_package_index: item.course_package_index,
      quantity: item.quantity, expected_price_cents: item.price_cents })) };
    const serialized = JSON.stringify(body);
    // A retry of unchanged input keeps its request ID; edited input is a new submission.
    if (submission.current !== serialized) {
      requestId.current = crypto.randomUUID();
      submission.current = serialized;
    }
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await invoiceRequest('', { method: 'POST', body: JSON.stringify({ ...body, request_id: requestId.current }) });
      setSaved(result.invoice);
      queryClient.invalidateQueries({ queryKey: ['inStoreInvoices'] });
    } catch (failure) {
      setError(failure.message);
      // A rejection is often a changed price: reload the catalog so re-adding uses the current one.
      queryClient.invalidateQueries({ queryKey: ['invoiceCatalog'] });
    }
    finally { submitting.current = false; setBusy(false); }
  };

  const pdfAction = async print => {
    setPdfBusy(true);
    setError('');
    try { await openInvoicePdf(invoice, print); }
    catch (failure) { setError(failure.message); }
    finally { setPdfBusy(false); }
  };
  const deleteInvoice = async record => {
    setDeleting(true);
    setError('');
    try {
      await invoiceRequest(`?id=${encodeURIComponent(record.id)}`, { method: 'DELETE' });
      setConfirmDelete(null);
      queryClient.removeQueries({ queryKey: ['inStoreInvoice', record.id] });
      if (history.data?.data?.length === 1 && page > 1) setPage(previous => previous - 1);
      await queryClient.invalidateQueries({ queryKey: ['inStoreInvoices'] });
      if (id === record.id) navigate('/in-store-invoices');
      else if (saved?.id === record.id) newInvoice();
    } catch (failure) { setError(failure.message); }
    finally { setDeleting(false); }
  };
  const newInvoice = () => {
    setSaved(null); setItems([]); setSearch(''); setLastAdded(''); setError('');
    setCustomer({ customer_name: '', customer_phone: '', customer_email: '' });
    requestId.current = null; submission.current = null;
  };

  return (
    <div className="in-store-invoices mx-auto max-w-6xl space-y-6 text-foreground">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{invoice ? invoice.invoice_number : id ? 'In-Store Invoice' : 'Create In-Store Invoice'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{invoice ? `Created ${dateTime(invoice.created_at)}` : 'Add items and customer details, then generate your invoice.'}</p>
        </div>
        {(saved || id) && (id ? <Button asChild variant="outline"><Link to="/in-store-invoices">Create In-Store Invoice</Link></Button>
          : <Button type="button" variant="outline" onClick={newInvoice}><Plus aria-hidden="true" />Create another invoice</Button>)}
      </header>

      {error && <div ref={errorRef} role="alert" tabIndex={-1} className="rounded-md border border-destructive p-4 text-sm">{error}</div>}
      {id && detail.isPending && <p role="status">Loading invoice…</p>}
      {id && detail.isError && <div role="alert">{detail.error.message}<Button variant="outline" onClick={() => detail.refetch()} className="ml-3">Retry</Button></div>}
      {saved && <p ref={savedRef} tabIndex={-1} role="status" className="rounded-md border border-border bg-card p-4 text-sm">Invoice saved. You can download or print it below, or reopen it from saved invoices.</p>}

      {(!id || invoice) && <form onSubmit={createInvoice} className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0 rounded-lg border border-border bg-card p-4 sm:p-6" aria-labelledby="invoice-products-heading">
          <h2 id="invoice-products-heading" className="text-lg font-semibold">{readOnly ? 'Invoice items' : 'Add items'}</h2>
          {!readOnly && <fieldset disabled={busy} className="mt-4">
            <Label htmlFor="invoice-search" className="text-base">Search products, bundles and courses by name</Label>
            <div className="relative mt-2">
              <Search aria-hidden="true" className="invoice-search-icon pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2" />
              <Input id="invoice-search" ref={searchRef} type="search" value={search} maxLength={100}
                onChange={event => setSearch(event.target.value)} onKeyDown={onSearchKeyDown}
                className="invoice-search-input h-14 pl-12 text-lg" placeholder="Start typing a name…" autoComplete="off"
                role="combobox" aria-expanded={!!search.trim()} aria-controls="invoice-search-results" aria-autocomplete="list"
                aria-activedescendant={results.length ? `invoice-result-${activeResult}` : undefined} />
            </div>
            <p className="sr-only" role="status" aria-live="polite">{lastAdded}</p>
            {search.trim() && <div ref={resultsRef} id="invoice-search-results" role="listbox" aria-label="Search results"
              className="invoice-search-results mt-2 max-h-[22rem] overflow-y-auto rounded-md">
              {catalog.isPending ? <p role="status" className="p-4 text-base">Loading products…</p>
                : catalog.isError ? <div role="alert" className="p-4 text-base">{catalog.error.message}<Button type="button" variant="ghost" onClick={() => catalog.refetch()}>Retry</Button></div>
                : results.length ? results.map((product, index) => {
                  const added = quantities.get(itemKey(product));
                  const full = items.length >= 100 && !added;
                  return <button type="button" key={itemKey(product)} id={`invoice-result-${index}`} data-result-index={index}
                    role="option" aria-selected={index === activeResult} disabled={full}
                    data-active={index === activeResult || undefined} data-added={!!added || undefined}
                    onMouseEnter={() => setActiveResult(index)}
                    onClick={() => { addProduct(product); searchRef.current?.focus(); }}
                    className="invoice-result flex w-full items-center justify-between gap-3 px-4 py-3 text-left disabled:opacity-50">
                    <span className="min-w-0">
                      <span className="block break-words text-base font-medium">{product.name}</span>
                      <span className="invoice-result-meta block text-sm">{itemLabel(product.item_type)} · {money(product.price)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      {added && <span className="invoice-added-badge inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-sm font-semibold">
                        <Check aria-hidden="true" className="h-4 w-4" />On invoice{added > 1 ? ` (${added})` : ''}
                      </span>}
                      <span className="invoice-result-add inline-flex h-10 items-center gap-1 rounded-md px-3 text-sm font-semibold">
                        <Plus aria-hidden="true" className="h-4 w-4" />{added ? 'Add 1 more' : 'Add'}
                      </span>
                    </span>
                  </button>;
                }) : <p role="status" className="p-4 text-base">No items found. Try another name.</p>}
            </div>}
            {search.trim() && results.length > 1 && <p className="mt-2 hidden text-sm text-muted-foreground sm:block">Tip: use the ↑ ↓ keys and press Enter to add, or Esc to clear the search.</p>}
          </fieldset>}

          <div className="invoice-lines mt-6 rounded-md p-3 sm:p-4">
            <h3 className="px-1 text-base font-semibold">{readOnly ? 'Items' : 'On this invoice'}{lines.length ? ` (${lines.length})` : ''}</h3>
            {!lines.length && <p className="px-1 py-6 text-base text-muted-foreground">Nothing added yet. Search by name above and tap an item to add it.</p>}
            <div className="mt-3 space-y-2">
            {lines.map(item => <div key={itemKey(item)} className="invoice-line grid gap-3 rounded-md p-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div className="min-w-0"><p className="break-words text-base font-medium">{item.product_name}</p><p className="mt-1 text-sm text-muted-foreground">{itemLabel(item.item_type)} · Unit price: {readOnly ? money(item.unit_price) : moneyZAR(item.price_cents)}</p></div>
              <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
                {readOnly ? <span className="text-sm">Qty: {item.quantity}</span> : <div className="flex items-center gap-1">
                  <Button type="button" variant="outline" className="h-11 w-11 px-0" disabled={busy || item.quantity <= 1} aria-label={`Decrease ${item.product_name} quantity`} onClick={() => changeQuantity(itemKey(item), item.quantity - 1)}><Minus aria-hidden="true" /></Button>
                  <Input type="number" min={1} max={9999} step={1} inputMode="numeric" required disabled={busy} value={item.quantity} aria-label={`Quantity for ${item.product_name}`} onChange={event => changeQuantity(itemKey(item), Number(event.target.value))} className="h-11 w-16 px-1 text-center" />
                  <Button type="button" variant="outline" className="h-11 w-11 px-0" disabled={busy || item.quantity >= 9999} aria-label={`Increase ${item.product_name} quantity`} onClick={() => changeQuantity(itemKey(item), item.quantity + 1)}><Plus aria-hidden="true" /></Button>
                </div>}
                <span className="min-w-20 text-right font-medium tabular-nums">{readOnly ? money(item.line_total) : moneyZAR(item.price_cents * item.quantity)}</span>
                {!readOnly && <Button type="button" variant="ghost" className="h-11 w-11 px-0" disabled={busy} aria-label={`Remove ${item.product_name}`} onClick={() => setItems(previous => previous.filter(line => itemKey(line) !== itemKey(item)))}><Trash2 aria-hidden="true" /></Button>}
              </div>
            </div>)}
            </div>
          </div>
        </section>

        <aside className="space-y-5 rounded-lg border border-border bg-card p-4 sm:p-6">
          <h2 className="text-lg font-semibold">Customer</h2>
          <fieldset disabled={busy || readOnly} className="space-y-4">
            <div><Label htmlFor="invoice-name">Customer name</Label><Input id="invoice-name" className="mt-2 h-11" autoComplete="name" maxLength={160} required value={currentCustomer.customer_name || ''} onChange={event => setCustomer(previous => ({ ...previous, customer_name: event.target.value }))} /></div>
            <div><Label htmlFor="invoice-phone">Phone number <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="invoice-phone" className="mt-2 h-11" type="tel" autoComplete="tel" maxLength={40} value={currentCustomer.customer_phone || ''} onChange={event => setCustomer(previous => ({ ...previous, customer_phone: event.target.value }))} /></div>
            <div><Label htmlFor="invoice-email">Email <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="invoice-email" className="mt-2 h-11" type="email" autoComplete="email" maxLength={254} value={currentCustomer.customer_email || ''} onChange={event => setCustomer(previous => ({ ...previous, customer_email: event.target.value }))} /></div>
          </fieldset>
          <dl aria-live="polite" className="space-y-3 border-t border-border pt-5 tabular-nums">
            <div className="flex justify-between gap-3 text-xl font-semibold"><dt>Total</dt><dd>{money(total)}</dd></div>
          </dl>
          {((invoice?.banking_details?.is_placeholder === 'true') || (!readOnly && history.data?.banking_configured === false)) && <p className="text-sm text-muted-foreground">Banking details are placeholders. Confirm them before sharing this invoice for payment.</p>}
          {invoice ? <div className="space-y-3">
            <Button type="button" disabled={pdfBusy} className="w-full" onClick={() => pdfAction(false)}><Download aria-hidden="true" />{pdfBusy ? 'Preparing PDF…' : 'Download PDF'}</Button>
            <Button type="button" variant="outline" disabled={pdfBusy} className="w-full" onClick={() => pdfAction(true)}><Printer aria-hidden="true" />Print Invoice</Button>
            <p className="break-words text-sm text-muted-foreground">Please use {invoice.invoice_number} as your payment reference when making payment.</p>
          </div> : <Button type="submit" disabled={busy || !items.length} className="w-full"><FileText aria-hidden="true" />{busy ? 'Saving invoice…' : 'Generate Invoice'}</Button>}
        </aside>
      </form>}

      <details ref={historyRef} className="min-w-0 rounded-lg border border-border bg-card p-4 sm:p-6">
        <summary className="cursor-pointer rounded-sm text-lg font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Saved invoices{history.data?.count != null && !historyFilter ? ` (${history.data.count})` : ''}
        </summary>
        <form className="invoice-history-search mt-4 flex flex-wrap items-end gap-2" onSubmit={event => { event.preventDefault(); setHistoryFilter(historySearch.trim()); setPage(1); }}>
          <div className="min-w-0 flex-1 basis-64">
            <Label htmlFor="invoice-history-search">Find by invoice number or customer name</Label>
            <Input id="invoice-history-search" type="search" className="mt-2 h-11" value={historySearch} maxLength={100} onChange={event => setHistorySearch(event.target.value)} placeholder="Invoice number or customer name…" />
          </div>
          <Button type="submit" className="h-11" disabled={history.isFetching}>Search</Button>
          {historyFilter && <Button type="button" className="h-11" variant="outline" onClick={() => { setHistorySearch(''); setHistoryFilter(''); setPage(1); }}>Clear</Button>}
        </form>
        {historyFilter && <p className="mt-3 break-words text-sm text-muted-foreground">Results for “{historyFilter}”</p>}
        {history.isPending ? <p role="status" className="mt-4 text-sm">Loading invoices…</p>
          : history.isError ? <div role="alert" className="mt-4 text-sm">{history.error.message}<Button type="button" variant="ghost" onClick={() => history.refetch()}>Retry</Button></div>
          : !history.data?.data?.length ? <p role="status" className="mt-4 text-sm text-muted-foreground">{historyFilter ? 'No invoices match this search.' : 'Your saved invoices will appear here.'}</p>
          : <ul className="mt-4 divide-y divide-border">{history.data.data.map(record => <li key={record.id} className="py-1">
            <div className="invoice-history-row flex items-stretch gap-1.5">
              <Link to={`/in-store-invoices/${record.id}`} onMouseEnter={() => prefetchInvoice(record.id)} onFocus={() => prefetchInvoice(record.id)}
                className="invoice-history-link flex min-w-0 flex-1 flex-wrap items-center justify-between gap-3 rounded-md px-3 py-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                <div className="min-w-0 flex-1 basis-48"><p className="break-words font-medium">{record.invoice_number}</p><p className="break-words text-sm">{record.customer_name}</p><p className="text-xs text-muted-foreground">{dateTime(record.created_at)}</p></div>
                <span className="shrink-0 font-medium tabular-nums">{money(record.total)} <span className="ml-2 text-sm text-muted-foreground">View →</span></span>
              </Link>
              {confirmDelete !== record.id && <Button type="button" variant="ghost" className="invoice-delete h-auto min-h-11 w-11 shrink-0 self-center px-0"
                aria-label={`Delete invoice ${record.invoice_number}`} title="Delete invoice" disabled={deleting}
                onClick={() => setConfirmDelete(record.id)}><Trash2 aria-hidden="true" /></Button>}
            </div>
            {confirmDelete === record.id && <div role="alertdialog" aria-labelledby={`delete-${record.id}`} className="invoice-delete-confirm mb-2 mt-1 flex flex-wrap items-center justify-between gap-3 rounded-md p-3">
              <p id={`delete-${record.id}`} className="text-base font-medium">Delete {record.invoice_number} for {record.customer_name}? This cannot be undone.</p>
              <div className="flex flex-wrap gap-2">
                <Button type="button" variant="outline" className="h-11" disabled={deleting} onClick={() => setConfirmDelete(null)}>Keep invoice</Button>
                <Button type="button" variant="destructive" className="h-11" disabled={deleting} onClick={() => deleteInvoice(record)}>
                  <Trash2 aria-hidden="true" />{deleting ? 'Deleting…' : 'Yes, delete'}</Button>
              </div>
            </div>}
          </li>)}</ul>}
        {(history.data?.count || 0) > (history.data?.page_size || 5) && <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <Button type="button" variant="outline" className="h-11" disabled={page === 1 || history.isFetching} onClick={() => setPage(previous => previous - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">{page} / {Math.ceil(history.data.count / (history.data.page_size || 5))}</span>
          <Button type="button" variant="outline" className="h-11" disabled={page * (history.data.page_size || 5) >= history.data.count || history.isFetching} onClick={() => setPage(previous => previous + 1)}>Next</Button>
        </div>}
      </details>
    </div>
  );
}
