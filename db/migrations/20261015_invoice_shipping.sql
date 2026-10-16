BEGIN;

-- Optional shipping / courier cost on in-store invoices. Additive: existing invoices keep
-- shipping = 0 (so total = subtotal still holds) and the older RPCs keep working unchanged.
ALTER TABLE public.in_store_invoices
  ADD COLUMN shipping numeric(14,2) NOT NULL DEFAULT 0 CHECK (shipping >= 0),
  ADD COLUMN shipping_label text CHECK (length(shipping_label) <= 60);
ALTER TABLE public.in_store_invoices DROP CONSTRAINT in_store_invoices_check;
ALTER TABLE public.in_store_invoices
  ADD CONSTRAINT in_store_invoices_total_check CHECK (total = subtotal + shipping);

-- New name instead of replacing create_in_store_invoice_tiered (same approach as the price-list
-- migration). Identical to it, including the 'extra' (invoice-only item) branch, plus shipping.
CREATE FUNCTION public.create_in_store_invoice_with_shipping(
  p_request_id uuid, p_created_by uuid, p_customer_name text,
  p_customer_phone text, p_customer_email text, p_items jsonb, p_banking_details jsonb,
  p_price_tier text, p_shipping_cents integer DEFAULT 0, p_shipping_label text DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
  v_id uuid;
  v_day date := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  v_sequence integer;
  v_item jsonb;
  v_catalog_id uuid;
  v_type text;
  v_package_index integer;
  v_course public.courses%ROWTYPE;
  v_package jsonb;
  v_name text;
  v_sku text;
  v_available boolean;
  v_raw_price numeric;
  v_quantity integer;
  v_price numeric(14,2);
  v_total numeric(14,2) := 0;
  v_snapshots jsonb := '[]'::jsonb;
  v_position integer := 0;
  v_tier text := nullif(btrim(p_price_tier), '');
  v_tier_name text;
  v_tier_cents integer;
  v_shipping numeric(14,2) := round(coalesce(p_shipping_cents, 0)::numeric / 100, 2);
  v_shipping_label text := nullif(btrim(coalesce(p_shipping_label, '')), '');
BEGIN
  IF p_request_id IS NULL OR p_created_by IS NULL THEN
    RAISE EXCEPTION 'A submission ID and staff ID are required' USING ERRCODE = '22023';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request_id::text, 0));
  SELECT id INTO v_id FROM public.in_store_invoices
    WHERE request_id = p_request_id AND created_by = p_created_by;
  IF v_id IS NOT NULL THEN RETURN v_id; END IF;

  IF p_customer_name IS NULL OR length(btrim(p_customer_name)) NOT BETWEEN 1 AND 160
    OR length(coalesce(p_customer_phone, '')) > 40
    OR length(coalesce(p_customer_email, '')) > 254 THEN
    RAISE EXCEPTION 'Enter valid customer details' USING ERRCODE = '22023';
  END IF;
  IF coalesce(p_shipping_cents, 0) NOT BETWEEN 0 AND 1000000 OR length(coalesce(v_shipping_label, '')) > 60 THEN
    RAISE EXCEPTION 'Enter a valid shipping amount (R0 to R10 000) and label' USING ERRCODE = '22023';
  END IF;
  IF v_tier IS NOT NULL THEN
    SELECT name INTO v_tier_name FROM public.price_tiers WHERE slug = v_tier AND is_active;
    IF v_tier_name IS NULL THEN
      RAISE EXCEPTION 'That price list is not available' USING ERRCODE = '22023';
    END IF;
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'Add at least one item' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(p_items) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'An invoice must contain between 1 and 100 items' USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_banking_details) IS DISTINCT FROM 'object'
    OR NOT (p_banking_details ?& ARRAY['bank_name', 'account_holder', 'account_number', 'account_type', 'branch_code']) THEN
    RAISE EXCEPTION 'BLOM banking details must be configured' USING ERRCODE = '22023';
  END IF;
  IF (SELECT count(DISTINCT (
      coalesce(item->>'item_type', 'product'), item->>'product_id', item->>'course_package_index'
    )) FROM jsonb_array_elements(p_items) item) <> jsonb_array_length(p_items) THEN
    RAISE EXCEPTION 'Combine duplicate products or catalog items into one invoice line' USING ERRCODE = '22023';
  END IF;

  -- Every request locks catalogs in the same order, and IDs within each catalog.
  PERFORM id FROM public.products
    WHERE id IN (SELECT (item->>'product_id')::uuid FROM jsonb_array_elements(p_items) item
      WHERE coalesce(item->>'item_type', 'product') = 'product') ORDER BY id FOR SHARE;
  PERFORM id FROM public.bundles
    WHERE id IN (SELECT (item->>'product_id')::uuid FROM jsonb_array_elements(p_items) item
      WHERE item->>'item_type' = 'bundle') ORDER BY id FOR SHARE;
  PERFORM id FROM public.courses
    WHERE id IN (SELECT (item->>'product_id')::uuid FROM jsonb_array_elements(p_items) item
      WHERE item->>'item_type' = 'course') ORDER BY id FOR SHARE;

  FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) LOOP
    IF coalesce(v_item->>'quantity', '') !~ '^[0-9]{1,4}$' THEN
      RAISE EXCEPTION 'Quantity must be a whole number between 1 and 9999' USING ERRCODE = '22023';
    END IF;
    v_quantity := (v_item->>'quantity')::integer;
    IF v_quantity NOT BETWEEN 1 AND 9999 THEN
      RAISE EXCEPTION 'Quantity must be a whole number between 1 and 9999' USING ERRCODE = '22023';
    END IF;
    v_catalog_id := (v_item->>'product_id')::uuid;
    v_type := coalesce(v_item->>'item_type', 'product');
    v_package_index := (v_item->>'course_package_index')::integer;
    IF v_catalog_id IS NULL OR v_type NOT IN ('product', 'bundle', 'course', 'extra')
      OR (v_package_index IS NOT NULL AND (v_type <> 'course' OR v_package_index NOT BETWEEN 0 AND 999)) THEN
      RAISE EXCEPTION 'Invalid invoice item' USING ERRCODE = '22023';
    END IF;
    v_name := NULL; v_sku := NULL; v_raw_price := NULL; v_available := false;
    IF v_type = 'product' THEN
      SELECT name, sku, price, is_active IS TRUE AND coalesce(status, '') NOT IN ('archived', 'deleted')
        INTO v_name, v_sku, v_raw_price, v_available FROM public.products WHERE id = v_catalog_id;
    ELSIF v_type = 'bundle' THEN
      SELECT name, sku, price_cents::numeric / 100, is_active IS TRUE AND coalesce(status, '') NOT IN ('archived', 'deleted')
        INTO v_name, v_sku, v_raw_price, v_available FROM public.bundles WHERE id = v_catalog_id;
    ELSIF v_type = 'extra' THEN
      SELECT name, code, retail_price_cents::numeric / 100, is_active
        INTO v_name, v_sku, v_raw_price, v_available FROM public.invoice_only_items WHERE id = v_catalog_id;
    ELSE
      SELECT * INTO v_course FROM public.courses WHERE id = v_catalog_id;
      v_available := FOUND AND v_course.is_active IS TRUE;
      v_name := v_course.title;
      v_raw_price := v_course.price;
      IF v_package_index IS NOT NULL THEN
        v_package := v_course.packages->v_package_index;
        IF jsonb_typeof(v_package) IS DISTINCT FROM 'object'
          OR nullif(btrim(v_package->>'name'), '') IS NULL OR v_package->>'price' IS NULL THEN
          RAISE EXCEPTION 'A course package is no longer available. Remove it and search again.' USING ERRCODE = '22023';
        END IF;
        v_name := v_name || ' — ' || (v_package->>'name');
        v_raw_price := (v_package->>'price')::numeric;
      ELSIF jsonb_typeof(v_course.packages) = 'array' THEN
        IF jsonb_array_length(v_course.packages) > 0 THEN
          RAISE EXCEPTION 'Choose a course package from the search results.' USING ERRCODE = '22023';
        END IF;
      END IF;
    END IF;
    IF v_available IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'A selected item is no longer available. Remove it and search again.' USING ERRCODE = '22023';
    END IF;
    -- Reseller price lists override the retail price; items missing from the list stay at retail.
    IF v_tier IS NOT NULL AND v_type IN ('product', 'bundle', 'extra') THEN
      SELECT price_cents INTO v_tier_cents FROM public.tier_prices
        WHERE tier_slug = v_tier AND item_type = v_type AND item_id = v_catalog_id;
      IF FOUND THEN v_raw_price := v_tier_cents::numeric / 100; END IF;
    END IF;
    IF v_raw_price IS NULL OR v_raw_price < 0 OR v_raw_price::text IN ('NaN', 'Infinity', '-Infinity') THEN
      RAISE EXCEPTION 'A selected item has no valid price' USING ERRCODE = '22023';
    END IF;
    v_price := round(v_raw_price, 2);
    IF v_item->>'expected_price_cents' IS NULL
      OR (v_item->>'expected_price_cents')::numeric <> v_price * 100 THEN
      RAISE EXCEPTION 'An item price changed. Remove that item and add it again to review its current price.' USING ERRCODE = 'P0001';
    END IF;
    v_total := v_total + v_price * v_quantity;
    v_position := v_position + 1;
    v_snapshots := v_snapshots || jsonb_build_array(jsonb_build_object(
      'position', v_position, 'product_id', v_catalog_id, 'product_name', v_name,
      'item_type', v_type, 'course_package_index', v_package_index,
      'sku', v_sku, 'quantity', v_quantity, 'unit_price', v_price, 'line_total', v_price * v_quantity
    ));
  END LOOP;

  INSERT INTO public.in_store_invoice_sequences AS seq (invoice_date, last_number)
    VALUES (v_day, 1) ON CONFLICT (invoice_date) DO UPDATE SET last_number = seq.last_number + 1
    RETURNING last_number INTO v_sequence;
  INSERT INTO public.in_store_invoices (
    request_id, invoice_number, created_by, customer_name, customer_phone, customer_email,
    subtotal, shipping, shipping_label, total, banking_details, price_tier, price_tier_name
  ) VALUES (
    p_request_id,
    'INV-' || to_char(v_day, 'YYMMDD') || '-' || lpad(v_sequence::text, greatest(3, length(v_sequence::text)), '0'),
    p_created_by, btrim(p_customer_name), nullif(btrim(p_customer_phone), ''),
    nullif(btrim(p_customer_email), ''), v_total, v_shipping, v_shipping_label, v_total + v_shipping, p_banking_details, v_tier, v_tier_name
  ) RETURNING id INTO v_id;
  INSERT INTO public.in_store_invoice_items (
    invoice_id, position, product_id, product_name, item_type, course_package_index,
    sku, quantity, unit_price, line_total
  ) SELECT v_id, x.position, x.product_id, x.product_name, x.item_type, x.course_package_index,
    x.sku, x.quantity, x.unit_price, x.line_total
    FROM jsonb_to_recordset(v_snapshots) AS x (
      position integer, product_id uuid, product_name text, item_type text, course_package_index integer,
      sku text, quantity integer, unit_price numeric, line_total numeric
    );
  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.create_in_store_invoice_with_shipping(uuid, uuid, text, text, text, jsonb, jsonb, text, integer, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_in_store_invoice_with_shipping(uuid, uuid, text, text, text, jsonb, jsonb, text, integer, text)
  TO service_role;

COMMIT;
