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
      request: { model },
      cost,
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
    }, { collections: ['jobs'] });

    const summary = await store.readAdminSummary();
    assert.ok(Math.abs(summary.generationSpeed1h.v45.seconds - 10) < 0.1);
    assert.ok(Math.abs(summary.generationSpeed1h.v5.seconds - 20) < 0.1);
    assert.equal(summary.generationSpeed1h.v45.count, 1);
    assert.equal(summary.generationSpeed1h.v5.count, 1);
    assert.equal(summary.usageHourlyDays.at(-1).credits, 6);
  } finally {
    store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.match(path.basename(dir), /^nai2api-admin-stats-/);
    await rm(dir, { recursive: true, force: true });
  }
});
