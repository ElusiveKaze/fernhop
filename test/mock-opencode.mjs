#!/usr/bin/env node
// A tiny stand-in for `opencode serve` (v2 HTTP API) used by `npm test`.
// It implements only what the bridge calls. Not a real agent.
//
//   node mock-opencode.mjs --version
//   node mock-opencode.mjs serve --hostname=127.0.0.1 --port=4250
//
// Env:
//   OPENCODE_SERVER_PASSWORD   basic-auth password (user "opencode"); if unset, a random one is printed
//   MOCK_IGNORE_ENV_PASSWORD=1 ignore OPENCODE_SERVER_PASSWORD and print a random password instead
//   MOCK_VERSION_FILE          file holding the version string (lets tests simulate an upgrade)
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';

const version = () => { try { return readFileSync(process.env.MOCK_VERSION_FILE, 'utf8').trim(); } catch { return '2.1.3'; } };
const argv = process.argv.slice(2);
if (argv.includes('--version')) { console.log(version()); process.exit(0); }
if (argv[0] !== 'serve') { console.error('usage: mock-opencode serve --port=N'); process.exit(2); }

const SERVE_VERSION = version();
const port = Number((argv.find((a) => a.startsWith('--port=')) || '--port=4096').split('=')[1]);
let pw = process.env.MOCK_IGNORE_ENV_PASSWORD ? null : process.env.OPENCODE_SERVER_PASSWORD;
if (!pw) { pw = randomBytes(8).toString('hex'); console.log('server password ' + pw); }
const auth = 'Basic ' + Buffer.from('opencode:' + pw).toString('base64');

const MODELS = [
  { providerID: 'acme', id: 'model-pro-0612', name: 'Acme Pro 0612' },
  { providerID: 'acme', id: 'model-pro-0918', name: 'Acme Pro 0918' },
  { providerID: 'acme', id: 'model-fast-0420', name: 'Acme Fast 0420' },
  { providerID: 'example', id: 'tiny', name: 'Example Tiny v1.5' },
  { providerID: 'opencode', id: 'free-model', name: 'Free Model' },
];
const sessions = new Map();
let n = 0;
const now = () => Date.now() + (n++) * 0.001;
const json = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== auth) return json(res, 401, { _tag: 'UnauthorizedError', message: 'Authentication required' });
  const u = new URL(req.url, 'http://x');
  let body = '';
  for await (const c of req) body += c;
  const b = body ? JSON.parse(body) : {};
  const m = u.pathname.match(/^\/api\/session\/([^/]+)(\/.*)?$/);
  if (u.pathname === '/api/info') return json(res, 200, { version: SERVE_VERSION, pid: process.pid, urls: ['http://127.0.0.1:' + port] });
  if (u.pathname === '/api/model') return json(res, 200, { data: MODELS });
  if (u.pathname === '/api/model/default') return json(res, 200, { data: { providerID: 'acme', id: 'model-pro-0612' } });
  if (u.pathname === '/api/session' && req.method === 'POST') {
    const id = 'ses_' + randomBytes(6).toString('hex');
    const s = { id, title: b.title, model: b.model || { providerID: 'acme', id: 'model-pro-0612' }, location: b.location, msgs: [] };
    sessions.set(id, s);
    return json(res, 200, { data: { id, title: s.title, model: s.model, location: s.location } });
  }
  if (u.pathname === '/api/session' && req.method === 'GET') {
    return json(res, 200, { data: [...sessions.values()].map(({ msgs, ...s }) => ({ ...s, outcome: msgs.at(-1)?.type === 'idle' ? 'succeeded' : undefined })) });
  }
  if (m) {
    const s = sessions.get(m[1]);
    if (!s) return json(res, 404, { _tag: 'NotFound' });
    if (m[2] === '/prompt') {
      s.msgs.push({ id: 'u' + n, type: 'user', time: { created: now() } });
      const slow = /sleep/i.test(b.text);
      const reply = (b.text.match(/echo (\S+?)`/) || [])[1] || (slow ? 'slept-done' : 'ok');
      setTimeout(() => s.msgs.push({ id: 'a' + n, type: 'assistant', model: s.model, content: [{ type: 'tool', name: 'shell', state: { status: 'running' } }], time: { created: now() } }), 200);
      setTimeout(() => {
        s.msgs.push({ id: 'b' + n, type: 'assistant', model: s.model, tokens: { input: 10, output: 2 }, content: [{ type: 'tool', name: 'shell', state: { status: 'completed' } }, { type: 'text', text: slow ? 'slept-done' : reply }], time: { created: now() } });
        s.msgs.push({ id: 'i' + n, type: 'idle', outcome: 'succeeded', time: { created: now() } });
      }, slow ? 25_000 : 800);
      return json(res, 200, { data: {} });
    }
    if (m[2] === '/message') return json(res, 200, { data: s.msgs.slice(-Number(u.searchParams.get('limit') || 200)) });
    if (m[2] === '/diff') return json(res, 200, { data: [] });
    if (m[2] === '/interrupt') return json(res, 200, { interrupted: true });
    if (!m[2]) return json(res, 200, { data: s });
  }
  json(res, 404, { _tag: 'NotFound', path: u.pathname });
});
server.on('error', (e) => { console.error('Failed to start server. Is port ' + port + ' in use?', e.code); process.exit(1); });
server.listen(port, '127.0.0.1', () => console.log('server listening on http://127.0.0.1:' + port));
