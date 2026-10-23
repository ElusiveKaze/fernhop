// Integration tests for fernhop. Every test uses a temporary state directory and its own
// port range, so it never touches a serve you are already using.
//
//   node test/run-tests.mjs --mock   no opencode needed (uses test/mock-opencode.mjs); default
//   node test/run-tests.mjs --live   real opencode; makes a few tiny model calls
//
// Env for --live: FERNHOP_TEST_MODEL=provider/model (default: OpenCode's default model)
import { spawn, execFile } from 'node:child_process';
import { mkdtempSync, rmSync, utimesSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import zlib from 'node:zlib';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BRIDGE = join(ROOT, 'bridge.mjs');
const CORE = join(ROOT, 'core.mjs');
const MOCK = join(HERE, 'mock-opencode.mjs');
const LIVE = process.argv.includes('--live');
const IS_WIN = process.platform === 'win32';
const BASE = LIVE ? 4150 : 4250;
const MODEL = LIVE ? (process.env.FERNHOP_TEST_MODEL || undefined) : 'acme/model-fast-0420';
const SLEEP_CMD = IS_WIN ? 'Start-Sleep -Seconds 40' : 'sleep 40';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const pids = new Set();
const dirs = [];

function mkEnv(port, extra = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'ocb-test-'));
  dirs.push(dir);
  const env = { ...process.env, FERNHOP_DIR: dir, OPENCODE_PORT: String(port), OPENCODE_PORT_SPAN: '5', OPENCODE_BLOCK_MS: '15000', ...extra };
  for (const k of ['OPENCODE_BASE_URL', 'OPENCODE_SERVER_PASSWORD', 'FERNHOP_CONFIG', 'FERNHOP_NO_COPY',
    'OPENCODE_BRIDGE_DIR', 'OPENCODE_BRIDGE_CONFIG', 'OPENCODE_BRIDGE_NO_COPY']) delete env[k];
  if (!LIVE) { env.OPENCODE_EXECUTABLE = MOCK; env.MOCK_VERSION_FILE = join(dir, 'mock-version.txt'); writeFileSync(env.MOCK_VERSION_FILE, '2.1.3'); }
  return { env, dir };
}

class Client {
  constructor(name, env, args = [BRIDGE]) {
    this.name = name; this.id = 0; this.waiters = new Map(); this.stderr = '';
    this.proc = spawn(process.execPath, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let buf = '';
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { this.stderr += '\n[bad stdout] ' + line; continue; }
        if (msg.id != null && this.waiters.has(msg.id)) { this.waiters.get(msg.id)(msg); this.waiters.delete(msg.id); }
      }
    });
    this.proc.stderr.on('data', (d) => { this.stderr += d; });
  }
  req(method, params, timeoutMs = 150_000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.waiters.delete(id); rej(new Error(`${this.name} ${method} timed out`)); }, timeoutMs);
      this.waiters.set(id, (m) => { clearTimeout(t); res(m); });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async init() {
    const r = await this.req('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'tests', version: '1' } });
    this.proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    return r;
  }
  async call(name, args = {}, timeoutMs) {
    const r = await this.req('tools/call', { name, arguments: args }, timeoutMs);
    return { text: r.result?.content?.[0]?.text ?? JSON.stringify(r.error || r), isError: !!(r.result?.isError || r.error) };
  }
  async status() { const s = await this.call('status'); const pid = servePid(s.text); if (pid) pids.add(pid); return s.text; }
  close() { try { this.proc.stdin.end(); } catch { /* ignore */ } }
}

