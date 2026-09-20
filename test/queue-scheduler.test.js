import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function scheduler({ slots = 1 } = {}) {
  let now = 1000;
  let sequence = 0;
  const timers = new Map();
  const starts = [];
  const db = { accounts: [], settings: {}, jobs: [{ id: 'job', status: 'queued' }] };
  const hooks = { slots, beforeUpdate: async () => {} };
  let activeUpdates = 0;
  let maximumUpdates = 0;
  const context = vm.createContext({
    Date: { now: () => now }, console,
    setTimeout: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    store: {
      update: async (mutate) => {
        maximumUpdates = Math.max(maximumUpdates, ++activeUpdates);
        try { await hooks.beforeUpdate(); return mutate(db); }
        finally { activeUpdates--; }
      },
      readCollections: async () => db
    },
    availableAccountSlots: () => hooks.slots,
    nextAccountReadyDelay: () => hooks.slots > 0 ? 0 : 1000,
    isQueueActiveJob: () => true,
    reserveQueuedJob: async (id) => {
      const job = db.jobs.find((item) => item.id === id);
      assert.equal(job.status, 'queued', 'a job must never be reserved twice');
      assert.ok(hooks.slots > 0, 'dispatch must respect account capacity');
      hooks.slots--;
      job.status = 'running';
      return { job };
    },
    runReservedJob: ({ job }) => starts.push({ id: job.id, at: now })
  });
  vm.runInContext(`
    ${section('let queueDrainTimer =', 'let accountQuotaRefreshTimer =')}
    ${section('function scheduleQueueDrain(', 'function hasEnabledAccounts(')}
  `, context);
  return {
    hooks, timers, starts,
    schedule: context.scheduleQueueDrain,
    maximumUpdates: () => maximumUpdates,
    nextAt: () => Math.min(...[...timers.values()].map((timer) => timer.at)),
    async tick(ms = 0) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.callback();
      }
      await new Promise(setImmediate);
    }
  };
}

test('account release brings a pending one-second retry forward and cancels its old timer', async () => {
  const queue = scheduler();
  queue.schedule(1000);
  await queue.tick(200);
  queue.schedule();
  assert.equal(queue.timers.size, 1);
  assert.equal(queue.nextAt(), 1200);
  await queue.tick();
  assert.deepEqual(queue.starts, [{ id: 'job', at: 1200 }]);
  await queue.tick(800);
  assert.equal(queue.starts.length, 1);
  assert.equal(queue.timers.size, 0);
});

test('an earlier delayed request also brings dispatch forward', async () => {
  const queue = scheduler();
  queue.schedule(1000);
  await queue.tick(200);
  queue.schedule(300);
  assert.equal(queue.nextAt(), 1500);
  await queue.tick(300);
  assert.deepEqual(queue.starts, [{ id: 'job', at: 1500 }]);
});

test('later requests never postpone an earlier timer and use its remaining time', async () => {
  const queue = scheduler();
  queue.schedule(1000);
  await queue.tick(900);
  queue.schedule(500);
  assert.equal(queue.nextAt(), 2000);
  assert.equal(queue.timers.size, 1);
  await queue.tick(100);
  assert.equal(queue.starts.length, 1);
});

test('many simultaneous wakeups keep one timer and start the job once', async () => {
  const queue = scheduler();
  queue.schedule(1000);
  for (let index = 0; index < 100; index++) queue.schedule();
  queue.schedule(500);
  assert.equal(queue.timers.size, 1);
  assert.equal(queue.nextAt(), 1000);
  await queue.tick();
  await queue.tick(1000);
  assert.equal(queue.starts.length, 1);
});

test('busy accounts retain delayed retries instead of immediate retry loops', async () => {
  const queue = scheduler({ slots: 0 });
  queue.schedule();
  await queue.tick();
  assert.equal(queue.starts.length, 0);
  assert.equal(queue.nextAt(), 2000);
  await queue.tick(500);
  assert.equal(queue.starts.length, 0);
  queue.hooks.slots = 1;
  queue.schedule();
  await queue.tick();
  assert.deepEqual(queue.starts, [{ id: 'job', at: 1500 }]);
});

test('wakeups during an active dispatch do not re-enter or reserve the job twice', async () => {
  const queue = scheduler();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  queue.hooks.beforeUpdate = () => gate;
  queue.schedule();
  await queue.tick();
  for (let index = 0; index < 20; index++) queue.schedule();
  assert.equal(queue.timers.size, 0);
  assert.equal(queue.maximumUpdates(), 1);
  release();
  await new Promise(setImmediate);
  assert.equal(queue.starts.length, 1);
  await queue.tick(1000);
  assert.equal(queue.starts.length, 1);
  assert.equal(queue.maximumUpdates(), 1);
});
