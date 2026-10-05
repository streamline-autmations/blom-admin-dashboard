import { supabase } from '@/lib/supabase';

export async function invoiceRequest(params = '', options = {}) {
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session?.access_token) throw new Error('Please sign in again to access invoices.');
  const response = await fetch(`/.netlify/functions/admin-in-store-invoices${params}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${data.session.access_token}`,
    },
  });
  if (!response.ok) {
    const result = await response.json().catch(() => ({}));
    throw new Error(result.error || `Invoice request failed (${response.status}). Please try again.`);
  }
  return response.headers.get('content-type')?.includes('application/pdf')
    ? response.blob() : response.json();
}

export async function openInvoicePdf(invoice, print = false) {
  // Open synchronously in the click handler so browsers do not block the print window.
  const printWindow = print ? window.open('', '_blank') : null;
  if (print && !printWindow) throw new Error('Allow pop-ups to print this invoice.');
  if (printWindow) {
    printWindow.document.title = invoice.invoice_number;
    printWindow.document.body.textContent = 'Preparing invoice for printing…';
    printWindow.opener = null;
  }
  try {
    const pdf = await invoiceRequest(`?action=pdf&id=${encodeURIComponent(invoice.id)}`);
    const url = URL.createObjectURL(pdf);
    if (printWindow) {
      if (printWindow.closed) { URL.revokeObjectURL(url); return; }
      const frame = printWindow.document.createElement('iframe');
      frame.title = invoice.invoice_number;
      frame.style.cssText = 'width:100%;height:100vh;border:0';
      printWindow.document.body.style.margin = '0';
      const button = printWindow.document.createElement('button');
      button.textContent = 'Print Invoice';
      button.style.cssText = 'position:fixed;top:12px;right:24px;z-index:2;padding:12px';
      const triggerPrint = () => {
        try { frame.contentWindow.focus(); frame.contentWindow.print(); }
        catch { printWindow.print(); }
      };
      button.onclick = triggerPrint;
      // Let staff trigger print after the PDF viewer loads. Auto-printing a PDF
      // iframe is unreliable across browser PDF plugins (and can crash Chromium).
      frame.src = url;
      printWindow.document.body.replaceChildren(button, frame);
      printWindow.addEventListener('pagehide', () => URL.revokeObjectURL(url), { once: true });
    } else {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${invoice.invoice_number}.pdf`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60000);
    }
  } catch (error) {
    printWindow?.close();
    throw error;
  }
}
