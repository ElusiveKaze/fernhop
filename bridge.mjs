#!/usr/bin/env node
// fernhop — stable MCP stdio shell.
//
// This file only speaks MCP over stdio and hot-reloads ./core.mjs. All tool logic lives in
// core.mjs: edit it and the next tool call runs the new code, no client restart needed.
// Keep this file small and stable; changing it requires the MCP client to relaunch the server.
//
// Zero dependencies. Node.js 18+.

import { existsSync, statSync, appendFileSync, mkdirSync, renameSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';

const SHELL_VERSION = '1.1.0';
const HERE = dirname(fileURLToPath(import.meta.url));
const CORE_PATH = join(HERE, 'core.mjs');

// Settings left empty in an installer UI arrive as "" or as an unfilled "${user_config.x}"
// placeholder (MCP Bundles). Treat both as "not set" so the defaults apply.
for (const k of Object.keys(process.env)) {
  if (!k.startsWith('OPENCODE_') && !k.startsWith('FERNHOP_')) continue;
  const v = String(process.env[k]).trim();
  if (v === '' || /^\$\{[^}]*\}$/.test(v)) delete process.env[k];
}
// fernhop was called opencode-bridge before 1.1.0: keep honouring its variable names.
for (const k of ['DIR', 'CONFIG', 'NO_COPY']) {
  if (!process.env['FERNHOP_' + k] && process.env['OPENCODE_BRIDGE_' + k]) process.env['FERNHOP_' + k] = process.env['OPENCODE_BRIDGE_' + k];
}

// ---------- command line (the MCP client starts us without arguments) ----------
const argv = process.argv.slice(2);
if (argv.includes('--version') || argv.includes('-v')) {
  let pkg = '';
  try { pkg = JSON.parse(readFileSync(join(HERE, 'package.json'), 'utf8')).version; } catch { /* ignore */ }
  process.stdout.write(`${pkg || SHELL_VERSION} (shell ${SHELL_VERSION}, node ${process.version})\n`);
  process.exit(0);
}
if (argv.includes('--help') || argv.includes('-h')) {
  process.stdout.write([
    'fernhop: MCP server (stdio) that lets Claude delegate tasks to OpenCode.',
    '',
    'It is started by your MCP client, not by hand. Examples:',
    '  claude mcp add --scope user opencode -- node ' + join(HERE, 'bridge.mjs'),
    '  Claude Desktop: install the .mcpb bundle, or add {"command":"node","args":["' + join(HERE, 'bridge.mjs').replace(/\\/g, '\\\\') + '"]}',
    '',
    'Options:  --version  --help',
    'Docs:     README.md next to this file',
    '',
  ].join('\n'));
  process.exit(0);
}
// State directory. An existing ~/.opencode-bridge (the old name) is kept until ~/.fernhop exists.
const NEW_DIR = join(homedir(), '.fernhop');
const OLD_DIR = join(homedir(), '.opencode-bridge');
const DIR = process.env.FERNHOP_DIR || (!existsSync(NEW_DIR) && existsSync(OLD_DIR) ? OLD_DIR : NEW_DIR);
const LOG_PATH = join(DIR, 'bridge.log');
const TOOLS_CACHE = join(DIR, 'tools-cache.json');

// ---------- logging: stderr (the MCP client's server log) + <state dir>/bridge.log ----------
let logCount = 0;
function fmt(x) {
  if (typeof x === 'string') return x;
  if (x instanceof Error) return x.stack || x.message;
  try { return JSON.stringify(x); } catch { return String(x); }
}
function log(...a) {
  const line = `${new Date().toISOString()} [${process.pid}] ${a.map(fmt).join(' ')}`;
  try { process.stderr.write('[fernhop] ' + line + '\n'); } catch { /* ignore */ }
  try {
    mkdirSync(DIR, { recursive: true });
    if (++logCount % 200 === 1) {
      try { if (statSync(LOG_PATH).size > 2_000_000) renameSync(LOG_PATH, LOG_PATH + '.1'); } catch { /* ignore */ }
    }
    appendFileSync(LOG_PATH, line + '\n');
  } catch { /* ignore */ }
}

// ---------- MCP output ----------
let initialized = false;
function send(obj) { try { process.stdout.write(JSON.stringify(obj) + '\n'); } catch (e) { log('stdout write failed:', e.message); } }
function respond(id, result) { send({ jsonrpc: '2.0', id, result }); }
function respondError(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }
function notify(method, params) { send({ jsonrpc: '2.0', method, ...(params ? { params } : {}) }); }

