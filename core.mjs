// fernhop core — all tool logic. bridge.mjs hot-reloads this file: edit it and the
// next tool call runs the new code, without restarting the MCP client.
//
// Design
// 1. Fixed secret. Generated once into <state dir>/secret. Every serve the bridge starts gets
//    OPENCODE_SERVER_PASSWORD=<secret>, so every bridge instance can authenticate to it.
//    (No scraping of a random password from stdout, so no "another instance changed it" 401s.)
// 2. One shared serve. It runs detached; a bridge instance exiting never takes it down.
// 3. Never kill blindly. The only process the bridge ever terminates is a serve that accepted
//    our credentials and reported its own pid via /api/info (on upgrade or a manual restart).
//    A port held by anything else is skipped and the next port in the range is used.
// 4. Self-healing requests. Connection refused or 401 -> rediscover (or start) the serve, retry.
//    A failed start is retried on the next call instead of poisoning the process.
// 5. Bounded blocking. run/check block at most OPENCODE_BLOCK_MS (default 50 s) because MCP
//    clients time tool calls out (60 s on some transports). Unfinished tasks return a session id.
// 6. Upgrade-friendly. On Windows the serve runs from a copy of opencode.exe, so the original can
//    be replaced by an upgrade. When the installed version changes, the serve is restarted as soon
//    as no task is running.
// 7. Model aliases come from config.json and can track the newest matching model.

import { spawn, execFile } from 'node:child_process';
import {
  existsSync, readdirSync, statSync, mkdirSync, readFileSync, writeFileSync, rmSync,
  openSync, closeSync, readSync, renameSync, copyFileSync, unlinkSync,
} from 'node:fs';
import { join, basename, extname } from 'node:path';
import { homedir } from 'node:os';
import { randomBytes } from 'node:crypto';

export const VERSION = '1.1.0';

const IS_WIN = process.platform === 'win32';
const HOST = '127.0.0.1';
const PORT_BASE = Number(process.env.OPENCODE_PORT || 4096);
const PORT_SPAN = Math.max(1, Number(process.env.OPENCODE_PORT_SPAN || 10));
const EXTERNAL_URL = process.env.OPENCODE_BASE_URL || null; // connect only, never start a serve
const EXTERNAL_PW = process.env.OPENCODE_SERVER_PASSWORD || null;
const BLOCK_MS = Number(process.env.OPENCODE_BLOCK_MS || 50_000);
const POLL_MS = 1200;
const VERIFY_EVERY_MS = 15_000;
const UPGRADE_CHECK_MS = Number(process.env.OPENCODE_UPGRADE_CHECK_MS || 10 * 60_000);
const SERVE_START_MS = 60_000;
const BLOCK_S = Math.round(BLOCK_MS / 1000);

let DIR = process.env.FERNHOP_DIR || join(homedir(), '.fernhop');
let LOG = (...a) => process.stderr.write('[fernhop] ' + a.join(' ') + '\n');
const log = (...a) => LOG(...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function init(ctx) {
  if (ctx?.log) LOG = ctx.log;
  if (ctx?.dir) DIR = ctx.dir;
  const S = ctx.state;
  S.snapBefore ??= new Map();
  S.snapResult ??= new Map();
  // Warm up in the background; failures are only logged and retried on the next call.
  ensureConn(ctx).catch((e) => log('warm-up failed (will retry on the next call):', e.message));
}

// ---------- small helpers ----------
const p = (name) => join(DIR, name);
const pwPath = (port) => p(`port-${port}.pw`); // used only when a serve printed its own password
function ensureDir() { mkdirSync(DIR, { recursive: true }); }
function readText(file) { try { return readFileSync(file, 'utf8').trim() || null; } catch { return null; } }
function readJson(file, dflt) { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return dflt; } }
function writeAtomic(file, data, mode) {
  ensureDir();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try { writeFileSync(tmp, data, mode ? { mode } : undefined); renameSync(tmp, file); }
  catch { try { writeFileSync(file, data, mode ? { mode } : undefined); } catch (e) { log('write failed', file, e.message); } try { unlinkSync(tmp); } catch { /* ignore */ } }
}
function fileSize(file) { try { return statSync(file).size; } catch { return 0; } }
function readFrom(file, offset) {
  try {
    const size = fileSize(file);
    if (size <= offset) return '';
    const len = Math.min(size - offset, 200_000);
    const buf = Buffer.alloc(len);
    const fd = openSync(file, 'r');
    try { readSync(fd, buf, 0, len, size - len); } finally { closeSync(fd); }
    return buf.toString('utf8');
  } catch { return ''; }
}
const authOf = (pw) => 'Basic ' + Buffer.from('opencode:' + pw).toString('base64');
const uniq = (arr) => [...new Set(arr.filter(Boolean))];
const errCode = (e) => e?.cause?.code || e?.code || e?.name || e?.message || String(e);
const isScript = (file) => ['.js', '.mjs', '.cjs'].includes(extname(file).toLowerCase());

