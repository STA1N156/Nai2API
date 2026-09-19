import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { JsonStore } from '../server/store.js';

async function temporaryStore(t) {
  const dir = await mkdtemp(path.join(tmpdir(), 'nai2api-load-'));
  const store = new JsonStore(dir);
  t.after(async () => {
    await store.close();
    assert.equal(path.dirname(dir), tmpdir());
    assert.match(path.basename(dir), /^nai2api-load-/);
    await rm(dir, { recursive: true, force: true });
  });
  await store.init();
  await store.write({ settings: store.db.settings, users: [], accounts: [], jobs: [], images: [], cards: [], ledger: [] });
  return store;
}

test('startup uses the active index and polling does not query historical jobs', async (t) => {
  const store = await temporaryStore(t);
  const insert = store.sqlite.prepare(`
    INSERT INTO jobs (id, order_value, data, status, created_at, source)
    VALUES (@id, @order, @data, @status, @createdAt, 'web')
  `);
  store.sqlite.transaction(() => {
    for (let index = 1; index <= 20_000; index++) {
      const job = {
        id: `job-${index}`,
        status: index === 1 ? 'running' : index === 20_000 ? 'queued' : 'done',
        createdAt: new Date(Date.now() - 20_000 + index).toISOString()
      };
      insert.run({ ...job, order: index, data: JSON.stringify(job) });
    }
  })();
  const prepare = store.sqlite.prepare.bind(store.sqlite);
  const queries = [];
  store.sqlite.prepare = (sql) => {
    queries.push(sql);
    return prepare(sql);
  };
  const rows = store.runtimeRowsForCollection('jobs');
  assert.equal(rows.length, 3001);
  assert.equal(rows[0].id, 'job-20000');
  assert.equal(rows.at(-1).id, 'job-1');
  assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
  const queued = JSON.parse(rows[0].data);
  store.db = store.loadFromSqlite();
  const queryCount = queries.length;
  assert.deepEqual(store.jobQueueProgress(queued), { progress: 1, total: 2 });
  assert.equal(queries.length, queryCount);
  await store.readQueueStateCounts();
  const activeQueries = queries.filter((sql) => sql.includes("status IN ('queued', 'running')"));
  assert.equal(activeQueries.length, 3);
  for (const sql of activeQueries) {
    const plan = prepare(`EXPLAIN QUERY PLAN ${sql}`).all(
      sql.includes('@id') ? { id: queued.id, createdAt: queued.createdAt } : {}
    );
    assert.match(plan.map((row) => row.detail).join('\n'), /idx_jobs_active_created/);
    assert.ok(!/\bOR\b/i.test(sql));
  }
  assert.equal(store.countRecords('jobs'), 20_000);
});

test('queue progress increases only as earlier work finishes and reaches N/N only when running', async (t) => {
  const store = await temporaryStore(t);
  const createdAt = new Date().toISOString();
  const jobs = ['newest', 'middle', 'oldest'].map((id, index) => ({ id, status: 'queued', createdAt, queueTotal: 3 - index }));
  const newest = jobs[0];
  const oldest = jobs[2];
  await store.update((db) => { db.jobs = jobs; }, { collections: ['jobs'] });
  assert.deepEqual(store.jobQueueProgress(newest), { progress: 1, total: 3 });
  assert.deepEqual(store.jobQueueProgress(oldest), { progress: 1, total: 1 });
  await store.update((db) => { db.jobs[2].status = 'running'; }, { dirtyRows: { jobs: ['oldest'] } });
  assert.equal(store.selectItemById('jobs', 'oldest').status, 'queued');
  assert.deepEqual(store.jobQueueProgress(newest), { progress: 1, total: 3 });
  assert.deepEqual(store.jobQueueProgress(oldest), { progress: 1, total: 1 });
  await store.update(() => { oldest.status = 'queued'; }, { dirtyRows: { jobs: ['oldest'] } });
  assert.deepEqual(store.jobQueueProgress(newest), { progress: 1, total: 3 });
  await store.update(() => { oldest.status = 'done'; }, { dirtyRows: { jobs: ['oldest'] } });
  assert.deepEqual(store.jobQueueProgress(newest), { progress: 2, total: 3 });
  await store.update((db) => {
    db.jobs.unshift({ id: 'later', status: 'queued', createdAt, queueTotal: 3 });
  }, { dirtyRows: { jobs: ['later'] } });
  assert.deepEqual(store.jobQueueProgress(newest), { progress: 2, total: 3 });
  await store.update((db) => { db.jobs.find((job) => job.id === 'middle').status = 'done'; }, { dirtyRows: { jobs: ['middle'] } });
  assert.deepEqual(store.jobQueueProgress(newest), { progress: 2, total: 3 });
  await store.update(() => { newest.status = 'running'; }, { dirtyRows: { jobs: ['newest'] } });
  assert.deepEqual(store.jobQueueProgress(newest), { progress: 3, total: 3 });
});

