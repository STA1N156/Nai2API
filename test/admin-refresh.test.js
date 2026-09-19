import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/admin.js', import.meta.url), 'utf8');
const server = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');

function section(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
}

function adminHarness() {
  const state = { adminToken: 'test-admin', summary: { users: [] }, summaryRequestSequence: 0 };
  const visibility = (hidden) => ({ classList: {
    hidden,
    contains() { return this.hidden; },
    toggle(name, value) { this.hidden = value; }
  } });
  const el = {
    adminToken: { value: 'test-admin' },
    enterAdminBtn: { textContent: '进入后台' },
    refreshBtn: { ...visibility(false), textContent: '刷新数据' },
    dashboard: visibility(false),
    loginPanel: visibility(true)
  };
  const requests = [];
  const toasts = [];
  const rendered = [];
  const context = vm.createContext({
    state, el, enterAdminButtonText: '进入后台', adminAutoRefreshIntervalMs: 300_000,
    api: (url) => {
      if (url === '/api/admin/ping') return Promise.resolve({ ok: true });
      const result = deferred();
      requests.push({ url, ...result });
      return result.promise;
    },
    localStorage: { setItem() {}, removeItem() {} },
    renderSummary: (summary) => rendered.push(summary),
    refreshImages: async () => {}, refreshUsers() {}, pruneSelections() {},
    showToast: (message, error) => toasts.push({ message, error }),
    normalizeErrorMessage: (error) => error.message,
    setInterval: (callback) => { context.autoRefresh = callback; }
  });
  vm.runInContext(`
    ${section('async function enterAdmin(', 'async function refreshUsers(')}
    ${section('setInterval(() =>', 'async function bootAdmin(')}
  `, context);
  return { state, el, requests, toasts, rendered, context };
}

test('manual refresh waits for fresh data, disables repeat clicks, and restores button on completion', async () => {
  const h = adminHarness();
  const refreshing = h.context.refreshAdmin();
  assert.equal(h.requests[0].url, '/api/admin/summary?revealTokens=1&fresh=1');
  assert.equal(h.el.refreshBtn.textContent, '刷新中...');
  assert.equal(h.el.refreshBtn.disabled, true);
  assert.equal(h.toasts.length, 0);
  await h.context.refreshAdmin();
  h.context.autoRefresh();
  assert.equal(h.requests.length, 1);
  h.requests[0].resolve({ version: 2 });
  await refreshing;
  assert.equal(h.state.summary.version, 2);
  assert.equal(h.el.refreshBtn.disabled, false);
  assert.equal(h.el.refreshBtn.textContent, '刷新数据');
  assert.equal(h.toasts.at(-1).message, '监控已刷新');
  h.context.autoRefresh();
  assert.equal(h.requests[1].url, '/api/admin/summary?revealTokens=1');
  h.requests[1].resolve({ version: 2 });
});

test('manual failures preserve displayed data and do not claim a successful refresh', async () => {
  const h = adminHarness();
  h.state.summary.version = 1;
  const refreshing = h.context.refreshAdmin();
  h.requests[0].reject(new Error('statistics unavailable'));
  await refreshing;
  assert.equal(h.state.summary.version, 1);
  assert.equal(h.el.refreshBtn.disabled, false);
  assert.equal(h.el.refreshBtn.textContent, '刷新数据');
  assert.equal(h.toasts.length, 1);
  assert.equal(h.toasts[0].error, true);
});

test('entering admin, including saved-token entry, waits for fresh statistics before showing dashboard', async () => {
  for (const silent of [false, true]) {
    const h = adminHarness();
    h.context.setAuthenticated(false);
    const entering = h.context.enterAdmin({ silent });
    await new Promise(setImmediate);
    assert.equal(h.requests[0].url, '/api/admin/summary?revealTokens=1&fresh=1');
    assert.equal(h.el.dashboard.classList.hidden, true);
    assert.equal(h.el.enterAdminBtn.disabled, true);
    h.requests[0].resolve({ version: 3 });
    await entering;
    assert.equal(h.el.dashboard.classList.hidden, false);
    assert.equal(h.el.enterAdminBtn.disabled, false);
    assert.equal(h.rendered[0].version, 3);
  }
});

test('entry failure keeps login available for retry without discarding valid credentials', async () => {
  const h = adminHarness();
  h.context.setAuthenticated(false);
  const entering = h.context.enterAdmin({ silent: true });
  await new Promise(setImmediate);
  h.requests[0].reject(new Error('statistics unavailable'));
  await entering;
  assert.equal(h.el.dashboard.classList.hidden, true);
  assert.equal(h.el.enterAdminBtn.disabled, false);
  assert.equal(h.state.adminToken, 'test-admin');
  assert.equal(h.toasts.at(-1).error, true);
});

test('a slower automatic response cannot overwrite the new manual refresh result', async () => {
  const h = adminHarness();
  const automatic = h.context.reloadDashboard();
  const manual = h.context.refreshAdmin();
  h.requests[1].resolve({ version: 2 });
  await manual;
  h.requests[0].resolve({ version: 1 });
  await automatic;
  assert.equal(h.state.summary.version, 2);
  assert.equal(h.rendered.at(-1).version, 2);
});

test('summary route enables a fresh read only on explicit fresh=1', () => {
  const statement = server.match(/const db = await store\.readAdminSummary\([^;]+;/)?.[0];
  assert.ok(statement);
  for (const query of ['', '?fresh=0', '?fresh=true', '?fresh=1']) {
    let fresh;
    vm.runInNewContext(`(async () => { ${statement} })()`, {
      url: new URL(`http://localhost/api/admin/summary${query}`),
      store: { readAdminSummary: (options) => { fresh = options.fresh; } }
    });
    assert.equal(fresh, query === '?fresh=1');
  }
});
