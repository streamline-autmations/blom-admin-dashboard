import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft, Package, FileText, CheckCircle,
  Truck, User, Clock, Download, RefreshCw
} from "lucide-react";
import { useToast } from "../components/ui/ToastProvider";

const toNumberLoose = (value) => {
  if (value === undefined || value === null) return Number.NaN;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return Number.NaN;
  const cleaned = value.replace(/,/g, "").replace(/[^\d.-]/g, "").trim();
  if (!cleaned) return Number.NaN;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : Number.NaN;
};

// Helper: Format currency safely (handles cents vs rands)
const formatMoney = (cents) => {
  if (cents === undefined || cents === null || cents === "") return "R0.00";
  const n = typeof cents === "string" ? toNumberLoose(cents) : Number(cents);
  if (!Number.isFinite(n)) return "R0.00";
  return `R${(n / 100).toFixed(2)}`;
};

// Helper: Format address safely (handle objects and strings)
const formatAddress = (address) => {
  if (!address) {
    return 'No delivery address provided - Please contact customer for address details';
  }
  
  // If it's already a string, return it
  if (typeof address === 'string') {
    return address;
  }
  
  // If it's an object, convert to string
  if (typeof address === 'object') {
    const parts = [];
    if (address.street_address) parts.push(address.street_address);
    if (address.local_area) parts.push(address.local_area);
    if (address.city) parts.push(address.city);
    if (address.zone) parts.push(address.zone);
    if (address.country) parts.push(address.country);
    return parts.join('\n') || 'Address details unavailable';
  }
  
  // Fallback for other types
  return String(address);
};

