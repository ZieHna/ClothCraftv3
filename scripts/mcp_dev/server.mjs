// Read-only MCP server for planning (Dev Tooling M1). Not part of the product; nothing customers or staff ever see.
// It reads ONLY clothcraft_sim2 and clothcraft_throwaway_* databases, in the dedicated container clothcraft-mcp-db (no network), as the
// read-only role clothcraft_mcp. The role is the real protection (grants.sql); this file is the second layer: an allow-list of database
// names checked before anything is spawned, one SELECT only, row limit, timeout, email scrub, and a log of query text (never results).
// It holds no superuser credentials and has no fallback: a missing grant is reported as "no access".
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENV = Object.fromEntries(readFileSync(join(HERE, '.env'), 'utf8').split(/\r?\n/).filter((l) => l.includes('=') && !l.startsWith('#')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
const URL_ = new URL(ENV.MCP_DB_URL);
const CONTAINER = 'clothcraft-mcp-db';           // a constant: the dev stack's database container is never named here
const ALLOWED_DB = /^(clothcraft_sim2|clothcraft_throwaway_[a-z0-9_]{1,40})$/;
const IDENT = /^(mcp_masked\.)?[a-z_][a-z0-9_]{0,62}$/;
const LIMIT = { def: 200, max: 1000 }, TIMEOUT = { def: 5000, max: 15000 }, TEXT_MAX = 2000;
const BLOCKED_WORDS = /\b(insert|update|delete|merge|copy|call|do|alter|create|drop|grant|revoke|truncate|vacuum|analyze|cluster|reindex|listen|notify|unlisten|set|reset|lock|prepare|execute|deallocate|discard|load|refresh|import|comment|begin|commit|rollback|savepoint)\b/i;
const BLOCKED_FUNCS = /\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_\w+|dblink\w*|pg_sleep\w*|set_config|current_setting|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|nextval|setval|pg_advisory\w*|query_to_xml\w*|table_to_xml\w*|cursor_to_xml\w*)\s*\(/i;
const EMAIL = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g;
const LOG = join(HERE, 'logs', 'queries.log');
mkdirSync(join(HERE, 'logs'), { recursive: true });

class Refused extends Error {}
const log = (entry) => appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n');

function checkDb(db) {
  if (typeof db !== 'string' || !ALLOWED_DB.test(db)) throw new Refused(`refused: database "${String(db).slice(0, 80)}" is not clothcraft_sim2 or clothcraft_throwaway_<name>; nothing was contacted`);
  return db;
}
function checkSelect(sql) {
  if (typeof sql !== 'string' || !sql.trim()) throw new Refused('refused: send one SELECT statement');
  const s = sql.trim();
  if (/[;\\]/.test(s) || s.includes('--') || s.includes('/*')) throw new Refused('refused: one statement only, with no ";", "\\" or comments');
  if (!/^(select|with)\b/i.test(s)) throw new Refused('refused: only SELECT (or WITH ... SELECT) is allowed');
  const words = s.replace(/'(?:[^']|'')*'/g, "''").replace(/"(?:[^"]|"")*"/g, '""');   // keywords inside string literals or quoted names do not count
  if (BLOCKED_WORDS.test(words)) throw new Refused(`refused: "${words.match(BLOCKED_WORDS)[1]}" is not allowed in a read-only query`);
  if (BLOCKED_FUNCS.test(words)) throw new Refused(`refused: the function "${words.match(BLOCKED_FUNCS)[1]}" is not allowed`);
  return s;
}
const clamp = (v, { def, max }) => (Number.isInteger(v) && v > 0 ? Math.min(v, max) : def);

function parseCsv(text) {
  const rows = []; let row = [], field = '', quoted = false, i = 0, wasQuoted = false;
  for (; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') quoted = false; else field += ch;
    } else if (ch === '"') { quoted = true; wasQuoted = true; }
    else if (ch === ',') { row.push(field === '' && !wasQuoted ? null : field); field = ''; wasQuoted = false; }
    else if (ch === '\n') { row.push(field === '' && !wasQuoted ? null : field); rows.push(row); row = []; field = ''; wasQuoted = false; }
    else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length) { row.push(field === '' && !wasQuoted ? null : field); rows.push(row); }
  return rows;
}

