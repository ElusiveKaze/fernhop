#!/usr/bin/env node
// Builds dist/fernhop-<version>.mcpb, the one-click installer for Claude Desktop.
// An .mcpb file is a zip with manifest.json at its root (https://github.com/anthropics/mcpb).
//
//   node scripts/build-mcpb.mjs [outDir]
//
// Zero dependencies. The official tool gives the same result:
//   npx @anthropic-ai/mcpb validate manifest.json && npx @anthropic-ai/mcpb pack . dist/x.mcpb
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = [
  'manifest.json', 'bridge.mjs', 'core.mjs', 'package.json',
  'README.md', 'README.zh-CN.md', 'CHANGELOG.md', 'LICENSE', 'examples/config.json',
];
const OPTIONAL = ['icon.png'];

const fail = (msg) => { console.error('build-mcpb: ' + msg); process.exit(1); };
const readJson = (f) => { try { return JSON.parse(readFileSync(join(ROOT, f), 'utf8')); } catch (e) { return fail(`${f}: ${e.message}`); } };

// ---------- checks ----------
const manifest = readJson('manifest.json');
const pkg = readJson('package.json');
if (manifest.version !== pkg.version) fail(`version mismatch: manifest.json ${manifest.version}, package.json ${pkg.version}`);
for (const k of ['manifest_version', 'name', 'version', 'description', 'author', 'server']) if (!manifest[k]) fail(`manifest.json: missing ${k}`);
if (!existsSync(join(ROOT, manifest.server.entry_point))) fail(`entry point not found: ${manifest.server.entry_point}`);
const core = await import(pathToFileURL(join(ROOT, 'core.mjs')).href);
const real = core.TOOLS.map((t) => t.name).sort().join(',');
const listed = (manifest.tools || []).map((t) => t.name).sort().join(',');
if (real !== listed) fail(`manifest.json tools (${listed}) differ from core.mjs (${real})`);

// ---------- zip ----------
const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc32 = zlib.crc32 || ((buf) => { let c = -1; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; });

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function zip(entries) {
  const { time, date } = dosTime(new Date());
  const locals = [], centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data) >>> 0;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8); local.writeUInt16LE(time, 10); local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE((3 << 8) | 20, 4); central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8); central.writeUInt16LE(8, 10); central.writeUInt16LE(time, 12); central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16); central.writeUInt32LE(comp.length, 20); central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28); // extra, comment, disk, internal attrs stay 0
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); central.writeUInt32LE(offset, 42);
    locals.push(local, nameBuf, comp);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

const entries = [];
for (const f of [...FILES, ...OPTIONAL.filter((f) => existsSync(join(ROOT, f)))]) {
  const p = join(ROOT, f);
  if (!existsSync(p)) fail('missing file: ' + f);
  entries.push({ name: f, data: readFileSync(p) });
}
const outDir = resolve(process.argv[2] || join(ROOT, 'dist'));
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `${manifest.name}-${manifest.version}.mcpb`);
const buf = zip(entries);
writeFileSync(out, buf);
console.log(`${out}\n${entries.length} files, ${(buf.length / 1024).toFixed(1)} KB, sha256 ${createHash('sha256').update(buf).digest('hex')}`);