export default function OrderDetail() {
  const navigate = useNavigate();
  const { showToast } = useToast();
  const queryClient = useQueryClient();
  const { id } = useParams();

  const [notes, setNotes] = useState("");

  // 1. Fetch Order - Updated to include discount_cents and coupon_code
  const { data, isLoading, error } = useQuery({
    queryKey: ['order', id],
    queryFn: async () => {
      const res = await fetch(`/.netlify/functions/admin-order?id=${id}`);
      const json = await res.json();
      if (!json.ok) throw new Error(json.error);
      return json;
    }
  });

  const order = data?.order;
  const items = data?.items || [];
  const asCentsColumn = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const n = typeof value === "string" ? toNumberLoose(value) : Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n);
  };

  const asRandsToCents = (value) => {
    if (value === undefined || value === null || value === "") return null;
    const n = typeof value === "string" ? toNumberLoose(value) : Number(value);
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
  };

  const itemsSubtotalCents = (items || []).reduce((sum, item) => {
    const unitPriceCents =
      asCentsColumn(item.unit_price_cents) ??
      asCentsColumn(item.price) ??
      (item.unit_price ? asRandsToCents(item.unit_price) : 0) ??
      0;
    const quantity = item.quantity || 0;
    const lineTotalCents =
      asCentsColumn(item.line_total_cents) ??
      asCentsColumn(item.line_total) ??
      (unitPriceCents * quantity);
    return sum + (lineTotalCents || 0);
  }, 0);

  const subtotalCents =
    asCentsColumn(order?.subtotal_cents) ??
    asRandsToCents(order?.subtotal) ??
    itemsSubtotalCents;
  const shippingCents =
    asCentsColumn(order?.shipping_cents) ??
    asRandsToCents(order?.shipping) ??
    0;
  const discountCents =
    asCentsColumn(order?.discount_cents) ??
    asRandsToCents(order?.discount) ??
    0;
  const isWomensDayPromotion = order?.coupon_code === 'WOMENSDAY2026';
  const discountLabel = isWomensDayPromotion
    ? "Women's Day Promotion"
    : `Coupon${order?.coupon_code ? ` (${order.coupon_code})` : ''}`;
  const totalCents =
    asCentsColumn(order?.total_cents) ??
    asRandsToCents(order?.total) ??
    (subtotalCents + shippingCents - discountCents);
  
  // Debug logging
  console.log('OrderDetail Debug:', {
    data,
    order,
    items,
    itemsLength: items.length,
    hasItems: items && items.length > 0,
    shippingAddress: order?.shipping_address,
    deliveryAddress: order?.delivery_address,
    fulfillmentType: order?.fulfillment_type
  });

  useEffect(() => {
    if (order?.notes) setNotes(order.notes);
  }, [order]);

  const [invoiceToolsEnabled, setInvoiceToolsEnabled] = useState(() => localStorage.getItem('blom_invoice_tools') === '1');

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const v = params.get('tools');
    if (v === '1') {
      localStorage.setItem('blom_invoice_tools', '1');
      setInvoiceToolsEnabled(true);
    }
    if (v === '0') {
      localStorage.removeItem('blom_invoice_tools');
      setInvoiceToolsEnabled(false);
    }
  }, []);

  const isPaid =
    order?.status === "paid" ||
    order?.payment_status === "paid" ||
    order?.payment_status === "complete" ||
    !!order?.paid_at;

  const hasInvoice = !!order?.invoice_url;

  const generateInvoiceMutation = useMutation({
    mutationFn: async () => {
      if (!order?.m_payment_id) throw new Error("Missing m_payment_id");
      const res = await fetch("/.netlify/functions/invoice-pdf?return_url=1", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          order_id: id,
          m_payment_id: order.m_payment_id,
          return_url: true,
        }),
      });

      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(detail || `Invoice generation failed (${res.status})`);
      }

      const json = await res.json().catch(() => null);
      if (!json?.ok) throw new Error(json?.error || "Invoice generation failed");
      return json;
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["order", id] });
      await queryClient.invalidateQueries({ queryKey: ["orders"] });
      showToast("Invoice generated", "success");
    },
    onError: (err) => {
      showToast(err?.message || "Invoice generation failed", "error");
    },
  });

  const notifyOrderMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/.netlify/functions/admin-notify-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order_id: id })
      });

      const json = await res.json().catch(() => null);
      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || 'Notification trigger failed');
      }
      return json;
    },
    onSuccess: () => {
      showToast('Notification webhook triggered', 'success');
    },
    onError: (err) => {
      showToast(err?.message || 'Notification trigger failed', 'error');
    }
  });

  // 2. Update Status Mutation - Send webhook payload AND update database
  const statusMutation = useMutation({
    mutationFn: async (newStatus) => {
      const currentStatus = order?.status || 'unknown';
      console.log('🔄 Status Update Request:', { orderId: id, newStatus, currentStatus });
      
      // STEP 1: Send webhook payload to user's workflow
      console.log('📡 Sending status update payload to webhook...');
      
      const payload = {
        event: 'order_status_change_request',
        order_id: id,
        order_number: order?.order_number,
        previous_status: currentStatus,
        new_status: newStatus,
        timestamp: new Date().toISOString(),
        fulfillment_type: order?.fulfillment_type,
        customer_info: {
          name: order?.buyer_name || order?.customer_name,
          email: order?.buyer_email || order?.customer_email,
          phone: order?.buyer_phone || order?.customer_phone
        }
      };
      
      // Send to correct webhook via proxy to avoid CORS issues
      let webhookPath = null;
      
      if (newStatus === 'packed') {
        webhookPath = order?.fulfillment_type === 'collection'
          ? 'ready-for-collection'
          : 'ready-for-delivery';
      } else if (newStatus === 'out_for_delivery') {
        webhookPath = 'out-for-delivery';
      }
      
      const webhookUrl = webhookPath ? `/.netlify/functions/webhook-proxy/${webhookPath}` : null;
      
      let webhookResponse;
      let webhookOk = false;
      
      try {
        webhookResponse = await fetch(webhookUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload)
        });
        
        webhookOk = webhookResponse.ok;
        console.log('✅ Webhook payload sent successfully');
      } catch (webhookError) {
        console.warn('⚠️ Webhook request failed (CORS or network issue):', webhookError.message);
        // Continue with database update even if webhook fails
        webhookResponse = { ok: false };
      }
      
      // STEP 2: Update the database directly
      console.log('🗄️ Updating order status in database...');
      
      const dbResponse = await fetch('/.netlify/functions/admin-order', {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          id: id,
          status: newStatus
        })
      });
      
      const dbResult = await dbResponse.json();
      
      if (!dbResponse.ok || !dbResult.ok) {
        throw new Error(`Database update failed: ${dbResult.error || 'Unknown error'}`);
      }
      
      console.log('✅ Database updated successfully');
      
      return { 
        ok: true, 
        payload_sent: webhookOk,
        database_updated: true,
        statusUpdated: newStatus,
        webhookUrl: webhookUrl,
        webhookPath: webhookPath,
        payload: payload,
        order: dbResult.order,
        success: true,
        webhookError: !webhookOk ? 'CORS or network issue - webhook may need server-side configuration' : null
      };
    },
    onSuccess: async (result) => {
      console.log('🎉 Mutation Success:', result);
      
      // Get the status that was updated from the result
      const updatedStatus = result.statusUpdated;
      
      // IMPROVED: Better cache invalidation strategy
      console.log('🔄 Clearing cache and refetching order data...');
      
      // Remove specific queries to ensure fresh data
      queryClient.removeQueries({ queryKey: ['order', id] });
      queryClient.removeQueries({ queryKey: ['orders'] });
      
      // Force immediate refetch with optimized timing
      await Promise.all([
        queryClient.refetchQueries({ queryKey: ['order', id], type: 'active' }),
        queryClient.refetchQueries({ queryKey: ['orders'], type: 'active' })
      ]);
      
      // Also invalidate any related queries
      queryClient.invalidateQueries({ queryKey: ['order'] });
      queryClient.invalidateQueries({ queryKey: ['orders'] });
      
      console.log('✅ Cache cleared and data refetched');

      // Dispatch custom event to notify other components with updated data
      window.dispatchEvent(new CustomEvent('orderStatusUpdated', { 
        detail: { 
          orderId: id, 
          newStatus: updatedStatus,
          timestamp: new Date().toISOString(),
          forceRefresh: true
        } 
      }));

      // Show success message with webhook status
      if (result.database_updated && result.payload_sent) {
        showToast('success', `Order status updated to "${updatedStatus}" - workflow notified and database updated`);
      } else if (result.database_updated && !result.payload_sent) {
        showToast('warning', `Order status updated to "${updatedStatus}" in database, but webhook failed (${result.webhookError || 'CORS issue'})`);
      } else if (result.payload_sent) {
        showToast('success', `Workflow notified for "${updatedStatus}" status change`);
      } else {
        showToast('success', `Order status updated successfully`);
      }
    },
    onError: (err) => {
      console.error('❌ Mutation Error:', err);
      showToast('error', `Failed to update order status: ${err.message}`);
    }
  });

  if (isLoading) return <div className="order-loading">Loading order details...</div>;
  if (error) return <div className="order-error">Error: {error.message}</div>;
  if (!order) return <div className="order-not-found">Order not found</div>;

  // Receipt generation function

  // Base44 styling CSS
  const base44Styles = `
    .order-detail-container {
      max-width: 1200px;
      margin: 0 auto;
      padding: 32px;
    }

    .order-header {
      display: flex;
      align-items: center;
      gap: 20px;
      margin-bottom: 32px;
    }

    .btn-back {
      padding: 12px;
      border-radius: 12px;
      border: none;
      background: var(--card);
      color: var(--text);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 3px 3px 6px var(--shadow-dark), -3px -3px 6px var(--shadow-light);
      transition: all 0.2s ease;
    }

    .btn-back:hover {
      box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
      color: var(--accent);
    }

    .order-title-section {
      flex: 1;
    }

    .order-title {
      font-size: 28px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 16px;
      margin-bottom: 8px;
    }

    .order-status-badge {
      padding: 6px 14px;
      border-radius: 10px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
    }

    .status-paid {
      background: #16a34a20;
      color: #16a34a;
    }

    .status-packed {
      background: #dc262620;
      color: #dc2626;
    }

    .status-out_for_delivery {
      background: #ea580c20;
      color: #ea580c;
    }

    .status-delivered, .status-collected {
      background: #05966920;
      color: #059669;
    }

    .status-unpaid, .status-created {
      background: #eab30820;
      color: #ca8a04;
    }

    .status-cancelled {
      background: #991b1b20;
      color: #991b1b;
    }

    .order-date {
      color: var(--text-muted);
      font-size: 14px;
    }

    .order-content {
      display: grid;
      grid-template-columns: 2fr 1fr;
      gap: 32px;
    }

    @media (max-width: 1024px) {
      .order-content {
        grid-template-columns: 1fr;
        gap: 24px;
      }
    }

    .section-card {
      background: var(--card);
      border-radius: 16px;
      padding: 24px;
      box-shadow: 6px 6px 12px var(--shadow-dark), -6px -6px 12px var(--shadow-light);
    }

    .workflow-card {
      background: linear-gradient(135deg, var(--card) 0%, var(--bg) 100%);
      border: 1px solid var(--accent)/20;
    }

    .section-title {
      font-size: 18px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 20px;
    }

    .btn-primary {
      padding: 12px 24px;
      border-radius: 12px;
      border: none;
      background: linear-gradient(135deg, var(--accent), var(--accent-2));
      color: white;
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 4px 4px 8px var(--shadow-dark), -4px -4px 8px var(--shadow-light);
      transition: all 0.3s ease;
    }

    .btn-primary:hover:not(:disabled) {
      transform: translateY(-2px);
      box-shadow: 6px 6px 12px var(--shadow-dark), -6px -6px 12px var(--shadow-light);
    }

    .btn-primary:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }

    .btn-secondary {
      padding: 12px 24px;
      border-radius: 12px;
      border: none;
      background: var(--card);
      color: var(--text);
      font-size: 14px;
      font-weight: 600;
      cursor: pointer;
      box-shadow: 3px 3px 6px var(--shadow-dark), -3px -3px 6px var(--shadow-light);
    }

    .btn-secondary:hover {
      box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
    }

    .order-loading, .order-error, .order-not-found {
      text-align: center;
      padding: 80px 20px;
      color: var(--text-muted);
      font-size: 16px;
    }

    .order-error {
      color: #ef4444;
    }

    .order-main-content {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .workflow-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
    }

    .workflow-current-stage {
      color: var(--text-muted);
      font-size: 14px;
      margin-top: 8px;
    }

    .workflow-info {
      flex: 1;
    }

    .items-table-container {
      overflow-x: auto;
    }

    .items-table {
      width: 100%;
      border-collapse: collapse;
    }

    .items-table th {
      text-align: left;
      padding: 12px 16px;
      font-size: 12px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      border-bottom: 2px solid var(--border);
      background: var(--card);
    }

    .items-table td {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      color: var(--text);
    }

    .item-row:hover td {
      background: rgba(110, 193, 255, 0.05);
    }

    .item-title {
      font-weight: 600;
      color: var(--text);
      margin-bottom: 4px;
    }

    .item-variant {
      font-size: 12px;
      color: var(--text-muted);
    }

    .item-request {
      margin-top: 8px;
      padding: 10px 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      font-size: 13px;
      color: var(--text);
    }

    .item-request dt {
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      color: var(--text-muted);
      margin-top: 6px;
    }

    .item-request dt:first-child {
      margin-top: 0;
    }

    .item-request dd {
      margin: 2px 0 0;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .item-request a {
      color: var(--accent);
      text-decoration: underline;
    }

    .item-request-images {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      margin-top: 4px;
    }

    .item-request-images img {
      width: 72px;
      height: 72px;
      object-fit: cover;
      border-radius: 6px;
      border: 1px solid var(--border);
    }

    .item-qty {
      font-weight: 600;
    }

    .item-price, .item-total {
      font-weight: 600;
    }

    .summary-label, .total-label {
      color: var(--text-muted);
      font-size: 14px;
    }

    .summary-value, .total-value {
      font-weight: 600;
      color: var(--text);
    }

    .summary-value.discount {
      color: #10b981;
    }

    .total-row td {
      border-top: 2px solid var(--border);
      padding-top: 16px;
    }

    .total-label, .total-value {
      font-weight: 700;
      font-size: 16px;
      color: var(--text);
    }

    .timeline-container {
      position: relative;
      padding-left: 24px;
    }

    .timeline-container::before {
      content: '';
      position: absolute;
      left: 8px;
      top: 0;
      bottom: 0;
      width: 2px;
      background: var(--border);
    }

    .timeline-item {
      position: relative;
      padding-bottom: 24px;
    }

    .timeline-item:last-child {
      padding-bottom: 0;
    }

    .timeline-dot {
      position: absolute;
      left: -20px;
      top: 4px;
      width: 16px;
      height: 16px;
      border-radius: 50%;
      border: 2px solid var(--border);
      background: var(--card);
    }

    .timeline-dot.completed {
      background: var(--accent);
      border-color: var(--accent);
    }

    .timeline-dot.active {
      background: var(--bg);
      border-color: var(--accent);
      animation: pulse 2s infinite;
    }

    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(110, 193, 255, 0.7); }
      70% { box-shadow: 0 0 0 10px rgba(110, 193, 255, 0); }
      100% { box-shadow: 0 0 0 0 rgba(110, 193, 255, 0); }
    }

    .timeline-content {
      font-size: 14px;
      font-weight: 600;
      color: var(--text);
    }

    .timeline-content.completed {
      color: var(--text);
    }

    .timeline-content.pending {
      color: var(--text-muted);
    }

    .timeline-date {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 4px;
    }

    .order-sidebar {
      display: flex;
      flex-direction: column;
      gap: 24px;
    }

    .sidebar-section-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text);
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 16px;
    }

    .customer-info, .delivery-info {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .info-item {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .info-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .info-value {
      color: var(--text);
      font-weight: 600;
    }

    .info-link {
      color: var(--accent);
      font-weight: 600;
      text-decoration: none;
      transition: color 0.2s ease;
    }

    .info-link:hover {
      color: var(--accent-2);
      text-decoration: underline;
    }

    .delivery-method {
      background: var(--bg);
      padding: 16px;
      border-radius: 12px;
      margin-bottom: 16px;
      box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
    }

    .method-label {
      display: block;
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 6px;
    }

    .method-value {
      font-weight: 700;
      color: var(--text);
      font-size: 16px;
    }

    .address-section, .collection-section {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .address-label {
      font-size: 11px;
      font-weight: 700;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }

    .address-content {
      white-space: pre-line;
      line-height: 1.6;
      color: var(--text);
      font-weight: 500;
    }

    .notes-textarea {
      width: 100%;
      min-height: 120px;
      padding: 16px;
      border-radius: 12px;
      border: none;
      background: var(--bg);
      color: var(--text);
      font-size: 14px;
      font-family: inherit;
      resize: vertical;
      box-shadow: inset 3px 3px 6px var(--shadow-dark), inset -3px -3px 6px var(--shadow-light);
    }

    .notes-textarea:focus {
      outline: none;
      box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light), 0 0 0 2px var(--accent)/20;
    }

    .notes-textarea:disabled {
      opacity: 0.7;
      cursor: not-allowed;
    }

    .notes-textarea::placeholder {
      color: var(--text-muted);
    }

    .btn-download {
      background: linear-gradient(135deg, #059669, #10b981);
      color: white;
      border: none;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      display: flex;
      align-items: center;
      gap: 6px;
      box-shadow: 2px 2px 4px var(--shadow-dark), -2px -2px 4px var(--shadow-light);
      transition: all 0.2s ease;
    }

    .btn-download:hover {
      transform: translateY(-1px);
      box-shadow: 3px 3px 6px var(--shadow-dark), -3px -3px 6px var(--shadow-light);
    }

    .invoice-section {
      background: var(--bg);
      padding: 16px;
      border-radius: 12px;
      margin-top: 16px;
      box-shadow: inset 2px 2px 4px var(--shadow-dark), inset -2px -2px 4px var(--shadow-light);
    }
  `;

  // Logic for Workflow Buttons
  const type = order.fulfillment_type || 'delivery'; // Default to delivery
  const status = order.status || 'unpaid';
  // Same 'collection' fulfillment flow as an in-store pickup — the customer just
  // sends their own courier to collect instead of walking in themselves.
  const isCourierCollection = type === 'collection' && String(order.collection_location || '').toLowerCase().includes('courier');

  let nextAction = null;
  let nextStatus = null;

  if (status === 'paid') {
    nextAction = "Mark as Packed";
    nextStatus = "packed";
  } else if (status === 'packed') {
    if (type === 'collection') {
      nextAction = "Mark Collected";
      nextStatus = "collected";
    } else {
      nextAction = "Mark Out for Delivery";
      nextStatus = "out_for_delivery";
    }
  } else if (status === 'out_for_delivery') {
    nextAction = "Mark Delivered";
    nextStatus = "delivered";
  }

  // Timeline Steps

  return (
    <>
      <style>{base44Styles}</style>
      <div className="order-detail-container">
      {/* Header */}
      <div className="order-header">
        <button onClick={() => navigate('/orders')} className="btn-back">
          <ArrowLeft size={20} />
        </button>
        <div className="order-title-section">
          <h1 className="order-title">
            Order {order.order_number || '#' + order.id.slice(0,8)}
            <span className={`order-status-badge status-${status}`}>
              {status.replace(/_/g, ' ').toUpperCase()}
            </span>
          </h1>
          <p className="order-date">
            Placed on {new Date(order.created_at).toLocaleString()}
          </p>
        </div>
      </div>

      <div className="order-content">
        {/* LEFT COLUMN: Workflow & Details */}
        <div className="order-main-content">
          {/* Workflow Action Card */}
          {status !== 'cancelled' && status !== 'delivered' && status !== 'collected' && (
            <div className="section-card workflow-card">
              <div className="workflow-header">
                <div className="workflow-info">
                  <h3 className="section-title">Next Step</h3>
                  <p className="workflow-current-stage">
                    Current stage: <strong className="capitalize">{status.replace(/_/g, ' ')}</strong>
                  </p>
                </div>
                {nextAction && (
                  <button
                    onClick={() => statusMutation.mutate(nextStatus)}
                    disabled={statusMutation.isPending}
                    className="btn-primary"
                  >
                    {statusMutation.isPending ? 'Updating...' : (
                      <>
                        <CheckCircle size={18} />
                        {nextAction}
                      </>
                    )}
                  </button>
                )}
              </div>
            </div>
          )}

          {/* Order Items */}
          <div className="section-card">
            <div className="mb-4">
              <h3 className="section-title">
                <Package size={20} />
                Order Items ({items.length})
              </h3>
            </div>
            <div className="items-table-container">
              <table className="items-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th className="text-center">Qty</th>
                    <th className="text-right">Price</th>
                    <th className="text-right">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item, i) => {
                    // ROBUST: Handle multiple field name variations for pricing
                    const unitPriceCents =
                      asCentsColumn(item.unit_price_cents) ??
                      asRandsToCents(item.unit_price) ??
                      asRandsToCents(item.price) ??
                      0;
                    const quantity = item.quantity || 0;
                    const totalCents =
                      asCentsColumn(item.line_total_cents) ??
                      asRandsToCents(item.line_total) ??
                      (unitPriceCents * quantity);

                    return (
                      <tr key={i} className="item-row">
                        <td className="item-name">
                          <div className="item-title">{item.name || item.product_name || 'Unknown Item'}</div>
                          {item.variant && <div className="item-variant">{item.variant}</div>}
                          {item.customization && (
                            <dl className="item-request">
                              <dt>Shade request</dt>
                              <dd>{item.customization.tiktok_handle || 'No TikTok handle'}</dd>
                              {item.customization.vibe && (<><dt>Vibe</dt><dd>{item.customization.vibe}</dd></>)}
                              {item.customization.base_colour && (<><dt>Base colour</dt><dd>{item.customization.base_colour}</dd></>)}
                              {item.customization.add_ins && (<><dt>Add-ins</dt><dd>{item.customization.add_ins}</dd></>)}
                              {item.customization.shade_name && (<><dt>Shade name idea</dt><dd>{item.customization.shade_name}</dd></>)}
                              {Array.isArray(item.customization.inspiration_images) && item.customization.inspiration_images.length > 0 && (
                                <>
                                  <dt>Inspiration photos</dt>
                                  <dd className="item-request-images">
                                    {item.customization.inspiration_images.map((url, idx) => (
                                      <a key={url} href={url} target="_blank" rel="noopener noreferrer" title="Open full size">
                                        <img src={url} alt={`Inspiration ${idx + 1}`} />
                                      </a>
                                    ))}
                                  </dd>
                                </>
                              )}
                              {item.customization.inspiration_link && (
                                <>
                                  <dt>Inspiration link</dt>
                                  <dd><a href={item.customization.inspiration_link} target="_blank" rel="noopener noreferrer">{item.customization.inspiration_link}</a></dd>
                                </>
                              )}
                            </dl>
                          )}
                        </td>
                        <td className="item-qty text-center">{quantity}</td>
                        <td className="item-price text-right">{formatMoney(unitPriceCents)}</td>
                        <td className="item-total text-right font-bold">{formatMoney(totalCents)}</td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="border-t-2 border-gray-100">
                    <td colSpan={2} className="py-3 px-3"></td>
                    <td className="text-right py-2 px-3 text-sm text-gray-600">Subtotal</td>
                    <td className="text-right py-2 px-3 text-sm font-medium">
                      {formatMoney(subtotalCents)}
                    </td>
                  </tr>
                  <tr>
                    <td colSpan={2} className="py-0 px-3"></td>
                    <td className="text-right py-2 px-3 text-sm text-gray-600">Shipping</td>
                    <td className="text-right py-2 px-3 text-sm font-medium">
                      {formatMoney(shippingCents)}
                    </td>
                  </tr>
                  {/* Discount Row */}
                  {discountCents > 0 && (
                    <tr>
                      <td colSpan={2} className="py-0 px-3"></td>
                      <td className="text-right py-2 px-3 text-sm text-green-600">
                        {discountLabel}
                      </td>
                      <td className="text-right py-2 px-3 text-sm font-medium text-green-600">
                        -{formatMoney(discountCents)}
                      </td>
                    </tr>
                  )}
                  {/* Final Total */}
                  <tr className="border-t">
                    <td colSpan={2} className="py-3 px-3"></td>
                    <td className="text-right py-3 px-3 text-base font-bold">Total</td>
                    <td className="text-right py-3 px-3 text-base font-bold">
                      {formatMoney(totalCents)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          {/* Timeline */}
          <div className="section-card">
            <h3 className="section-title">
              <Clock size={20} />
              Timeline
            </h3>
            <div className="timeline-container">
              {/* Placed */}
              <TimelineItem
                title="Order Placed"
                date={order.placed_at || order.created_at}
                isCompleted={true}
              />
              {/* Paid */}
              <TimelineItem
                title="Payment Confirmed"
                date={order.paid_at}
                isCompleted={!!order.paid_at}
                isActive={status === 'unpaid'}
              />
              {/* Packed */}
              <TimelineItem
                title="Packed"
                date={order.order_packed_at}
                isCompleted={!!order.order_packed_at}
                isActive={status === 'paid'}
              />

              {type === 'delivery' ? (
                <>
                  <TimelineItem
                    title="Out for Delivery"
                    date={order.order_out_for_delivery_at}
                    isCompleted={!!order.order_out_for_delivery_at}
                    isActive={status === 'packed'}
                  />
                  <TimelineItem
                    title="Delivered"
                    date={order.order_delivered_at}
                    isCompleted={!!order.order_delivered_at}
                    isActive={status === 'out_for_delivery'}
                  />
                </>
              ) : (
                 <TimelineItem
                    title="Collected"
                    date={order.order_collected_at}
                    isCompleted={!!order.order_collected_at}
                    isActive={status === 'packed'}
                  />
              )}
            </div>
          </div>
        </div>

        {/* RIGHT COLUMN: Info Sidebar */}
        <div className="order-sidebar">
          {/* Customer Info */}
          <div className="section-card">
            <h3 className="sidebar-section-title">
              <User size={18} />
              Customer
            </h3>
            <div className="customer-info">
              <div className="info-item">
                <div className="info-label">Name</div>
                <div className="info-value">{order.buyer_name || order.customer_name || 'Guest'}</div>
              </div>
              <div className="info-item">
                <div className="info-label">Email</div>
                <a href={`mailto:${order.buyer_email || order.customer_email}`} className="info-link">
                  {order.buyer_email || order.customer_email}
                </a>
              </div>
              <div className="info-item">
                <div className="info-label">Phone</div>
                <div className="info-value">{order.buyer_phone || order.customer_phone || '-'}</div>
              </div>
            </div>
          </div>

          {/* Invoice Info */}
          <div className="section-card">
            <h3 className="sidebar-section-title">
              <FileText size={18} />
              Invoice
            </h3>
            <div className="invoice-section">
              <div className="info-item mb-3">
                <div className="info-label">Status</div>
                {hasInvoice ? (
                  <div className="info-value text-green-600 font-bold">✅ Invoice Available</div>
                ) : (
                  <div className="info-value text-orange-600 font-bold">⚠️ No invoice yet</div>
                )}
              </div>

              <div className="info-item">
                <div className="info-label mb-2">Actions</div>
                {hasInvoice ? (
                  <div className="flex flex-col gap-2">
                    <a
                      href={order.invoice_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="btn-primary inline-flex items-center gap-2 w-full justify-center"
                    >
                      <Download size={16} />
                      View/Download Invoice
                    </a>
                    {invoiceToolsEnabled && (
                      <button
                        type="button"
                        className="btn-secondary inline-flex items-center gap-2 w-full justify-center text-sm"
                        disabled={generateInvoiceMutation.isPending}
                        onClick={() => {
                          if (window.confirm('Regenerate invoice? This will overwrite the existing file.')) {
                            generateInvoiceMutation.mutate();
                          }
                        }}
                      >
                        <RefreshCw size={14} />
                        {generateInvoiceMutation.isPending ? "Regenerating..." : "Regenerate Invoice"}
                      </button>
                    )}
                  </div>
                ) : (
                  <button
                    type="button"
                    className="btn-primary inline-flex items-center gap-2"
                    disabled={!isPaid || !order?.m_payment_id || generateInvoiceMutation.isPending}
                    onClick={() => generateInvoiceMutation.mutate()}
                  >
                    <FileText size={16} />
                    {generateInvoiceMutation.isPending ? "Generating…" : "Generate Invoice"}
                  </button>
                )}

                {!isPaid && !hasInvoice && (
                  <div className="text-xs text-[var(--text-muted)] mt-2">
                    Invoice can be generated once payment is marked as paid.
                  </div>
                )}

                {isPaid && (
                  <button
                    type="button"
                    className="btn-secondary inline-flex items-center gap-2 mt-3"
                    disabled={notifyOrderMutation.isPending}
                    onClick={() => notifyOrderMutation.mutate()}
                  >
                    {notifyOrderMutation.isPending ? 'Sending…' : 'Send Notification'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* Delivery / Collection Info */}
          <div className="section-card">
            <h3 className="sidebar-section-title">
              <Truck size={18} />
              {type === 'collection' ? (isCourierCollection ? 'Courier Collection Details' : 'Collection Details') : 'Delivery Details'}
            </h3>
            <div className="delivery-info">
              <div className="bg-[var(--bg)] p-3 rounded-lg mb-2">
                <span className="text-xs font-bold uppercase text-[var(--text-muted)] block mb-1">Method</span>
                <span className="font-bold capitalize">{isCourierCollection ? 'Courier Collection' : type}</span>
              </div>

              {type === 'delivery' ? (
                 <div>
                   <div className="text-[var(--text-muted)] text-xs uppercase font-bold">Shipping Address</div>
                   <div className="whitespace-pre-wrap mt-1 leading-relaxed">
                     {formatAddress(
                       order.shipping_address ||
                       order.delivery_address ||
                       order.ship_to_address ||
                       'No delivery address provided - Please contact customer for address details'
                     )}
                   </div>
                 </div>
              ) : (
                 <div>
                   <div className="text-[var(--text-muted)] text-xs uppercase font-bold">
                     {isCourierCollection ? 'Courier Collection Point' : 'Collection Point'}
                   </div>
                   <div className="mt-1">
                     {order.collection_location || (
                       <>BLOM Cosmetics Studio<br/>(See Settings for Address)</>
                     )}
                   </div>
                   {isCourierCollection && (
                     <div className="text-[var(--text-muted)] text-xs mt-2">
                       Customer is arranging their own courier — pack and have it ready for collection.
                     </div>
                   )}
                 </div>
              )}
            </div>
          </div>

          {/* Notes */}
          <div className="section-card">
            <h3 className="sidebar-section-title">
              <FileText size={18} />
              Internal Notes
            </h3>
            <textarea
              className="notes-textarea"
              placeholder="Add note..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled // Enable if you add a save-note function
            />
          </div>

        </div>
      </div>
    </div>
    </>
  );
}

function TimelineItem({ title, date, isCompleted, isActive }) {
  return (
    <div className="timeline-item">
      <div className={`timeline-dot ${isCompleted ? 'completed' : isActive ? 'active' : ''}`} />
      <div className={`timeline-content ${isCompleted ? 'completed' : 'pending'}`}>
        {title}
      </div>
      {date && (
        <div className="timeline-date">
          {new Date(date).toLocaleString()}
        </div>
      )}
    </div>
  );
}