// ---------- config.json (model aliases, provider labels) ----------
const configPath = () => process.env.FERNHOP_CONFIG || p('config.json');
const EMPTY_CONFIG = { aliases: {}, providerLabels: {} };
let cfgCache = { path: null, mtime: -1, value: EMPTY_CONFIG, error: null };
function loadConfig() {
  const file = configPath();
  let mtime;
  try { mtime = statSync(file).mtimeMs; } catch { cfgCache = { path: file, mtime: -1, value: EMPTY_CONFIG, error: null }; return EMPTY_CONFIG; }
  if (cfgCache.path === file && cfgCache.mtime === mtime) return cfgCache.value;
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8'));
    const aliases = {};
    for (const [name, v] of Object.entries(raw.aliases || {})) {
      const key = name.toLowerCase();
      if (typeof v === 'string') aliases[key] = { fixed: v, label: '' };
      else if (v && typeof v === 'object') {
        aliases[key] = {
          fixed: v.model || null,
          provider: v.provider || null,
          match: v.match ? new RegExp(v.match, 'i') : null,
          fallback: v.fallback || null,
          label: v.label || '',
        };
      }
    }
    cfgCache = { path: file, mtime, value: { aliases, providerLabels: raw.providerLabels || {} }, error: null };
  } catch (e) {
    log('config.json is invalid and is ignored:', e.message);
    cfgCache = { path: file, mtime, value: EMPTY_CONFIG, error: e.message };
  }
  return cfgCache.value;
}

// ---------- fixed secret ----------
function getSecret() {
  if (EXTERNAL_PW) return EXTERNAL_PW;
  const file = p('secret');
  const have = readText(file);
  if (have) return have;
  const fresh = randomBytes(24).toString('base64url');
  try { ensureDir(); writeFileSync(file, fresh, { flag: 'wx', mode: 0o600 }); } catch { /* another instance won the race */ }
  return readText(file) || fresh;
}

