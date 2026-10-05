import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, FileText, Minus, Plus, Printer, Search, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { moneyZAR, dateTime } from '@/components/formatUtils';
import { invoiceRequest, openInvoicePdf } from '@/lib/inStoreInvoices';

const money = value => moneyZAR(Math.round(Number(value) * 100));

export default function InStoreInvoices() {
  const { id } = useParams();
  const queryClient = useQueryClient();
  const [customer, setCustomer] = useState({ customer_name: '', customer_phone: '', customer_email: '' });
  const [items, setItems] = useState([]);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [saved, setSaved] = useState(null);
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [error, setError] = useState('');
  const requestId = useRef(null);
  const submission = useRef(null);
  const submitting = useRef(false);
  const errorRef = useRef(null);
  const savedRef = useRef(null);

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search.trim()), 250);
    return () => window.clearTimeout(timer);
  }, [search]);
  useEffect(() => { if (error) errorRef.current?.focus(); }, [error]);
  useEffect(() => { if (saved) savedRef.current?.focus(); }, [saved]);
  useEffect(() => {
    if (id) {
      setSaved(null); setItems([]); setSearch(''); setDebouncedSearch(''); setError('');
      setCustomer({ customer_name: '', customer_phone: '', customer_email: '' });
      requestId.current = null; submission.current = null;
    }
  }, [id]);

  const history = useQuery({
    queryKey: ['inStoreInvoices', page], queryFn: () => invoiceRequest(`?page=${page}`),
  });
  const products = useQuery({
    queryKey: ['invoiceProducts', debouncedSearch],
    queryFn: ({ signal }) => invoiceRequest(`?action=products&q=${encodeURIComponent(debouncedSearch)}`, { signal }),
    enabled: !!debouncedSearch && !saved && !id,
  });
  const detail = useQuery({
    queryKey: ['inStoreInvoice', id], queryFn: () => invoiceRequest(`?id=${encodeURIComponent(id)}`), enabled: !!id,
  });
  const invoice = id ? detail.data?.invoice : saved;
  const readOnly = !!invoice || !!id;
  const lines = invoice?.in_store_invoice_items || items;
  const total = invoice ? Number(invoice.total) : items.reduce((sum, item) => sum + item.price_cents * item.quantity, 0) / 100;
  const currentCustomer = invoice || customer;

  const addProduct = product => {
    setItems(previous => {
      const existing = previous.find(item => item.product_id === product.id);
      if (existing) return previous.map(item => item === existing ? { ...item, quantity: Math.min(9999, item.quantity + 1) } : item);
      if (previous.length >= 100) return previous;
      return [...previous, { product_id: product.id, product_name: product.name, sku: product.sku,
        price_cents: Math.round(Number(product.price) * 100), quantity: 1 }];
    });
  };
  const changeQuantity = (productId, quantity) => {
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) return;
    setItems(previous => previous.map(item => item.product_id === productId ? { ...item, quantity } : item));
  };

  const createInvoice = async event => {
    event.preventDefault();
    if (submitting.current) return;
    if (!items.length) { setError('Search for a product and add it to the invoice.'); return; }
    const body = { ...customer, items: items.map(item => ({ product_id: item.product_id,
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
    } catch (failure) { setError(failure.message); }
    finally { submitting.current = false; setBusy(false); }
  };

  const pdfAction = async print => {
    setPdfBusy(true);
    setError('');
    try { await openInvoicePdf(invoice, print); }
    catch (failure) { setError(failure.message); }
    finally { setPdfBusy(false); }
  };
  const newInvoice = () => {
    setSaved(null); setItems([]); setSearch(''); setDebouncedSearch(''); setError('');
    setCustomer({ customer_name: '', customer_phone: '', customer_email: '' });
    requestId.current = null; submission.current = null;
  };

  return (
    <div className="mx-auto max-w-6xl space-y-6 text-foreground">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{invoice ? invoice.invoice_number : id ? 'In-Store Invoice' : 'Create In-Store Invoice'}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{invoice ? `Created ${dateTime(invoice.created_at)}` : 'Add products and customer details, then generate your invoice.'}</p>
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
          <h2 id="invoice-products-heading" className="text-lg font-semibold">{readOnly ? 'Invoice items' : 'Products'}</h2>
          {!readOnly && <fieldset disabled={busy} className="mt-4">
            <Label htmlFor="invoice-search">Search by product name or SKU</Label>
            <div className="relative mt-2">
              <Search aria-hidden="true" className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
              <Input id="invoice-search" type="search" value={search} maxLength={100} onChange={event => setSearch(event.target.value)} className="h-11 pl-9" placeholder="Search BLOM products…" autoComplete="off" />
            </div>
            {search.trim() && <div className="mt-3 max-h-64 overflow-y-auto rounded-md border border-border" aria-label="Product search results">
              {(products.isFetching || search.trim() !== debouncedSearch) ? <p role="status" className="p-3 text-sm text-muted-foreground">Searching products…</p>
                : products.isError ? <div role="alert" className="p-3 text-sm">{products.error.message}<Button type="button" variant="ghost" onClick={() => products.refetch()}>Retry</Button></div>
                : products.data?.data?.length ? products.data.data.map(product => <div key={product.id} className="flex items-center justify-between gap-3 border-b border-border p-3 last:border-0">
                  <div className="min-w-0"><p className="break-words text-sm font-medium">{product.name}</p><p className="text-xs text-muted-foreground">{product.sku ? `${product.sku} · ` : ''}{money(product.price)}</p></div>
                  <Button type="button" variant="outline" disabled={items.length >= 100 && !items.some(item => item.product_id === product.id)} onClick={() => addProduct(product)} aria-label={`Add ${product.name}`}><Plus aria-hidden="true" />Add</Button>
                </div>) : <p role="status" className="p-3 text-sm text-muted-foreground">No products found. Try another name or SKU.</p>}
            </div>}
          </fieldset>}

          <div className="mt-6 space-y-4">
            {!lines.length && <p className="border-t border-border py-8 text-sm text-muted-foreground">Search for a product above to add your first invoice item.</p>}
            {lines.map(item => <div key={item.product_id} className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_auto]">
              <div className="min-w-0"><p className="break-words font-medium">{item.product_name}</p><p className="mt-1 text-sm text-muted-foreground">Unit price: {readOnly ? money(item.unit_price) : moneyZAR(item.price_cents)}</p></div>
              <div className="flex flex-wrap items-center justify-between gap-3 sm:justify-end">
                {readOnly ? <span className="text-sm">Qty: {item.quantity}</span> : <div className="flex items-center gap-1">
                  <Button type="button" variant="outline" className="h-11 w-11 px-0" disabled={busy || item.quantity <= 1} aria-label={`Decrease ${item.product_name} quantity`} onClick={() => changeQuantity(item.product_id, item.quantity - 1)}><Minus aria-hidden="true" /></Button>
                  <Input type="number" min={1} max={9999} step={1} inputMode="numeric" required disabled={busy} value={item.quantity} aria-label={`Quantity for ${item.product_name}`} onChange={event => changeQuantity(item.product_id, Number(event.target.value))} className="h-11 w-16 px-1 text-center" />
                  <Button type="button" variant="outline" className="h-11 w-11 px-0" disabled={busy || item.quantity >= 9999} aria-label={`Increase ${item.product_name} quantity`} onClick={() => changeQuantity(item.product_id, item.quantity + 1)}><Plus aria-hidden="true" /></Button>
                </div>}
                <span className="min-w-20 text-right font-medium tabular-nums">{readOnly ? money(item.line_total) : moneyZAR(item.price_cents * item.quantity)}</span>
                {!readOnly && <Button type="button" variant="ghost" className="h-11 w-11 px-0" disabled={busy} aria-label={`Remove ${item.product_name}`} onClick={() => setItems(previous => previous.filter(line => line.product_id !== item.product_id))}><Trash2 aria-hidden="true" /></Button>}
              </div>
            </div>)}
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
            <div className="flex justify-between gap-3 text-sm"><dt>Subtotal</dt><dd>{money(total)}</dd></div>
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

      <section className="rounded-lg border border-border bg-card p-4 sm:p-6" aria-labelledby="saved-invoices-heading">
        <h2 id="saved-invoices-heading" className="text-lg font-semibold">Saved in-store invoices</h2>
        {history.isPending ? <p role="status" className="mt-4 text-sm">Loading invoices…</p>
          : history.isError ? <div role="alert" className="mt-4 text-sm">{history.error.message}<Button type="button" variant="ghost" onClick={() => history.refetch()}>Retry</Button></div>
          : !history.data?.data?.length ? <p className="mt-4 text-sm text-muted-foreground">Your saved invoices will appear here.</p>
          : <ul className="mt-4 divide-y divide-border">{history.data.data.map(record => <li key={record.id}>
            <Link to={`/in-store-invoices/${record.id}`} className="flex flex-wrap items-center justify-between gap-3 rounded-md py-4 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
              <div className="min-w-0"><p className="font-medium">{record.invoice_number}</p><p className="break-words text-sm text-muted-foreground">{record.customer_name} · {dateTime(record.created_at)}</p></div>
              <span className="font-medium tabular-nums">{money(record.total)}</span>
            </Link>
          </li>)}</ul>}
        {(history.data?.count || 0) > 20 && <div className="mt-4 flex items-center justify-between gap-3">
          <Button type="button" variant="outline" disabled={page === 1} onClick={() => setPage(previous => previous - 1)}>Previous</Button>
          <span className="text-sm text-muted-foreground">Page {page} of {Math.ceil(history.data.count / 20)}</span>
          <Button type="button" variant="outline" disabled={page * 20 >= history.data.count} onClick={() => setPage(previous => previous + 1)}>Next</Button>
        </div>}
      </section>
    </div>
  );
}
