import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

test('official key hides prices and merging; switching back restores site prices', () => {
  const el = { userToken: { value: 'pst-test' }, sizeInput: { value: '竖图' }, mergePanel: {}, directGenerateBtn: {} };
  const context = vm.createContext({ el, state: {}, sizeOptions: [{ value: '竖图' }], generationCost: () => 1,
    totalGenerationCost: () => 1, refreshSelect() {}, setMergePanelOpen() {} });
  vm.runInContext(section('function usesOfficialKey()', 'function wait(')
    + section('function populateSizeOptions()', 'async function loadSettings(')
    + section('function updateGenerateCostLabel()', 'function setGenerationCount('), context);
  vm.runInContext('updateKeyMode(); updateGenerateCostLabel();', context);
  assert.equal(el.mergePanel.hidden, true);
  assert.equal(el.directGenerateBtn.textContent, '生成图片');
  assert.ok(!el.sizeInput.innerHTML.includes('点'));
  el.userToken.value = 'STA1N-test';
  vm.runInContext('updateKeyMode(); updateGenerateCostLabel();', context);
  assert.equal(el.mergePanel.hidden, false);
  assert.equal(el.directGenerateBtn.textContent, '生成图片（1点）');
  assert.ok(el.sizeInput.innerHTML.includes('（1点）'));
});

test('official quota is shown separately from site balance; key input is masked', async () => {
  const el = { userToken: { value: 'pst-test' }, balanceText: {}, tokenStatusDot: { classList: { add() {} } } };
  const state = { token: 'pst-test', userBalance: 50 };
  const context = vm.createContext({ el, state, api: async () => ({ authMode: 'official', anlas: 17963,
    v5RemainingPercent: 76.5, membership: 'Opus 会员' }) });
  vm.runInContext(section('async function loadMe()', 'async function mergeTokenBalance('), context);
  await vm.runInContext('loadMe()', context);
  assert.equal(state.userBalance, null);
  assert.equal(el.balanceText.textContent, 'Anlas: 17963点 · V5 剩余 76.5% · Opus 会员');
  const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
  assert.match(html, /id="userToken" type="password"[^>]*placeholder="STA1N密钥\/NAI官方密钥"/);
});
