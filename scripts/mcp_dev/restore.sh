#!/bin/bash
# Restore a dump into the MCP sandbox and give the read-only role its rights. Usage:
#   scripts/mcp_dev/restore.sh <path to a .dump file> <database name>
# The name must be clothcraft_sim2 or clothcraft_throwaway_<a-z0-9_>; anything else is refused before Docker is touched. The dump FILE is
# only read (copied into the container); no other database or server is ever contacted. The database must not exist yet.
# Steps: restore as-is (no migration) -> verify every table's row count against the dump -> grants (grants.sql) -> read-only by default.
set -euo pipefail
export MSYS_NO_PATHCONV=1
HERE="$(cd "$(dirname "$0")" && pwd)"
DUMP="$1"; DB="$2"
if ! [[ "$DB" =~ ^(clothcraft_sim2|clothcraft_throwaway_[a-z0-9_]{1,40})$ ]]; then
  echo "refused: '$DB' is not clothcraft_sim2 or clothcraft_throwaway_<name>" >&2; exit 2
fi
[ -f "$DUMP" ] || { echo "no such dump file: $DUMP" >&2; exit 2; }
C=clothcraft-mcp-db
S() { docker exec -i "$C" psql -q -X -v ON_ERROR_STOP=1 -U postgres "$@"; }
if [ "$(docker exec "$C" psql -At -U postgres -d postgres -c "select count(*) from pg_database where datname = '$DB'")" != "0" ]; then
  echo "refused: $DB already exists in $C (this script never overwrites)" >&2; exit 2
fi

docker cp "$DUMP" "$C:/tmp/restore.dump"
echo "== pg_restore --list: $(docker exec "$C" sh -c 'pg_restore --list /tmp/restore.dump > /tmp/restore.list; echo "exit $?, $(wc -l < /tmp/restore.list) entries"')"
docker exec "$C" createdb -U postgres -E UTF8 -T template0 "$DB"
docker exec "$C" pg_restore -U postgres -d "$DB" --no-owner --exit-on-error /tmp/restore.dump
echo "== restored $DB (as-is, no migration)"

# every table's row count against the dump: the rows of each COPY block in the dump's data, and count(*) of every table restored
docker exec -i "$C" sh -s "$DB" <<'EOF'
DB="$1"
pg_restore -f - --data-only /tmp/restore.dump | awk '/^COPY /{t=$2; sub(/^public\./,"",t); gsub(/"/,"",t); n=0; inside=1; next} inside && $0=="\\."{print t"|"n; inside=0; next} inside{n++}' | sort > /tmp/dump_counts.txt
psql -At -X -U postgres -d "$DB" -c "select table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from only public.%I', table_name), false, true, '')))[1]::text from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'" | sort > /tmp/db_counts.txt
n=$(wc -l < /tmp/dump_counts.txt); m=$(wc -l < /tmp/db_counts.txt); rows=$(awk -F'|' '{s+=$2} END{print s+0}' /tmp/dump_counts.txt)
d=$(diff /tmp/dump_counts.txt /tmp/db_counts.txt | grep -c '^[<>]' || true)
echo "== row counts against the dump: dump has $n tables with $rows rows | database has $m tables | lines that differ: $d"
diff /tmp/dump_counts.txt /tmp/db_counts.txt | head -10 || true
EOF

S -d "$DB" -v db="$DB" -f - < "$HERE/grants.sql" >/dev/null
echo "== grants applied: $(docker exec "$C" psql -At -X -U postgres -d "$DB" -c "select count(*) filter (where has_table_privilege('clothcraft_mcp', c.oid, 'SELECT')) || ' tables in full, ' || count(*) filter (where not has_table_privilege('clothcraft_mcp', c.oid, 'SELECT') and has_any_column_privilege('clothcraft_mcp', c.oid, 'SELECT')) || ' by column, ' || count(*) filter (where not has_any_column_privilege('clothcraft_mcp', c.oid, 'SELECT')) || ' not at all' from pg_class c where c.relkind = 'r' and c.relnamespace = 'public'::regnamespace"), masked views: $(docker exec "$C" psql -At -X -U postgres -d "$DB" -c "select count(*) from pg_views where schemaname = 'mcp_masked'")"

S -d postgres <<SQL
ALTER DATABASE "$DB" SET default_transaction_read_only = on;
COMMENT ON DATABASE "$DB" IS 'MCP read-only copy restored from $(basename "$DUMP"). Never run Odoo (web or crons) against it.';
SQL
echo "== $DB is read-only by default: $(docker exec "$C" psql -At -X -U postgres -d "$DB" -c 'show default_transaction_read_only')"
docker exec "$C" rm -f /tmp/restore.dump /tmp/restore.list /tmp/dump_counts.txt /tmp/db_counts.txt
