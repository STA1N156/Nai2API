import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { MAX_STEPS, DIRECT_URL_MAX_STEPS, normalizeNovelAiRequest } from '../server/providers.js';
import { generationPrice, sizeMap } from '../public/generation-pricing.js';

const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const frontend = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const v5 = 'nai-diffusion-5-full';
const v45 = 'nai-diffusion-4-5-full';
function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}
const pricing = section(server, 'function generationCost(', 'function requestCacheKey(');
const prices28 = {
  '竖图': [1, 6], '横图': [1, 6], '方图': [1, 6],
  '2K竖图': [34, 51], '2K横图': [34, 51], '2K方图': [35, 53],
  '4K竖图': [51, 77], '4K横图': [51, 77], '4K方图': [57, 86]
};

test('paid resolutions follow official prices; standard prices stay unchanged and client cost is ignored', () => {
  const api = vm.runInNewContext(`${pricing}; ({ generationCost })`, { sizeMap, generationPrice });
  for (const size of Object.keys(sizeMap)) {
    for (const model of [v45, v5]) {
      for (const cost of [undefined, 0, -8, 1, 5, 999]) {
        const request = { size, model, steps: 28, cost };
        assert.equal(api.generationCost(request), prices28[size][model === v5 ? 1 : 0]);
      }
    }
  }
});

test('high steps use exact pixels and both official rounding stages, not old price bands', () => {
  for (const [size, steps, normal, v5Cost] of [
    ['竖图', 29, 20, 30], ['方图', 29, 21, 32], ['竖图', 35, 24, 36],
    ['竖图', 45, 30, 45], ['竖图', 50, 33, 50], ['2K竖图', 50, 56, 84],
    ['2K方图', 50, 58, 87], ['4K竖图', 50, 85, 128], ['4K方图', 50, 95, 143]
  ]) {
    assert.equal(generationPrice({ size, steps, model: v45 }), normal);
    assert.equal(generationPrice({ size, steps, model: v5 }), v5Cost);
  }
  assert.equal(generationPrice({ size: '竖图', width: 1728, height: 1728, model: v5, steps: 28, cost: 1 }), 86);
});

test('frontend and OpenAI model catalog match server prices, including batch totals', () => {
  const el = { modelInput: { value: v5 }, sizeInput: { value: '竖图' }, stepsInput: { value: 28 }, directGenerateBtn: {} };
  const state = { generationCount: 1 };
  const ui = vm.runInNewContext(`
    ${section(frontend, 'const sizeOptions =', 'const paramOrder =')}
    ${section(frontend, 'function populateSizeOptions(', 'async function loadSettings(')}
    ${section(frontend, 'function updateGenerateCostLabel(', 'function setGenerationCount(')}
    ${section(frontend, 'function totalGenerationCost(', 'function wait(')}
    ({ generationCost, totalGenerationCost, populateSizeOptions, updateGenerateCostLabel });
  `, { el, state, refreshSelect: () => {}, generationPrice, sizeMap, normalizeSteps: Number });
  const catalog = vm.runInNewContext(`
    ${section(server, 'const openAiSamplers =', 'const insufficientBalanceMessage =')}
    ${section(server, 'function openAiModelsResponse(', 'function parseOpenAiImageRequest(')}
    openAiModelsResponse().data;
  `, { sizeMap, generationCost: generationPrice, openAiFixedSteps: 28 });
  assert.equal(catalog.length, 36);
  for (const item of catalog) {
    const tier = item.resolution_tier === 'standard' ? '' : item.resolution_tier;
    const modelIndex = item.id.includes(v5) ? 1 : 0;
    const expected = prices28[`${tier}竖图`][modelIndex];
    assert.equal(item.cost, expected, item.id);
    if (tier) for (const size of ['竖图', '横图', '方图']) assert.equal(item.cost_by_size[size], prices28[`${tier}${size}`][modelIndex]);
  }
  for (const model of [v45, v5]) {
    el.modelInput.value = model;
    ui.populateSizeOptions();
    for (const size of Object.keys(sizeMap)) {
      el.sizeInput.value = size;
      const expected = prices28[size][model === v5 ? 1 : 0];
      assert.equal(ui.generationCost(), expected);
      assert.ok(el.sizeInput.innerHTML.includes(`>${size}（${expected}点）</option>`));
      for (const count of [1, 2, 4]) {
        state.generationCount = count;
        assert.equal(ui.totalGenerationCost(), expected * count);
        ui.updateGenerateCostLabel();
        assert.equal(el.directGenerateBtn.textContent, `生成图片（${expected * count}点）`);
      }
    }
  }
});

test('web, URL and OpenAI jobs reserve 6, reject insufficient balance and refund only the stored amount once', async () => {
  for (const source of ['web', 'direct', 'openai']) {
    const user = { token: 'test-token', balance: 6 };
    const db = { settings: {}, users: [user], jobs: [], ledger: [] };
    let nextId = 0;
    const api = vm.runInNewContext(`
      ${pricing}
      ${section(server, 'async function createJob(', 'async function ensureAccountRouteIds(')}
      ${section(server, 'async function createDirectJob(', 'async function markDirectJobRunning(')}
      ${section(server, 'function refundJob(', 'function hourlyUsageStatsByDay(')}
      ({ createJob, createDirectJob, refundJob });
    `, {
      sizeMap, normalizeNovelAiRequest, DIRECT_URL_MAX_STEPS, MAX_STEPS, generationPrice,
      store: { update: async (mutate) => mutate(db) },
      cleanupStaleActiveJobs: async () => {},
      getUserOrThrow: () => user,
      requestCacheKey: () => 'test-cache',
      isNoCache: (value) => value === '1',
      activeJobCount: (jobs) => jobs.length,
      dirtyResultJobRows: () => {},
      createId: () => `test-${++nextId}`,
      httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
      insufficientBalanceMessage: 'insufficient balance'
    });
    const request = { model: v5, size: '竖图', cost: 8, nocache: '1' };
    const create = () => source === 'direct'
      ? api.createDirectJob(user.token, request, 'test-cache')
      : api.createJob(user.token, request, { source });
    user.balance = 5;
    await assert.rejects(create(), { statusCode: 402 });
    assert.equal(user.balance, 5);
    assert.equal(db.ledger.length, 0);
    user.balance = 6;
    const job = await create();
    assert.equal(job.cost, 6);
    assert.equal(job.accountCost, 0);
    assert.equal(user.balance, 0);
    assert.equal(db.ledger[0].amount, -6);
    api.refundJob(db, job, 'test failure');
    api.refundJob(db, job, 'duplicate failure');
    assert.equal(user.balance, 6);
    assert.equal(db.ledger.length, 2);
    assert.equal(db.ledger[0].amount, 6);
    api.refundJob(db, { id: 'old-job', userToken: user.token, cost: 8 }, 'old task');
    assert.equal(user.balance, 14);
    assert.equal(db.ledger[0].amount, 8);
  }
});
