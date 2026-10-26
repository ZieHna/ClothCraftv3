#!/bin/bash
# One-time setup of the MCP sandbox (Dev Tooling M1). Creates:
#   - the untracked .env with two NEW random passwords (this container's superuser, and the read-only role) - never printed
#   - the volume clothcraft-mcp-data and the container clothcraft-mcp-db (postgres:16) on --network none: no TCP route from anything,
#     reached only through `docker exec`; no Odoo container is ever pointed at it
#   - the read-only role clothcraft_mcp (no superuser, read-only by default, 5 s statement timeout, 3 connections)
# It never touches the dev stack (clothcraft-v3-*), its database or its password. Safe to run again: what exists is kept.
set -euo pipefail
export MSYS_NO_PATHCONV=1
cd "$(dirname "$0")"
C=clothcraft-mcp-db

if [ ! -f .env ]; then
  node -e "
    const c = require('crypto'), fs = require('fs');
    const p = () => c.randomBytes(24).toString('base64url');
    fs.writeFileSync('.env', 'MCP_CONTAINER=$C\nMCP_SUPERUSER_PASSWORD=' + p() + '\nMCP_DB_URL=postgresql://clothcraft_mcp:' + p() + '@127.0.0.1:5432\n', { mode: 0o600 });"
  echo "wrote .env (new passwords, not shown)"
fi
set -a; . ./.env; set +a
ROLE_PW=$(node -e "console.log(new URL(process.env.MCP_DB_URL).password)")

if ! docker inspect "$C" >/dev/null 2>&1; then
  docker volume create clothcraft-mcp-data >/dev/null
  # POSTGRES_PASSWORD is passed from this shell's environment by name, so it is never on a command line
  POSTGRES_PASSWORD="$MCP_SUPERUSER_PASSWORD" docker run -d --name "$C" --network none --restart unless-stopped \
    -e POSTGRES_PASSWORD -e POSTGRES_USER=postgres -v clothcraft-mcp-data:/var/lib/postgresql/data postgres:16 >/dev/null
  echo "created container $C (network: none)"
fi
for i in $(seq 1 60); do docker exec "$C" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
sleep 2

# the role; its password goes in through stdin (never argv), and psql runs quietly
docker exec -i "$C" psql -q -X -v ON_ERROR_STOP=1 -U postgres -d postgres >/dev/null <<SQL
DO \$\$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'clothcraft_mcp') THEN
    CREATE ROLE clothcraft_mcp LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT CONNECTION LIMIT 3;
  END IF;
END \$\$;
ALTER ROLE clothcraft_mcp PASSWORD '$ROLE_PW';
ALTER ROLE clothcraft_mcp SET default_transaction_read_only = on;
ALTER ROLE clothcraft_mcp SET statement_timeout = '5s';
ALTER ROLE clothcraft_mcp SET idle_in_transaction_session_timeout = '10s';
-- nobody but the superuser connects to the maintenance databases
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE template1 FROM PUBLIC;
SQL
echo "role clothcraft_mcp ready (read-only by default, 5 s timeout, 3 connections)"
docker exec "$C" psql -At -U postgres -d postgres -c "select 'role: super='||rolsuper||' createdb='||rolcreatedb||' createrole='||rolcreaterole||' conn_limit='||rolconnlimit||' settings='||coalesce((select string_agg(x, ', ') from unnest(s.setconfig) x), '') from pg_roles r left join pg_db_role_setting s on s.setrole = r.oid and s.setdatabase = 0 where rolname = 'clothcraft_mcp'"
