// The one proof of the MCP sandbox (Dev Tooling M1). Talks to the server exactly as Claude Code does (an SDK client over stdio), and checks
// the database layer directly: as the read-only role (bypassing the server's filter) and, for reference counts, as this container's
// superuser. It touches only clothcraft-mcp-db (clothcraft_sim2 and clothcraft_throwaway_shop7g). Passwords are never printed.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = Object.fromEntries(readFileSync(join(HERE, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const ROLE_PW = decodeURIComponent(new URL(ENV.MCP_DB_URL).password);
const SIM = 'clothcraft_sim2', TMP = 'clothcraft_throwaway_shop7g', C = 'clothcraft-mcp-db';
const printed = [];
const say = (...a) => { const line = a.join(' '); printed.push(line); console.log(line); };
const sh = (cmd, args, env) => { try { return execFileSync(cmd, args, { encoding: 'utf8', env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] }).trim(); } catch (e) { return 'ERROR ' + (e.stderr || e.message).toString().trim().split('\n').filter((l) => !/^psql:.*NOTICE/.test(l))[0]; } };
const asRole = (db, sql) => sh('docker', ['exec', '-e', 'PGPASSWORD', C, 'psql', '-X', '-At', '-h', '127.0.0.1', '-U', 'clothcraft_mcp', '-d', db, '-c', sql], { PGPASSWORD: ROLE_PW });
const asSuper = (db, sql) => sh('docker', ['exec', C, 'psql', '-X', '-At', '-U', 'postgres', '-d', db, '-c', sql]);

const client = new Client({ name: 'proof', version: '0.1.0' });
await client.connect(new StdioClientTransport({ command: 'node', args: [join(HERE, 'server.mjs')] }));
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  const text = r.content[0].text;
  return r.isError ? { error: text } : JSON.parse(text);
};
const brief = (r) => (r.error ? 'REFUSED: ' + r.error.slice(0, 110) : `ok (${(r.rows || []).length} rows${r.truncated ? ', truncated' : ''})`);

