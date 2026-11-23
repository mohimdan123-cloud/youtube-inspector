#!/usr/bin/env node
/**
 * Tube Inspector local server: serves the app AND the backend from your own computer.
 * No Cloudflare, no GitHub. Needs Node.js 18 or newer.
 *
 *   node server.mjs            app at http://localhost:8787 (only this computer can reach it)
 *   node server.mjs --open     ...and open it in your browser
 *   node server.mjs --lan      also reachable from your phone on the same Wi-Fi (uses an access token)
 *   node server.mjs --port=9000
 *
 * Keys are read from a file named .dev.vars next to this file (see .dev.vars.example).
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { handleRequest } from './worker/core.js';

if (Number(process.versions.node.split('.')[0]) < 18) {
  console.error('Node.js 18 or newer is needed. Install the LTS version from https://nodejs.org and try again.');
  process.exit(1);
}

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const LAN = args.includes('--lan');
const OPEN = args.includes('--open');
const portArg = args.find((a) => a.startsWith('--port='));
const PORT = Number(process.env.PORT ?? (portArg ? portArg.split('=')[1] : 8787));
const HOST = LAN ? '0.0.0.0' : '127.0.0.1';
const MAX_BODY = 4_000_000;

/* ---------------- settings and keys ---------------- */

function loadEnvFile(file) {
  const out = {};
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return out;
  }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*#/.test(line)) continue;
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    out[m[1]] = v;
  }
  return out;
}

const fileEnv = { ...loadEnvFile(path.join(ROOT, '.env')), ...loadEnvFile(process.env.ENV_FILE || path.join(ROOT, '.dev.vars')) };
const NAMES = [
  'APP_TOKEN', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'PROVIDER_ORDER',
  'GEMINI_FAST_MODELS', 'GEMINI_SMART_MODELS', 'GEMINI_VIDEO_MODELS', 'GROQ_FAST_MODELS', 'GROQ_SMART_MODELS', 'OPENROUTER_MODELS',
];
const env = {};
for (const k of NAMES) {
  const v = process.env[k] || fileEnv[k];
  if (v) env[k] = String(v).trim();
}

let generatedToken = false;
if (LAN) {
  // Anyone on your Wi-Fi could otherwise spend your free quota, so a token is mandatory.
  if (!env.APP_TOKEN) {
    env.APP_TOKEN = crypto.randomBytes(9).toString('hex');
    generatedToken = true;
  }
} else {
  delete env.APP_TOKEN; // only this computer can reach the server, so no token is needed
}

/* ---------------- static files (whitelist) ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};
const FILES = new Set(['index.html', 'manifest.webmanifest', 'sw.js']);
const DIRS = ['css/', 'js/', 'icons/'];

function resolveStatic(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (rel === '') rel = 'index.html';
  if (rel.includes('..') || rel.includes('\\') || rel.includes('\0')) return null;
  if (!(FILES.has(rel) || DIRS.some((d) => rel.startsWith(d)))) return null; // keys, server code and tests are never served
  const abs = path.join(ROOT, rel);
  return abs.startsWith(ROOT + path.sep) ? abs : null;
}

const SECURITY = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-cache' };

function send(res, status, body, headers = {}) {
  res.writeHead(status, { ...SECURITY, ...headers });
  res.end(body);
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* ---------------- request handling ---------------- */

let allowedHosts = null; // set once we know the port (DNS-rebinding protection)

async function handle(req, res) {
  const started = Date.now();
  const host = String(req.headers.host || '').toLowerCase();
  if (!LAN && allowedHosts && !allowedHosts.has(host)) return send(res, 403, 'Forbidden host');

  const url = new URL(req.url, `http://${host || 'localhost'}`);

  if (url.pathname.startsWith('/api/')) {
    let body;
    try {
      if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) body = await readBody(req, MAX_BODY);
    } catch (e) {
      return send(res, e.status || 400, JSON.stringify({ error: 'too_large', detail: 'Request body is too big.' }), { 'content-type': 'application/json' });
    }
    const headers = new Headers();
    for (const k of ['authorization', 'content-type', 'origin']) if (req.headers[k]) headers.set(k, String(req.headers[k]));
    const request = new Request(url, { method: req.method, headers, body: body && body.length ? body : undefined });
    const response = await handleRequest(request, env);
    const buf = Buffer.from(await response.arrayBuffer());
    res.writeHead(response.status, { ...Object.fromEntries(response.headers.entries()), ...SECURITY });
    res.end(buf);
    logApi(req, url, response.status, buf, Date.now() - started);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed');
  const file = resolveStatic(url.pathname);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found');
  const data = fs.readFileSync(file);
  send(res, 200, req.method === 'HEAD' ? undefined : data, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
}

function logApi(req, url, status, buf, ms) {
  if (url.pathname === '/api/health') return;
  let extra = '';
  try {
    if (url.pathname === '/api/llm') {
      const d = JSON.parse(buf.toString('utf8'));
      extra = status === 200 ? `${d.provider}/${d.model}` : d.error || '';
    } else if (url.pathname === '/api/video') {
      const d = JSON.parse(buf.toString('utf8'));
      extra = `captions: ${d.captionStatus}${d.meta ? '' : ' (no metadata)'}`;
    }
  } catch {
    /* ignore */
  }
  const t = new Date().toLocaleTimeString();
  console.log(`${t}  ${req.method} ${url.pathname}${url.pathname === '/api/video' ? '?id=' + url.searchParams.get('id') : ''}  ${status}  ${ms}ms  ${extra}`);
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    console.error('Server error:', e && e.message);
    if (!res.headersSent) send(res, 500, JSON.stringify({ error: 'server_error' }), { 'content-type': 'application/json' });
    else res.end();
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Close the other copy, or run: node server.mjs --port=${PORT + 1}`);
  else console.error('Could not start:', e.message);
  process.exit(1);
});

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) for (const i of list || []) if (i.family === 'IPv4' && !i.internal) out.push(i.address);
  return out;
}

server.listen(PORT, HOST, () => {
  const port = server.address().port;
  const local = `http://localhost:${port}`;
  allowedHosts = new Set([`localhost:${port}`, `127.0.0.1:${port}`]);
  const origins = [local, `http://127.0.0.1:${port}`];
  const lan = LAN ? lanAddresses().map((ip) => `http://${ip}:${port}`) : [];
  env.ALLOWED_ORIGIN = [...origins, ...lan].join(',');

  const providers = [['Gemini', env.GEMINI_API_KEY], ['Groq', env.GROQ_API_KEY], ['OpenRouter', env.OPENROUTER_API_KEY]].filter((p) => p[1]).map((p) => p[0]);
  console.log('');
  console.log('  Tube Inspector is running.');
  console.log(`  LISTENING ${local}`);
  console.log('');
  console.log(`  AI providers ready: ${providers.length ? providers.join(', ') : 'NONE'}`);
  if (!providers.length) console.log('  Add your keys to the file named .dev.vars (see .dev.vars.example), then restart.');
  if (LAN) {
    console.log('');
    console.log('  On your phone (same Wi-Fi), open one of:');
    for (const u of lan) console.log('    ' + u);
    console.log(`  Backend address: the same address.   Access token: ${env.APP_TOKEN}${generatedToken ? '   (new each run; set APP_TOKEN in .dev.vars to keep one)' : ''}`);
  }
  console.log('');
  console.log('  Press Ctrl+C to stop.');
  console.log('');
  if (OPEN) {
    const cmd = process.platform === 'win32' ? `start "" "${local}"` : process.platform === 'darwin' ? `open "${local}"` : `xdg-open "${local}"`;
    exec(cmd, () => {});
  }
});
