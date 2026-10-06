-- Allow staff to delete a saved in-store invoice: removing the header removes its
-- item snapshots in the same statement, so an invoice can never be left half-deleted.
-- Deleted invoice numbers are not reused (the daily counter only moves forward).
ALTER TABLE public.in_store_invoice_items
  DROP CONSTRAINT in_store_invoice_items_invoice_id_fkey,
  ADD CONSTRAINT in_store_invoice_items_invoice_id_fkey
    FOREIGN KEY (invoice_id) REFERENCES public.in_store_invoices(id) ON DELETE CASCADE;
