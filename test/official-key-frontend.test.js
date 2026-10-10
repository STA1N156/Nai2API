import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { generationPrice, sizeMap } from '../public/generation-pricing.js';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('official key shows estimated Anlas with free quota; switching back restores site credits', () => {
  const el = { userToken: { value: 'pst-test' }, sizeInput: { value: '竖图' }, mergePanel: {}, directGenerateBtn: {},
    modelInput: { value: 'nai-diffusion-5-full' }, stepsInput: { value: 28 } };
  const state = { generationCount: 1, officialAccount: null };
  const context = vm.createContext({ el, state, sizeOptions: Object.keys(sizeMap).map(value => ({ value })),
    generationPrice, normalizeSteps: Number, refreshSelect() {}, setMergePanelOpen() {} });
  vm.runInContext(section('function totalGenerationCost()', 'function wait(')
    + section('function populateSizeOptions()', 'async function loadSettings(')
    + section('function updateGenerateCostLabel()', 'function setGenerationCount('), context);
  vm.runInContext('updateKeyMode(); updateGenerateCostLabel();', context);
  assert.equal(el.mergePanel.hidden, true);
  assert.equal(el.directGenerateBtn.textContent, '生成图片（预计 30 Anlas）');
  state.officialAccount = { freeStandard: { v45: true, v5: true } };
  vm.runInContext('updateKeyMode(); updateGenerateCostLabel();', context);
  assert.equal(el.directGenerateBtn.textContent, '生成图片（预计 0 Anlas）');
  assert.ok(el.sizeInput.innerHTML.includes('2K竖图（预计 51 Anlas）'));
  el.stepsInput.value = 35;
  vm.runInContext('updateGenerateCostLabel();', context);
  assert.equal(el.directGenerateBtn.textContent, '生成图片（预计 36 Anlas）');
  el.stepsInput.value = 28;
  state.officialAccount.freeStandard.v5 = false;
  vm.runInContext('updateGenerateCostLabel();', context);
  assert.equal(el.directGenerateBtn.textContent, '生成图片（预计 30 Anlas）');
  el.sizeInput.value = '2K竖图';
  state.generationCount = 4;
  vm.runInContext('updateGenerateCostLabel();', context);
  assert.equal(el.directGenerateBtn.textContent, '生成图片（预计 204 Anlas）');
  el.sizeInput.value = '竖图';
  el.userToken.value = 'STA1N-test';
  vm.runInContext('updateKeyMode(); updateGenerateCostLabel();', context);
  assert.equal(el.mergePanel.hidden, false);
  assert.equal(el.directGenerateBtn.textContent, '生成图片（24点）');
  assert.ok(el.sizeInput.innerHTML.includes('竖图（6点）'));
});

test('official quota is shown separately from site balance; key input is masked', async () => {
  const el = { userToken: { value: 'pst-test' }, balanceText: {}, tokenStatusDot: { classList: { add() {} } } };
  const state = { token: 'pst-test', userBalance: 50 };
  const context = vm.createContext({ el, state, populateSizeOptions() {}, updateUrlOutputs() {},
    api: async () => ({ authMode: 'official', anlas: 17963, freeStandard: { v45: true, v5: true },
      v5RemainingPercent: 76.5, membership: 'Opus 会员' }) });
  vm.runInContext(section('async function loadMe()', 'async function mergeTokenBalance('), context);
  await vm.runInContext('loadMe()', context);
  assert.equal(state.userBalance, null);
  assert.equal(state.officialAccount.freeStandard.v5, true);
  assert.equal(el.balanceText.textContent, 'Anlas: 17963点 · V5 剩余 76.5% · Opus 会员');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="userToken" type="password"[^>]*placeholder="STA1N密钥\/NAI官方密钥"/);
});