// ---------- probing / discovering a serve ----------
async function probe(base, pw, timeoutMs = 2500) {
  try {
    const r = await fetch(base + '/api/info', {
      headers: pw ? { Authorization: authOf(pw) } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (r.ok) {
      let info = null;
      try { info = await r.json(); } catch { /* ignore */ }
      return { ok: true, info };
    }
    try { await r.body?.cancel(); } catch { /* ignore */ }
    return { ok: false, status: r.status };
  } catch (e) {
    const code = errCode(e);
    return { ok: false, down: true, free: code === 'ECONNREFUSED', error: code };
  }
}

function candidatePorts() {
  const st = readJson(p('state.json'), {});
  const ports = [];
  if (st.port) ports.push(Number(st.port));
  for (let port = PORT_BASE; port < PORT_BASE + PORT_SPAN; port++) if (!ports.includes(port)) ports.push(port);
  return ports;
}

async function discover() {
  const secret = getSecret();
  let freePort = null;
  const busy = [];
  for (const port of candidatePorts()) {
    const base = `http://${HOST}:${port}`;
    let r = null;
    for (const pw of uniq([secret, readText(pwPath(port))])) {
      r = await probe(base, pw);
      if (r.ok) return { found: { port, base, pw, info: r.info } };
      if (r.down) break; // nothing listening; other passwords will not help
    }
    if (r?.down && r.free) { if (freePort === null) freePort = port; }
    else busy.push(`${port}(${r?.status ? 'HTTP ' + r.status : r?.error})`);
  }
  return { freePort, busy };
}

function setConn(S, found) {
  S.conn = { ...found, verifiedAt: Date.now() };
  const st = readJson(p('state.json'), {});
  if (st.port !== found.port || st.pid !== found.info?.pid || st.version !== found.info?.version) {
    writeAtomic(p('state.json'), JSON.stringify({ ...st, port: found.port, pid: found.info?.pid ?? null, version: found.info?.version ?? null, seenAt: new Date().toISOString() }, null, 2));
  }
  return S.conn;
}

async function ensureConn(ctx, { force = false } = {}) {
  const S = ctx.state;
  if (!force && S.conn && Date.now() - S.conn.verifiedAt < VERIFY_EVERY_MS) return S.conn;
  if (S.ensuring) return S.ensuring;
  S.ensuring = (async () => {
    try {
      if (S.conn && !force) {
        const r = await probe(S.conn.base, S.conn.pw);
        if (r.ok) { S.conn.verifiedAt = Date.now(); S.conn.info = r.info || S.conn.info; return S.conn; }
        log('serve probe failed:', r.status ? 'HTTP ' + r.status : r.error, '-> rediscovering');
      }
      S.conn = null;
      if (EXTERNAL_URL) {
        const base = EXTERNAL_URL.replace(/\/+$/, '');
        const r = await probe(base, EXTERNAL_PW, 5000);
        if (!r.ok) throw new Error(`cannot reach OPENCODE_BASE_URL=${base} (${r.status ? 'HTTP ' + r.status : r.error})`);
        S.conn = { port: Number(new URL(base).port) || null, base, pw: EXTERNAL_PW, info: r.info, verifiedAt: Date.now() };
        return S.conn;
      }
      const d = await discover();
      if (d.found) { log(`using serve :${d.found.port} (pid ${d.found.info?.pid ?? '?'}, v${d.found.info?.version ?? '?'})`); return setConn(S, d.found); }
      return setConn(S, await startServe(ctx));
    } finally {
      S.ensuring = null;
    }
  })();
  return S.ensuring;
}

// ---------- starting a serve ----------
async function startServe(ctx) {
  ensureDir();
  const lock = p('spawn.lock');
  const deadline = Date.now() + 90_000;
  for (;;) {
    try { if (Date.now() - statSync(lock).mtimeMs > 120_000) { rmSync(lock, { recursive: true, force: true }); log('removed a stale spawn lock'); } } catch { /* no lock */ }
    let got = false;
    try { mkdirSync(lock); got = true; } catch { /* another instance is starting one */ }
    if (got) break;
    await sleep(700);
    const again = await discover();
    if (again.found) { log('another instance started the serve; reusing it'); return again.found; }
    if (Date.now() > deadline) throw new Error('timed out (90 s) waiting for another bridge instance to start opencode serve');
  }
  try {
    const again = await discover(); // someone may have started it while we waited for the lock
    if (again.found) return again.found;
    if (again.freePort === null) throw new Error(`ports ${PORT_BASE}-${PORT_BASE + PORT_SPAN - 1} are all taken by servers we cannot authenticate to: ${again.busy.join(', ')}`);
    if (again.busy.length) log('skipping ports held by other programs (not touching them):', again.busy.join(', '));
    return await spawnServeOn(ctx, again.freePort);
  } finally {
    try { rmSync(lock, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function execArgs(file, args) {
  return isScript(file) ? [process.execPath, [file, ...args]] : [file, args];
}

function exeVersion(file) {
  return new Promise((resolve) => {
    const [cmd, args] = execArgs(file, ['--version']);
    execFile(cmd, args, { timeout: 20_000, windowsHide: true, encoding: 'utf8' }, (err, out) => {
      if (err) return resolve(null);
      const m = String(out || '').match(/\d+\.\d+\.\d+[\w.+-]*/);
      resolve(m ? m[0] : (String(out || '').trim() || null));
    });
  });
}

function findOriginalExe() {
  if (process.env.OPENCODE_EXECUTABLE) return process.env.OPENCODE_EXECUTABLE;
  const c = [];
  const sep = IS_WIN ? ';' : ':';
  const exeName = IS_WIN ? 'opencode.exe' : 'opencode';
  if (IS_WIN && process.env.APPDATA) {
    c.push(join(process.env.APPDATA, 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'));
    c.push(join(process.env.APPDATA, 'npm', 'node_modules', 'opencode-ai', 'bin', 'opencode.exe'));
  }
  c.push(join(homedir(), '.opencode', 'bin', exeName));
  if (!IS_WIN) c.push('/opt/homebrew/bin/opencode', '/usr/local/bin/opencode', '/usr/bin/opencode');
  for (const d of (process.env.PATH || '').split(sep)) if (d) c.push(join(d, exeName));
  for (const f of c) { try { if (f && existsSync(f) && statSync(f).isFile()) return f; } catch { /* ignore */ } }
  return null;
}

// A running .exe is locked on Windows, which makes upgrades fail. So the serve runs from a copy
// and the original stays free for the package manager / `opencode upgrade`.
async function runnableExe() {
  const orig = findOriginalExe();
  if (!orig) throw new Error('opencode executable not found (install opencode, or set OPENCODE_EXECUTABLE)');
  const version = await exeVersion(orig);
  if (!IS_WIN || process.env.FERNHOP_NO_COPY || extname(orig).toLowerCase() !== '.exe') return { path: orig, original: orig, version };
  try {
    const binDir = p('bin');
    mkdirSync(binDir, { recursive: true });
    const size = statSync(orig).size;
    const copy = join(binDir, `opencode-${(version || 'unknown').replace(/[^\w.-]/g, '_')}-${size}.exe`);
    if (!existsSync(copy) || statSync(copy).size !== size) {
      const tmp = `${copy}.${process.pid}.tmp`;
      copyFileSync(orig, tmp);
      try { renameSync(tmp, copy); } catch (e) { try { unlinkSync(tmp); } catch { /* ignore */ } if (!existsSync(copy)) throw e; }
    }
    if (!(await exeVersion(copy))) throw new Error('the copy does not run');
    for (const f of readdirSync(binDir)) {
      if (f !== basename(copy) && /^opencode-.*\.exe$/.test(f)) { try { unlinkSync(join(binDir, f)); } catch { /* still in use; next time */ } }
    }
    return { path: copy, original: orig, version };
  } catch (e) {
    log('cannot use a copy of the executable, using the original:', e.message);
    return { path: orig, original: orig, version };
  }
}

async function spawnServeOn(ctx, port) {
  const secret = getSecret();
  const exe = await runnableExe();
  const logFile = p(`serve-${port}.log`);
  try { if (fileSize(logFile) > 2_000_000) renameSync(logFile, logFile + '.1'); } catch { /* ignore */ }
  const offset = fileSize(logFile);
  const env = { ...process.env, OPENCODE_SERVER_PASSWORD: secret };
  delete env.OPENCODE_SERVER_USERNAME; // default user name "opencode"
  const [cmd, args] = execArgs(exe.path, ['serve', `--hostname=${HOST}`, `--port=${port}`]);
  log('starting serve:', cmd, args.join(' '));
  const fd = openSync(logFile, 'a');
  let child;
  try {
    child = spawn(cmd, args, { detached: true, windowsHide: true, stdio: ['ignore', fd, fd], env, cwd: homedir() });
  } finally {
    closeSync(fd);
  }
  let exited = null;
  child.on('exit', (code, sig) => { exited = code ?? sig ?? 'unknown'; });
  child.on('error', (e) => { exited = 'spawn error: ' + e.message; });
  child.unref(); // the serve outlives this bridge instance

  const base = `http://${HOST}:${port}`;
  const t0 = Date.now();
  while (Date.now() - t0 < SERVE_START_MS) {
    await sleep(300);
    const r = await probe(base, secret, 2000);
    if (r.ok) {
      log(`serve ready on :${port} (pid ${r.info?.pid ?? child.pid}, v${r.info?.version ?? exe.version ?? '?'})`);
      return { port, base, pw: secret, info: r.info };
    }
    // Fallback for a serve that ignores OPENCODE_SERVER_PASSWORD and prints its own.
    const printed = (readFrom(logFile, offset).match(/server password (\S+)/) || [])[1];
    if (printed) {
      const r2 = await probe(base, printed, 2000);
      if (r2.ok) { writeAtomic(pwPath(port), printed, 0o600); log('serve ignored the fixed secret; using the password it printed'); return { port, base, pw: printed, info: r2.info }; }
    }
    if (exited !== null) {
      const again = await discover(); // maybe another instance took the port first
      if (again.found) return again.found;
      throw new Error(`opencode serve exited during startup (code ${exited}). Log tail:\n${readFrom(logFile, offset).slice(-1500) || '(no output)'}`);
    }
  }
  throw new Error(`opencode serve was not ready within ${SERVE_START_MS / 1000} s. Log tail:\n${readFrom(logFile, offset).slice(-1500) || '(no output)'}`);
}

function killTree(pid) {
  return new Promise((resolve) => {
    if (!pid) return resolve();
    if (IS_WIN) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, timeout: 15_000 }, () => resolve());
    else { try { process.kill(pid); } catch { /* ignore */ } resolve(); }
  });
}

// Only restarts a serve that accepted our credentials and told us its pid.
async function restartServe(ctx, reason) {
  const S = ctx.state;
  const conn = await ensureConn(ctx, { force: true });
  const pid = conn.info?.pid;
  if (!pid) throw new Error('the serve did not report a pid; refusing to restart it');
  log(`restarting serve (${reason}): stopping pid ${pid}`);
  await killTree(pid);
  S.conn = null;
  for (let i = 0; i < 30; i++) { const r = await probe(conn.base, conn.pw, 800); if (r.down) break; await sleep(300); }
  return ensureConn(ctx, { force: true });
}

// ---------- task registry (shared across instances: completion + safe-restart checks) ----------
const PENDING = () => p('pending.json');
function readPending() { const o = readJson(PENDING(), {}); return o && typeof o === 'object' ? o : {}; }
function writePending(o) { writeAtomic(PENDING(), JSON.stringify(o)); }
function addPending(sid, rec) { const o = readPending(); o[sid] = rec; writePending(o); }
function getPending(sid) { return readPending()[sid] || null; }
function removePending(sid) { const o = readPending(); if (o[sid]) { delete o[sid]; writePending(o); } }
function setLastSession(ctx, sid) { ctx.state.lastSessionId = sid; writeAtomic(p('last-session'), sid); }
function getLastSession(ctx) { return ctx.state.lastSessionId || readText(p('last-session')); }

async function runningSessions(ctx) {
  const o = readPending();
  const running = [];
  let changed = false;
  for (const [sid, rec] of Object.entries(o)) {
    if (Date.now() - (rec.at || 0) > 6 * 3600_000) { delete o[sid]; changed = true; continue; }
    try {
      const st = await sessionState(ctx, sid);
      if (st.done) { delete o[sid]; changed = true; } else running.push(sid);
    } catch { running.push(sid); }
  }
  if (changed) writePending(o);
  return running;
}

async function maybeUpgrade(ctx) {
  const S = ctx.state;
  if (EXTERNAL_URL || Date.now() - (S.lastUpgradeCheck || 0) < UPGRADE_CHECK_MS) return null;
  S.lastUpgradeCheck = Date.now();
  const conn = await ensureConn(ctx);
  const cur = conn.info?.version;
  const orig = findOriginalExe();
  if (!cur || !orig) return null;
  const v = await exeVersion(orig);
  if (!v || v === cur) return null;
  const running = await runningSessions(ctx);
  if (running.length) {
    log(`opencode was upgraded to ${v} (serve still ${cur}); ${running.length} task(s) running, restart postponed`);
    S.lastUpgradeCheck = Date.now() - UPGRADE_CHECK_MS + 60_000; // look again in a minute
    return null;
  }
  await restartServe(ctx, `opencode ${cur} -> ${v}`);
  return ` (opencode was upgraded from ${cur} to ${v}; the serve was restarted)`;
}

// ---------- HTTP ----------
async function api(ctx, method, path, opts = {}) {
  let qs = '';
  if (opts.rawQuery) qs = (path.includes('?') ? '&' : '?') + opts.rawQuery;
  else if (opts.query) {
    const sp = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== '') sp.set(k, String(v));
    const s = sp.toString();
    if (s) qs = '?' + s;
  }
  const safeRetry = method === 'GET' || opts.retrySafe;
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const conn = await ensureConn(ctx, { force: attempt > 0 });
    let res;
    try {
      res = await fetch(conn.base + path + qs, {
        method,
        headers: { Authorization: authOf(conn.pw), 'Content-Type': 'application/json' },
        body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: AbortSignal.timeout(opts.timeoutMs || 30_000),
      });
    } catch (e) {
      const code = errCode(e);
      lastErr = new Error(`cannot reach opencode (${method} ${path}): ${code}`);
      ctx.state.conn = null;
      if (attempt < 2 && (safeRetry || code === 'ECONNREFUSED')) { log(`${method} ${path} network error ${code}; reconnecting and retrying`); await sleep(400 * (attempt + 1)); continue; }
      throw lastErr;
    }
    const text = await res.text();
    if (res.status === 401 && attempt < 2) {
      log(`${method} ${path} got 401; rediscovering the serve and retrying`);
      ctx.state.conn = null;
      lastErr = new Error(`OpenCode ${method} ${path} -> HTTP 401`);
      continue; // a 401 means the request was not processed, so retrying is safe
    }
    if (res.status >= 500 && safeRetry && attempt < 2) { lastErr = new Error(`HTTP ${res.status}`); await sleep(500); continue; }
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const err = new Error(`OpenCode ${method} ${path} -> HTTP ${res.status}: ${(text || '').slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    return json;
  }
  throw lastErr || new Error(`OpenCode ${method} ${path} failed`);
}

// ---------- models ----------
const modelId = (m) => m.modelID || m.id;
function versionKey(m) {
  const s = `${modelId(m)} ${m.name || ''}`;
  const vs = [...s.matchAll(/v(\d+(?:\.\d+)?)/gi)].map((x) => parseFloat(x[1]));
  const ds = [...s.matchAll(/(?:^|[^\d])(\d{4})(?![\d])/g)].map((x) => parseInt(x[1], 10));
  return [vs.length ? Math.max(...vs) : 0, ds.length ? ds[ds.length - 1] : 0];
}
async function listModels(ctx) {
  const S = ctx.state;
  if (S.models && Date.now() - S.models.at < 5 * 60_000) return S.models.list;
  const list = (await api(ctx, 'GET', '/api/model'))?.data || [];
  S.models = { at: Date.now(), list };
  return list;
}
function resolveAlias(list, rule, name) {
  if (rule.fixed) return rule.fixed;
  const cands = list.filter((m) => m.enabled !== false && (!rule.provider || m.providerID === rule.provider)
    && (!rule.match || rule.match.test(`${modelId(m)} ${m.name || ''}`)));
  if (!cands.length) {
    if (rule.fallback) return rule.fallback;
    throw new Error(`alias "${name}" matches no available model (check config.json or call provider_models)`);
  }
  cands.sort((a, b) => { const ka = versionKey(a), kb = versionKey(b); return kb[0] - ka[0] || kb[1] - ka[1]; });
  return `${cands[0].providerID}/${modelId(cands[0])}`;
}
async function resolveModel(ctx, raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  if (!s) return null;
  const rule = loadConfig().aliases[s.toLowerCase()];
  if (rule) {
    let list = [];
    try { list = await listModels(ctx); } catch (e) { log('could not list models; alias falls back to its configured value:', e.message); }
    s = resolveAlias(list, rule, s);
  }
  if (s.includes('/')) { const i = s.indexOf('/'); return { providerID: s.slice(0, i).trim(), id: s.slice(i + 1).trim() }; }
  const hits = (await listModels(ctx)).filter((m) => modelId(m) === s);
  if (hits.length === 1) return { providerID: hits[0].providerID, id: s };
  if (hits.length > 1) throw new Error(`model id "${s}" exists under several providers (${hits.map((h) => h.providerID).join(', ')}); use "provider/${s}"`);
  throw new Error(`unknown model "${s}"; use an alias, "provider/model", or call provider_models to list models`);
}

// ---------- sessions ----------
async function listMessages(ctx, sid, limit = 200) {
  const data = (await api(ctx, 'GET', `/api/session/${sid}/message`, { query: { limit } }))?.data || [];
  data.sort((a, b) => (a.time?.created || 0) - (b.time?.created || 0));
  return data;
}
function assistantText(m) {
  if (!m || !Array.isArray(m.content)) return '';
  return m.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
}
function assistantTools(m) {
  if (!m || !Array.isArray(m.content)) return [];
  return m.content.filter((c) => c.type === 'tool').map((c) => (c.state?.status === 'error' ? `${c.name}(error)` : c.name));
}

// "Done" means: if we dispatched it, a new idle message appeared after dispatch;
// otherwise, the newest message is an idle message.
async function sessionState(ctx, sid) {
  const pend = getPending(sid);
  const msgs = await listMessages(ctx, sid);
  const newest = msgs[msgs.length - 1] || null;
  let idle = null;
  if (pend) {
    const prev = new Set(pend.prevIdles || []);
    const fresh = msgs.filter((m) => m.type === 'idle' && !prev.has(m.id));
    idle = fresh[fresh.length - 1] || null;
  } else if (newest?.type === 'idle') idle = newest;
  let start = 0;
  for (let i = msgs.length - 1; i >= 0; i--) if (msgs[i].type === 'user') { start = i; break; }
  let lastAssistant = null;
  const tools = [];
  for (const m of msgs.slice(start)) if (m.type === 'assistant') { lastAssistant = m; tools.push(...assistantTools(m)); }
  return { done: !!idle, idle, lastAssistant, tools: uniq(tools), newestType: newest?.type || null, hasUser: msgs.some((m) => m.type === 'user'), pend };
}

// ---------- file snapshots for non-git directories (bounded, never hangs) ----------
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'out', '.next', 'vendor', 'target', '.cache', '__pycache__', '.venv', 'venv', '.idea', '.vscode']);
function safeSnapshot(dir, maxFiles = 20_000, maxMs = 3_000) {
  const map = new Map();
  if (!dir || !existsSync(dir)) return null;
  const t0 = Date.now();
  let aborted = false;
  (function walk(rel) {
    if (aborted) return;
    let entries;
    try { entries = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (aborted) return;
      if (map.size > maxFiles || Date.now() - t0 > maxMs) { aborted = true; return; }
      if (SKIP_DIRS.has(e.name)) continue;
      const r = rel ? join(rel, e.name) : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile()) { try { const st = statSync(join(dir, r)); map.set(r, st.mtimeMs + ':' + st.size); } catch { /* ignore */ } }
    }
  })('');
  return aborted ? null : map;
}
function diffSnapshots(before, after) {
  const added = [], modified = [], removed = [];
  for (const [k, v] of after) { if (!before.has(k)) added.push(k); else if (before.get(k) !== v) modified.push(k); }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k);
  return { added, modified, removed };
}
const snapEmpty = (d) => !d || (!d.added.length && !d.modified.length && !d.removed.length);
function fmtSnapshotDiff(d) {
  const out = [];
  if (d.modified.length) out.push(`modified ${d.modified.length}:` + d.modified.slice(0, 60).map((f) => '\n  * ' + f).join(''));
  if (d.added.length) out.push(`added ${d.added.length}:` + d.added.slice(0, 60).map((f) => '\n  + ' + f).join(''));
  if (d.removed.length) out.push(`removed ${d.removed.length}:` + d.removed.slice(0, 60).map((f) => '\n  - ' + f).join(''));
  return out.join('\n');
}
function fmtDiff(files) { return files.map((f) => `- ${f.status} ${f.file} (+${f.additions ?? 0} -${f.deletions ?? 0})`).join('\n'); }

// ---------- reports ----------
const modelOf = (m) => (m?.model ? `${m.model.providerID}/${m.model.id}` : '?');
const clip = (s, n) => (s.length > n ? s.slice(0, n) + `\n...(truncated, ${s.length} chars total)` : s);
const tailClip = (s, n) => (s.length > n ? '...' + s.slice(-n) : s);

async function finalReport(ctx, sid, st, note = '') {
  const S = ctx.state;
  let diff = [];
  try { diff = (await api(ctx, 'GET', `/api/session/${sid}/diff`))?.data || []; } catch (e) { log('diff failed:', e.message); }
  let snap = S.snapResult.get(sid) || null;
  const before = S.snapBefore.get(sid);
  const dir = st.pend?.directory;
  if (!snap && before && dir) {
    const after = safeSnapshot(dir);
    if (after) { snap = diffSnapshots(before, after); S.snapResult.set(sid, snap); }
    S.snapBefore.delete(sid);
  }
  removePending(sid);
  const out = [];
  out.push(`✅ Done (outcome=${st.idle?.outcome ?? '?'})${note}`);
  if (st.idle?.error) out.push(`⚠️ Error: ${st.idle.error.message || st.idle.error.type || JSON.stringify(st.idle.error)}`);
  out.push(`session_id: ${sid}`);
  out.push(`model: ${modelOf(st.lastAssistant)}`);
  if (st.lastAssistant?.tokens) out.push(`tokens: ${st.lastAssistant.tokens.input} in / ${st.lastAssistant.tokens.output} out`);
  out.push(`tools_used: ${st.tools.length ? st.tools.join(', ') : '(none)'}`);
  out.push('\n--- files changed ---');
  if (diff.length) out.push(fmtDiff(diff));
  else if (!snapEmpty(snap)) out.push(fmtSnapshotDiff(snap));
  else out.push('(no file changes)');
  const text = assistantText(st.lastAssistant);
  if (text) { out.push('\n--- result ---'); out.push(clip(text, 15_000)); }
  return out.join('\n');
}

function progressReport(sid, st, waitedMs, note = '') {
  const out = [];
  if (waitedMs) out.push(`⏳ Still running (waited ${Math.round(waitedMs / 1000)} s; returning early to stay under the client timeout)${note}`);
  else if (st.newestType === 'assistant' || st.lastAssistant) out.push('Status: 🔄 running');
  else if (st.hasUser) out.push('Status: task received, executor starting');
  else out.push('Status: idle (nothing dispatched yet)');
  out.push(`session_id: ${sid}`);
  if (st.lastAssistant) out.push(`model: ${modelOf(st.lastAssistant)}`);
  if (st.tools.length) out.push(`tools used so far: ${st.tools.join(', ')}`);
  const text = assistantText(st.lastAssistant);
  if (text) { out.push('\n--- latest output ---'); out.push(tailClip(text, 3000)); }
  out.push(`\nKeep waiting: check {sessionId: "${sid}", waitSeconds: ${BLOCK_S}}. Stop it: interrupt.`);
  return out.join('\n');
}

async function waitAndReport(ctx, sid, budgetMs, note = '') {
  const t0 = Date.now();
  let st;
  try {
    for (;;) {
      st = await sessionState(ctx, sid);
      if (st.done || Date.now() - t0 >= budgetMs) break;
      await sleep(POLL_MS);
    }
  } catch (e) {
    return `⚠️ Could not read progress: ${e.message}\nsession_id: ${sid}\nThe task may still be running; call check again later.${note}`;
  }
  if (st.done) return finalReport(ctx, sid, st, note);
  return progressReport(sid, st, Date.now() - t0, note);
}

// ---------- tools ----------
async function tool_run(ctx, args) {
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('prompt is required');
  if (args.directory && !existsSync(args.directory)) throw new Error('directory does not exist: ' + args.directory);
  const wait = args.wait !== false;
  let note = '';
  try { note = (await maybeUpgrade(ctx)) || ''; } catch (e) { log('upgrade check failed (dispatching anyway):', e.message); }

  let sid = args.sessionId || null;
  if (!sid) {
    const body = {};
    if (args.title) body.title = String(args.title);
    if (args.directory) body.location = { directory: args.directory };
    const mdl = await resolveModel(ctx, args.model);
    if (mdl?.id) body.model = mdl;
    const r = await api(ctx, 'POST', '/api/session', { body, retrySafe: true });
    sid = r?.data?.id;
    if (!sid) throw new Error('creating the session failed: no id in the response');
    log('created session', sid, mdl ? `${mdl.providerID}/${mdl.id}` : '(default model)');
  } else if (args.model) {
    note += ' (model is ignored when continuing a session; it keeps its original model)';
  }
  setLastSession(ctx, sid);

  const prevIdles = (await listMessages(ctx, sid)).filter((m) => m.type === 'idle').map((m) => m.id);
  addPending(sid, { prevIdles, directory: args.directory || null, at: Date.now() });
  ctx.state.snapResult.delete(sid);
  if (args.directory) { const snap = safeSnapshot(args.directory); if (snap) ctx.state.snapBefore.set(sid, snap); }

  try {
    await api(ctx, 'POST', `/api/session/${sid}/prompt`, { body: { text: prompt } });
  } catch (e) {
    removePending(sid);
    throw e;
  }
  log('dispatched to', sid);
  if (!wait) {
    return `⏳ Dispatched (running in the background).${note}\nsession_id: ${sid}\nPoll with check; to wait for completion use check {sessionId, waitSeconds: ${BLOCK_S}}.`;
  }
  return waitAndReport(ctx, sid, BLOCK_MS, note);
}

async function tool_check(ctx, args) {
  let sid = args.sessionId || getLastSession(ctx);
  if (!sid) {
    const l = (await api(ctx, 'GET', '/api/session', { query: { limit: 3 } }))?.data || [];
    if (!l.length) return 'No sessions yet; dispatch one with run.';
    sid = l[0].id;
  }
  const waitMs = Math.max(0, Math.min(Number(args.waitSeconds) || 0, BLOCK_S)) * 1000;
  if (waitMs > 0) return waitAndReport(ctx, sid, waitMs);
  const st = await sessionState(ctx, sid);
  if (st.done) return finalReport(ctx, sid, st);
  return progressReport(sid, st, 0);
}

async function tool_review_changes(ctx, args) {
  const sid = args.sessionId || getLastSession(ctx);
  const out = [];
  if (sid) {
    const diff = (await api(ctx, 'GET', `/api/session/${sid}/diff`))?.data || [];
    const snap = ctx.state.snapResult.get(sid);
    if (diff.length) { out.push('--- changes (git diff) ---'); out.push(fmtDiff(diff)); }
    else if (!snapEmpty(snap)) { out.push('--- changes (file comparison, non-git directory) ---'); out.push(fmtSnapshotDiff(snap)); }
    else { out.push('--- changes ---'); out.push('(none; in a non-git directory, changes are only tracked for tasks this bridge dispatched with a directory)'); }
  } else if (args.directory) {
    const rawQuery = 'location[directory]=' + encodeURIComponent(args.directory);
    const files = (await api(ctx, 'GET', '/api/vcs/status', { rawQuery }))?.data || [];
    out.push(`--- working tree (${args.directory}, git) ---`);
    out.push(files.length ? fmtDiff(files) : '(clean)');
  } else {
    out.push('No session and no directory. Pass sessionId (or run something first) or directory.');
  }
  return out.join('\n');
}

async function tool_session_list(ctx, args) {
  const l = (await api(ctx, 'GET', '/api/session', { query: { limit: args.limit || 20 } }))?.data || [];
  if (!l.length) return '(no sessions)';
  return l.map((s) => {
    const model = s.model ? `${s.model.providerID}/${s.model.id}` : '?';
    return `${s.id}  [${s.outcome || 'running'}]  ${model}  ${s.title || '(untitled)'}  ${s.location?.directory || ''}`;
  }).join('\n');
}

async function tool_interrupt(ctx, args) {
  const sid = args.sessionId || getLastSession(ctx);
  if (!sid) return 'No session to interrupt.';
  const r = await api(ctx, 'POST', `/api/session/${sid}/interrupt`, { query: { resume: 'true' } });
  removePending(sid);
  return `interrupted=${r?.interrupted ?? true} (session ${sid})`;
}

async function tool_provider_models(ctx) {
  let def = null;
  try { def = (await api(ctx, 'GET', '/api/model/default'))?.data; } catch { /* ignore */ }
  const models = await listModels(ctx);
  const cfg = loadConfig();
  const defKey = def?.providerID && def?.id ? `${def.providerID}/${def.id}` : null;
  const aliasLines = [];
  const aliasesOf = {};
  for (const [name, rule] of Object.entries(cfg.aliases)) {
    let full;
    try { full = resolveAlias(models, rule, name); } catch (e) { aliasLines.push(`  ${name} -> (unresolved: ${e.message})`); continue; }
    (aliasesOf[full] ||= []).push(name);
    aliasLines.push(`  ${name} -> ${full}${rule.label ? '   (' + rule.label + ')' : ''}${rule.match ? '   [tracks newest match]' : ''}`);
  }
  const lines = ['Default model: ' + (defKey || '?'), ''];
  const providers = uniq(models.filter((m) => m.enabled !== false).map((m) => m.providerID));
  for (const pid of providers) {
    const label = cfg.providerLabels[pid];
    lines.push(`[${pid}${label ? ' — ' + label : ''}]`);
    for (const m of models.filter((x) => x.providerID === pid && x.enabled !== false)) {
      const key = `${m.providerID}/${modelId(m)}`;
      lines.push(`  ${key}${defKey === key ? '  <- default' : ''}${aliasesOf[key] ? '  alias: ' + aliasesOf[key].join(', ') : ''}${m.name ? '   name: ' + m.name : ''}`);
    }
    lines.push('');
  }
  lines.push('Aliases' + (cfgCache.error ? ` (config.json is invalid: ${cfgCache.error})` : '') + ':');
  lines.push(aliasLines.length ? aliasLines.join('\n') : `  (none; add them in ${configPath()})`);
  lines.push('\nFor run.model use an alias, "provider/model", or a bare model id.');
  return lines.join('\n');
}

async function tool_status(ctx, args) {
  const out = [];
  out.push(`bridge: shell v${ctx.shellVersion} + core v${VERSION} (pid ${process.pid}, node ${process.version}, up ${Math.round((Date.now() - ctx.startedAt) / 60000)} min)`);
  out.push(`state dir: ${DIR}`);
  const cfg = loadConfig();
  out.push(`config: ${configPath()} — ${cfgCache.error ? 'INVALID: ' + cfgCache.error : existsSync(configPath()) ? Object.keys(cfg.aliases).length + ' alias(es)' : 'not present (optional)'}`);
  if (args.restartServe) {
    const running = await runningSessions(ctx);
    if (running.length && !args.force) {
      out.push(`⚠️ ${running.length} task(s) running (${running.join(', ')}); not restarting. Pass force: true to restart anyway.`);
    } else {
      await restartServe(ctx, 'requested');
      out.push('✅ serve restarted');
    }
  }
  try {
    const conn = await ensureConn(ctx, { force: true });
    out.push(`serve: ${conn.base}  pid ${conn.info?.pid ?? '?'}  v${conn.info?.version ?? '?'}  auth: ${conn.pw === getSecret() ? 'fixed secret' : 'per-port password file'}`);
  } catch (e) {
    out.push('serve: ❌ ' + e.message);
  }
  const orig = findOriginalExe();
  out.push(`opencode CLI: ${orig || 'not found'}${orig ? '  v' + ((await exeVersion(orig)) || '?') : ''}`);
  const running = await runningSessions(ctx).catch(() => []);
  out.push(`running tasks: ${running.length ? running.join(', ') : 'none'}`);
  const logLines = (readText(p('bridge.log')) || '').split('\n');
  const recent = logLines.filter((l) => /fail|error|401|uncaught|unhandled|timed out|invalid/i.test(l)).slice(-8);
  out.push('\n--- recent problems ---');
  out.push(recent.length ? recent.join('\n') : '(none)');
  out.push('\n--- recent log ---');
  out.push(logLines.slice(-8).join('\n'));
  return out.join('\n');
}

// ---------- tool definitions ----------
function modelParamDescription() {
  const names = Object.entries(loadConfig().aliases).map(([n, a]) => (a.label ? `"${n}" (${a.label})` : `"${n}"`));
  return 'Optional model: ' + (names.length ? `an alias — ${names.join(', ')} — or ` : '')
    + '"provider/model", or a bare model id. Omit to use OpenCode\'s default model. Call provider_models to list models.';
}

export const TOOLS = [
  {
    name: 'run',
    description: `Dispatch a task to OpenCode (the executor agent). Waits up to ~${BLOCK_S} s and returns the result plus changed files; if the task is not finished by then, returns the session_id and progress — call check with waitSeconds to keep waiting. Set wait:false to return immediately.`,
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The task/instruction for the executor agent. Be specific.' },
        directory: { type: 'string', description: 'Optional absolute path of the project directory to work in (must exist).' },
        title: { type: 'string', description: 'Optional session title.' },
        sessionId: { type: 'string', description: 'Optional existing session id to continue (keeps its context and model).' },
        model: { type: 'string', description: modelParamDescription() },
        wait: { type: 'boolean', description: `Wait for completion (default true, at most ~${BLOCK_S} s). false = return the session_id immediately; poll with check.` },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'check',
    description: `Check a session's status and latest output. With waitSeconds (max ${BLOCK_S}) it blocks until the task finishes or time is up, and returns the full result plus changed files when done.`,
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session id. Defaults to the last session dispatched.' },
        waitSeconds: { type: 'number', description: `Optional: keep waiting up to this many seconds (max ${BLOCK_S}) for the task to finish.` },
      },
    },
  },
  {
    name: 'review_changes',
    description: 'Show the file changes made by a session, or the git working-tree status of a directory.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Optional session id (defaults to the last session).' },
        directory: { type: 'string', description: 'Optional directory to show the git working-tree status for.' },
      },
    },
  },
  {
    name: 'session_list',
    description: 'List recent OpenCode sessions.',
    inputSchema: { type: 'object', properties: { limit: { type: 'number', description: 'Max sessions to return (default 20).' } } },
  },
  {
    name: 'interrupt',
    description: 'Interrupt (stop) a running session.',
    inputSchema: { type: 'object', properties: { sessionId: { type: 'string', description: 'Optional session id. Defaults to the last session.' } } },
  },
  {
    name: 'provider_models',
    description: 'List the available models grouped by provider, the default model, and the configured aliases with what they currently resolve to. Call this when the user names a model.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'status',
    description: 'Bridge health: versions, which opencode serve is used (port, pid, version), opencode CLI version, config, running tasks, recent errors. restartServe:true restarts the serve (refused while tasks run unless force:true).',
    inputSchema: {
      type: 'object',
      properties: {
        restartServe: { type: 'boolean', description: 'Restart the opencode serve process.' },
        force: { type: 'boolean', description: 'With restartServe: restart even if tasks are running.' },
      },
    },
  },
];

export async function callTool(ctx, name, args = {}) {
  switch (name) {
    case 'run': return tool_run(ctx, args);
    case 'check': return tool_check(ctx, args);
    case 'review_changes': return tool_review_changes(ctx, args);
    case 'session_list': return tool_session_list(ctx, args);
    case 'interrupt': return tool_interrupt(ctx, args);
    case 'provider_models': return tool_provider_models(ctx, args);
    case 'status': return tool_status(ctx, args);
    default: throw new Error('unknown tool: ' + name);
  }
}
