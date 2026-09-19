import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { DIRECT_URL_MAX_STEPS, normalizeNovelAiRequest, sizeCostMap } from '../server/providers.js';

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

test('V5 standard costs 8 even with an old client cost; other tiers and upstream quota are unchanged', () => {
  const api = vm.runInNewContext(`${pricing}; ({ generationCost, accountGenerationCost })`, { sizeCostMap });
  for (const [size, sizeCost] of Object.entries(sizeCostMap)) {
    for (const model of [v45, v5]) {
      for (const cost of [undefined, 0, -8, 1, 5]) {
        const request = { size, model, cost };
        assert.equal(api.generationCost(request), Math.max(sizeCost, model === v5 ? 8 : 1, cost || 0));
        assert.equal(api.accountGenerationCost(request), sizeCost > 1 ? sizeCost : 0);
      }
    }
  }
});

test('frontend and OpenAI model catalog match server prices, including batch totals', () => {
  const el = { modelInput: { value: v5 }, sizeInput: { value: '竖图' }, directGenerateBtn: {} };
  const state = { generationCount: 1 };
  const ui = vm.runInNewContext(`
    ${section(frontend, 'const sizeOptions =', 'const paramOrder =')}
    ${section(frontend, 'function populateSizeOptions(', 'async function loadSettings(')}
    ${section(frontend, 'function updateGenerateCostLabel(', 'function setGenerationCount(')}
    ${section(frontend, 'function totalGenerationCost(', 'function wait(')}
    ({ generationCost, totalGenerationCost, populateSizeOptions, updateGenerateCostLabel });
  `, { el, state, refreshSelect: () => {} });
  const catalog = vm.runInNewContext(`
    ${section(server, 'const openAiSamplers =', 'const insufficientBalanceMessage =')}
    ${section(server, 'function openAiModelsResponse(', 'function parseOpenAiImageRequest(')}
    openAiModelsResponse().data;
  `);
  assert.equal(catalog.length, 36);
  for (const item of catalog) {
    const expected = item.resolution_tier === '4K' ? 25 : item.resolution_tier === '2K' ? 15 : item.id.startsWith(v5) ? 8 : 1;
    assert.equal(item.cost, expected, item.id);
  }
  for (const model of [v45, v5]) {
    el.modelInput.value = model;
    ui.populateSizeOptions();
    for (const [size, cost] of Object.entries(sizeCostMap)) {
      el.sizeInput.value = size;
      const expected = Math.max(cost, model === v5 ? 8 : 1);
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

test('web, URL and OpenAI jobs reserve 8, reject insufficient balance and refund only the stored amount once', async () => {
  for (const source of ['web', 'direct', 'openai']) {
    const user = { token: 'test-token', balance: 8 };
    const db = { settings: {}, users: [user], jobs: [], ledger: [] };
    let nextId = 0;
    const api = vm.runInNewContext(`
      ${pricing}
      ${section(server, 'async function createJob(', 'async function ensureAccountRouteIds(')}
      ${section(server, 'async function createDirectJob(', 'async function markDirectJobRunning(')}
      ${section(server, 'function refundJob(', 'function hourlyUsageStatsByDay(')}
      ({ createJob, createDirectJob, refundJob });
    `, {
      sizeCostMap, normalizeNovelAiRequest, DIRECT_URL_MAX_STEPS,
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
    const request = { model: v5, size: '竖图', cost: 5, nocache: '1' };
    const create = () => source === 'direct'
      ? api.createDirectJob(user.token, request, 'test-cache')
      : api.createJob(user.token, request, { source });
    user.balance = 7;
    await assert.rejects(create(), { statusCode: 402 });
    assert.equal(user.balance, 7);
    assert.equal(db.ledger.length, 0);
    user.balance = 8;
    const job = await create();
    assert.equal(job.cost, 8);
    assert.equal(job.accountCost, 0);
    assert.equal(user.balance, 0);
    assert.equal(db.ledger[0].amount, -8);
    api.refundJob(db, job, 'test failure');
    api.refundJob(db, job, 'duplicate failure');
    assert.equal(user.balance, 8);
    assert.equal(db.ledger.length, 2);
    assert.equal(db.ledger[0].amount, 8);
    api.refundJob(db, { id: 'old-job', userToken: user.token, cost: 5 }, 'old task');
    assert.equal(user.balance, 13);
    assert.equal(db.ledger[0].amount, 5);
  }
});
