import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell, TableCaption } from '@/components/ui/table';
import { moneyZAR } from '@/components/formatUtils';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer } from 'recharts';
import './Analytics.css';

const presets = [['today', 'Today'], ['month', 'This month'], ['30', 'Last 30 days'], ['lifetime', 'Lifetime']];
const count = value => new Intl.NumberFormat('en-ZA', { maximumFractionDigits: 1 }).format(value || 0);
const dateLabel = (value, monthly = false) => new Date(`${value}T12:00:00+02:00`).toLocaleDateString('en-ZA', monthly ? { month: 'short', year: 'numeric' } : { day: 'numeric', month: 'short', year: 'numeric' });
function presetDates(preset) {
  const localNow = new Date(Date.now() + 2 * 3600000);
  const end = localNow.toISOString().slice(0, 10);
  const start = preset === 'lifetime' ? '' : preset === 'month' ? `${end.slice(0, 7)}-01` : preset === '30'
    ? new Date(localNow.getTime() - 29 * 86400000).toISOString().slice(0, 10) : end;
  return { start, end };
}

function Metric({ title, value, note }) {
  return <div className="analytics-metric"><dt>{title}</dt><dd>{value}</dd><p>{note}</p></div>;
}

export default function Analytics() {
  const [selection, setSelection] = useState({ preset: 'month' });
  const [draft, setDraft] = useState(() => presetDates('month'));
  const [dateError, setDateError] = useState('');
  const [chartMetric, setChartMetric] = useState('revenueCents');
  const params = selection.preset === 'custom'
    ? `start_date=${selection.start}&end_date=${selection.end}` : `period=${selection.preset}`;
  const report = useQuery({
    queryKey: ['admin-analytics-advanced', params],
    queryFn: async ({ signal }) => {
      const response = await fetch(`/.netlify/functions/admin-analytics-advanced?${params}`, { signal });
      const json = await response.json();
      if (!response.ok || !json.ok) throw new Error(json.error || 'Unable to load analytics.');
      return json.data;
    },
    staleTime: 60000, retry: 1,
  });
  const data = report.data;
  const summary = data?.summary;
  const monthly = data?.period.bucket === 'month';
  const choosePreset = preset => {
    setSelection({ preset }); setDraft(presetDates(preset)); setDateError('');
  };
  const applyDates = event => {
    event.preventDefault();
    if (!draft.start || !draft.end || draft.start > draft.end) {
      setDateError('Choose a start date on or before the end date.'); return;
    }
    setDateError(''); setSelection({ preset: 'custom', ...draft });
  };
  const rangeText = data?.period.start
    ? `${dateLabel(data.period.start)} – ${dateLabel(data.period.end)}` : 'All recorded sales';

  return <section className="analytics-page" aria-labelledby="analytics-title">
    <header className="analytics-heading">
      <div><h1 id="analytics-title"><BarChart3 aria-hidden="true" />Analytics</h1><p>Sales, products and customers at a glance.</p></div>
      <Button variant="outline" onClick={() => report.refetch()} disabled={report.isFetching}>
        <RefreshCw aria-hidden="true" />Refresh
      </Button>
    </header>

    <div className="analytics-filters">
      <div className="analytics-presets" role="group" aria-label="Quick date filters">
        {presets.map(([key, label]) => <Button key={key} variant={selection.preset === key ? 'default' : 'outline'}
          aria-pressed={selection.preset === key} onClick={() => choosePreset(key)}>{label}</Button>)}
      </div>
      <form onSubmit={applyDates} className="analytics-date-form">
        <div><Label htmlFor="analytics-from">From</Label><Input id="analytics-from" type="date" required min="2000-01-01" max="2099-12-31"
          value={draft.start} onChange={event => setDraft({ ...draft, start: event.target.value })} aria-describedby={dateError ? 'analytics-date-error' : undefined} /></div>
        <div><Label htmlFor="analytics-to">To</Label><Input id="analytics-to" type="date" required min="2000-01-01" max="2099-12-31"
          value={draft.end} onChange={event => setDraft({ ...draft, end: event.target.value })} aria-describedby={dateError ? 'analytics-date-error' : undefined} /></div>
        <Button type="submit" variant={selection.preset === 'custom' ? 'default' : 'outline'}>Apply range</Button>
      </form>
      {dateError && <p id="analytics-date-error" role="alert" className="analytics-error-text">{dateError}</p>}
    </div>

    <p className="analytics-range" role="status">{report.isPending ? 'Loading analytics…' : report.isError ? 'Analytics could not be loaded.' : `${data.period.label}: ${rangeText}`}{report.isFetching && !report.isPending ? ' · Updating…' : ''}</p>
    {report.isError && <div className="analytics-panel analytics-error" role="alert"><h2>Couldn’t load analytics</h2><p>{report.error.message}</p><Button variant="outline" onClick={() => report.refetch()}>Try again</Button></div>}
    {report.isPending && <div className="analytics-loading" aria-hidden="true">{[1, 2, 3, 4].map(key => <div key={key} />)}</div>}
    {!report.isError && data && <>
      <dl className="analytics-metrics">
        <Metric title="Sales revenue" value={moneyZAR(summary.totalRevenueCents)} note="Paid order totals, including shipping" />
        <Metric title="Paid orders" value={count(summary.totalOrders)} note="Unpaid and cancelled orders excluded" />
        <Metric title="Items sold" value={count(summary.itemsSold)} note="Ordered quantities, bundles count as one" />
        <Metric title="Average order value" value={moneyZAR(summary.avgOrderValue)} note="Sales revenue per paid order" />
      </dl>
      {summary.totalOrders === 0 && <div className="analytics-empty" role="status">No paid sales in this range. Try another date range or Lifetime.</div>}
      <div className="analytics-overview">
        <section className="analytics-panel analytics-trend" aria-labelledby="trend-title">
          <div className="analytics-panel-heading"><div><h2 id="trend-title">Sales trend</h2><p>{monthly ? 'Monthly' : 'Daily'} totals for this range</p></div>
            <div className="analytics-chart-switch" role="group" aria-label="Trend metric">{[['revenueCents', 'Revenue'], ['itemsSold', 'Items sold']].map(([key, label]) =>
              <Button key={key} size="sm" variant={chartMetric === key ? 'secondary' : 'ghost'} aria-pressed={chartMetric === key} onClick={() => setChartMetric(key)}>{label}</Button>)}</div>
          </div>
          <div className="analytics-chart" aria-label={`${chartMetric === 'revenueCents' ? 'Revenue' : 'Items sold'} trend`}>
            <ResponsiveContainer width="100%" height="100%"><BarChart data={data.trends} margin={{ top: 8, right: 8, left: 0, bottom: 0 }} accessibilityLayer>
              <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--analytics-border)" />
              <XAxis dataKey="date" stroke="var(--text-muted)" fontSize={11} minTickGap={36} tickFormatter={value => dateLabel(value, monthly)} />
              <YAxis stroke="var(--text-muted)" fontSize={11} width={65} tickFormatter={value => chartMetric === 'revenueCents' ? `R ${count(value / 100)}` : count(value)} />
              <Tooltip cursor={{ fill: 'var(--hover-bg)' }} contentStyle={{ background: 'var(--analytics-surface)', borderColor: 'var(--analytics-border)', color: 'var(--text)' }}
                labelFormatter={value => dateLabel(value, monthly)} formatter={value => [chartMetric === 'revenueCents' ? moneyZAR(value) : count(value), chartMetric === 'revenueCents' ? 'Revenue' : 'Items sold']} />
              <Bar dataKey={chartMetric} fill="var(--accent)" radius={[3, 3, 0, 0]} maxBarSize={48} isAnimationActive={false} />
            </BarChart></ResponsiveContainer>
          </div>
          <details className="analytics-trend-data"><summary>View trend data</summary><Table><TableCaption>Sales trend for the selected range</TableCaption><TableHeader><TableRow>
            <TableHead scope="col">{monthly ? 'Month' : 'Date'}</TableHead><TableHead scope="col">Revenue</TableHead><TableHead scope="col">Orders</TableHead><TableHead scope="col">Items sold</TableHead>
          </TableRow></TableHeader><TableBody>{data.trends.map(point => <TableRow key={point.date}><TableCell>{dateLabel(point.date, monthly)}</TableCell><TableCell>{moneyZAR(point.revenueCents)}</TableCell><TableCell>{count(point.orders)}</TableCell><TableCell>{count(point.itemsSold)}</TableCell></TableRow>)}</TableBody></Table></details>
        </section>
        <section className="analytics-panel" aria-labelledby="snapshot-title"><h2 id="snapshot-title">In this range</h2>
          <dl className="analytics-facts">
            <div><dt>Customers</dt><dd>{count(data.customers.totalCustomers)}</dd></div>
            <div><dt>Repeat customers</dt><dd>{count(data.customers.repeatCustomers)} <span>({count(data.customers.repeatCustomerRate)}%)</span></dd></div>
            <div><dt>Items per order</dt><dd>{count(summary.avgItemsPerOrder)}</dd></div>
            <div><dt>Discounts used</dt><dd>{moneyZAR(summary.totalDiscountCents)}</dd></div>
            <div><dt>Shipping collected</dt><dd>{moneyZAR(summary.shippingRevenueCents)}</dd></div>
          </dl>
          <p className="analytics-small">Customers are identified by email. Repeat means more than one paid order in this range.</p>
          <h3>Order fulfilment</h3><dl className="analytics-facts analytics-fulfillment">{[['delivery', 'Delivery'], ['collection', 'Collection'], ['other', 'Other / unspecified']].map(([key, label]) => <div key={key}><dt>{label}<span>{count(data.fulfillment[key].count)} orders</span></dt><dd>{moneyZAR(data.fulfillment[key].revenueCents)}</dd></div>)}</dl>
        </section>
      </div>
      <section className="analytics-panel" aria-labelledby="top-title"><div className="analytics-panel-heading"><div><h2 id="top-title">Top sellers</h2><p>Top 10 by quantity. Item revenue is before order-level discounts and shipping.</p></div></div>
        {data.allTopProducts.length > 0 && <p id="analytics-table-hint" className="analytics-small analytics-table-hint">Scroll the table sideways to see quantities and revenue.</p>}
        {data.allTopProducts.length ? <Table aria-describedby="analytics-table-hint"><TableCaption className="sr-only">Top selling items in the selected date range</TableCaption><TableHeader><TableRow>
          <TableHead scope="col">Item</TableHead><TableHead scope="col" className="text-right">Items sold</TableHead><TableHead scope="col" className="text-right">Orders</TableHead><TableHead scope="col" className="text-right">Item revenue</TableHead>
        </TableRow></TableHeader><TableBody>{data.allTopProducts.map(product => <TableRow key={product.key || product.id}><TableCell className="analytics-product-name">{product.name}{product.isBundle && <span>Bundle</span>}</TableCell><TableCell className="text-right tabular-nums">{count(product.totalUnitsSold)}</TableCell><TableCell className="text-right tabular-nums">{count(product.totalOrders)}</TableCell><TableCell className="text-right tabular-nums whitespace-nowrap">{moneyZAR(product.totalRevenueCents)}</TableCell></TableRow>)}</TableBody></Table> : <p className="analytics-small">No items sold in this range.</p>}
      </section>
      <section className="analytics-panel analytics-stock" aria-labelledby="stock-title"><div className="analytics-panel-heading"><div><h2 id="stock-title">Inventory now</h2><p>Current active products, independent of the date filter. Value uses stored cost prices.</p></div><Link to="/products">View products</Link></div>
        <dl className="analytics-stock-facts"><div><dt>Inventory value</dt><dd>{moneyZAR(data.inventory.totalInventoryValue)}</dd></div><div><dt>Active products</dt><dd>{count(data.inventory.activeProducts)}</dd></div><div><dt>Low stock (1–4)</dt><dd>{count(data.inventory.lowStockProducts)}</dd></div><div><dt>Out of stock</dt><dd>{count(data.inventory.outOfStockProducts)}</dd></div></dl>
      </section>
      <p className="analytics-small analytics-footnote">Dates use South African time and the order creation date. Refunded and archived orders are excluded. In-store invoices are not recorded payments and are not included.</p>
    </>}
  </section>;
}
