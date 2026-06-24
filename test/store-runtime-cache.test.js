import assert from 'node:assert/strict';
import test from 'node:test';
import { JsonStore } from '../server/store.js';

function fakeStoreWithJobs(jobs) {
  const rowState = new Map();
  const orderKeys = new Map();
  jobs.forEach((job, index) => {
    rowState.set(job.id, { data: JSON.stringify(job), order: jobs.length - index });
    orderKeys.set(job.id, jobs.length - index);
  });

  return Object.assign(Object.create(JsonStore.prototype), {
    db: {
      jobs,
      images: [],
      ledger: [],
    },
    partialCollections: new Set(),
    rowState: {
      jobs: rowState,
      images: new Map(),
      ledger: new Map(),
    },
    orderKeys: {
      jobs: orderKeys,
      images: new Map(),
      ledger: new Map(),
    },
  });
}

test('trims completed runtime jobs once they exceed the cache limit', () => {
  const jobs = Array.from({ length: 3005 }, (_, index) => ({
    id: `job_${index}`,
    status: 'done',
  }));
  const store = fakeStoreWithJobs(jobs);

  store.trimRuntimePartialCaches();

  assert.equal(store.db.jobs.length, 3000);
  assert.equal(store.partialCollections.has('jobs'), true);
  assert.equal(store.rowState.jobs.has('job_3004'), false);
  assert.equal(store.orderKeys.jobs.has('job_3004'), false);
});
