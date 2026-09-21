import assert from 'node:assert/strict';
import test from 'node:test';
import { JobPreviews } from '../server/job-previews.js';
import { OfficialKeyJobs, officialKeyOwner, officialKeyError } from '../server/official-key-jobs.js';

const key = 'pst-official-test-key';
const other = 'pst-other-test-key';
const request = { steps: 28, prompt: 'test' };
const options = { cacheKey: 'owner-specific-cache', timeoutMs: 10_000 };
const deferred = () => Promise.withResolvers();

function harness(overrides = {}) {
  const calls = [], pending = [], saved = [];
  const previews = new JobPreviews();
  const jobs = new OfficialKeyJobs({
    previews, findImage: async () => null,
    generate: (request, account, options) => {
      const result = deferred();
      calls.push({ request, account, options });
      pending.push(result);
      options.signal.addEventListener('abort', () => result.reject(new Error('aborted')), { once: true });
      return result.promise;
    },
    saveImage: async (job, image) => { saved.push({ owner: job.owner, image }); return { id: `image-${saved.length}` }; },
    ...overrides
  });
  return { jobs, calls, pending, saved, previews };
}

test('own key only: separate owners run together, one key queues serially, all results clear credentials and previews', async () => {
  const h = harness();
  const first = await h.jobs.create(key, request, options);
  const second = await h.jobs.create(key, request, options);
  const third = await h.jobs.create(other, request, options);
  assert.equal(first.status, 'running');
  assert.equal(second.status, 'queued');
  assert.equal(third.status, 'running');
  assert.deepEqual(h.calls.map(call => call.account), [{ token: key }, { token: other }]);
  assert.throws(() => h.jobs.get(first.id, other), { statusCode: 403 });
  h.calls[0].options.onProgress({ percent: 40, step: 11, previewBuffer: Buffer.from('preview'), previewMimeType: 'image/jpeg' });
  const updated = h.jobs.snapshot(h.jobs.get(first.id, key));
  assert.equal(updated.generationProgress.percent, 40);
  assert.ok(!JSON.stringify(updated).includes(key));
  h.pending[0].resolve({ buffer: Buffer.from('first') });
  const finished = await h.jobs.get(first.id, key).done;
  assert.equal(finished.status, 'done');
  assert.equal(finished.token, undefined);
  assert.equal(finished.request, undefined);
  assert.equal(h.previews.frames.size, 0);
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[2].account.token, key);
  assert.equal(h.jobs.snapshot(finished).cost, 0);
  h.pending[1].resolve({ buffer: Buffer.from('third') });
  h.pending[2].resolve({ buffer: Buffer.from('second') });
  await Promise.all([h.jobs.get(second.id, key).done, h.jobs.get(third.id, other).done]);
  assert.equal(h.jobs.running.size, 0);
});

test('official failures never retry another account and do not expose upstream secrets', async () => {
  const h = harness();
  const first = await h.jobs.create(key, request, options);
  h.pending[0].reject(new Error(`NovelAI returned 401: echoed ${key}`));
  const job = await h.jobs.get(first.id, key).done;
  assert.equal(job.status, 'failed');
  assert.equal(job.token, undefined);
  assert.equal(h.calls.length, 1);
  assert.equal(h.saved.length, 0);
  assert.equal(h.previews.frames.size, 0);
  assert.doesNotMatch(JSON.stringify(h.jobs.snapshot(job)), /pst-|echoed/);
  assert.equal(officialKeyError(new Error('NovelAI returned 402')).statusCode, 402);
  assert.throws(() => officialKeyOwner('STA1N-test'), { statusCode: 401 });
});

test('cached requests coalesce only inside the same owner, and completed jobs are bounded', async () => {
  const h = harness({ maxJobs: 2 });
  const first = await h.jobs.create(key, request, { ...options, noCache: false });
  const duplicate = await h.jobs.create(key, request, { ...options, noCache: false });
  assert.equal(duplicate.id, first.id);
  const second = await h.jobs.create(other, request, { ...options, noCache: false });
  assert.notEqual(second.id, first.id);
  await assert.rejects(h.jobs.create(key, request, options), { statusCode: 429 });
  h.pending[0].resolve({ buffer: Buffer.from('a') });
  h.pending[1].resolve({ buffer: Buffer.from('b') });
  await Promise.all([h.jobs.get(first.id, key).done, h.jobs.get(second.id, other).done]);
  const next = await h.jobs.create(key, request, options);
  assert.equal(h.jobs.jobs.size, 2);
  h.pending[2].resolve({ buffer: Buffer.from('c') });
  await h.jobs.get(next.id, key).done;
});

test('queued timeout discards the key and never starts an upstream generation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const first = await h.jobs.create(key, request, { ...options, timeoutMs: 1000 });
  const queued = await h.jobs.create(key, request, { ...options, timeoutMs: 10 });
  t.mock.timers.tick(11);
  const failed = await h.jobs.get(queued.id, key).done;
  assert.equal(failed.status, 'failed');
  assert.equal(failed.token, undefined);
  assert.equal(h.calls.length, 1);
  h.pending[0].resolve({ buffer: Buffer.from('ok') });
  await h.jobs.get(first.id, key).done;
  assert.equal(h.calls.length, 1);
  assert.equal(h.jobs.queue.length, 0);
});

test('running timeout aborts upstream, clears preview and advances the same-key queue', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness();
  const first = await h.jobs.create(key, request, { ...options, timeoutMs: 10 });
  const next = await h.jobs.create(key, request, { ...options, timeoutMs: 1000 });
  h.calls[0].options.onProgress({ percent: 10, previewBuffer: Buffer.from('p'), previewMimeType: 'image/jpeg' });
  t.mock.timers.tick(11);
  await h.jobs.get(first.id, key).done;
  assert.equal(h.calls[0].options.signal.aborted, true);
  assert.equal(h.previews.frames.size, 0);
  assert.equal(h.jobs.get(first.id, key).token, undefined);
  assert.equal(h.calls.length, 2);
  h.pending[1].resolve({ buffer: Buffer.from('ok') });
  await h.jobs.get(next.id, key).done;
});