const servePid = (t) => Number((t.match(/serve: \S+\s+pid (\d+)/) || [])[1]) || null;
const servePort = (t) => Number((t.match(/serve: http:\/\/127\.0\.0\.1:(\d+)/) || [])[1]) || null;
const serveVersion = (t) => (t.match(/serve: \S+\s+pid \d+\s+v(\S+)/) || [])[1] || null;
function killPid(pid) {
  return new Promise((r) => {
    if (!pid) return r();
    if (IS_WIN) execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    else { try { process.kill(pid); } catch { /* ignore */ } r(); }
  });
}
function procPath(pid) {
  return new Promise((r) => execFile('powershell.exe', ['-NoProfile', '-Command', `(Get-Process -Id ${pid}).Path`], { windowsHide: true }, (e, out) => r(String(out || '').trim())));
}
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push(true);
    console.log(`PASS  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)${detail ? '  — ' + detail : ''}`);
  } catch (e) {
    results.push(false);
    console.log(`FAIL  ${name}  (${((Date.now() - t0) / 1000).toFixed(1)}s)  — ${e.message}`);
  }
}
const must = (cond, msg) => { if (!cond) throw new Error(msg); };
const echoPrompt = (word) => `Run the shell command \`echo ${word}\` and reply with its output only.`;
const run = (args) => new Promise((r) => execFile(process.execPath, args, { windowsHide: true }, (e, out, err) => r({ code: e ? e.code || 1 : 0, out: String(out), err: String(err) })));

// Minimal unzip (stored or deflated entries), enough to install an .mcpb the way a client does.
function unzipTo(file, dest) {
  const b = readFileSync(file);
  const end = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  must(end >= 0, 'not a zip file');
  let p = b.readUInt32LE(end + 16);
  const names = [];
  for (let i = 0, n = b.readUInt16LE(end + 10); i < n; i++) {
    must(b.readUInt32LE(p) === 0x02014b50, 'bad central directory');
    const method = b.readUInt16LE(p + 10), csize = b.readUInt32LE(p + 20), size = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28), xlen = b.readUInt16LE(p + 30), clen = b.readUInt16LE(p + 32), off = b.readUInt32LE(p + 42);
    const name = b.toString('utf8', p + 46, p + 46 + nlen);
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const raw = b.subarray(start, start + csize);
    const data = method === 8 ? zlib.inflateRawSync(raw) : raw;
    must(data.length === size, 'size mismatch for ' + name);
    mkdirSync(dirname(join(dest, name)), { recursive: true });
    writeFileSync(join(dest, name), data);
    names.push(name);
    p += 46 + nlen + xlen + clen;
  }
  return names;
}

