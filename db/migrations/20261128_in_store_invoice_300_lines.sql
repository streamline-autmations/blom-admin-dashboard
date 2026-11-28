-- Raise the in-store invoice line limit from 100 to 300 (large distributor orders hit 100).
-- Rewrites only the limit check in the live functions, so the rest of each body is untouched.
-- Keep in step with maxLines in src/pages/InStoreInvoices.jsx and admin-in-store-invoices.ts.
DO $$
DECLARE
  fn regprocedure;
  def text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.create_in_store_invoice_with_shipping(uuid, uuid, text, text, text, jsonb, jsonb, text, integer, text)'::regprocedure,
    'public.update_in_store_invoice(uuid, uuid, text, text, text, jsonb, integer, text)'::regprocedure
  ] LOOP
    def := pg_get_functiondef(fn);
    IF position('jsonb_array_length(p_items) NOT BETWEEN 1 AND 100' IN def) = 0 THEN
      RAISE EXCEPTION '% does not contain the expected 100-line check', fn;
    END IF;
    def := replace(def, 'jsonb_array_length(p_items) NOT BETWEEN 1 AND 100', 'jsonb_array_length(p_items) NOT BETWEEN 1 AND 300');
    def := replace(def, 'between 1 and 100 items', 'between 1 and 300 items');
    EXECUTE def;
  END LOOP;
END $$;
