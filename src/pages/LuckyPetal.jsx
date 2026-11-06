import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw, Save, Flower2, AlertTriangle } from 'lucide-react';
import { supabase } from '../lib/supabase';

// BLOM Lucky Petal (Black Friday spin-to-win) control room.
// Tables: lucky_petal_campaigns / lucky_petal_prizes / lucky_petal_spins (Store DB).
// RLS lets owner/staff accounts read and edit them; customers never touch these directly.

const CAMPAIGN_ID = 'black-friday-2026';

const rands = (cents) => (cents == null ? '-' : `R${(Number(cents) / 100).toLocaleString('en-ZA', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`);

// South Africa is UTC+2 all year, so datetime-local <-> ISO is a fixed offset.
const toSastInput = (iso) => (iso ? new Date(Date.parse(iso) + 2 * 3600_000).toISOString().slice(0, 16) : '');
const fromSastInput = (value) => (value ? new Date(`${value}:00+02:00`).toISOString() : null);
const sastDateTime = (iso) =>
  iso ? new Date(iso).toLocaleString('en-ZA', { timeZone: 'Africa/Johannesburg', dateStyle: 'medium', timeStyle: 'short' }) : '-';

const STATUS_HELP = {
  off: 'Hidden from everyone.',
  preview: 'Only owner/staff accounts see the wheel and can spin, at any time. Preview spins never count against prize limits.',
  live: 'Everyone sees it between the spin start and end times.',
};

const KIND_LABEL = { percent: '% off', fixed: 'R off', gift: 'Free gift', course: 'Online course' };