// one psql call as the read-only role, inside the container, over 127.0.0.1 (password needed); the password goes by environment, never argv
function psql(db, sql, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: decodeURIComponent(URL_.password), PGOPTIONS: `-c statement_timeout=${timeoutMs} -c default_transaction_read_only=on` };
    const child = spawn('docker', ['exec', '-i', '-e', 'PGPASSWORD', '-e', 'PGOPTIONS', CONTAINER, 'psql', '-X', '-q', '--csv', '-v', 'ON_ERROR_STOP=1',
      '-h', URL_.hostname, '-p', URL_.port || '5432', '-U', decodeURIComponent(URL_.username), '-d', db, '-f', '-'], { env, windowsHide: true });
    let out = '', err = '';
    const kill = setTimeout(() => child.kill(), timeoutMs + 10000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('close', (code) => {
      clearTimeout(kill);
      if (code === 0) return resolve(parseCsv(out));
      const message = err.replace(/^psql:[^:]*:\d+: /gm, '').trim().split('\n')[0] || `psql exited ${code}`;
      reject(new Error(/permission denied/i.test(message) ? `no access: ${message}` : message));
    });
    child.stdin.end(sql + '\n');
  });
}

const scrub = (v) => (typeof v === 'string' ? (v.length > TEXT_MAX ? v.slice(0, TEXT_MAX) + '…[cut]' : v).replace(EMAIL, '$1***@$2') : v);
async function query(tool, db, sql, { limit = LIMIT.def, timeoutMs = TIMEOUT.def, logged = sql } = {}) {
  const t0 = Date.now();
  try {
    const [header = [], ...rows] = await psql(db, sql, timeoutMs);
    const truncated = rows.length > limit;
    const kept = rows.slice(0, limit).map((r) => Object.fromEntries(header.map((h, i) => [h, scrub(r[i])])));
    log({ tool, db, sql: logged, ms: Date.now() - t0, rows: kept.length, ok: true });
    return { columns: header, rows: kept, truncated, ms: Date.now() - t0 };
  } catch (e) {
    log({ tool, db, sql: logged, ms: Date.now() - t0, ok: false, error: e.message.slice(0, 200) });
    throw e;
  }
}
const qualified = (table) => {
  if (typeof table !== 'string' || !IDENT.test(table)) throw new Refused('refused: a table name is lower-case letters, digits and _ (optionally mcp_masked.<name>)');
  return table.includes('.') ? table.split('.').map((p) => `"${p}"`).join('.') : `public."${table}"`;
};

async function readableTables(db) {
  const r = await query('readable_tables', db, `SELECT relname AS t FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND has_any_column_privilege(oid, 'SELECT') ORDER BY 1`, { limit: 5000 });
  return r.rows.map((x) => x.t);
}
async function counts(db, tables) {
  if (!tables.length) return {};
  const sql = tables.map((t) => `SELECT '${t}' AS t, count(*) AS n FROM public."${t}"`).join(' UNION ALL ');
  const r = await query('compare_counts', db, sql, { limit: 5000, timeoutMs: TIMEOUT.max, logged: `count(*) of ${tables.length} tables` });
  return Object.fromEntries(r.rows.map((x) => [x.t, Number(x.n)]));
}