test('generation writes do not invalidate the 30-second statistics cache', async (t) => {
  const store = await temporaryStore(t);
  let requests = 0;
  store.statsReader.request = async () => ({ requests: ++requests });
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 1 });
  await store.update((db) => {
    db.jobs.unshift({ id: 'charged', status: 'queued', cost: 5 });
  }, { collections: ['jobs'] });
  await store.update((db) => {
    db.jobs[0].status = 'done';
  }, { dirtyRows: { jobs: ['charged'] } });
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 1 });
  store.adminStatsCache.at = 0;
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 1 });
  await store.adminStatsPromise;
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 2 });
  assert.equal(store.sqlite.prepare('SELECT cost FROM jobs WHERE id = ?').get('charged').cost, 5);
});

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

test('fresh requests wait for one shared new read while automatic requests keep using cache', async (t) => {
  const store = await temporaryStore(t);
  store.adminStatsCache = { at: 0, value: { requests: 0 } };
  const started = deferred();
  const result = deferred();
  let requests = 0;
  store.statsReader.request = async () => {
    requests++;
    started.resolve();
    return result.promise;
  };
  const first = store.readAdminSummaryStats({ fresh: true });
  const second = store.readAdminSummaryStats({ fresh: true });
  await started.promise;
  let completed = false;
  first.then(() => { completed = true; });
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 0 });
  assert.equal(completed, false);
  assert.equal(requests, 1);
  result.resolve({ requests: 1 });
  assert.deepEqual(await Promise.all([first, second]), [{ requests: 1 }, { requests: 1 }]);
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 1 });
  assert.equal(store.adminFreshStatsPromise, null);
  assert.equal(requests, 1);
});

test('fresh summary flushes only pending changes and includes them in actual worker statistics', async (t) => {
  const store = await temporaryStore(t);
  const now = new Date().toISOString();
  await store.update((db) => {
    db.users.push({ id: 'user', token: 'test-only', balance: 92 });
    db.accounts.push({ id: 'account', v5Quota: 42 });
    db.ledger.push({ id: 'charge', amount: -8 });
    db.jobs.push({ id: 'new', status: 'running', cost: 8, model: 'nai-diffusion-5-full', createdAt: now, updatedAt: now });
  });
  const before = await store.readAdminSummary();
  assert.equal(before.jobStats1h.done, 0);
  await store.update((db) => { db.jobs[0].status = 'done'; }, { dirtyRows: { jobs: ['new'] } });
  assert.equal(store.selectItemById('jobs', 'new').status, 'running');
  assert.equal((await store.readAdminSummary()).jobStats1h.done, 0);
  const persist = store.persistIncremental.bind(store);
  store.persistIncremental = (db, scope) => {
    assert.ok(scope?.hasDirtyRows, 'fresh reads must not persist the entire database');
    return persist(db, scope);
  };
  const latest = await store.readAdminSummary({ fresh: true });
  assert.equal(latest.jobStats1h.done, 1);
  assert.equal(latest.requestStats1m.total, 1);
  assert.equal(latest.generationSpeed1h.v5.count, 1);
  assert.equal(store.selectItemById('jobs', 'new').status, 'done');
  assert.equal(store.selectItemById('jobs', 'new').cost, 8);
  assert.equal(store.selectItemById('users', 'user').balance, 92);
  assert.equal(store.selectItemById('accounts', 'account').v5Quota, 42);
  assert.equal(store.selectItemById('ledger', 'charge').amount, -8);
  assert.equal(store.pendingPersistScope, null);
});

test('fresh reads wait for older background work and queued writes before starting a new snapshot', async (t) => {
  const store = await temporaryStore(t);
  store.adminStatsCache = { at: 0, value: { requests: 0 } };
  const background = deferred();
  const updateReady = deferred();
  let requests = 0;
  store.statsReader.request = async () => {
    requests++;
    if (requests === 1) return background.promise;
    assert.equal(store.selectItemById('jobs', 'queued-write').cost, 8);
    return { requests };
  };
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 0 });
  const update = store.update(async (db) => {
    await updateReady.promise;
    db.jobs.push({ id: 'queued-write', status: 'done', cost: 8 });
  }, { dirtyRows: { jobs: ['queued-write'] } });
  const fresh = store.readAdminSummaryStats({ fresh: true });
  background.resolve({ requests: 1 });
  await store.adminStatsPromise;
  assert.equal(requests, 1);
  updateReady.resolve();
  await update;
  assert.deepEqual(await fresh, { requests: 2 });
});

