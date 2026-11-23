// Starts the local server on a free port with fake keys and checks that it behaves and stays safe.
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ti-')), 'vars');
fs.writeFileSync(envFile, 'GEMINI_API_KEY=fake-gemini-key-123\nGROQ_API_KEY="fake-groq-key-456"\n# comment\nAPP_TOKEN=ignored-in-local-mode\n');

const envFile2 = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ti-')), 'vars');
fs.writeFileSync(envFile2, 'GEMINI_API_KEY=fake-gemini-key-123\n');

function start(extraArgs = [], file = envFile) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.mjs', ...extraArgs], { cwd: ROOT, env: { ...process.env, PORT: '0', ENV_FILE: file, GEMINI_API_KEY: '', GROQ_API_KEY: '', OPENROUTER_API_KEY: '', APP_TOKEN: '' } });
    let out = '';
    const timer = setTimeout(() => reject(new Error('server did not start: ' + out)), 8000);
    child.stdout.on('data', (d) => {
      out += d;
      const m = /LISTENING http:\/\/localhost:(\d+)/.exec(out);
      if (m && /Press Ctrl\+C/.test(out)) {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), out: () => out });
      }
    });
    child.stderr.on('data', (d) => (out += d));
    child.on('exit', (c) => reject(new Error('server exited ' + c + ': ' + out)));
  });
}

function req(port, p, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { host: `127.0.0.1:${port}`, ...headers } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

let failed = 0;
const t = async (name, fn) => {
  try {
    await fn();
    console.log('  ok   ' + name);
  } catch (e) {
    failed++;
    console.log('  FAIL ' + name + '\n       ' + String(e.message || e).split('\n').slice(0, 4).join('\n       '));
  }
};

const s = await start();
await t('serves the app page and scripts', async () => {
  const a = await req(s.port, '/');
  assert.equal(a.status, 200);
  assert.match(a.text, /Tube Inspector/);
  assert.match(a.headers['content-type'], /text\/html/);
  const j = await req(s.port, '/js/app.js');
  assert.equal(j.status, 200);
  assert.match(j.headers['content-type'], /javascript/);
  assert.equal((await req(s.port, '/manifest.webmanifest')).status, 200);
  assert.equal((await req(s.port, '/icons/apple-touch-icon.png')).status, 200);
});

await t('never serves keys, server code, tests or the worker', async () => {
  for (const p of ['/.dev.vars', '/.dev.vars.example', '/.env', '/server.mjs', '/package.json', '/worker/core.js', '/tests/run.mjs', '/README.md', '/%2e%2e/%2e%2e/etc/passwd', '/js/../.dev.vars', '/js/..%2f.dev.vars', '/css%5c..%5c.dev.vars']) {
    const r = await req(s.port, p);
    assert.ok([403, 404].includes(r.status), `${p} -> ${r.status}`);
    assert.ok(!/fake-gemini-key/.test(r.text));
  }
});

await t('health and info work, keys are never returned, token ignored locally', async () => {
  const h = JSON.parse((await req(s.port, '/api/health')).text);
  assert.equal(h.name, 'tube-inspector-backend');
  const i = await req(s.port, '/api/info');
  assert.equal(i.status, 200, 'local mode must not demand a token');
  const info = JSON.parse(i.text);
  assert.deepEqual(info.providers.map((p) => p.id), ['gemini', 'groq']);
  assert.equal(info.video, true);
  assert.equal(info.tokenRequired, false);
  assert.ok(!/fake-(gemini|groq)-key/.test(i.text));
  assert.match(s.out(), /Gemini, Groq/);
});

await t('rejects a foreign Host header (DNS rebinding)', async () => {
  const r = await req(s.port, '/api/info', { headers: { host: 'evil.example.com' } });
  assert.equal(r.status, 403);
});

await t('CORS: only local origins are allowed', async () => {
  const bad = await req(s.port, '/api/llm', { method: 'OPTIONS', headers: { origin: 'https://evil.example.com' } });
  assert.notEqual(bad.headers['access-control-allow-origin'], 'https://evil.example.com');
  assert.notEqual(bad.headers['access-control-allow-origin'], '*');
  const good = await req(s.port, '/api/llm', { method: 'OPTIONS', headers: { origin: `http://localhost:${s.port}` } });
  assert.equal(good.headers['access-control-allow-origin'], `http://localhost:${s.port}`);
});

await t('oversized and malformed API bodies are refused', async () => {
  const big = await req(s.port, '/api/llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: 'x'.repeat(4_500_000) }) }).catch((e) => ({ status: 'closed', text: String(e) }));
  assert.ok(['closed', 413].includes(big.status), 'status ' + big.status);
  const bad = await req(s.port, '/api/llm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not json' });
  assert.equal(bad.status, 400);
  assert.equal((await req(s.port, '/api/video?id=bad')).status, 400);
  assert.equal((await req(s.port, '/api/nope')).status, 404);
  assert.equal((await req(s.port, '/', { method: 'POST' })).status, 405);
});
s.child.kill();

const lan = await start(['--lan'], envFile2);
await t('phone mode generates and enforces an access token', async () => {
  assert.match(lan.out(), /Access token: [0-9a-f]{18}/);
  const token = /Access token: ([0-9a-f]+)/.exec(lan.out())[1];
  assert.equal((await req(lan.port, '/api/info')).status, 401);
  assert.equal((await req(lan.port, '/api/info', { headers: { authorization: 'Bearer ' + token } })).status, 200);
  assert.equal((await req(lan.port, '/api/health')).status, 200);
});
lan.child.kill();

const lan2 = await start(['--lan'], envFile);
await t('phone mode honours a token you set yourself', async () => {
  assert.match(lan2.out(), /Access token: ignored-in-local-mode/);
  assert.equal((await req(lan2.port, '/api/info', { headers: { authorization: 'Bearer ignored-in-local-mode' } })).status, 200);
});
lan2.child.kill();

console.log(failed ? `\n${failed} failed` : '\nall server checks passed');
process.exit(failed ? 1 : 0);
