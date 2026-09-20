import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { JsonStore } from '../server/store.js';

test('admin stats include daily credits and one-hour V4.5/V5 total duration', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nai2api-admin-stats-'));
  const store = new JsonStore(dir);
  try {
    await store.init();
    const completedAt = Date.now();
    const job = (id, model, seconds, cost, status = 'done') => ({
      id,
      status,
      accountId: 'acct-1',
      request: { model },
      cost,
      error: status === 'failed' ? 'generation failed' : '',
      createdAt: new Date(completedAt - seconds * 1000).toISOString(),
      updatedAt: new Date(completedAt).toISOString(),
      completedAt: new Date(completedAt).toISOString()
    });
    await store.update((db) => {
      db.jobs.unshift(
        job('v45', 'nai-diffusion-4-5-full', 10, 1),
        job('v5', 'nai-diffusion-5-full', 20, 5),
        job('failed', 'nai-diffusion-5-full', 30, 25, 'failed')
      );
      db.users.unshift(...Array.from({ length: 350 }, (_, index) => ({
        id: `user-${index}`,
        token: `STA1N-${index}`,
        balance: index,
        enabled: true,
        note: index === 349 ? 'needle' : '',
        createdAt: new Date(completedAt).toISOString(),
        updatedAt: new Date(completedAt).toISOString()
      })));
    }, { collections: ['jobs', 'users'] });

    const summary = await store.readAdminSummary();
    assert.ok(Math.abs(summary.generationSpeed1h.v45.seconds - 10) < 0.1);
    assert.ok(Math.abs(summary.generationSpeed1h.v5.seconds - 20) < 0.1);
    assert.equal(summary.generationSpeed1h.v45.count, 1);
    assert.equal(summary.generationSpeed1h.v5.count, 1);
    assert.equal(summary.usageHourlyDays.at(-1).credits, 6);
    assert.equal(summary.userCount, 350);
    assert.equal(summary.users, undefined);

    const costs = store.sqlite.prepare('SELECT id, cost FROM jobs ORDER BY id').all();
    assert.deepEqual(costs, [
      { id: 'failed', cost: 25 },
      { id: 'v45', cost: 1 },
      { id: 'v5', cost: 5 }
    ]);
    const page = await store.readUserPage({ limit: 300 });
    assert.equal(page.users.length, 300);
    assert.equal(page.total, 350);
    const search = await store.readUserPage({ q: 'needle', limit: 300 });
    assert.equal(search.matched, 1);
    assert.equal(search.users[0].id, 'user-349');

    const plan = store.sqlite.prepare(`
      EXPLAIN QUERY PLAN
      SELECT updated_at, status, cost
      FROM jobs INDEXED BY idx_jobs_updated_stats
      WHERE updated_at >= ? AND status IN ('done', 'failed')
    `).all(new Date(completedAt - 60_000).toISOString());
    assert.match(plan.map((row) => row.detail).join('\n'), /idx_jobs_updated_stats.*updated_at>/i);
    const indexes = store.sqlite.prepare(`PRAGMA index_list('jobs')`).all().map((row) => row.name);
    assert.ok(indexes.includes('idx_jobs_created_stats'));
    assert.ok(indexes.includes('idx_jobs_updated_stats'));
    assert.ok(!indexes.includes('idx_jobs_status_created'));
  } finally {
    await store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.match(path.basename(dir), /^nai2api-admin-stats-/);
    await rm(dir, { recursive: true, force: true });
  }
});

test('one-minute generation count uses completion time and excludes unfinished, failed and cached jobs', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nai2api-admin-stats-'));
  const store = new JsonStore(dir);
  try {
    await store.init();
    const now = Date.now();
    const job = (id, age, status = 'done', cost = 8, source = 'web') => ({
      id, source, status, cost,
      request: { model: cost === 1 ? 'nai-diffusion-4-5-full' : 'nai-diffusion-5-full' },
      createdAt: new Date(now - 5 * 60_000).toISOString(),
      updatedAt: new Date(now - age).toISOString(),
      completedAt: status === 'done' ? new Date(now - age).toISOString() : ''
    });
    await store.update((db) => {
      db.jobs.push(
        job('web', 10_000),
        job('direct', 20_000, 'done', 1, 'direct'),
        job('openai', 30_000, 'done', 15, 'openai'),
        job('boundary', 60_000),
        job('old', 60_001),
        job('failed', 1000, 'failed'),
        job('queued', 1000, 'queued'),
        job('running', 1000, 'running'),
        job('cached', 1000, 'done', 0, 'direct'),
        job('paid-cache', 1000, 'done', 0.1, 'direct'),
        job('future', -1000)
      );
    }, { collections: ['jobs'] });
    const stats = await store.statsReader.request('adminStats', { now, days: 7 }, 3000);
    assert.equal(stats.generationStats1m.total, 4);
    assert.equal(stats.requestStats1m.total, 0, 'the original request statistic keeps its meaning');

    const worker = readFileSync(new URL('../server/sqlite-read-worker.js', import.meta.url), 'utf8');
    const query = worker.match(/const generationRow = sqlite\.prepare\(`([\s\S]*?)`\)/)?.[1];
    assert.ok(query);
    const plan = store.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all({
      since: new Date(now - 60_000).toISOString(), now: new Date(now).toISOString()
    });
    assert.match(plan.map((row) => row.detail).join('\n'), /SEARCH jobs USING COVERING INDEX idx_jobs_updated_stats/i);
    assert.doesNotMatch(query, /json_|\bJOIN\b/i);
  } finally {
    await store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.match(path.basename(dir), /^nai2api-admin-stats-/);
    await rm(dir, { recursive: true, force: true });
  }
});

