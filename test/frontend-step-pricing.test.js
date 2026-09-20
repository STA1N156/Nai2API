import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { MAX_STEPS, DIRECT_URL_MAX_STEPS, normalizeNovelAiRequest, sizeCostMap } from '../server/providers.js';
import { frontendGenerationCost } from '../public/generation-pricing.js';

const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
const frontend = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (text, start, end) => text.slice(text.indexOf(start), text.indexOf(end));
const pricing = section(server, 'function generationCost(', 'function requestCacheKey(');
const v45 = 'nai-diffusion-4-5-full', v5 = 'nai-diffusion-5-full';
const tiers = [[1, 1, 8, 15, 25], [28, 1, 8, 15, 25], [29, 6, 12, 19, 29], [35, 6, 12, 19, 29],
  [36, 8, 14, 21, 31], [45, 8, 14, 21, 31], [46, 10, 16, 23, 33], [50, 10, 16, 23, 33]];

function runtime() {
  const user = { id: 'user', token: 'test', balance: 1000 };
  const db = { settings: {}, users: [user], accounts: [], jobs: [], images: [], ledger: [] };
  let id = 0;
  const api = vm.runInNewContext(`
    ${pricing}
    ${section(server, 'async function createJob(', 'async function ensureAccountRouteIds(')}
    ${section(server, 'function refundJob(', 'function hourlyUsageStatsByDay(')}
    ${section(server, 'function selectAccount(', 'function accountQuotaPoints(')}
    ${section(server, 'function accountQuotaPoints(', 'function availableAccountSlots(')}
    ${section(server, 'function hasAccountWithEnoughQuota(', 'function resetStaleAccountLoads(')}
    ${section(server, 'async function completeGeneration(', 'async function cancelReservedJob(')}
    ${section(server, 'async function retryReservationWithNextAccount(', 'async function requeueReservedJob(')}
    ${section(server, 'function applyAccountQuotaResult(', 'function accountAvailability(')}
    ({ createJob, refundJob, requiresPaidAccount, selectAccount, hasAccountWithEnoughQuota,
      completeGeneration, retryReservationWithNextAccount, applyAccountQuotaResult });
  `, {
    MAX_STEPS, DIRECT_URL_MAX_STEPS, normalizeNovelAiRequest, sizeCostMap, frontendGenerationCost,
    store: { update: async mutate => mutate(db), trimImageCache: async () => [] }, cleanupStaleActiveJobs: async () => {},
    getUserOrThrow: () => user, requestCacheKey: () => 'cache', isNoCache: value => value === '1',
    activeJobCount: jobs => jobs.length, dirtyResultJobRows: () => {}, createId: () => `id-${++id}`,
    httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode }),
    insufficientBalanceMessage: 'insufficient balance', isAccountCoolingDown: () => false,
    resetStaleAccountLoads: () => {}, numberOrNull: value => value ?? null,
    writeStoredImage: async () => 'test-image.png', removeStoredImages: async () => {}, imageCacheTrimBuffer: () => 0,
    scheduleQueueDrain: () => {}, clearJobStreamProgress: () => {}, notifyJobWaiters: () => {},
    dirtyReservationJobRows: () => {}, isNovelAiCapacityError: () => false, isNovelAiAccountBannedError: () => false,
    isNovelAiAccountQuotaError: () => true, isNovelAiOutOfTrialImageGenerationError: () => false
  });
  return { api, user, db };
}

test('every frontend price boundary matches all sizes and both models; batch totals stay exact', () => {
  const el = { modelInput: { value: v45 }, sizeInput: { value: '竖图' }, stepsInput: { value: 28 }, directGenerateBtn: {} };
  const state = { generationCount: 1 };
  const ui = vm.runInNewContext(`
    ${section(frontend, 'const sizeOptions =', 'const paramOrder =')}
    ${section(frontend, 'function normalizeSteps(', 'function buildGenerateUrl(')}
    ${section(frontend, 'function populateSizeOptions(', 'async function loadSettings(')}
    ${section(frontend, 'function updateGenerateCostLabel(', 'function setGenerationCount(')}
    ${section(frontend, 'function totalGenerationCost(', 'function wait(')}
    ({ populateSizeOptions, generationCost, totalGenerationCost, updateGenerateCostLabel });
  `, { el, state, frontendGenerationCost, maxSteps: 50, defaultSteps: 28, refreshSelect: () => {} });
  for (const [steps, normal45, normal5, twoK, fourK] of tiers) {
    el.stepsInput.value = steps;
    for (const model of [v45, v5]) {
      el.modelInput.value = model;
      ui.populateSizeOptions();
      for (const [size, sizeCost] of Object.entries(sizeCostMap)) {
        el.sizeInput.value = size;
        const expected = sizeCost === 25 ? fourK : sizeCost === 15 ? twoK : model === v5 ? normal5 : normal45;
        assert.equal(frontendGenerationCost(sizeCost, model, steps), expected);
        assert.equal(ui.generationCost(), expected);
        assert.ok(el.sizeInput.innerHTML.includes(`${size}（${expected}点）`));
        for (const count of [1, 2, 4]) {
          state.generationCount = count;
          ui.updateGenerateCostLabel();
          assert.equal(ui.totalGenerationCost(), expected * count);
          assert.equal(el.directGenerateBtn.textContent, `生成图片（${expected * count}点）`);
        }
      }
    }
  }
});