// ---------- hot-reloading core.mjs ----------
// ctx.state belongs to the shell, so connection, snapshots and the last session survive a reload.
const ctx = { state: {}, log, shellVersion: SHELL_VERSION, startedAt: Date.now(), dir: DIR };
let core = null;
let coreMtime = -1;
let coreError = null;
let loading = null;

const toolsSig = (m) => { try { return JSON.stringify(m?.TOOLS); } catch { return ''; } };

async function loadCore() {
  let mtime;
  try { mtime = statSync(CORE_PATH).mtimeMs; } catch (e) { coreError = e; return core; }
  if (mtime === coreMtime) return core; // unchanged (or the same broken file was already tried)
  try {
    const mod = await import(pathToFileURL(CORE_PATH).href + '?mtime=' + mtime);
    if (!Array.isArray(mod.TOOLS) || typeof mod.callTool !== 'function') throw new Error('core.mjs must export TOOLS and callTool');
    const prev = core;
    if (typeof mod.init === 'function') await mod.init(ctx);
    core = mod;
    coreMtime = mtime;
    coreError = null;
    ctx.coreVersion = mod.VERSION;
    try { mkdirSync(DIR, { recursive: true }); writeFileSync(TOOLS_CACHE, JSON.stringify(mod.TOOLS)); } catch { /* ignore */ }
    log(prev ? `core reloaded ${prev.VERSION} -> ${mod.VERSION}` : `core loaded v${mod.VERSION}`);
    if (prev && initialized && toolsSig(prev) !== toolsSig(mod)) notify('notifications/tools/list_changed');
  } catch (e) {
    coreError = e;
    coreMtime = mtime; // do not retry the same broken file on every call; the next edit retries
    log('core.mjs failed to load, keeping the previous version:', e);
  }
  return core;
}
function getCore() {
  if (!loading) loading = loadCore().finally(() => { loading = null; });
  return loading;
}

// ---------- MCP requests ----------
async function handle(msg) {
  const { id, method } = msg;
  const hasId = id !== undefined && id !== null;
  try {
    if (method === 'initialize') {
      respond(id, {
        protocolVersion: msg.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: 'fernhop', version: SHELL_VERSION },
      });
      getCore();
    } else if (method === 'notifications/initialized') {
      initialized = true;
    } else if (method === 'ping') {
      respond(id, {});
    } else if (method === 'tools/list') {
      const c = await getCore();
      let tools = c?.TOOLS;
      if (!tools) { try { tools = JSON.parse(readFileSync(TOOLS_CACHE, 'utf8')); } catch { tools = []; } }
      respond(id, { tools });
    } else if (method === 'tools/call') {
      const c = await getCore();
      if (!c) throw new Error('core.mjs failed to load: ' + (coreError?.message || 'unknown error') + ' (fix core.mjs; the next call reloads it automatically)');
      const text = await c.callTool(ctx, msg.params?.name, msg.params?.arguments || {});
      respond(id, { content: [{ type: 'text', text: String(text) }], isError: false });
    } else if (method === 'resources/list') {
      respond(id, { resources: [] });
    } else if (method === 'resources/templates/list') {
      respond(id, { resourceTemplates: [] });
    } else if (method === 'prompts/list') {
      respond(id, { prompts: [] });
    } else if (typeof method === 'string' && method.startsWith('notifications/')) {
      // ignore other notifications
    } else if (hasId) {
      respondError(id, -32601, 'Method not found: ' + method);
    }
  } catch (e) {
    log('error handling', method, msg.params?.name || '', ':', e?.message || e);
    if (hasId) respond(id, { content: [{ type: 'text', text: 'ERROR: ' + (e?.message || String(e)) }], isError: true });
  }
}

process.stdout.on('error', () => process.exit(0)); // the client closed the pipe
process.on('uncaughtException', (e) => log('uncaughtException:', e));
process.on('unhandledRejection', (e) => log('unhandledRejection:', e));

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try { msg = JSON.parse(t); } catch { log('unparseable input:', t.slice(0, 200)); return; }
  handle(msg);
});
// Exit when the client closes us. The opencode serve is a separate process and keeps running
// for the other bridge instances.
rl.on('close', () => { log('stdin closed, exiting'); setTimeout(() => process.exit(0), 100); });

log(`shell v${SHELL_VERSION} starting (node ${process.version}, ${HERE})`);
getCore();