test('admin card displays generated images instead of submitted requests', () => {
  const html = readFileSync(new URL('../public/admin.html', import.meta.url), 'utf8');
  const frontend = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
  const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  assert.match(html, /最近 1 分钟出图[\s\S]*?id="metricGenerated1m"[\s\S]*?<small>张<\/small>/);
  assert.doesNotMatch(html, /每分钟请求|<small>RPM<\/small>/);
  assert.match(server, /generationStats1m: db\.generationStats1m/);
  const display = frontend.match(/el\.metricGenerated1m\.textContent = [^;]+;/)?.[0];
  assert.ok(display);
  const el = { metricGenerated1m: {} };
  for (const total of [0, 7, 100]) {
    vm.runInNewContext(display, { el, summary: { generationStats1m: { total }, requestStats1m: { total: 999 } }, formatNumber: String });
    assert.equal(el.metricGenerated1m.textContent, String(total));
  }
  vm.runInNewContext(display, { el, summary: {}, formatNumber: String });
  assert.equal(el.metricGenerated1m.textContent, '0');
});

test('daily and hourly counts exclude cached deliveries without losing failed requests or actual credits', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nai2api-admin-stats-'));
  const store = new JsonStore(dir);
  try {
    await store.init();
    const now = Date.now();
    const at = new Date(now).toISOString();
    const jobs = [
      ['v45', 'done', 1], ['v5', 'done', 8],
      ['cached', 'done', 0], ['paid-cache', 'done', 0.1],
      ['failed', 'failed', 8], ['failed-without-charge', 'failed', 0],
      ['queued', 'queued', 8], ['running', 'running', 1]
    ].map(([id, status, cost]) => ({ id, status, cost, createdAt: at, updatedAt: at }));
    await store.write({ settings: store.db.settings, users: [], accounts: [], jobs, images: [], cards: [], ledger: [] });
    const stats = await store.statsReader.request('adminStats', { now, days: 7 }, 3000);
    assert.equal(stats.generationStats1m.total, 2);
    assert.equal(stats.requestStats1m.total, 8);
    const day = stats.usageHourlyDays.at(-1);
    assert.equal(day.total, 4);
    assert.equal(day.done, 2);
    assert.equal(day.failed, 2);
    assert.equal(day.successRate, 0.5);
    assert.ok(Math.abs(day.credits - 9.1) < 0.0001);
    const hour = day.hours[new Date(now + 8 * 60 * 60_000).getUTCHours()];
    for (const field of ['total', 'done', 'failed', 'successRate', 'credits']) assert.equal(hour[field], day[field]);

    const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
    const fallback = server.slice(server.indexOf('function hourlyUsageStatsByDay('), server.indexOf('function errorLogs('));
    const calculate = vm.runInNewContext(`${fallback}; hourlyUsageStatsByDay`, {
      usageChartDays: 7,
      recentBeijingDateKeys: () => stats.usageHourlyDays.map((value) => value.date),
      beijingDateKey: (time) => new Date(time + 8 * 60 * 60_000).toISOString().slice(0, 10),
      beijingHour: (time) => new Date(time + 8 * 60 * 60_000).getUTCHours()
    });
    assert.deepEqual(JSON.parse(JSON.stringify(calculate(jobs))), stats.usageHourlyDays);
    assert.equal(store.countRecords('jobs'), jobs.length, 'statistics must not delete cache-hit records');
  } finally {
    await store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.match(path.basename(dir), /^nai2api-admin-stats-/);
    await rm(dir, { recursive: true, force: true });
  }
});
