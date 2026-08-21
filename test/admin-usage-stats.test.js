import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
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