const TOOLS = {
  list_tables: { description: 'Tables (public) and masked views (mcp_masked) the read-only role can read, with approximate row counts.', props: { db: { type: 'string' } }, req: ['db'],
    run: ({ db }) => query('list_tables', checkDb(db), `SELECT n.nspname AS schema, c.relname AS name, CASE c.relkind WHEN 'v' THEN 'view' ELSE 'table' END AS kind, greatest(c.reltuples, 0)::bigint AS approx_rows FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname IN ('public', 'mcp_masked') AND c.relkind IN ('r', 'v') AND has_any_column_privilege(c.oid, 'SELECT') ORDER BY 2, 1`, { limit: 5000 }) },
  describe_table: { description: 'Columns of a table: readable, hidden (never granted), or masked (read them through mcp_masked.<table>).', props: { db: { type: 'string' }, table: { type: 'string' } }, req: ['db', 'table'],
    run: ({ db, table }) => { const q = qualified(table); return query('describe_table', checkDb(db), `SELECT a.attname AS column, format_type(a.atttypid, a.atttypmod) AS type, CASE WHEN has_column_privilege(a.attrelid, a.attnum, 'SELECT') THEN 'readable' WHEN to_regclass('mcp_masked.' || c.relname) IS NOT NULL AND EXISTS (SELECT 1 FROM pg_attribute m WHERE m.attrelid = to_regclass('mcp_masked.' || c.relname) AND m.attname = a.attname) THEN 'masked: see mcp_masked.' || c.relname ELSE 'hidden' END AS access FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE a.attrelid = to_regclass('${q.replace(/'/g, "''")}') AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, { limit: 2000 }); } },
  count_rows: { description: 'Exact count(*) of one table or masked view.', props: { db: { type: 'string' }, table: { type: 'string' } }, req: ['db', 'table'],
    run: ({ db, table }) => { const q = qualified(table); return query('count_rows', checkDb(db), `SELECT count(*) AS n FROM ${q}`); } },
  run_query: { description: 'One SELECT (or WITH ... SELECT) as the read-only role. Row limit (default 200, max 1000) and timeout (default 5000 ms, max 15000). Personal columns are only readable masked, through mcp_masked.<table>.',
    props: { db: { type: 'string' }, sql: { type: 'string' }, limit: { type: 'integer' }, timeoutMs: { type: 'integer' } }, req: ['db', 'sql'],
    run: ({ db, sql, limit, timeoutMs }) => { const d = checkDb(db), s = checkSelect(sql), n = clamp(limit, LIMIT); return query('run_query', d, `SELECT * FROM (${s}\n) AS mcp_q LIMIT ${n + 1}`, { limit: n, timeoutMs: clamp(timeoutMs, TIMEOUT), logged: s }); } },
  compare_counts: { description: 'Exact row counts of every table both databases let the role read (or the tables named), and where they differ.', props: { dbA: { type: 'string' }, dbB: { type: 'string' }, tables: { type: 'array', items: { type: 'string' } } }, req: ['dbA', 'dbB'],
    run: async ({ dbA, dbB, tables }) => {
      const a = checkDb(dbA), b = checkDb(dbB);
      if (tables !== undefined && (!Array.isArray(tables) || tables.some((t) => typeof t !== 'string' || !/^[a-z_][a-z0-9_]{0,62}$/.test(t)))) throw new Refused('refused: tables is a list of plain table names');
      const [ra, rb] = await Promise.all([readableTables(a), readableTables(b)]);
      const want = tables ?? [...new Set([...ra, ...rb])].sort();
      const [ca, cb] = await Promise.all([counts(a, want.filter((t) => ra.includes(t))), counts(b, want.filter((t) => rb.includes(t)))]);
      const rows = want.map((t) => ({ table: t, [a]: t in ca ? ca[t] : 'no access', [b]: t in cb ? cb[t] : 'no access' }));
      return { tables: rows.length, differing: rows.filter((r) => r[a] !== r[b]), rows };
    } },
};

const server = new Server({ name: 'clothcraft-dev', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: { type: 'object', properties: t.props, required: t.req, additionalProperties: false } })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  const tool = TOOLS[params.name];
  try {
    if (!tool) throw new Refused(`unknown tool ${params.name}`);
    const args = params.arguments ?? {};
    const extra = Object.keys(args).filter((k) => !(k in tool.props));
    if (extra.length) throw new Refused(`refused: unknown argument(s) ${extra.join(', ')}`);
    return { content: [{ type: 'text', text: JSON.stringify(await tool.run(args), null, 1) }] };
  } catch (e) {
    if (e instanceof Refused) log({ tool: params.name, refused: e.message.slice(0, 200) });
    return { content: [{ type: 'text', text: e.message }], isError: true };
  }
});

if (process.argv.includes('--check')) {
  // startup check: the .env is there, the container answers, the role reaches clothcraft_sim2 read-only
  const r = await query('startup_check', 'clothcraft_sim2', `SELECT current_user AS role, current_setting('default_transaction_read_only') AS read_only, current_setting('statement_timeout') AS timeout, (SELECT count(*) FROM pg_class WHERE relkind = 'r' AND relnamespace = 'public'::regnamespace AND has_any_column_privilege(oid, 'SELECT')) AS readable_tables`);
  console.log('startup check ok:', JSON.stringify(r.rows[0]), '| tools:', Object.keys(TOOLS).join(', '));
} else {
  await server.connect(new StdioServerTransport());
}