say('== tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));

say('\n== 1. writes as the role are refused by the DATABASE (psql directly, no server filter)');
const before = asSuper(SIM, 'select count(*) from res_partner');
for (const sql of ["INSERT INTO res_partner (name, active) VALUES ('proof', true)", 'UPDATE res_partner SET name = name WHERE id = 1', 'DELETE FROM res_partner WHERE id < 0',
  'CREATE TABLE proof_t (a int)', 'CREATE TEMP TABLE proof_tmp (a int)', "SELECT nextval('res_partner_id_seq')",
  'SET default_transaction_read_only = off; UPDATE res_partner SET name = name WHERE id = 1', 'BEGIN READ WRITE; DELETE FROM res_partner WHERE id < 0; COMMIT']) {
  say('  ', sql.slice(0, 70).padEnd(72), '->', asRole(SIM, sql).replace(/^ERROR\s*/, '').slice(0, 90));
}
say('   res_partner rows before/after:', before, '/', asSuper(SIM, 'select count(*) from res_partner'));

say('\n== 2. names outside the allow-list are refused BEFORE anything is contacted');
const logBefore = readFileSync(join(HERE, 'logs', 'queries.log'), 'utf8').split('\n').length;
for (const db of ['clothcraft_shop', 'clothcraft_dev', 'clothcraft', 'clothcraft_sim', 'postgres', 'template1', 'clothcraft_sim2; drop', 'clothcraft_throwaway_X', "clothcraft_sim2' or '1"]) {
  say('  ', JSON.stringify(db).padEnd(28), brief(await call('run_query', { db, sql: 'SELECT 1' })));
}
const newLines = readFileSync(join(HERE, 'logs', 'queries.log'), 'utf8').split('\n').slice(logBefore - 1).filter(Boolean).map((l) => JSON.parse(l));
say('   log lines for those 9 calls:', newLines.length, '| all are refusals with no query run:', newLines.every((l) => l.refused && l.ms === undefined));

say('\n== 3. secrets are unreadable for the role (alias, CTE and subquery too)');
for (const [db, sql] of [[SIM, 'SELECT password FROM res_users'], [SIM, 'SELECT x FROM (SELECT password AS x FROM res_users) s'], [SIM, 'WITH p AS (SELECT password FROM res_users) SELECT * FROM p'],
  [SIM, 'SELECT * FROM res_users'], [SIM, 'SELECT totp_secret FROM res_users'], [SIM, 'SELECT value FROM ir_config_parameter'], [SIM, 'SELECT * FROM res_users_apikeys'],
  [TMP, 'SELECT sid_hash FROM clothcraft_api_session'], [TMP, 'SELECT * FROM clothcraft_api_throttle'], [SIM, 'SELECT login FROM res_users'], [SIM, 'SELECT email FROM res_partner']]) {
  say('  ', `${db === SIM ? 'sim2' : 'throwaway'}: ${sql}`.padEnd(70), brief(await call('run_query', { db, sql })));
}
say('   ir_config_parameter key only:', brief(await call('run_query', { db: SIM, sql: 'SELECT key FROM ir_config_parameter ORDER BY key' })));
const d = await call('describe_table', { db: SIM, table: 'res_users' });
say('   describe res_users:', ['password', 'totp_secret', 'login', 'id', 'partner_id'].map((c) => `${c}=${(d.rows.find((r) => r.column === c) || {}).access}`).join(' | '));
asSuper(TMP, 'SET default_transaction_read_only = off; ANALYZE res_users; ANALYZE res_partner');
say('   pg_stats on res_users (throwaway, analysed) as the role, columns shown:', asRole(TMP, "select coalesce(string_agg(attname, ',' order by attname), '(none)') from pg_stats where tablename = 'res_users' and attname in ('password','login','id','share')"),
  '| as superuser:', asSuper(TMP, "select string_agg(attname, ',' order by attname) from pg_stats where tablename = 'res_users' and attname in ('password','login','id','share')"));
say('   fail closed: count_rows on a table with no grant ->', brief(await call('count_rows', { db: SIM, table: 'res_users_apikeys' })));
say('   the server holds no superuser credential:', !readFileSync(join(HERE, 'server.mjs'), 'utf8').includes('MCP_SUPERUSER'));

say('\n== 4. personal columns come back masked');
const m = await call('run_query', { db: TMP, sql: "SELECT email, phone, street, street2, zip, city FROM mcp_masked.res_partner WHERE email IS NOT NULL AND type = 'delivery' ORDER BY id" });
say('   mcp_masked.res_partner (throwaway):', JSON.stringify(m.rows));
say('   raw values for comparison are NOT printed; the raw emails differ from the masked ones:', asSuper(TMP, "select count(*) from res_partner where type='delivery' and email is not null"), 'rows, masked values contain "***":', m.rows.every((r) => r.email.includes('***') && (!r.phone || r.phone.startsWith('***')) && (!r.street || r.street === '***')));
const u = await call('run_query', { db: SIM, sql: 'SELECT login FROM mcp_masked.res_users ORDER BY id LIMIT 3' });
say('   mcp_masked.res_users logins (sim2):', JSON.stringify(u.rows));
say('   email scrub in free text:', JSON.stringify((await call('run_query', { db: SIM, sql: "SELECT 'write to jane.doe@example.com today' AS t" })).rows[0]));

say('\n== 5. the code filter refuses everything but one SELECT');
for (const sql of ['SELECT 1; SELECT 2', 'SELECT 1 -- note', 'SELECT 1 /* note */', '\\! ls', 'DELETE FROM res_partner', 'UPDATE res_partner SET name = 1', 'COPY res_partner TO STDOUT',
  'WITH d AS (DELETE FROM res_partner RETURNING id) SELECT * FROM d', "SELECT pg_read_file('/etc/passwd')", 'SELECT pg_sleep(1)', "SELECT set_config('x','y',false)",
  "SELECT nextval('res_partner_id_seq')", 'SELECT * FROM res_partner FOR UPDATE', "SELECT query_to_xml('select 1', true, true, '')", 'EXPLAIN ANALYZE SELECT 1']) {
  say('  ', sql.padEnd(66), brief(await call('run_query', { db: SIM, sql })));
}
say('   a keyword inside a string is fine:', brief(await call('run_query', { db: SIM, sql: "SELECT 'delete me' AS t" })));

say('\n== 6. row limit and timeout');
for (const [label, args] of [['default limit', {}], ['limit 1000', { limit: 1000 }], ['limit 5000 (capped)', { limit: 5000 }], ['limit 10', { limit: 10 }]]) {
  const r = await call('run_query', { db: SIM, sql: 'SELECT generate_series(1, 5000) AS n', ...args });
  say('  ', label.padEnd(22), `${r.rows.length} rows, truncated=${r.truncated}`);
}
let t0 = Date.now();
say('   timeout 1000 ms on a heavy query:', brief(await call('run_query', { db: SIM, sql: 'SELECT count(*) FROM generate_series(1, 300000000) a', timeoutMs: 1000 })), `after ${Date.now() - t0} ms`);
t0 = Date.now();
say('   default timeout (5000 ms):', brief(await call('run_query', { db: SIM, sql: 'SELECT count(*) FROM generate_series(1, 2000000000) a' })), `after ${Date.now() - t0} ms`);

say('\n== 7. compare_counts against direct superuser counts');
const cc = await call('compare_counts', { dbA: SIM, dbB: TMP });
const direct = {};
for (const db of [SIM, TMP]) {
  direct[db] = Object.fromEntries(asSuper(db, "select table_name || '|' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from public.%I', table_name), false, true, '')))[1]::text from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE'")
    .split('\n').map((l) => l.split('|')).map(([t, n]) => [t, Number(n)]));
}
let agree = 0, checked = 0;
const noAccess = [], wrong = [];
for (const row of cc.rows) {
  for (const db of [SIM, TMP]) {
    if (row[db] === 'no access') { if (row.table in direct[db]) noAccess.push(`${db === SIM ? 'sim2' : 'throwaway'}:${row.table}`); continue; }
    checked++;
    if (direct[db][row.table] === row[db]) agree++; else wrong.push(`${db}:${row.table}`);
  }
}
say(`   ${cc.tables} tables; ${checked} counts compared with the superuser's own count(*): ${agree} agree${wrong.length ? ' | differ: ' + wrong.join(', ') : ''}`);
say('   no access (never granted):', noAccess.join(', ') || '(none)');
say('   tables that differ between the two databases:', cc.differing.length, '(expected: they are different databases)');

say('\n== 8. isolation, read-only database, dev stack');
say('   clothcraft-mcp-db network mode:', sh('docker', ['inspect', C, '--format', '{{.HostConfig.NetworkMode}} | networks: {{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}| ip: [{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}]']));
const others = sh('docker', ['ps', '-a', '--format', '{{.Names}}']).split('\n').filter((n) => n && n !== C);
const sharing = others.filter((n) => /container:/.test(sh('docker', ['inspect', n, '--format', '{{.HostConfig.NetworkMode}}'])));
say('   containers sharing its network namespace:', sharing.length ? sharing.join(', ') : 'none', '| containers whose environment names it:', others.filter((n) => sh('docker', ['inspect', n, '--format', '{{json .Config.Env}}']).includes(C)).join(', ') || 'none');
say('   clothcraft_sim2 default_transaction_read_only (a new superuser session):', asSuper(SIM, 'show default_transaction_read_only'), '| comment:', asSuper('postgres', "select shobj_description(oid, 'pg_database') from pg_database where datname = 'clothcraft_sim2'").slice(0, 80));
say('   databases in the MCP container:', asSuper('postgres', "select string_agg(datname, ', ' order by datname) from pg_database where not datistemplate"));
const now = ['clothcraft-v3-db-1', 'clothcraft-v3-odoo-1', 'clothcraft-v3-api-1'].map((n) => sh('docker', ['inspect', n, '--format', '{{.Name}} id={{.Id}} started={{.State.StartedAt}} restarts={{.RestartCount}} image={{.Image}} networks={{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'])).join('\n');
// docker inspect ends each line with a space after the last network name: compare line by line, trailing spaces removed on both sides
const tidy = (text) => text.split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean).join('\n');
const baseline = process.env.DEVSTACK_BEFORE ? tidy(readFileSync(process.env.DEVSTACK_BEFORE, 'utf8')) : null;
say('   dev stack containers (id, start time, restarts, image, networks) identical to the baseline taken before setup:', baseline === null ? 'no baseline given' : baseline === tidy(now));

say('\n== 9. secrets never shown');
const logText = readFileSync(join(HERE, 'logs', 'queries.log'), 'utf8');
const dbLogs = sh('docker', ['logs', C]);
for (const [label, secret] of [['superuser password', ENV.MCP_SUPERUSER_PASSWORD], ['role password', ROLE_PW]]) {
  say(`   ${label}: in the query log ${logText.includes(secret)} | in the database container log ${dbLogs.includes(secret)} | in this proof's output ${printed.join('\n').includes(secret)}`);
}
say('   .env ignored by git:', sh('git', ['-C', join(HERE, '..', '..'), 'check-ignore', '-q', 'scripts/mcp_dev/.env']).startsWith('ERROR') ? 'NO' : 'yes');
await client.close();