const csvCell = (value) => {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

export default function LuckyPetal() {
  const queryClient = useQueryClient();
  const [notice, setNotice] = useState(null);

  const campaignQuery = useQuery({
    queryKey: ['lucky-petal', 'campaign'],
    queryFn: async () => {
      const { data, error } = await supabase.from('lucky_petal_campaigns').select('*').eq('id', CAMPAIGN_ID).maybeSingle();
      if (error) throw new Error(error.message);
      return data;
    },
  });

  const prizesQuery = useQuery({
    queryKey: ['lucky-petal', 'prizes'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lucky_petal_prizes')
        .select('*')
        .eq('campaign_id', CAMPAIGN_ID)
        .order('sort_order');
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  const spinsQuery = useQuery({
    queryKey: ['lucky-petal', 'spins'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('lucky_petal_spins')
        .select('*, product:products!lucky_petal_spins_gift_product_id_fkey(name)')
        .eq('campaign_id', CAMPAIGN_ID)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  const productsQuery = useQuery({
    queryKey: ['lucky-petal', 'products'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('products')
        .select('id, name, price_cents, stock_on_hand, is_active, status')
        .eq('is_active', true)
        .order('name');
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  const redeemedOrderIds = useMemo(
    () => (spinsQuery.data || []).filter((s) => s.redeemed_order_id && !s.is_preview).map((s) => s.redeemed_order_id),
    [spinsQuery.data],
  );

  const ordersQuery = useQuery({
    queryKey: ['lucky-petal', 'orders', redeemedOrderIds],
    enabled: redeemedOrderIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('orders')
        .select('id, order_number, subtotal_cents, discount_cents, total_cents, created_at')
        .in('id', redeemedOrderIds);
      if (error) throw new Error(error.message);
      return data || [];
    },
  });

  const refreshAll = () => queryClient.invalidateQueries({ queryKey: ['lucky-petal'] });
  const flash = (type, text) => {
    setNotice({ type, text });
    window.setTimeout(() => setNotice(null), 4000);
  };

  const campaign = campaignQuery.data;
  const prizes = prizesQuery.data || [];
  const spins = spinsQuery.data || [];
  const products = productsQuery.data || [];
  const productName = (id) => products.find((p) => p.id === id)?.name || 'Unknown product';

  const stats = useMemo(() => {
    const real = spins.filter((s) => !s.is_preview);
    const redeemed = real.filter((s) => s.status === 'redeemed' || s.status === 'fulfilled');
    const orders = ordersQuery.data || [];
    const revenue = orders.reduce((sum, o) => sum + Number(o.total_cents || 0), 0);
    const discount = orders.reduce((sum, o) => sum + Number(o.discount_cents || 0), 0);
    return {
      spins: real.length,
      previewSpins: spins.length - real.length,
      redeemed: redeemed.length,
      redemptionRate: real.length ? Math.round((100 * redeemed.length) / real.length) : 0,
      revenue,
      discount,
      aov: orders.length ? Math.round(revenue / orders.length) : 0,
      doubleUse: real.filter((s) => (s.double_use_order_ids || []).length > 0).length,
      goldenToFulfil: real.filter((s) => s.prize_snapshot?.kind === 'course' && s.status === 'awarded').length,
    };
  }, [spins, ordersQuery.data]);

  const totalWeight = prizes.filter((p) => p.is_active && p.weight > 0).reduce((sum, p) => sum + p.weight, 0);

  const exportCsv = () => {
    const header = ['spun_at', 'email', 'prize', 'code', 'gift', 'status', 'preview', 'order_number', 'order_total', 'double_use_orders'];
    const orderById = new Map((ordersQuery.data || []).map((o) => [o.id, o]));
    const rows = spins.map((s) => {
      const order = s.redeemed_order_id ? orderById.get(s.redeemed_order_id) : null;
      return [
        s.created_at,
        s.email,
        s.prize_snapshot?.title,
        s.code,
        s.product?.name || '',
        s.status,
        s.is_preview ? 'yes' : 'no',
        order?.order_number || s.redeemed_order_id || '',
        order ? (order.total_cents / 100).toFixed(2) : '',
        (s.double_use_order_ids || []).join(' '),
      ];
    });
    const csv = [header, ...rows].map((r) => r.map(csvCell).join(',')).join('\n');
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `lucky-petal-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  if (campaignQuery.isLoading) return <div className="p-8">Loading Lucky Petal…</div>;
  if (campaignQuery.error) {
    return (
      <div className="p-8">
        <h1 className="text-3xl font-bold">Lucky Petal</h1>
        <p className="mt-4 text-red-400">Could not load the campaign: {campaignQuery.error.message}</p>
        <p className="mt-2 text-text-muted">If this is the first run, the database migration has not been applied yet.</p>
      </div>
    );
  }
  if (!campaign) return <div className="p-8">No Lucky Petal campaign found.</div>;

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Flower2 className="text-accent" />
          <h1 className="text-3xl font-bold">Lucky Petal</h1>
          <span className={`status-badge ${campaign.status === 'live' ? 'status-active' : 'status-archived'}`}>
            {campaign.status.toUpperCase()}
          </span>
        </div>
        <div className="flex gap-2">
          <button type="button" className="btn-secondary flex items-center gap-2" onClick={refreshAll}>
            <RefreshCw size={16} /> Refresh
          </button>
          <button type="button" className="btn-secondary flex items-center gap-2" onClick={exportCsv} disabled={!spins.length}>
            <Download size={16} /> Export CSV
          </button>
        </div>
      </div>

      {notice && (
        <div className={`mb-4 rounded-md px-4 py-3 text-sm ${notice.type === 'error' ? 'bg-red-500/10 text-red-400' : 'bg-green-500/10 text-green-500'}`}>
          {notice.text}
        </div>
      )}

      <Stats stats={stats} />

      <CampaignSettings campaign={campaign} onSaved={() => { refreshAll(); flash('ok', 'Campaign saved.'); }} onError={(m) => flash('error', m)} />

      <div className="section-card mt-8">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-xl font-semibold">Prizes</h2>
          <p className="text-sm text-text-muted">
            Odds = weight ÷ total weight of active prizes ({totalWeight}). Wheel order = position. Edits apply to new spins only; prizes already won keep their terms.
          </p>
        </div>
        <div className="space-y-4">
          {prizes.map((prize) => (
            <PrizeRow
              key={prize.id}
              prize={prize}
              totalWeight={totalWeight}
              products={products}
              productName={productName}
              onSaved={() => { refreshAll(); flash('ok', `Saved “${prize.title}”.`); }}
              onError={(m) => flash('error', m)}
            />
          ))}
        </div>
      </div>

      <SpinsTable
        spins={spins}
        orders={ordersQuery.data || []}
        onChanged={refreshAll}
        onError={(m) => flash('error', m)}
        onOk={(m) => flash('ok', m)}
      />
    </div>
  );
}

function Stats({ stats }) {
  const tiles = [
    ['Customers spun', stats.spins, stats.previewSpins ? `+${stats.previewSpins} preview` : null],
    ['Prizes used', stats.redeemed, `${stats.redemptionRate}% of spins`],
    ['Revenue from prize orders', rands(stats.revenue), stats.redeemed ? `AOV ${rands(stats.aov)}` : null],
    ['Discount given', rands(stats.discount), 'gifts not included'],
    ['Golden Petals to set up', stats.goldenToFulfil, 'mark as fulfilled below'],
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      {tiles.map(([label, value, sub]) => (
        <div key={label} className="section-card !p-4">
          <p className="text-xs uppercase tracking-wide text-text-muted">{label}</p>
          <p className="mt-1 text-2xl font-bold">{value}</p>
          {sub && <p className="text-xs text-text-muted">{sub}</p>}
        </div>
      ))}
      {stats.doubleUse > 0 && (
        <div className="col-span-2 flex items-center gap-2 rounded-md bg-amber-500/10 px-4 py-3 text-sm text-amber-500 md:col-span-5">
          <AlertTriangle size={16} />
          {stats.doubleUse} prize(s) were paid on more than one order. Check the flagged rows below.
        </div>
      )}
    </div>
  );
}

function CampaignSettings({ campaign, onSaved, onError }) {
  const [form, setForm] = useState(() => ({
    status: campaign.status,
    spin_starts_at: toSastInput(campaign.spin_starts_at),
    spin_ends_at: toSastInput(campaign.spin_ends_at),
    redeem_ends_at: toSastInput(campaign.redeem_ends_at),
  }));

  const save = useMutation({
    mutationFn: async () => {
      if (form.status === 'live' && !window.confirm('Go LIVE? Every customer will see the wheel during the spin window.')) {
        throw new Error('cancelled');
      }
      const { error } = await supabase
        .from('lucky_petal_campaigns')
        .update({
          status: form.status,
          spin_starts_at: fromSastInput(form.spin_starts_at),
          spin_ends_at: fromSastInput(form.spin_ends_at),
          redeem_ends_at: fromSastInput(form.redeem_ends_at),
          updated_at: new Date().toISOString(),
        })
        .eq('id', campaign.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: onSaved,
    onError: (e) => e.message !== 'cancelled' && onError(e.message),
  });

  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  return (
    <div className="section-card mt-8">
      <h2 className="mb-4 text-xl font-semibold">Campaign</h2>
      <div className="grid gap-4 md:grid-cols-4">
        <label className="block text-sm">
          <span className="text-text-muted">Status</span>
          <select className="select mt-1 w-full" value={form.status} onChange={set('status')}>
            <option value="off">Off</option>
            <option value="preview">Preview (staff only)</option>
            <option value="live">Live</option>
          </select>
          <span className="mt-1 block text-xs text-text-muted">{STATUS_HELP[form.status]}</span>
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Spins open (SAST)</span>
          <input type="datetime-local" className="form-input mt-1 w-full" value={form.spin_starts_at} onChange={set('spin_starts_at')} />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Spins close (SAST)</span>
          <input type="datetime-local" className="form-input mt-1 w-full" value={form.spin_ends_at} onChange={set('spin_ends_at')} />
        </label>
        <label className="block text-sm">
          <span className="text-text-muted">Prizes expire (SAST)</span>
          <input type="datetime-local" className="form-input mt-1 w-full" value={form.redeem_ends_at} onChange={set('redeem_ends_at')} />
        </label>
      </div>
      <div className="mt-4 flex justify-end">
        <button type="button" className="btn-primary flex items-center gap-2" onClick={() => save.mutate()} disabled={save.isPending}>
          <Save size={16} /> {save.isPending ? 'Saving…' : 'Save campaign'}
        </button>
      </div>
    </div>
  );
}

function PrizeRow({ prize, totalWeight, products, productName, onSaved, onError }) {
  const [form, setForm] = useState(() => ({
    ...prize,
    percent_off: prize.percent_off ?? '',
    amount_off_rands: prize.amount_off_cents ? prize.amount_off_cents / 100 : '',
    max_discount_rands: prize.max_discount_cents ? prize.max_discount_cents / 100 : '',
    min_order_rands: prize.min_order_cents ? prize.min_order_cents / 100 : 0,
    max_awards: prize.max_awards ?? '',
    gift_product_ids: prize.gift_product_ids || [],
  }));
  const [addId, setAddId] = useState('');

  const set = (key) => (e) => {
    const value = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
    setForm((f) => ({ ...f, [key]: value }));
  };
  const num = (v) => (v === '' || v == null ? null : Number(v));
  const cents = (v) => (v === '' || v == null ? null : Math.round(Number(v) * 100));

  const save = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('lucky_petal_prizes')
        .update({
          wheel_line1: form.wheel_line1,
          wheel_line2: form.wheel_line2,
          title: form.title,
          description: form.description,
          kind: form.kind,
          percent_off: form.kind === 'percent' ? num(form.percent_off) : null,
          amount_off_cents: form.kind === 'fixed' ? cents(form.amount_off_rands) : null,
          max_discount_cents: form.kind === 'percent' ? cents(form.max_discount_rands) : null,
          min_order_cents: cents(form.min_order_rands) || 0,
          gift_product_ids: form.kind === 'gift' ? form.gift_product_ids : [],
          weight: Number(form.weight) || 0,
          max_awards: num(form.max_awards),
          tone: form.tone,
          is_active: form.is_active,
          updated_at: new Date().toISOString(),
        })
        .eq('id', prize.id);
      if (error) throw new Error(error.message);
    },
    onSuccess: onSaved,
    onError: (e) => onError(e.message),
  });

  const odds = form.is_active && totalWeight > 0 ? ((100 * (Number(form.weight) || 0)) / totalWeight).toFixed(1) : '0';

  return (
    <div className="rounded-lg border border-border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          #{prize.sort_order + 1} · {prize.title}{' '}
          <span className="text-sm font-normal text-text-muted">
            · {KIND_LABEL[form.kind]} · {odds}% · awarded {prize.awarded_count}
            {prize.max_awards != null ? ` / ${prize.max_awards}` : ''}
          </span>
        </p>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.is_active} onChange={set('is_active')} /> On the wheel
        </label>
      </div>

      <div className="mt-3 grid gap-3 md:grid-cols-6">
        <Field label="Petal big text"><input className="form-input w-full" value={form.wheel_line1} onChange={set('wheel_line1')} maxLength={8} /></Field>
        <Field label="Petal small text"><input className="form-input w-full" value={form.wheel_line2} onChange={set('wheel_line2')} maxLength={14} /></Field>
        <Field label="Title" wide><input className="form-input w-full" value={form.title} onChange={set('title')} /></Field>
        <Field label="Colour">
          <select className="select w-full" value={form.tone} onChange={set('tone')}>
            {['pink', 'blush', 'blue', 'white', 'gold'].map((t) => <option key={t} value={t}>{t}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className="select w-full" value={form.kind} onChange={set('kind')}>
            {Object.entries(KIND_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
          </select>
        </Field>
        <Field label="Description (customer sees this)" full>
          <input className="form-input w-full" value={form.description || ''} onChange={set('description')} />
        </Field>
        {form.kind === 'percent' && (
          <>
            <Field label="% off"><input type="number" min="1" max="100" className="form-input w-full" value={form.percent_off} onChange={set('percent_off')} /></Field>
            <Field label="Max discount (R)"><input type="number" min="0" className="form-input w-full" value={form.max_discount_rands} onChange={set('max_discount_rands')} /></Field>
          </>
        )}
        {form.kind === 'fixed' && (
          <Field label="Amount off (R)"><input type="number" min="1" className="form-input w-full" value={form.amount_off_rands} onChange={set('amount_off_rands')} /></Field>
        )}
        {form.kind !== 'course' && (
          <Field label="Min. order (R)"><input type="number" min="0" className="form-input w-full" value={form.min_order_rands} onChange={set('min_order_rands')} /></Field>
        )}
        <Field label="Weight"><input type="number" min="0" className="form-input w-full" value={form.weight} onChange={set('weight')} /></Field>
        <Field label="Max winners (blank = no limit)"><input type="number" min="0" className="form-input w-full" value={form.max_awards} onChange={set('max_awards')} /></Field>
      </div>

      {form.kind === 'gift' && (
        <div className="mt-3">
          <p className="text-sm text-text-muted">Gift products (one is picked at random from those in stock):</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {form.gift_product_ids.map((id) => (
              <span key={id} className="flex items-center gap-2 rounded-full bg-accent/10 px-3 py-1 text-sm">
                {productName(id)}
                <button
                  type="button"
                  className="text-text-muted hover:text-red-400"
                  onClick={() => setForm((f) => ({ ...f, gift_product_ids: f.gift_product_ids.filter((x) => x !== id) }))}
                  aria-label={`Remove ${productName(id)}`}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <select className="select flex-1" value={addId} onChange={(e) => setAddId(e.target.value)}>
              <option value="">Add a product…</option>
              {products
                .filter((p) => !form.gift_product_ids.includes(p.id))
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} · {rands(p.price_cents)} · stock {p.stock_on_hand ?? '?'}
                  </option>
                ))}
            </select>
            <button
              type="button"
              className="btn-secondary"
              disabled={!addId}
              onClick={() => {
                setForm((f) => ({ ...f, gift_product_ids: [...f.gift_product_ids, addId] }));
                setAddId('');
              }}
            >
              Add
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 flex justify-end">
        <button type="button" className="btn-primary flex items-center gap-2" onClick={() => save.mutate()} disabled={save.isPending}>
          <Save size={16} /> {save.isPending ? 'Saving…' : 'Save prize'}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children, wide, full }) {
  return (
    <label className={`block text-sm ${full ? 'md:col-span-6' : wide ? 'md:col-span-2' : ''}`}>
      <span className="text-text-muted">{label}</span>
      <div className="mt-1">{children}</div>
    </label>
  );
}

function SpinsTable({ spins, orders, onChanged, onError, onOk }) {
  const [filter, setFilter] = useState('real');
  const orderById = useMemo(() => new Map(orders.map((o) => [o.id, o])), [orders]);
  const shown = spins.filter((s) => (filter === 'all' ? true : filter === 'preview' ? s.is_preview : !s.is_preview));

  const update = async (spin, patch, okText) => {
    const { error } = await supabase
      .from('lucky_petal_spins')
      .update({ ...patch, updated_at: new Date().toISOString() })
      .eq('id', spin.id);
    if (error) onError(error.message);
    else {
      onOk(okText);
      onChanged();
    }
  };

  const resetPreview = async () => {
    if (!window.confirm('Delete all preview spins so staff can test again?')) return;
    const { error } = await supabase.from('lucky_petal_spins').delete().eq('campaign_id', CAMPAIGN_ID).eq('is_preview', true);
    if (error) onError(error.message);
    else {
      onOk('Preview spins cleared.');
      onChanged();
    }
  };

  return (
    <div className="section-card mt-8">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">Spins</h2>
        <div className="flex items-center gap-2">
          <select className="select text-sm" value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="real">Customers</option>
            <option value="preview">Preview (staff)</option>
            <option value="all">All</option>
          </select>
          <button type="button" className="btn-secondary text-sm" onClick={resetPreview}>
            Reset preview spins
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-text-muted">
              <th className="p-3">Spun</th>
              <th className="p-3">Customer</th>
              <th className="p-3">Prize</th>
              <th className="p-3">Code</th>
              <th className="p-3">Status</th>
              <th className="p-3">Order</th>
              <th className="p-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan="7" className="p-4 text-center text-text-muted">No spins yet.</td></tr>
            )}
            {shown.map((s) => {
              const order = s.redeemed_order_id ? orderById.get(s.redeemed_order_id) : null;
              const isCourse = s.prize_snapshot?.kind === 'course';
              return (
                <tr key={s.id} className="border-b border-border align-top">
                  <td className="p-3 whitespace-nowrap">{sastDateTime(s.created_at)}</td>
                  <td className="p-3">{s.email}{s.is_preview && <span className="ml-2 text-xs text-text-muted">(preview)</span>}</td>
                  <td className="p-3">
                    {s.prize_snapshot?.title}
                    {s.product?.name && <div className="text-xs text-text-muted">{s.product.name}</div>}
                  </td>
                  <td className="p-3 font-mono">{s.code}</td>
                  <td className="p-3">
                    <span className={`status-badge ${s.status === 'awarded' ? 'status-archived' : 'status-active'}`}>{s.status}</span>
                    {(s.double_use_order_ids || []).length > 0 && (
                      <div className="mt-1 text-xs text-amber-500">Also paid on: {s.double_use_order_ids.join(', ')}</div>
                    )}
                  </td>
                  <td className="p-3">
                    {s.redeemed_order_id ? (
                      <a className="text-accent underline" href={`/orders/${s.redeemed_order_id}`}>
                        {order?.order_number || 'View order'}
                      </a>
                    ) : (s.order_ids || []).length > 0 ? (
                      <span className="text-text-muted">{s.order_ids.length} unpaid</span>
                    ) : '-'}
                  </td>
                  <td className="p-3">
                    <div className="flex flex-wrap gap-2">
                      {isCourse && s.status === 'awarded' && (
                        <button type="button" className="btn-secondary text-xs" onClick={() => update(s, { status: 'fulfilled' }, 'Marked as set up.')}>
                          Course set up
                        </button>
                      )}
                      {s.status === 'awarded' && (
                        <button
                          type="button"
                          className="text-xs text-red-400 hover:underline"
                          onClick={() => window.confirm(`Cancel ${s.email}'s prize?`) && update(s, { status: 'void' }, 'Prize cancelled.')}
                        >
                          Cancel prize
                        </button>
                      )}
                      {s.status === 'void' && (
                        <button type="button" className="text-xs hover:underline" onClick={() => update(s, { status: 'awarded' }, 'Prize restored.')}>
                          Restore
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
