-- The read-only role's rights in ONE database (run by restore.sh as this container's superuser, with -v db=<name>).
-- The role is the real protection: what is not granted here cannot be read, whatever SQL is sent.
--   - whole tables never granted: API keys, two-step devices, the shop's session and throttle tables
--   - columns never granted, in any table: names matching the secret pattern below, ir_config_parameter.value, ir_attachment contents
--   - personal columns (email, phone, street, zip, users' login) are not granted on the base table; mcp_masked.<table> shows them masked
--   - only base tables in public are granted (not Odoo's own SQL views, which could show other tables through their owner's rights)
\set ON_ERROR_STOP on
SET default_transaction_read_only = off;
REVOKE ALL ON DATABASE :"db" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"db" TO clothcraft_mcp;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE ALL ON SCHEMA public FROM clothcraft_mcp;
GRANT USAGE ON SCHEMA public TO clothcraft_mcp;
DROP SCHEMA IF EXISTS mcp_masked CASCADE;
CREATE SCHEMA mcp_masked;
REVOKE ALL ON SCHEMA mcp_masked FROM PUBLIC;
GRANT USAGE ON SCHEMA mcp_masked TO clothcraft_mcp;

DO $$
DECLARE
  t record;
  c record;
  allowed text[];
  masked int;
  sel text;
  n_all int;
  denied_tables text[] := ARRAY['res_users_apikeys', 'auth_totp_device', 'clothcraft_api_session', 'clothcraft_api_throttle'];
  secret_re text := '(password|passwd|secret|token|api_?key|sid_hash|totp|signup|private_key|credential|salt)';
  pii_email text[] := ARRAY['email', 'email_normalized', 'email_from', 'email_to', 'email_cc', 'reply_to'];
  pii_phone text[] := ARRAY['phone', 'mobile', 'phone_sanitized'];
  pii_addr text[] := ARRAY['street', 'street2', 'zip'];
BEGIN
  FOR t IN SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY 1 LOOP
    EXECUTE format('REVOKE ALL ON public.%I FROM clothcraft_mcp', t.table_name);
    CONTINUE WHEN t.table_name = ANY (denied_tables);
    allowed := '{}'; masked := 0; sel := ''; n_all := 0;
    FOR c IN SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t.table_name ORDER BY ordinal_position LOOP
      n_all := n_all + 1;
      IF c.column_name ~ secret_re
         OR (t.table_name = 'ir_config_parameter' AND c.column_name = 'value')
         OR (t.table_name = 'ir_attachment' AND c.column_name IN ('db_datas', 'store_fname', 'checksum', 'access_token')) THEN
        CONTINUE;                                                         -- hidden: not in the table grant, not in the view
      ELSIF c.column_name = ANY (pii_email) OR (t.table_name = 'res_users' AND c.column_name = 'login') THEN
        masked := masked + 1;
        sel := sel || format(', CASE WHEN %1$I IS NULL THEN NULL ELSE left(split_part(%1$I::text, ''@'', 1), 1) || ''***@'' || split_part(%1$I::text, ''@'', 2) END AS %1$I', c.column_name);
      ELSIF c.column_name = ANY (pii_phone) THEN
        masked := masked + 1;
        sel := sel || format(', CASE WHEN %1$I IS NULL THEN NULL ELSE ''***'' || right(regexp_replace(%1$I::text, ''\D'', '''', ''g''), 2) END AS %1$I', c.column_name);
      ELSIF c.column_name = ANY (pii_addr) THEN
        masked := masked + 1;
        sel := sel || format(', CASE WHEN %1$I IS NULL THEN NULL ELSE ''***'' END AS %1$I', c.column_name);
      ELSE
        allowed := allowed || c.column_name::text;
        sel := sel || format(', %I', c.column_name);
      END IF;
    END LOOP;
    IF cardinality(allowed) = n_all THEN
      EXECUTE format('GRANT SELECT ON public.%I TO clothcraft_mcp', t.table_name);
    ELSIF cardinality(allowed) > 0 THEN
      EXECUTE format('GRANT SELECT (%s) ON public.%I TO clothcraft_mcp', (SELECT string_agg(quote_ident(x), ', ') FROM unnest(allowed) x), t.table_name);
    END IF;
    IF masked > 0 THEN
      EXECUTE format('CREATE VIEW mcp_masked.%I AS SELECT %s FROM public.%I', t.table_name, substr(sel, 3), t.table_name);
      EXECUTE format('GRANT SELECT ON mcp_masked.%I TO clothcraft_mcp', t.table_name);
    END IF;
  END LOOP;
END $$;