async function main() {
  console.log(`mode: ${LIVE ? 'live (real opencode)' : 'mock'}   bridge: ${BRIDGE}`);
  const A_env = mkEnv(BASE);
  const A = new Client('A', A_env.env);

  await test('initialize + tools/list', async () => {
    const r = await A.init();
    must(r.result?.capabilities?.tools, 'initialize returned no tools capability');
    const names = ((await A.req('tools/list', {})).result?.tools || []).map((t) => t.name);
    for (const n of ['run', 'check', 'review_changes', 'session_list', 'interrupt', 'provider_models', 'status']) must(names.includes(n), 'missing tool ' + n);
    return names.join(', ');
  });

  await test('--version matches package.json', async () => {
    const r = await run([BRIDGE, '--version']);
    const v = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
    must(r.code === 0 && r.out.startsWith(v + ' '), JSON.stringify(r));
    return r.out.trim();
  });

  await test('first call starts a serve with the fixed secret', async () => {
    const s = await A.status();
    must(servePid(s), 'no serve pid in status:\n' + s);
    must(/auth: fixed secret/.test(s), 'not using the fixed secret:\n' + s);
    if (LIVE && IS_WIN) {
      const path = await procPath(servePid(s));
      must(path.toLowerCase().startsWith(A_env.dir.toLowerCase()), 'serve is not running from the copied executable: ' + path);
      return `pid ${servePid(s)}, port ${servePort(s)}, exe copy ${path}`;
    }
    return `pid ${servePid(s)}, port ${servePort(s)}`;
  });

  await test('session_list', async () => { const r = await A.call('session_list', { limit: 3 }); must(!r.isError, r.text); });

  await test('provider_models', async () => {
    const r = await A.call('provider_models');
    must(!r.isError && /Default model:/.test(r.text) && /\[\S+/.test(r.text), r.text.slice(0, 800));
  });

  await test('run waits and returns the result', async () => {
    const r = await A.call('run', { model: MODEL, title: 'bridge test: echo', prompt: echoPrompt('bridge-test-ok') }, 120_000);
    must(!r.isError && /✅/.test(r.text) && /bridge-test-ok/.test(r.text), r.text.slice(0, 1500));
    return (r.text.match(/model: .*/) || [''])[0];
  });

  await test('long task returns early, then check waitSeconds collects the result', async () => {
    const t0 = Date.now();
    const r = await A.call('run', { model: MODEL, title: 'bridge test: long', prompt: `Run the shell command \`${SLEEP_CMD}\` (allow it up to 120 seconds), then reply with slept-done only.` }, 120_000);
    must(!r.isError && /⏳/.test(r.text), 'expected an early ⏳ return:\n' + r.text.slice(0, 800));
    must(Date.now() - t0 < 30_000, 'blocked too long: ' + (Date.now() - t0) + ' ms');
    const sid = (r.text.match(/session_id: (\S+)/) || [])[1];
    must(sid, 'no session_id');
    for (let i = 0; i < 10; i++) {
      const c = await A.call('check', { sessionId: sid, waitSeconds: 15 }, 60_000);
      if (/✅/.test(c.text)) { must(/slept-done/.test(c.text), c.text.slice(0, 800)); return `${i + 1} check call(s), ${Math.round((Date.now() - t0) / 1000)} s total`; }
    }
    throw new Error('not finished after 10 check calls');
  });

  await test('serve killed -> next call starts a new one', async () => {
    const before = servePid(await A.status());
    await killPid(before);
    await sleep(1500);
    const r = await A.call('session_list', { limit: 2 }, 120_000);
    must(!r.isError, r.text);
    const after = servePid(await A.status());
    must(after && after !== before, `pid did not change: ${before} -> ${after}`);
    return `pid ${before} -> ${after}`;
  });

  await test('port held by another program (always 401) -> left alone, next port used', async () => {
    const s0 = await A.status();
    const port = servePort(s0);
    await killPid(servePid(s0));
    await sleep(1500);
    const foreign = http.createServer((req, res) => { res.writeHead(401); res.end(); });
    await new Promise((r) => foreign.listen(port, '127.0.0.1', r));
    try {
      const r = await A.call('session_list', { limit: 2 }, 120_000);
      must(!r.isError, r.text);
      const s = await A.status();
      must(servePort(s) && servePort(s) !== port, `port did not change: ${port} -> ${servePort(s)}`);
      return `${port} (taken) -> ${servePort(s)}`;
    } finally { foreign.close(); }
  });

  await test('missing directory gives a clear error', async () => {
    const r = await A.call('run', { prompt: 'x', directory: join(tmpdir(), 'ocb-does-not-exist-' + Date.now()) });
    must(r.isError && /directory does not exist/.test(r.text), r.text);
  });

  await test('hot reload: touching core.mjs takes effect without a restart', async () => {
    const now = new Date();
    utimesSync(CORE, now, now);
    await sleep(300);
    const r = await A.call('status');
    must(!r.isError, r.text);
    await sleep(200);
    must(/core reloaded/.test(A.stderr), 'no reload in the log');
  });

  await test('two instances starting together share one serve; closing one keeps it', async () => {
    const E = mkEnv(BASE + 10);
    const B = new Client('B', E.env), C = new Client('C', E.env);
    await Promise.all([B.init(), C.init()]);
    const [rb, rc] = await Promise.all([B.call('session_list', { limit: 1 }, 150_000), C.call('session_list', { limit: 1 }, 150_000)]);
    must(!rb.isError && !rc.isError, rb.text + '\n' + rc.text);
    const pb = servePid(await B.status()), pc = servePid(await C.status());
    must(pb && pb === pc, `different serves: ${pb} vs ${pc}`);
    B.close();
    await sleep(1500);
    must(B.proc.exitCode !== null, 'B did not exit after stdin closed');
    must(servePid(await C.status()) === pb, 'serve changed or died after B exited');
    C.close();
    return `shared pid ${pb}`;
  });

  if (!LIVE) {
    await test('[mock] aliases from config.json, tracking the newest match', async () => {
      writeFileSync(join(A_env.dir, 'config.json'), JSON.stringify({
        aliases: { pro: { provider: 'acme', match: 'pro', label: 'strong model' }, fast: 'acme/model-fast-0420' },
        providerLabels: { acme: 'team API' },
      }));
      const pm = await A.call('provider_models');
      must(/pro -> acme\/model-pro-0918/.test(pm.text) && /fast -> acme\/model-fast-0420/.test(pm.text) && /team API/.test(pm.text), pm.text);
      const r = await A.call('run', { model: 'pro', prompt: echoPrompt('alias-ok') });
      must(/model: acme\/model-pro-0918/.test(r.text), r.text);
    });

    await test('[mock] bare model id is looked up; unknown model is a clear error', async () => {
      const r = await A.call('run', { model: 'tiny', prompt: echoPrompt('bare-ok') });
      must(/model: example\/tiny/.test(r.text), r.text);
      const bad = await A.call('run', { model: 'no-such-model', prompt: 'x' });
      must(bad.isError && /unknown model/.test(bad.text), bad.text);
    });

    await test('[mock] serve that ignores the env password -> printed password is used', async () => {
      const E = mkEnv(BASE + 20, { MOCK_IGNORE_ENV_PASSWORD: '1' });
      const D = new Client('D', E.env);
      await D.init();
      const s = await D.status();
      must(/auth: per-port password file/.test(s), s);
      D.close();
    });

    await test('[mock] opencode upgrade -> serve restarted when idle, postponed while busy', async () => {
      const E = mkEnv(BASE + 30, { OPENCODE_UPGRADE_CHECK_MS: '0' });
      const U = new Client('U', E.env);
      await U.init();
      let r = await U.call('run', { prompt: echoPrompt('v1') });
      must(/✅/.test(r.text) && !/upgraded/.test(r.text), r.text);
      writeFileSync(E.env.MOCK_VERSION_FILE, '2.1.4');
      r = await U.call('run', { prompt: echoPrompt('v2') });
      must(/upgraded from 2\.1\.3 to 2\.1\.4/.test(r.text), r.text);
      const s = await U.status();
      must(serveVersion(s) === '2.1.4', s);
      await U.call('run', { prompt: 'sleep please', wait: false });
      writeFileSync(E.env.MOCK_VERSION_FILE, '2.1.5');
      r = await U.call('run', { prompt: echoPrompt('v3') });
      must(!/upgraded/.test(r.text), 'restarted while a task was running:\n' + r.text);
      must(servePid(await U.status()) === servePid(s), 'serve pid changed while busy');
      U.close();
    });

    await test('[mock] empty or unfilled installer settings are ignored', async () => {
      const E = mkEnv(BASE + 40, { OPENCODE_UPGRADE_CHECK_MS: '', OPENCODE_BLOCK_MS: '${user_config.block_ms}' });
      E.env.FERNHOP_CONFIG = '${user_config.alias_config}';
      const F = new Client('F', E.env);
      await F.init();
      const s = await F.status();
      F.close();
      must(s.includes('config: ' + join(E.dir, 'config.json')), 'placeholder was not ignored:\n' + s);
    });

    await test('[mock] .mcpb bundle builds, unpacks and runs the way Claude Desktop starts it', async () => {
      const E = mkEnv(BASE + 50);
      const out = join(E.dir, 'dist');
      const b = await run([join(ROOT, 'scripts', 'build-mcpb.mjs'), out]);
      must(b.code === 0, 'build failed: ' + b.err + b.out);
      const file = b.out.split('\n')[0].trim();
      const ext = join(E.dir, 'ext');
      const names = unzipTo(file, ext);
      for (const f of ['manifest.json', 'bridge.mjs', 'core.mjs']) must(names.includes(f), 'bundle lacks ' + f);
      const m = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
      // Same substitution rules as the client: defaults, then user values; unset optional values stay as "${...}".
      const vars = { __dirname: ext, 'user_config.port': String(BASE + 50), 'user_config.opencode_executable': MOCK };
      const sub = (v) => v.replace(/\$\{([^}]+)\}/g, (all, k) => (k in vars ? vars[k] : all));
      const args = m.server.mcp_config.args.map(sub);
      const env = { ...E.env };
      for (const k of Object.keys(env)) if ((k.startsWith('OPENCODE_') || k.startsWith('FERNHOP_')) && k !== 'FERNHOP_DIR') delete env[k];
      for (const [k, v] of Object.entries(m.server.mcp_config.env || {})) env[k] = sub(v);
      must(env.FERNHOP_CONFIG === '${user_config.alias_config}', 'expected an unfilled placeholder');
      const X = new Client('X', env, args);
      await X.init();
      const tools = ((await X.req('tools/list', {})).result?.tools || []).map((t) => t.name).sort().join(',');
      must(tools === m.tools.map((t) => t.name).sort().join(','), 'tools differ from manifest: ' + tools);
      const r = await X.call('run', { prompt: echoPrompt('bundle-ok') });
      const s = await X.status();
      X.close();
      must(/✅/.test(r.text) && /bundle-ok/.test(r.text), r.text);
      must(servePort(s) === BASE + 50 && s.includes('config: ' + join(E.dir, 'config.json')), s);
      return `${names.length} files, ${file.split(/[\\/]/).pop()}`;
    });

    await test('[mock] setups from the old name (opencode-bridge) keep working', async () => {
      const E = mkEnv(BASE + 60);
      const home = join(E.dir, 'home');
      const oldDir = join(home, '.opencode-bridge');
      mkdirSync(oldDir, { recursive: true });
      writeFileSync(join(oldDir, 'config.json'), JSON.stringify({ aliases: { legacy: 'acme/model-fast-0420' } }));
      const other = join(E.dir, 'other-config.json');
      writeFileSync(other, JSON.stringify({ aliases: { a: 'acme/model-fast-0420', b: 'acme/model-fast-0420' } }));
      delete E.env.FERNHOP_DIR;
      Object.assign(E.env, { HOME: home, USERPROFILE: home });
      // 1. no ~/.fernhop yet: the old state directory and its config are used
      const G = new Client('G', E.env);
      await G.init();
      let s = await G.status();
      G.close();
      must(s.includes('state dir: ' + oldDir) && s.includes('config: ' + join(oldDir, 'config.json') + ' — 1 alias'), s);
      // 2. the old variable name for the alias file is still read
      const H = new Client('H', { ...E.env, OPENCODE_BRIDGE_CONFIG: other });
      await H.init();
      s = await H.status();
      H.close();
      must(s.includes('config: ' + other + ' — 2 alias'), s);
      // 3. once ~/.fernhop exists it wins
      mkdirSync(join(home, '.fernhop'));
      const I = new Client('I', E.env);
      await I.init();
      s = await I.status();
      I.close();
      must(s.includes('state dir: ' + join(home, '.fernhop')), s);
    });
  }

  A.close();
  await sleep(500);
  for (const pid of pids) await killPid(pid);
  await sleep(1000);
  for (const d of dirs) { try { rmSync(d, { recursive: true, force: true }); } catch (e) { console.log('could not remove', d, e.message); } }

  const failed = results.filter((x) => !x).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  if (failed) { console.log('\n--- bridge A stderr (tail) ---\n' + A.stderr.slice(-4000)); process.exitCode = 1; }
}

main().catch((e) => { console.log('test runner crashed:', e.stack); process.exitCode = 2; }).finally(() => setTimeout(() => process.exit(), 1000));
