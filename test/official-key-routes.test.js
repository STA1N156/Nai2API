import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const key = 'pst-route-test-official-key';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN0cAAAAASUVORK5CYII=', 'base64');
const listen = async server => { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; };

test('PST frontend and URL routes use only the supplied key; billing, pool and persisted credentials stay untouched', { timeout: 30_000 }, async t => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'nai2api-official-routes-'));
  const calls = [];
  const upstream = http.createServer(async (req, res) => {
    const token = String(req.headers.authorization || '').replace('Bearer ', '');
    if (token !== key) { res.writeHead(401); res.end(`invalid token ${token}`); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/user/data') {
      res.end(JSON.stringify({ subscription: { tier: 3, trainingStepsLeft: { fixedTrainingStepsLeft: 17963, purchasedTrainingSteps: 0 }, usage: { percent: 76.5 } } }));
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    calls.push({ token, body: JSON.parse(raw) });
    res.end(JSON.stringify({ image: png.toString('base64') }));
  });
  const upstreamPort = await listen(upstream);
  const portProbe = http.createServer();
  const port = await listen(portProbe);
  await new Promise(resolve => portProbe.close(resolve));
  const child = spawn(process.execPath, ['server/index.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, HOST: '127.0.0.1', PORT: String(port), DATA_DIR: dataDir, ADMIN_TOKEN: 'test-admin',
      NOVELAI_API_URL: `http://127.0.0.1:${upstreamPort}`, NOVELAI_ACCOUNT_API_URL: `http://127.0.0.1:${upstreamPort}`, MOCK_WHEN_NO_ACCOUNT: 'false' },
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  t.after(async () => {
    if (child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    assert.equal(path.dirname(dataDir), tmpdir());
    assert.match(path.basename(dataDir), /^nai2api-official-routes-/);
    await rm(dataDir, { recursive: true, force: true });
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Server startup failed: ${output}`)), 10_000);
    child.stdout.on('data', () => { if (output.includes('listening on')) { clearTimeout(timer); resolve(); } });
    child.once('exit', () => { clearTimeout(timer); reject(new Error(`Server exited: ${output}`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const fetchJson = async (url, options = {}) => {
    const response = await fetch(origin + url, { ...options, signal: AbortSignal.timeout(5000) });
    assert.equal(response.ok, true, `${response.status} ${await response.clone().text()}`);
    return response.json();
  };
  const headers = { 'content-type': 'application/json', 'x-admin-token': 'test-admin' };
  const issued = await fetchJson('/api/admin/users', { method: 'POST', headers, body: JSON.stringify({ count: 1, credits: 25 }) });
  const siteKey = issued.users[0].token;
  const before = await fetchJson('/api/me', { headers: { 'x-user-token': siteKey } });
  const official = await fetchJson('/api/me', { headers: { 'x-user-token': key } });
  assert.deepEqual(official, { authMode: 'official', balance: null, anlas: 17963, v5RemainingPercent: 76.5, membership: 'Opus 会员' });
  const denied = await fetch(origin + '/api/me', { headers: { 'x-user-token': 'pst-invalid' } });
  assert.equal(denied.status, 401);
  assert.doesNotMatch(await denied.text(), /pst-invalid/);

  let job = await fetchJson('/api/web/jobs', { method: 'POST', headers, body: JSON.stringify({ token: key, tag: 'test', artist: '', steps: 48, nocache: '1' }) });
  for (let n = 0; !['done', 'failed'].includes(job.status) && n < 100; n++) {
    job = await fetchJson(`/api/jobs/${job.id}`, { headers: { 'x-user-token': key } });
  }
  assert.equal(job.status, 'done');
  assert.equal(job.cost, 0);
  assert.equal(calls[0].token, key);
  assert.equal(calls[0].body.parameters.steps, 48);
  assert.ok(!JSON.stringify(job).includes(key));
  assert.equal((await fetch(origin + `/api/jobs/${job.id}?token=pst-another-key`)).status, 403);
  assert.deepEqual(Buffer.from(await (await fetch(origin + job.imageUrl)).arrayBuffer()), png);
  assert.equal((await fetch(origin + `/api/jobs/${job.id}/content?token=${key}`)).status, 200);

  const url = `/generate?token=${key}&tag=url-test&artist=&steps=48&nocache=0`;
  const direct = await fetch(origin + url);
  assert.equal(direct.headers.get('x-auth-mode'), 'official');
  assert.equal(direct.headers.get('x-cache'), 'miss');
  assert.equal(calls[1].body.parameters.steps, 28);
  assert.deepEqual(Buffer.from(await direct.arrayBuffer()), png);
  const cached = await fetch(origin + url);
  assert.equal(cached.headers.get('x-cache'), 'hit');
  await cached.arrayBuffer();
  assert.equal(calls.length, 2);
  const otherKey = await fetch(origin + url.replace(key, 'pst-not-the-owner'));
  assert.equal(otherKey.headers.get('x-error'), '1');
  assert.equal(otherKey.headers.get('x-cache'), null);
  await otherKey.arrayBuffer();

  assert.deepEqual(await fetchJson('/api/me', { headers: { 'x-user-token': siteKey } }), before);
  const snapshot = await fetchJson('/api/admin/export', { headers });
  assert.equal(snapshot.data.accounts.length, 0);
  assert.equal(snapshot.data.users.length, 1);
  assert.doesNotMatch(JSON.stringify(snapshot), /pst-route-test-official-key/);
  const db = new Database(path.join(dataDir, 'library.sqlite'), { readonly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM ledger').get().n, 1); // key issuance only
  } finally { db.close(); }
  assert.doesNotMatch(output, /pst-route-test-official-key|pst-not-the-owner/);
  for (const name of await readdir(dataDir)) {
    if (name.endsWith('.sqlite') || name.endsWith('-wal') || name.endsWith('.json')) {
      assert.equal((await readFile(path.join(dataDir, name))).includes(Buffer.from(key)), false, `Raw key leaked to ${name}`);
    }
  }
});
