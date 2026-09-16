// Isolated HTTP benchmark: no production data, credentials or upstream requests.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, cp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore } from '../server/store.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = path.join(root, 'comparison-results');
await mkdir(outputDir, { recursive: true });
const fixtureRoot = await mkdtemp(path.join(outputDir, 'perf-run-'));
const baseline = path.join(fixtureRoot, 'old-source');
const historyCount = Number(process.env.BENCH_HISTORY || 200_000);
const queuedCount = 350;
const durationMs = Number(process.env.BENCH_DURATION_MS || 5000);
const token = 'isolated-benchmark-token';
const admin = 'isolated-benchmark-admin';
const report = { historyCount, queuedCount, durationMs, baseline: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), versions: [] };
let child;
let worktreeAdded = false;

function summarize(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rounded = (value) => Number(value.toFixed(1));
  return {
    count: sorted.length,
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)]),
    p95Ms: rounded(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))]),
    maxMs: rounded(sorted.at(-1))
  };
}

async function freePort() {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const { port } = socket.address();
  await new Promise((resolve) => socket.close(resolve));
  return port;
}

async function stopChild() {
  if (!child || child.exitCode !== null) return;
  const closed = once(child, 'exit');
  child.kill();
  await closed;
  child = null;
}

try {
  console.log(`Seeding ${historyCount} historical jobs and ${queuedCount} queued jobs.`);
  const seedDir = path.join(fixtureRoot, 'seed');
  const seed = new JsonStore(seedDir);
  await seed.init();
  const now = Date.now();
  const timestamp = new Date(now).toISOString();
  await seed.update((db) => {
    db.users = Array.from({ length: 6328 }, (_, index) => ({ id: `user-${index}`, token: index ? `test-${index}` : token, balance: 1_000_000, enabled: true, createdAt: timestamp }));
    db.accounts = [{ id: 'busy-test-account', token: 'not-a-real-key', enabled: true, inFlight: 1, lastUsedAt: timestamp, cooldownUntil: new Date(now + 3_600_000).toISOString() }];
    db.settings.mockWhenNoAccount = false;
  });
  const insert = seed.sqlite.prepare(`INSERT INTO jobs
    (id, order_value, data, user_token, status, source, created_at, updated_at, model, cost)
    VALUES (@id, @order, @data, @token, @status, 'web', @createdAt, @updatedAt, @model, 1)`);
  const request = { model: 'nai-diffusion-4-5-full', steps: 28, tag: 'test', prompt: 'synthetic benchmark prompt '.repeat(40) };
  seed.sqlite.transaction(() => {
    for (let index = 0; index < historyCount + queuedCount; index++) {
      const queued = index >= historyCount;
      const id = queued ? `queued-${index - historyCount}` : `history-${index}`;
      const createdAt = new Date(queued ? now : now - 10_000 - (index % (6 * 86400)) * 1000).toISOString();
      const updatedAt = queued ? createdAt : new Date(Date.parse(createdAt) + 8000).toISOString();
      const job = { id, status: queued ? 'queued' : 'done', source: 'web', userToken: token, request, cost: 1, queueTotal: index - historyCount + 1, createdAt, updatedAt };
      insert.run({ ...job, token, model: request.model, order: index + 1, data: JSON.stringify(job) });
    }
  })();
  await seed.close();
  execFileSync('git', ['worktree', 'add', '--detach', baseline, 'HEAD'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  worktreeAdded = true;
  for (const [version, sourceDir] of [['old', baseline], ['new', root]]) {
    const dataDir = path.join(fixtureRoot, `${version}-data`);
    await cp(seedDir, dataDir, { recursive: true });
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const logs = [];
    const started = performance.now();
    child = spawn(process.execPath, ['server/index.js'], {
      cwd: sourceDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, ADMIN_TOKEN: admin,
        NOVELAI_API_URL: 'http://127.0.0.1:9', NOVELAI_ACCOUNT_API_URL: 'http://127.0.0.1:9' }
    });
    let ready = false;
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => {
      const text = chunk.toString();
      logs.push(text);
      if (text.includes('Nai2API listening')) ready = true;
    });
    while (!ready && performance.now() - started < 60_000 && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(ready, logs.join(''));
    const result = { version, startupMs: Math.round(performance.now() - started), cases: [] };
    console.log(`${version}: ready in ${result.startupMs} ms`);
    for (const concurrency of [30, 100, 300]) {
      const polling = [], adminTimes = [], pageTimes = [];
      let errors = 0, writes = 0;
      const runStarted = performance.now();
      const deadline = runStarted + durationMs;
      const requestTimed = async (url, options, times) => {
        const start = performance.now();
        try {
          const response = await fetch(`${origin}${url}`, { ...options, signal: AbortSignal.timeout(15_000) });
          const body = await response.text();
          assert.equal(response.status, options?.method === 'POST' ? 202 : 200, body.slice(0, 100));
          times?.push(performance.now() - start);
          return body;
        } catch { errors++; }
      };
      await Promise.all([
        ...Array.from({ length: concurrency }, (_, index) => (async () => {
          while (performance.now() < deadline) {
            const body = await requestTimed(`/api/jobs/queued-${index % queuedCount}?token=${token}`, {}, polling);
            if (body) assert.equal(JSON.parse(body).status, 'queued');
          }
        })()),
        (async () => {
          while (performance.now() < deadline) {
            await requestTimed('/api/admin/summary', { headers: { 'x-admin-token': admin } }, adminTimes);
            await requestTimed('/admin', {}, pageTimes);
            await new Promise((resolve) => setTimeout(resolve, 300));
          }
        })(),
        (async () => {
          while (performance.now() < deadline) {
            await requestTimed('/api/jobs', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token, tag: 'isolated-test', nocache: '1', model: request.model }) });
            writes++;
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
        })()
      ]);
      const elapsed = performance.now() - runStarted;
      const sample = { concurrency, elapsedMs: Math.round(elapsed), requestsPerSecond: Number((polling.length * 1000 / elapsed).toFixed(1)), polling: summarize(polling), admin: summarize(adminTimes), page: summarize(pageTimes), writes, errors };
      result.cases.push(sample);
      console.log(JSON.stringify({ version, ...sample }));
    }
    result.slowLogs = logs.join('').split('\n').filter((line) => /admin summary|runtime cache in|persist slow/.test(line)).slice(-15);
    report.versions.push(result);
    await stopChild();
  }
  const reportPath = path.join(outputDir, `performance-${Date.now()}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report: ${reportPath}`);
} finally {
  await stopChild();
  if (worktreeAdded) execFileSync('git', ['worktree', 'remove', baseline], { cwd: root, windowsHide: true, stdio: 'pipe' });
  assert.equal(path.dirname(fixtureRoot), outputDir);
  assert.match(path.basename(fixtureRoot), /^perf-run-/);
  await rm(fixtureRoot, { recursive: true });
}