test('frontend charges server-calculated price, rejects insufficient balance and refunds the stored price once', async () => {
  for (const [steps, normal45, normal5, twoK, fourK] of tiers) {
    for (const model of [v45, v5]) {
      for (const [size, sizeCost] of Object.entries(sizeCostMap)) {
        const { api, user, db } = runtime();
        const expected = sizeCost === 25 ? fourK : sizeCost === 15 ? twoK : model === v5 ? normal5 : normal45;
        const body = { model, size, steps, cost: 0.1, nocache: '1' };
        user.balance = expected - 1;
        await assert.rejects(api.createJob('test', body, { frontend: true }), { statusCode: 402 });
        assert.equal(user.balance, expected - 1);
        assert.equal(db.ledger.length, 0);
        user.balance = expected;
        const job = await api.createJob('test', body, { frontend: true });
        assert.equal(job.request.steps, steps);
        assert.equal(job.cost, expected);
        assert.equal(job.accountCost, 0);
        assert.equal(user.balance, 0);
        assert.equal(db.ledger[0].amount, -expected);
        api.refundJob(db, job, 'failed');
        api.refundJob(db, job, 'duplicate failure');
        assert.equal(user.balance, expected);
        assert.equal(db.ledger.length, 2);
      }
    }
  }
});

test('50-step limit is frontend-only; forged cost/dimensions do not change frontend pricing', async () => {
  const { api } = runtime();
  for (const steps of [28, 35, 45, 50, 99]) {
    const body = { model: v5, size: '竖图', steps, cost: 1, nocache: '1' };
    const legacy = await api.createJob('test', body);
    assert.equal(legacy.request.steps, 28);
    assert.equal(legacy.cost, 8);
    const web = await api.createJob('test', { ...body, cost: 999, width: 2048, height: 2048 }, { frontend: true });
    assert.equal(web.request.steps, Math.min(50, steps));
    assert.equal(web.request.width, 832);
    assert.equal(web.request.height, 1216);
    assert.equal(web.cost, frontendGenerationCost(1, v5, Math.min(50, steps)));
  }
  const fractional = await api.createJob('test', { model: v45, size: '竖图', steps: 35.9, nocache: '1' }, { frontend: true });
  assert.equal(fractional.request.steps, 35);
  assert.equal(fractional.cost, 6);
  assert.match(frontend, /const maxUrlSteps = 28/);
  assert.match(server, /const openAiFixedSteps = 28/);
  assert.equal((frontend.match(/api\('\/api\/web\/jobs'/g) || []).length, 2);
});

test('paid requests prefer refreshed balances, not local cost estimates or V5 free allowance', () => {
  const { api } = runtime();
  const request = { model: v5, size: '竖图', steps: 50, width: 832, height: 1216 };
  const accounts = [
    { id: 'free-only', enabled: true, quotaPoints: 0, v5UsagePercent: 100 },
    { id: 'poor', enabled: true, quotaPoints: 1, v5UsagePercent: 100 },
    { id: 'paid', enabled: true, quotaPoints: 100, v5UsagePercent: 0 }
  ];
  for (const paid of [request, { ...request, model: v45 }, { ...request, steps: 28, size: '2K竖图' }]) {
    assert.equal(api.requiresPaidAccount(paid), true);
    assert.equal(api.selectAccount(accounts, {}, { request: paid }).id, 'paid');
    assert.equal(api.selectAccount(accounts.slice(0, 2), {}, { request: paid }).id, 'poor');
    assert.equal(api.selectAccount(accounts.slice(0, 1), {}, { request: paid }), null);
    assert.equal(api.hasAccountWithEnoughQuota(accounts.slice(0, 1), paid), false);
  }
  const standard = { ...request, steps: 28 };
  assert.equal(api.requiresPaidAccount(standard), false);
  assert.equal(api.selectAccount(accounts, {}, { request: standard }).id, 'free-only');
  assert.equal(api.hasAccountWithEnoughQuota(accounts.slice(0, 1), standard), true);
  accounts[0].inFlight = 1;
  accounts[1].inFlight = 1;
  assert.equal(api.selectAccount(accounts, {}, { request: standard }).id, 'paid');
});

test('successful generation never deducts NovelAI balance, including old in-flight estimates', async () => {
  for (const quotaPoints of [null, 0, 1, 100]) {
    for (const accountCost of [0, 15, 25, 50]) {
      const { api, db, user } = runtime();
      const account = { id: 'account', quotaPoints, inFlight: 1, total: 2 };
      db.accounts.push(account);
      db.jobs.push({ id: 'job', status: 'running' });
      const result = await api.completeGeneration(
        { account, accountCost, token: user.token, cost: 16 },
        { model: v5, steps: 50 }, { mimeType: 'image/png' }, { jobId: 'job' }
      );
      assert.equal(account.quotaPoints, quotaPoints);
      assert.equal(account.inFlight, 0);
      assert.equal(account.total, 3);
      assert.equal(db.jobs[0].status, 'done');
      assert.equal(result.accountCost, accountCost);
      assert.equal(user.balance, 1000);
    }
  }
});

test('upstream insufficient-points error blocks paid routing without overwriting balance; refresh restores eligibility', async () => {
  const { api, db } = runtime();
  const request = { model: v5, size: '竖图', steps: 50 };
  const account = { id: 'account', quotaPoints: 100, inFlight: 1 };
  db.accounts.push(account);
  assert.equal(await api.retryReservationWithNextAccount({ account }, new Error('quota'), new Set(['account']), { request }), null);
  assert.equal(account.quotaPoints, 100);
  assert.equal(account.quotaError, '点数不足');
  assert.equal(api.selectAccount(db.accounts, {}, { request }), null);
  assert.equal(api.hasAccountWithEnoughQuota(db.accounts, request), false);
  api.applyAccountQuotaResult(account, { ok: true, quotaPoints: 70, quotaError: '', quotaCheckedAt: 'refreshed' }, 'refreshed');
  assert.equal(account.quotaPoints, 70);
  assert.equal(api.selectAccount(db.accounts, {}, { request }).id, 'account');
});

test('UI retains collapsed advanced settings and prompts without image-editing controls or layout overrides', () => {
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
  assert.match(html, /<details class="advanced-prompts">\s*<summary>画师串与负面提示词<\/summary>/);
  assert.match(html, /id="stepsInput"[^>]*max="50"/);
  assert.match(html, /<label for="stepsInput">迭代步数<\/label>/);
  const advanced = html.match(/<details class="advanced-prompts">\s*<summary>高级设置<\/summary>([\s\S]*?)<\/details>/);
  assert.ok(advanced);
  for (const id of ['samplerInput', 'scaleInput', 'cfgInput']) assert.ok(advanced[1].includes(`id="${id}"`));
  assert.doesNotMatch(`${html}\n${frontend}\n${css}\n${server}`, /imageEditor|ImageInputs|imageEditPanel|preview-edit-actions|editUpload|inpaintImageBtn|useBaseImageBtn|重构优化|optimizeStoredImage/);
  assert.doesNotMatch(`${html}\n${frontend}\n${css}`, /mobileGenerateBtn|mobile-generation-bar|model-param-grid/);
  assert.doesNotMatch(css, /\.user-shell input,/);
  assert.match(css, /\.composer-panel:has\(\.custom-select\.open\)\s*\{\s*z-index: 2;/);
});

test('stale image-editing submissions are rejected before reserving credits or creating jobs', async () => {
  const route = section(server, "  if (method === 'POST' && ['/api/jobs', '/api/web/jobs']", "  if (method === 'GET' && url.pathname === '/api/jobs/events')");
  let reserved = 0;
  for (const mode of ['img2img', 'infill']) {
    const submit = vm.runInNewContext(`(async () => { ${route} })`, {
      method: 'POST', url: new URL('http://localhost/api/web/jobs'), req: {},
      readJson: async () => ({ edit: { mode }, token: 'test' }),
      createJob: () => { reserved++; },
      httpError: (statusCode, message) => Object.assign(new Error(message), { statusCode })
    });
    await assert.rejects(submit(), { statusCode: 400, message: '图片编辑功能已移除，请刷新页面后重试。' });
  }
  assert.equal(reserved, 0);
});