test('fresh read failures are reported, automatic reads retain cache, and retries work', async (t) => {
  const store = await temporaryStore(t);
  store.adminStatsCache = { at: 0, value: { requests: 1 } };
  store.statsReader.request = async () => { throw new Error('test statistics unavailable'); };
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 1 });
  await assert.rejects(store.readAdminSummaryStats({ fresh: true }), /test statistics unavailable/);
  assert.equal(store.adminStatsPromise, null);
  assert.equal(store.adminFreshStatsPromise, null);
  assert.deepEqual(store.adminStatsCache.value, { requests: 1 });
  store.statsReader.request = () => { throw new Error('test worker failed to start'); };
  await assert.rejects(store.readAdminSummaryStats({ fresh: true }), /test worker failed to start/);
  assert.equal(store.adminStatsPromise, null);
  assert.equal(store.adminFreshStatsPromise, null);
  store.statsReader.request = async () => ({ requests: 2 });
  assert.deepEqual(await store.readAdminSummaryStats({ fresh: true }), { requests: 2 });
  assert.deepEqual(await store.readAdminSummaryStats(), { requests: 2 });
});

test('log clearing yields between batches and preserves active jobs and concurrent charges', async (t) => {
  const store = await temporaryStore(t);
  await store.update((db) => {
    db.users.push({ id: 'user', token: 'test-only', balance: 95 });
    db.accounts.push({ id: 'account', inFlight: 1, v5Quota: 42 });
    db.ledger.push({ id: 'charge-v5', token: 'test-only', amount: -5 });
    db.jobs.push(
      { id: 'running', status: 'running', cost: 5 },
      { id: 'queued', status: 'queued', cost: 1 },
      ...Array.from({ length: 600 }, (_, index) => ({ id: `old-${index}`, status: 'done', cost: 5, createdAt: new Date().toISOString() }))
    );
  });
  const clearing = store.clearRequestLogs();
  const charging = new Promise((resolve, reject) => setImmediate(async () => {
    try {
      const remainingDuringClear = store.countRecords('jobs');
      assert.ok(remainingDuringClear > 2 && remainingDuringClear < 602);
      await store.update((db) => {
        db.users[0].balance -= 1;
        db.ledger.unshift({ id: 'charge-v45', token: 'test-only', amount: -1 });
        db.jobs.unshift({ id: 'new', status: 'done', cost: 1, createdAt: new Date().toISOString() });
      }, { dirtyRows: { users: ['user'], ledger: ['charge-v45'], jobs: ['new'] }, immediate: true });
      resolve();
    } catch (error) {
      reject(error);
    }
  }));
  const [result] = await Promise.all([clearing, charging]);
  assert.deepEqual(result, { removed: 600, remaining: 3 });
  assert.deepEqual(store.db.jobs.map((job) => job.id).sort(), ['new', 'queued', 'running']);
  assert.equal(store.selectItemById('users', 'user').balance, 94);
  assert.deepEqual(store.selectItemById('accounts', 'account'), store.db.accounts[0]);
  assert.equal(store.selectItemById('accounts', 'account').inFlight, 1);
  assert.equal(store.selectItemById('accounts', 'account').v5Quota, 42);
  assert.equal(store.countRecords('ledger'), 2);
  assert.equal(store.selectItemById('ledger', 'charge-v5').amount, -5);
  assert.equal(store.selectItemById('ledger', 'charge-v45').amount, -1);
  await store.close();
  store.db = null;
  await store.init();
  assert.equal(store.countRecords('jobs'), 3);
  assert.equal(store.selectItemById('users', 'user').balance, 94);
});

test('automatic image trimming is bounded and throttled without changing job costs', async (t) => {
  const store = await temporaryStore(t);
  await store.update((db) => {
    for (let index = 0; index < 80; index++) {
      db.images.push({ id: `image-${index}`, file: `image-${index}.png` });
      db.jobs.push({ id: `job-${index}`, status: 'done', imageId: `image-${index}`, cost: 5, createdAt: new Date().toISOString() });
    }
  }, { collections: ['images', 'jobs'] });
  const removed = await store.trimImageCache(10, { batchSize: 0 });
  assert.equal(removed.length, 25);
  assert.equal(store.countRecords('images'), 55);
  for (const image of removed) {
    assert.equal(store.selectItemById('jobs', image.id.replace('image-', 'job-')).imageId, '');
  }
  assert.deepEqual(await store.trimImageCache(10, { batchSize: 0 }), []);
  assert.equal((await store.trimImageCache(10, { force: true })).length, 25);
  assert.equal(store.countRecords('jobs'), 80);
  assert.equal(store.sqlite.prepare('SELECT SUM(cost) AS cost FROM jobs').get().cost, 400);
});
