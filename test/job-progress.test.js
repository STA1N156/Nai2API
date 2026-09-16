import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const frontend = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const section = (source, start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const statusCode = section(frontend, 'function jobStatusText(', 'function setGenerateBusy(');

test('queue display keeps the original text and layout without simulated counters', () => {
  const { jobStatusText } = vm.runInNewContext(`${statusCode}; ({ jobStatusText })`);
  assert.equal(jobStatusText({ status: 'queued', queuePosition: 12, queuedCount: 300 }), '排队中（第 12 / 300 个）');
  assert.equal(jobStatusText({ status: 'queued', queuePosition: 1, queuedCount: 1 }), '准备生成中');
  assert.equal(jobStatusText({ status: 'running', generationProgress: { percent: 0 } }), '生成中');
  assert.equal(jobStatusText({ status: 'running', generationProgress: { percent: 100 } }), '生成中');
  assert.equal(jobStatusText({ status: 'done' }), '生成完成');
  assert.doesNotMatch(frontend, /queueView|finishQueueView|pollTimer/);
});

test('single-job polling is sequential and a temporary network failure does not fail the job', async () => {
  let active = 0;
  let maximumActive = 0;
  let call = 0;
  const rendered = [];
  const statuses = [];
  const delays = [];
  const state = { generating: true };
  const responses = [
    { status: 'queued', queuePosition: 300, queuedCount: 300 },
    new Error('connection timeout'),
    { status: 'queued', queuePosition: 299, queuedCount: 305 },
    { status: 'running', generationProgress: { percent: 100 } },
    { status: 'done', imageUrl: '/api/images/image/content' }
  ];
  const context = vm.createContext({
    state, el: { jobText: { textContent: '' } },
    queuedPollIntervalMs: 1000, jobPollIntervalMs: 450,
    api: async (url) => {
      assert.equal(url, '/api/jobs/test?token=fixed-token');
      maximumActive = Math.max(maximumActive, ++active);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      const response = responses[call++];
      if (response instanceof Error) throw response;
      return response;
    },
    wait: async (ms) => { delays.push(ms); },
    updateLoadingStatus: (job) => { statuses.push(job.status); },
    renderResultImage: (url) => { rendered.push(url); },
    loadMe: async () => {}, showToast: () => {},
    setGenerateBusy: (value) => { state.generating = value; }
  });
  vm.runInContext(`${statusCode}\n${section(frontend, 'async function pollJob(', 'function renderLoadingFrame(')}`, context);
  await context.pollJob('test', 'fixed-token');
  assert.equal(maximumActive, 1);
  assert.equal(call, 5);
  assert.deepEqual(statuses, ['queued', 'queued', 'running', 'done']);
  assert.deepEqual(delays, [1000, 1000, 1000, 450]);
  assert.deepEqual(rendered, ['/api/images/image/content']);
  assert.equal(state.generating, false);
});

test('public job responses retain status, progress, queue and result fields', () => {
  const context = vm.createContext({
    store: { jobQueueProgress: () => ({ progress: 3, total: 10 }) },
    jobAccountCost: () => 5, publicErrorMessage: (text) => text,
    jobDurationMs: () => 1000, jobStreamProgress: new Map(),
    clamp: (n, min, max) => Math.max(min, Math.min(max, n))
  });
  vm.runInContext(section(server, 'function publicJob(', 'function jobDurationMs('), context);
  for (const status of ['queued', 'running', 'done', 'failed']) {
    const result = context.publicJob({
      id: 'test', status, request: { model: 'nai-diffusion-5-full', steps: 28 },
      imageId: status === 'done' ? 'image' : '', cost: 5, generationProgress: { percent: 30 },
      createdAt: '2026-09-16T00:00:00.000Z', updatedAt: '2026-09-16T00:00:01.000Z'
    });
    assert.equal(result.status, status);
    for (const field of ['queuePosition', 'queuedCount', 'durationMs', 'cost']) assert.equal(typeof result[field], 'number');
    assert.equal(typeof result.generationProgress.percent, 'number');
    assert.equal(typeof result.generationProgress.step, 'number');
    assert.equal(typeof result.generationProgress.total, 'number');
    assert.equal(typeof result.generationProgress.active, 'boolean');
    assert.equal(result.imageUrl, status === 'done' ? '/api/images/image/content' : '');
    if (status === 'done') assert.equal(result.generationProgress.percent, 100);
  }
  assert.match(server, /method === 'GET' && url\.pathname\.startsWith\('\/api\/jobs\/'\)/);
  assert.match(server, /job\.userToken !== token && !isAdmin\(req, url\)/);
});
