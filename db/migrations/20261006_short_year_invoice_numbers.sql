-- Invoice numbers use a two-digit year: INV-YYMMDD-### (e.g. INV-261006-003).
-- Rewrites only the date format inside the live RPC so every other rule is preserved.
-- Existing invoices keep their original INV-YYYYMMDD-### numbers; the shorter prefix
-- cannot collide with them, and the daily counter continues unchanged.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef(
    'public.create_in_store_invoice(uuid,uuid,text,text,text,jsonb,jsonb)'::regprocedure);
BEGIN
  IF position($fmt$to_char(v_day, 'YYYYMMDD')$fmt$ IN v_definition) = 0 THEN
    RAISE EXCEPTION 'create_in_store_invoice does not contain the expected invoice date format';
  END IF;
  EXECUTE replace(v_definition, $fmt$to_char(v_day, 'YYYYMMDD')$fmt$, $fmt$to_char(v_day, 'YYMMDD')$fmt$);
END;
$migration$;
