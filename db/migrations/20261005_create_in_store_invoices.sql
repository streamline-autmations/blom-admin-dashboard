BEGIN;

-- Independent from orders: these records never invoke payment, stock or fulfilment triggers.
CREATE TABLE public.in_store_invoice_sequences (
  invoice_date date PRIMARY KEY,
  last_number integer NOT NULL CHECK (last_number > 0)
);

CREATE TABLE public.in_store_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL UNIQUE,
  invoice_number text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid NOT NULL,
  customer_name text NOT NULL CHECK (length(customer_name) BETWEEN 1 AND 160),
  customer_phone text CHECK (length(customer_phone) <= 40),
  customer_email text CHECK (length(customer_email) <= 254),
  subtotal numeric(14,2) NOT NULL CHECK (subtotal >= 0),
  total numeric(14,2) NOT NULL CHECK (total = subtotal),
  banking_details jsonb NOT NULL
);

CREATE TABLE public.in_store_invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES public.in_store_invoices(id),
  position integer NOT NULL,
  -- Deliberately no product FK: deleting a product must not delete an invoice's snapshot.
  product_id uuid NOT NULL,
  product_name text NOT NULL,
  sku text,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 9999),
  unit_price numeric(14,2) NOT NULL CHECK (unit_price >= 0),
  line_total numeric(14,2) NOT NULL CHECK (line_total = unit_price * quantity),
  UNIQUE (invoice_id, position)
);

CREATE INDEX in_store_invoices_created_at_idx ON public.in_store_invoices(created_at DESC, id);

ALTER TABLE public.in_store_invoice_sequences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.in_store_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.in_store_invoice_items ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.in_store_invoice_sequences, public.in_store_invoices,
  public.in_store_invoice_items FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.in_store_invoice_sequences, public.in_store_invoices,
  public.in_store_invoice_items TO service_role;

-- Only the authenticated Admin Netlify function can call this service-role RPC.
-- Prices/names come from products, never from browser-submitted totals.
CREATE FUNCTION public.create_in_store_invoice(
  p_request_id uuid, p_created_by uuid, p_customer_name text,
  p_customer_phone text, p_customer_email text, p_items jsonb, p_banking_details jsonb
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_day date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_sequence integer;
  v_item jsonb;
  v_product public.products%ROWTYPE;
  v_quantity integer;
  v_price numeric(14,2);
  v_total numeric(14,2) := 0;
  v_snapshots jsonb := '[]'::jsonb;
  v_position integer := 0;
BEGIN
  IF p_request_id IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'A submission ID and staff ID are required' USING ERRCODE = '22023';
  END IF;

  -- Serializes retries of the same request, including concurrent requests.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  SELECT id INTO v_id FROM public.in_store_invoices
    WHERE request_id = p_request_id AND created_by = p_created_by;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  IF p_customer_name IS NULL OR length(btrim(p_customer_name)) NOT BETWEEN 1 AND 160
    OR length(coalesce(p_customer_phone, '')) > 40
    OR length(coalesce(p_customer_email, '')) > 254 THEN
    RAISE EXCEPTION 'Enter valid customer details' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Add at least one product' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'An invoice must contain between 1 and 100 products' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_banking_details) IS DISTINCT FROM 'object'
    OR NOT (p_banking_details ?& ARRAY['bank_name', 'account_holder', 'account_number', 'account_type', 'branch_code']) THEN
    RAISE EXCEPTION 'BLOM banking details must be configured' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT item->>'product_id') FROM jsonb_array_elements(p_items) item)
    <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'Combine duplicate products into one invoice line' USING ERRCODE = '22023';
  END IF;

  -- Lock in a stable order to avoid deadlocks when invoices share products.
  PERFORM id FROM public.products
    WHERE id IN (SELECT (item->>'product_id')::uuid FROM jsonb_array_elements(p_items) item)
    ORDER BY id FOR SHARE;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF coalesce(v_item->>'quantity', '') !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'Quantity must be a whole number between 1 and 9999' USING ERRCODE = '22023';
    END IF;
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity NOT BETWEEN 1 AND 9999 THEN
      RAISE EXCEPTION 'Quantity must be a whole number between 1 and 9999' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_product FROM public.products WHERE id = (v_item->>'product_id')::uuid;
    IF NOT FOUND OR v_product.is_active IS DISTINCT FROM true
      OR coalesce(v_product.status, '') IN ('archived', 'deleted') THEN
      RAISE EXCEPTION 'A selected product is no longer available. Remove it and search again.' USING ERRCODE = '22023';
    END IF;
    IF v_product.price IS NULL OR v_product.price < 0 OR v_product.price::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'A selected product has no valid price' USING ERRCODE = '22023';
    END IF;
    v_price := round(v_product.price::numeric, 2);
    IF v_item->>'expected_price_cents' IS NULL
      OR (v_item->>'expected_price_cents')::numeric <> v_price * 100 THEN
      RAISE EXCEPTION 'A product price changed. Remove that product and add it again to review its current price.' USING ERRCODE = 'P0001';
    END IF;
    v_total := v_total + v_price * v_quantity;
    v_position := v_position + 1;
    v_snapshots := v_snapshots || jsonb_build_array(jsonb_build_object(
      'position', v_position, 'product_id', v_product.id, 'product_name', v_product.name,
      'sku', v_product.sku, 'quantity', v_quantity, 'unit_price', v_price,
      'line_total', v_price * v_quantity
    ));
  END LOOP;

  -- UPSERT takes a row lock per South African calendar day. Never use MAX()+1.
  INSERT INTO public.in_store_invoice_sequences AS seq (invoice_date, last_number)
    VALUES (v_day, 1)
    ON CONFLICT (invoice_date) DO UPDATE SET last_number = seq.last_number + 1
    RETURNING last_number INTO v_sequence;

  INSERT INTO public.in_store_invoices (
    request_id, invoice_number, created_by, customer_name, customer_phone, customer_email,
    subtotal, total, banking_details
  ) VALUES (
    p_request_id,
    'INV-' || to_char(v_day, 'YYYYMMDD') || '-' || lpad(v_sequence::text, greatest(3, length(v_sequence::text)), '0'),
    p_created_by, btrim(p_customer_name), nullif(btrim(p_customer_phone), ''),
    nullif(btrim(p_customer_email), ''), v_total, v_total, p_banking_details
  ) RETURNING id INTO v_id;

  INSERT INTO public.in_store_invoice_items (
    invoice_id, position, product_id, product_name, sku, quantity, unit_price, line_total
  ) SELECT v_id, x.position, x.product_id, x.product_name, x.sku, x.quantity, x.unit_price, x.line_total
    FROM jsonb_to_recordset(v_snapshots) AS x (
      position integer, product_id uuid, product_name text, sku text,
      quantity integer, unit_price numeric, line_total numeric
    );
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_in_store_invoice(uuid, uuid, text, text, text, jsonb, jsonb)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_in_store_invoice(uuid, uuid, text, text, text, jsonb, jsonb)
  TO service_role;

COMMIT;
