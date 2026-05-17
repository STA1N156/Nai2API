import { enhanceSelects, refreshSelect } from './select-ui.js';

const state = {
  adminToken: localStorage.getItem('nai.adminToken') || '',
  selectedUsers: new Set(),
  selectedAccounts: new Set(),
  testingAccounts: new Set(),
  selectedUsageDate: '',
  chartScrollSyncing: false,
  chartDrag: null,
  userMonitorExpanded: false,
  summary: null,
  images: [],
  imageTotal: 0,
  imagePage: 1,
  imagePageSize: 1,
  imageMatched: 0,
  jobPage: 1,
  toastTimer: null
};

const jobPageSize = 10;
const userRenderLimit = 300;

const ids = [
  'adminState',
  'loginPanel',
  'dashboard',
  'adminToken',
  'enterAdminBtn',
  'refreshBtn',
  'metricUsers',
  'metricCredits',
  'metricAccounts',
  'metricImages',
  'usageChartSummary',
  'clearLogsBtn',
  'usageDateSelect',
  'usageChart',
  'userMonitorPanel',
  'userMonitorToggle',
  'userMonitorBody',
  'userCount',
  'userCredits',
  'userNote',
  'createUsersBtn',
  'newUsersOutput',
  'maxCacheImages',
  'saveSettingsBtn',
  'accountName',
  'accountToken',
  'accountProxy',
  'addAccountBtn',
  'exportAccountsBtn',
  'accountImportText',
  'importAccountsBtn',
  'replaceAccountsBtn',
  'accountProxyImportText',
  'applyAccountProxiesBtn',
  'exportPackageBtn',
  'packageFile',
  'packageImportText',
  'importPackageMergeBtn',
  'importPackageReplaceBtn',
  'accountCount',
  'userCountText',
  'jobCountText',
  'imageCountText',
  'selectAllAccounts',
  'enableAccountsBtn',
  'disableAccountsBtn',
  'refreshAccountQuotaBtn',
  'resetAccountStatsBtn',
  'deleteAccountsBtn',
  'userSearch',
  'selectAllUsers',
  'balanceAdjustValue',
  'setBalanceBtn',
  'addBalanceBtn',
  'deleteUsersBtn',
  'imageSearch',
  'imageTier',
  'imageRows',
  'refreshImagesBtn',
  'clearImagesBtn',
  'jobPrevBtn',
  'jobNextBtn',
  'jobPageText',
  'errorLogCount',
  'errorLogList',
  'imagePrevBtn',
  'imageNextBtn',
  'imagePageText',
  'accountList',
  'userList',
  'jobList',
  'imageList',
  'imagePreview',
  'closeImagePreviewBtn',
  'previewImage',
  'previewTitle',
  'previewInfo',
  'toast'
];
const el = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));

enhanceSelects();
bindEvents();
setAuthenticated(false);
bootAdmin();

async function bootAdmin() {
  el.adminToken.value = state.adminToken;
  if (!state.adminToken) return;
  await enterAdmin({ silent: true });
}

function bindEvents() {
  el.enterAdminBtn.addEventListener('click', enterAdmin);
  el.refreshBtn.addEventListener('click', refreshAdmin);
  el.createUsersBtn.addEventListener('click', createUsers);
  el.saveSettingsBtn.addEventListener('click', saveSettings);
  el.addAccountBtn.addEventListener('click', addAccount);
  el.exportAccountsBtn.addEventListener('click', exportAccounts);
  el.importAccountsBtn.addEventListener('click', () => importAccounts('append'));
  el.replaceAccountsBtn.addEventListener('click', () => importAccounts('replace'));
  el.applyAccountProxiesBtn.addEventListener('click', applyAccountProxies);
  el.exportPackageBtn.addEventListener('click', exportPackage);
  el.packageFile.addEventListener('change', loadPackageFile);
  el.importPackageMergeBtn.addEventListener('click', () => importPackage('merge'));
  el.importPackageReplaceBtn.addEventListener('click', () => importPackage('replace'));
  el.selectAllUsers.addEventListener('change', toggleAllUsers);
  el.selectAllAccounts.addEventListener('change', toggleAllAccounts);
  el.deleteUsersBtn.addEventListener('click', deleteSelectedUsers);
  el.setBalanceBtn.addEventListener('click', () => adjustSelectedUsers('set'));
  el.addBalanceBtn.addEventListener('click', () => adjustSelectedUsers('delta'));
  el.enableAccountsBtn.addEventListener('click', () => setSelectedAccountsEnabled(true));
  el.disableAccountsBtn.addEventListener('click', () => setSelectedAccountsEnabled(false));
  el.refreshAccountQuotaBtn.addEventListener('click', refreshSelectedAccountQuotas);
  el.resetAccountStatsBtn.addEventListener('click', resetSelectedAccountStats);
  el.deleteAccountsBtn.addEventListener('click', deleteSelectedAccounts);
  el.refreshImagesBtn.addEventListener('click', refreshImages);
  el.clearLogsBtn.addEventListener('click', clearLogs);
  el.userMonitorToggle.addEventListener('click', toggleUserMonitor);
  el.usageDateSelect.addEventListener('change', () => {
    state.selectedUsageDate = el.usageDateSelect.value;
    renderUsageChart(state.summary?.usageHourlyDays || []);
  });
  el.usageChart.addEventListener('scroll', syncUsageChartScroll, true);
  el.usageChart.addEventListener('pointerdown', startChartDrag);
  el.usageChart.addEventListener('pointermove', dragUsageChart);
  el.usageChart.addEventListener('pointerup', stopChartDrag);
  el.usageChart.addEventListener('pointercancel', stopChartDrag);
  el.jobPrevBtn.addEventListener('click', () => changeJobPage(-1));
  el.jobNextBtn.addEventListener('click', () => changeJobPage(1));
  el.imagePrevBtn.addEventListener('click', () => changeImagePage(-1));
  el.imageNextBtn.addEventListener('click', () => changeImagePage(1));
  el.clearImagesBtn.addEventListener('click', clearImages);
  el.userSearch.addEventListener('input', () => renderUsers(state.summary?.users || []));
  el.imageSearch.addEventListener('input', debounce(() => {
    state.imagePage = 1;
    refreshImages(false);
  }, 260));
  el.imageTier.addEventListener('change', () => {
    state.imagePage = 1;
    refreshImages();
  });
  el.imageRows.addEventListener('change', () => {
    state.imagePage = 1;
    refreshImages();
  });
  el.userList.addEventListener('change', handleUserSelection);
  el.accountList.addEventListener('change', handleAccountSelection);
  el.accountList.addEventListener('click', handleAccountAction);
  el.imageList.addEventListener('click', handleImagePreview);
  window.addEventListener('resize', debounce(() => {
    if (state.adminToken && !el.dashboard.classList.contains('hidden')) refreshImages(false);
  }, 320));
  el.closeImagePreviewBtn.addEventListener('click', closeImagePreview);
  el.imagePreview.addEventListener('click', (event) => {
    if (event.target === el.imagePreview) closeImagePreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.imagePreview.classList.contains('hidden')) closeImagePreview();
  });
  el.adminToken.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') enterAdmin();
  });
}

async function enterAdmin(options = {}) {
  try {
    state.adminToken = el.adminToken.value.trim();
    if (!state.adminToken) return showToast('请输入 Admin Token', true);
    const summary = await loadSummary();
    localStorage.setItem('nai.adminToken', state.adminToken);
    setAuthenticated(true);
    renderSummary(summary, { renderImages: false });
    await refreshImages(false);
    if (!options.silent) showToast('已进入后台');
  } catch (error) {
    localStorage.removeItem('nai.adminToken');
    state.adminToken = '';
    el.adminToken.value = '';
    setAuthenticated(false);
    if (!options.silent) showToast(normalizeErrorMessage(error), true);
  }
}

async function refreshAdmin() {
  try {
    if (!state.adminToken) return showToast('请先进入后台', true);
    await reloadDashboard();
    showToast('监控已刷新');
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

function setAuthenticated(isAuthenticated) {
  el.loginPanel.classList.toggle('hidden', isAuthenticated);
  el.dashboard.classList.toggle('hidden', !isAuthenticated);
  el.refreshBtn.classList.toggle('hidden', !isAuthenticated);
  el.adminState.textContent = isAuthenticated ? '监控在线' : '等待验证';
}

async function reloadDashboard() {
  const summary = await loadSummary();
  renderSummary(summary, { renderImages: false });
}

async function loadSummary() {
  state.summary = await api('/api/admin/summary?revealTokens=1', { admin: true });
  pruneSelections();
  return state.summary;
}

async function createUsers() {
  try {
    const data = await api('/api/admin/users', {
      method: 'POST',
      admin: true,
      body: {
        count: Number(el.userCount.value),
        credits: Number(el.userCredits.value),
        note: el.userNote.value.trim()
      }
    });
    const tokens = data.users.map((user) => user.token).join('\n');
    el.newUsersOutput.value = tokens;
    downloadText(`sta1n-keys-${dateStamp()}.txt`, `${tokens}\n`);
    showToast('STA1N 密钥已生成，TXT 已下载');
    await refreshAdmin();
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function saveSettings() {
  try {
    const maxCacheImages = Number(el.maxCacheImages.value);
    if (!Number.isFinite(maxCacheImages)) return showToast('请输入有效缓存数量', true);
    const settings = await api('/api/settings', {
      method: 'PUT',
      admin: true,
      body: {
        maxCacheImages
      }
    });
    el.maxCacheImages.value = settings.maxCacheImages;
    const summary = await loadSummary();
    renderSummary(summary);
    await refreshImages(false);
    showToast('设置已保存');
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function addAccount() {
  try {
    await api('/api/admin/accounts', {
      method: 'POST',
      admin: true,
      body: {
        name: el.accountName.value.trim(),
        token: el.accountToken.value.trim(),
        proxyUrl: el.accountProxy.value.trim()
      }
    });
    el.accountToken.value = '';
    el.accountProxy.value = '';
    showToast('账号已加入池');
    await refreshAdmin();
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function exportAccounts() {
  try {
    const data = await api('/api/admin/accounts/export', { admin: true });
    downloadJson(`novelai-accounts-${dateStamp()}.json`, data);
    el.accountImportText.value = data.accounts.map((account) => [account.name || '', account.token, account.proxyUrl || '', account.weight || 1].join(',')).join('\n');
    showToast('账号 token 已导出');
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function importAccounts(mode) {
  try {
    const tokens = el.accountImportText.value.trim();
    if (!tokens) return showToast('请先粘贴 token', true);
    if (mode === 'replace' && !confirm('覆盖导入会替换当前账号池，确定继续？')) return;
    const data = await api('/api/admin/accounts/import', {
      method: 'POST',
      admin: true,
      body: { mode, tokens }
    });
    showToast(`账号池现在有 ${data.accounts.length} 个账号`);
    await refreshAdmin();
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function applyAccountProxies() {
  try {
    const proxies = el.accountProxyImportText.value.trim();
    if (!proxies) return showToast('请先粘贴 SOCKS5 代理', true);
    const data = await api('/api/admin/accounts/proxies', {
      method: 'POST',
      admin: true,
      body: { proxies }
    });
    showToast(`已给 ${data.applied} 个账号应用代理`);
    await refreshAdmin();
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function exportPackage() {
  try {
    const data = await api('/api/admin/export', { admin: true });
    downloadJson(`sta1n-package-${dateStamp()}.json`, data);
    showToast('完整数据包已导出');
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function loadPackageFile() {
  const file = el.packageFile.files?.[0];
  if (!file) return;
  el.packageImportText.value = await file.text();
  showToast('数据包已载入');
}

async function importPackage(mode) {
  try {
    const text = el.packageImportText.value.trim();
    if (!text) return showToast('请先选择或粘贴数据包', true);
    if (mode === 'replace' && !confirm('覆盖导入会替换当前全部数据，确定继续？')) return;
    const parsed = JSON.parse(text);
    const data = parsed.data || parsed.package || parsed;
    const result = await api('/api/admin/import', {
      method: 'POST',
      admin: true,
      body: { mode, data }
    });
    showToast(`导入完成：${result.users} 个密钥，${result.accounts} 个账号`);
    await refreshAdmin();
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function deleteSelectedUsers() {
  try {
    const ids = Array.from(state.selectedUsers);
    if (!ids.length) return showToast('请先选择密钥', true);
    if (!confirm(`确定删除 ${ids.length} 个密钥？`)) return;
    const result = await api('/api/admin/users', {
      method: 'DELETE',
      admin: true,
      body: { ids }
    });
    state.selectedUsers.clear();
    showToast(`已删除 ${result.deleted} 个密钥`);
    await refreshAdmin();
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function adjustSelectedUsers(mode) {
  try {
    const ids = Array.from(state.selectedUsers);
    if (!ids.length) return showToast('请先选择密钥', true);
    const value = Number(el.balanceAdjustValue.value);
    if (!Number.isFinite(value)) return showToast('请输入有效额度', true);
    await api('/api/admin/users', {
      method: 'PATCH',
      admin: true,
      body: mode === 'set' ? { ids, setBalance: value } : { ids, delta: value }
    });
    showToast(mode === 'set' ? '额度已设置' : '额度已调整');
    await refreshAdmin();
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function deleteSelectedAccounts() {
  try {
    const ids = Array.from(state.selectedAccounts);
    if (!ids.length) return showToast('请先选择账号', true);
    if (!confirm(`确定删除 ${ids.length} 个账号？`)) return;
    const result = await api('/api/admin/accounts', {
      method: 'DELETE',
      admin: true,
      body: { ids }
    });
    state.selectedAccounts.clear();
    await reloadDashboard();
    showToast(`已删除 ${result.deleted} 个账号`);
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function setSelectedAccountsEnabled(enabled) {
  try {
    const ids = Array.from(state.selectedAccounts);
    if (!ids.length) return showToast('请先选择账号', true);
    await api('/api/admin/accounts', {
      method: 'PATCH',
      admin: true,
      body: { ids, enabled }
    });
    await reloadDashboard();
    showToast(enabled ? '账号已启用' : '账号已禁用');
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function refreshSelectedAccountQuotas() {
  try {
    const ids = Array.from(state.selectedAccounts);
    const result = await api('/api/admin/accounts/quota', {
      method: 'POST',
      admin: true,
      body: ids.length ? { ids } : {}
    });
    await reloadDashboard();
    showToast(`点数已刷新：成功 ${result.ok} 个，失败 ${result.failed} 个`);
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function testAccount(accountId) {
  if (!accountId || state.testingAccounts.has(accountId)) return;
  try {
    state.testingAccounts.add(accountId);
    renderAccounts();
    const result = await api(`/api/admin/accounts/${encodeURIComponent(accountId)}/test`, {
      method: 'POST',
      admin: true
    });
    replaceSummaryAccount(result.account);
    renderAccounts();
    showToast(result.message || (result.ok ? '账号测试通过' : '账号测试失败'), !result.ok);
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  } finally {
    state.testingAccounts.delete(accountId);
    renderAccounts();
    syncSelectionControls();
  }
}

function replaceSummaryAccount(account) {
  if (!account || !state.summary?.accounts) return;
  const index = state.summary.accounts.findIndex((item) => item.id === account.id);
  if (index >= 0) state.summary.accounts[index] = account;
}

async function resetSelectedAccountStats() {
  try {
    const ids = Array.from(state.selectedAccounts);
    if (!ids.length) return showToast('请先选择账号', true);
    if (!confirm(`确定重置 ${ids.length} 个账号的监控数据吗？运行中、成功、失败和最近使用时间会清零。`)) return;
    const result = await resetAccountStats(ids);
    await reloadDashboard();
    showToast(`已重置 ${result.reset} 个账号`);
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function resetAccountStats(ids) {
  return resetAccountStatsByPackage(ids);
}

async function resetAccountStatsByPackage(ids) {
  const exported = await api('/api/admin/export', { admin: true });
  const data = exported.data || exported.package || exported;
  const idSet = new Set(ids);
  let reset = 0;
  const now = new Date().toISOString();
  data.accounts = (data.accounts || []).map((account) => {
    if (!idSet.has(account.id)) return account;
    reset += 1;
    return {
      ...account,
      inFlight: 0,
      total: 0,
      failures: 0,
      lastUsedAt: '',
      updatedAt: now
    };
  });
  if (!reset) throw new Error('没有找到匹配账号');
  await api('/api/admin/import', {
    method: 'POST',
    admin: true,
    body: { mode: 'merge', data }
  });
  return { reset };
}

async function refreshImages(withToast = true) {
  try {
    const limit = imagePageLimit();
    const params = new URLSearchParams({
      limit: String(limit),
      offset: String((state.imagePage - 1) * limit)
    });
    const q = el.imageSearch.value.trim();
    if (q) params.set('q', q);
    if (el.imageTier.value) params.set('tier', el.imageTier.value);
    const data = await api(`/api/admin/images?${params.toString()}`, { admin: true });
    const matched = data.matched ?? 0;
    const pageCount = Math.max(1, Math.ceil(matched / limit));
    if (state.imagePage > pageCount) {
      state.imagePage = pageCount;
      return refreshImages(withToast);
    }
    state.images = data.images || [];
    state.imagePageSize = limit;
    state.imageTotal = Number(data.total ?? state.imageTotal ?? state.images.length);
    state.imageMatched = matched;
    renderImages(data);
    if (withToast) showToast('缓存图片已刷新');
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function clearImages() {
  try {
    const q = el.imageSearch.value.trim();
    const message = q
      ? `确定清理当前搜索匹配的缓存图片？搜索词：${q}`
      : '确定清理全部缓存图片？此操作不会删除密钥和账号。';
    if (!confirm(message)) return;
    const result = await api('/api/admin/images', {
      method: 'DELETE',
      admin: true,
      body: q ? { q } : { all: true }
    });
    const summary = await loadSummary();
    renderSummary(summary);
    await refreshImages(false);
    showToast(`已清理 ${result.deleted} 张缓存图`);
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

async function clearLogs() {
  try {
    const message = '确定清空请求日志吗？会清除已完成和失败的历史记录，并重置图表和错误日志；排队中、生成中的任务不受影响。';
    if (!confirm(message)) return;
    const result = await api('/api/admin/logs', {
      method: 'DELETE',
      admin: true
    });
    state.jobPage = 1;
    state.selectedUsageDate = '';
    const summary = await loadSummary();
    renderSummary(summary);
    showToast(`已清空 ${formatNumber(result.removed || 0)} 条日志`);
  } catch (error) {
    showToast(normalizeErrorMessage(error), true);
  }
}

function renderSummary(summary, options = {}) {
  const enabledAccounts = summary.accounts.filter((account) => account.enabled).length;
  const requestStats = requestStats1h(summary);
  const jobPageCount = Math.max(1, Math.ceil(summary.jobs.length / jobPageSize));
  if (state.jobPage > jobPageCount) state.jobPage = jobPageCount;
  el.metricUsers.textContent = formatNumber(summary.requestStats1m?.total || 0);
  el.metricCredits.textContent = `${formatPercent(requestStats.successRate)}%`;
  el.metricAccounts.textContent = enabledAccounts;
  const imageTotal = summaryImageTotal(summary);
  if (imageTotal !== null) {
    el.metricImages.textContent = imageTotal;
    state.imageTotal = imageTotal;
  } else if (!state.imageTotal) {
    el.metricImages.textContent = '统计中';
  }
  el.accountCount.textContent = `${summary.accounts.length} 个账号`;
  el.maxCacheImages.value = summary.settings?.maxCacheImages ?? 500;

  renderAccounts(summary.accounts);
  renderUsageChart(summary.usageHourlyDays || []);
  renderErrorLogs(summary.errorLogs || []);

  renderUsers(summary.users);

  renderJobs(summary.jobs);
  if (options.renderImages === true) renderSummaryImages(summary);

  syncSelectionControls();
}

function renderSummaryImages(summary) {
  if (state.imagePage !== 1 || el.imageSearch.value.trim() || el.imageTier.value) return;
  const images = Array.isArray(summary.images) ? summary.images : [];
  const total = summaryImageTotal(summary) ?? state.imageTotal ?? 0;
  state.images = images;
  state.imagePageSize = imagePageLimit();
  state.imageMatched = total;
  state.imageTotal = total;
  renderImages({ images, total, matched: total, offset: 0 });
}

function toggleUserMonitor() {
  state.userMonitorExpanded = !state.userMonitorExpanded;
  el.userMonitorBody.hidden = !state.userMonitorExpanded;
  el.userMonitorPanel.classList.toggle('is-collapsed', !state.userMonitorExpanded);
  el.userMonitorToggle.textContent = state.userMonitorExpanded ? '收起' : '展开';
  el.userMonitorToggle.setAttribute('aria-expanded', String(state.userMonitorExpanded));
}

function syncUsageChartScroll(event) {
  const source = event.target?.closest?.('.usage-chart-scroll');
  if (!source || !el.usageChart.contains(source) || state.chartScrollSyncing) return;
  state.chartScrollSyncing = true;
  el.usageChart.querySelectorAll('.usage-chart-scroll').forEach((target) => {
    if (target !== source) target.scrollLeft = source.scrollLeft;
  });
  requestAnimationFrame(() => {
    state.chartScrollSyncing = false;
  });
}

function startChartDrag(event) {
  if (event.button !== 0) return;
  const source = event.target?.closest?.('.usage-chart-scroll');
  if (!source) return;
  state.chartDrag = {
    source,
    pointerId: event.pointerId,
    startX: event.clientX,
    scrollLeft: source.scrollLeft
  };
  source.classList.add('dragging');
  source.setPointerCapture?.(event.pointerId);
}

function dragUsageChart(event) {
  const drag = state.chartDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag.source.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
  event.preventDefault();
}

function stopChartDrag(event) {
  const drag = state.chartDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  drag.source.classList.remove('dragging');
  drag.source.releasePointerCapture?.(event.pointerId);
  state.chartDrag = null;
}

function summaryImageTotal(summary = {}) {
  const value = summary.imageCount ?? summary.imageTotal ?? summary.cacheImageCount;
  const total = Number(value);
  return Number.isFinite(total) ? total : null;
}

function requestStats1h(summary) {
  if (summary.jobStats1h) {
    return {
      done: Number(summary.jobStats1h.done || 0),
      failed: Number(summary.jobStats1h.failed || 0),
      total: Number(summary.jobStats1h.total || 0),
      successRate: Number(summary.jobStats1h.successRate || 0)
    };
  }
  const since = Date.now() - 60 * 60 * 1000;
  const stats = (summary.jobs || []).reduce((current, job) => {
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return current;
    if (job.status === 'done') current.done += 1;
    if (job.status === 'failed') current.failed += 1;
    return current;
  }, { done: 0, failed: 0 });
  stats.total = stats.done + stats.failed;
  stats.successRate = stats.total ? stats.done / stats.total : 0;
  return stats;
}

function renderUsageChart(days) {
  const data = (Array.isArray(days) ? days : []).filter((day) => day?.date);
  if (!data.length) {
    state.selectedUsageDate = '';
    el.usageDateSelect.innerHTML = '';
    el.usageDateSelect.disabled = true;
    refreshSelect(el.usageDateSelect);
    el.usageChartSummary.textContent = '北京时间，按 00:00-23:00 小时统计';
    el.usageChart.innerHTML = '<div class="empty small">暂无图表数据</div>';
    return;
  }

  const newestFirst = data.slice().reverse();
  const availableDates = new Set(data.map((day) => day.date));
  if (!state.selectedUsageDate || !availableDates.has(state.selectedUsageDate)) {
    state.selectedUsageDate = newestFirst[0].date;
  }
  const selectedDay = data.find((day) => day.date === state.selectedUsageDate) || newestFirst[0];
  el.usageDateSelect.disabled = false;
  el.usageDateSelect.innerHTML = newestFirst.map((day) => (
    `<option value="${escapeHtml(day.date)}"${day.date === selectedDay.date ? ' selected' : ''}>${escapeHtml(day.date)}</option>`
  )).join('');
  el.usageDateSelect.value = selectedDay.date;
  refreshSelect(el.usageDateSelect);

  const totalRequests = Number(selectedDay.total || 0);
  const totalDone = Number(selectedDay.done || 0);
  const totalFailed = Number(selectedDay.failed || 0);
  const failureRate = totalRequests ? totalFailed / totalRequests : 0;
  el.usageChartSummary.textContent = `北京时间，${selectedDay.date} 00:00-23:00 · ${formatNumber(totalRequests)} 次请求 · 失败率 ${formatPercent(failureRate)}%`;
  el.usageChart.innerHTML = `<div class="chart-stat-row">
    <span><b>${formatNumber(totalRequests)}</b> 当天请求</span>
    <span><b>${formatNumber(totalDone)}</b> 成功</span>
    <span><b>${formatNumber(totalFailed)}</b> 失败</span>
    <span><b>${formatPercent(failureRate)}%</b> 当天失败率</span>
  </div>
  ${renderSelectedUsageChart(selectedDay)}`;
}

function renderSelectedUsageChart(day) {
  const hours = normalizeChartHours(day?.hours);
  const width = 1440;
  const height = 340;
  const pad = { top: 42, right: 38, bottom: 64, left: 66 };
  const plotWidth = width - pad.left - pad.right;
  const plotHeight = height - pad.top - pad.bottom;
  const xFor = (hour) => pad.left + (plotWidth * Number(hour || 0)) / 23;
  const horizontalGridLines = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = pad.top + plotHeight - ratio * plotHeight;
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" class="chart-grid" />`;
  }).join('');
  const verticalGridLines = hours.map((hour) => {
    const x = xFor(hour.hour);
    return `<line x1="${x}" y1="${pad.top}" x2="${x}" y2="${pad.top + plotHeight}" class="chart-grid chart-grid-hour" />`;
  }).join('');
  const labels = hours.map((hour) => {
    const x = xFor(hour.hour);
    const label = `${String(hour.hour).padStart(2, '0')}:00`;
    return `<text x="${x}" y="${height - 24}" class="chart-label chart-hour-label" text-anchor="middle">${label}</text>`;
  }).join('');
  const base = {
    width,
    height,
    pad,
    plotHeight,
    xFor,
    horizontalGridLines,
    verticalGridLines,
    labels
  };

  return `<div class="usage-chart-stack">
    ${renderHourlyRequestChart(day, hours, base)}
    ${renderHourlyFailureRateChart(day, hours, base)}
  </div>`;
}

function renderHourlyRequestChart(day, hours, base) {
  const { width, height, pad, plotHeight, xFor, horizontalGridLines, verticalGridLines, labels } = base;
  const maxTotal = Math.max(1, ...hours.map((hour) => Number(hour.total || 0)));
  const countY = (value) => pad.top + plotHeight - (Number(value || 0) / maxTotal) * plotHeight;
  const countPoints = hours.map((hour) => `${xFor(hour.hour)},${countY(hour.total)}`).join(' ');
  const peak = Math.max(0, ...hours.map((hour) => Number(hour.total || 0)));
  const points = hours.map((hour) => {
    const x = xFor(hour.hour);
    const hasRequests = Number(hour.total || 0) > 0;
    const failed = Number(hour.failed || 0);
    const tooltipWidth = 186;
    const tooltipHeight = 66;
    const tooltipX = Math.max(pad.left + 4, Math.min(width - pad.right - tooltipWidth - 4, x - tooltipWidth / 2));
    const topPointY = countY(hour.total);
    const tooltipY = Math.max(8, topPointY - tooltipHeight - 12);
    const failureRateText = hasRequests ? `${formatPercent(hourFailureRate(hour))}%` : '无请求';
    return `<g class="chart-hour-point">
      <circle cx="${x}" cy="${countY(hour.total)}" r="4.8" class="chart-point chart-point-count"></circle>
      <circle cx="${x}" cy="${countY(hour.total)}" r="13" class="chart-hit-point"></circle>
      <g class="chart-node-tooltip" transform="translate(${tooltipX} ${tooltipY})">
        <rect width="${tooltipWidth}" height="${tooltipHeight}" rx="12"></rect>
        <text x="12" y="22">
          <tspan class="chart-tooltip-title">${escapeHtml(day.date)} ${escapeHtml(hour.label)}</tspan>
          <tspan x="12" dy="18">请求 ${formatNumber(hour.total || 0)} 次 · 失败率 ${failureRateText}</tspan>
          <tspan x="12" dy="18">成功 ${formatNumber(hour.done || 0)} 次 · 失败 ${formatNumber(failed)} 次</tspan>
        </text>
      </g>
    </g>`;
  }).join('');

  return `<article class="usage-chart-block">
    <div class="usage-chart-heading">
      <strong>每小时请求次数</strong>
      <span>峰值 ${formatNumber(peak)} 次</span>
    </div>
    <div class="usage-chart-scroll">
  <svg class="single-hourly-chart" viewBox="0 0 ${width} ${height}" role="img">
    <rect x="0" y="0" width="${width}" height="${height}" rx="12" class="chart-bg"></rect>
    ${horizontalGridLines}
    ${verticalGridLines}
    <line x1="${pad.left}" y1="${pad.top + plotHeight}" x2="${width - pad.right}" y2="${pad.top + plotHeight}" class="chart-axis" />
    <text x="${pad.left}" y="24" class="chart-axis-label">请求次数</text>
    <text x="${pad.left - 10}" y="${countY(maxTotal)}" class="chart-tick" text-anchor="end">${formatNumber(maxTotal)}</text>
    <text x="${pad.left - 10}" y="${countY(0)}" class="chart-tick" text-anchor="end">0</text>
    <polyline points="${countPoints}" class="chart-line chart-line-count"></polyline>
    ${labels}
    ${points}
  </svg>
    </div>
  </article>`;
}

function renderHourlyFailureRateChart(day, hours, base) {
  const { width, height, pad, plotHeight, xFor, horizontalGridLines, verticalGridLines, labels } = base;
  const rateY = (value) => pad.top + plotHeight - Math.max(0, Math.min(1, Number(value || 0))) * plotHeight;
  const validHours = hours.filter((hour) => Number(hour.total || 0) > 0);
  const rateSegments = [];
  let currentRateSegment = [];
  hours.forEach((hour) => {
    if (Number(hour.total || 0) > 0) {
      currentRateSegment.push(`${xFor(hour.hour)},${rateY(hourFailureRate(hour))}`);
      return;
    }
    if (currentRateSegment.length > 1) rateSegments.push(currentRateSegment);
    currentRateSegment = [];
  });
  if (currentRateSegment.length > 1) rateSegments.push(currentRateSegment);
  const rateLines = rateSegments.map((segment) => (
    `<polyline points="${segment.join(' ')}" class="chart-line chart-line-failure"></polyline>`
  )).join('');
  const worstRate = validHours.length ? Math.max(...validHours.map((hour) => hourFailureRate(hour))) : 0;
  const points = validHours.map((hour) => {
    const x = xFor(hour.hour);
    const failed = Number(hour.failed || 0);
    const y = rateY(hourFailureRate(hour));
    const tooltipWidth = 186;
    const tooltipHeight = 66;
    const tooltipX = Math.max(pad.left + 4, Math.min(width - pad.right - tooltipWidth - 4, x - tooltipWidth / 2));
    const tooltipY = Math.max(8, y - tooltipHeight - 12);
    return `<g class="chart-hour-point">
      <circle cx="${x}" cy="${y}" r="4.8" class="chart-point chart-point-failure"></circle>
      <circle cx="${x}" cy="${y}" r="13" class="chart-hit-point"></circle>
      <g class="chart-node-tooltip" transform="translate(${tooltipX} ${tooltipY})">
        <rect width="${tooltipWidth}" height="${tooltipHeight}" rx="12"></rect>
        <text x="12" y="22">
          <tspan class="chart-tooltip-title">${escapeHtml(day.date)} ${escapeHtml(hour.label)}</tspan>
          <tspan x="12" dy="18">失败率 ${formatPercent(hourFailureRate(hour))}% · 请求 ${formatNumber(hour.total || 0)} 次</tspan>
          <tspan x="12" dy="18">成功 ${formatNumber(hour.done || 0)} 次 · 失败 ${formatNumber(failed)} 次</tspan>
        </text>
      </g>
    </g>`;
  }).join('');

  return `<article class="usage-chart-block">
    <div class="usage-chart-heading">
      <strong>每小时失败率</strong>
      <span>${validHours.length ? `最高 ${formatPercent(worstRate)}%` : '暂无有请求的小时'}</span>
    </div>
    <div class="usage-chart-scroll">
  <svg class="single-hourly-chart" viewBox="0 0 ${width} ${height}" role="img">
    <rect x="0" y="0" width="${width}" height="${height}" rx="12" class="chart-bg"></rect>
    ${horizontalGridLines}
    ${verticalGridLines}
    <line x1="${pad.left}" y1="${pad.top + plotHeight}" x2="${width - pad.right}" y2="${pad.top + plotHeight}" class="chart-axis" />
    <text x="${pad.left}" y="24" class="chart-axis-label">失败率</text>
    <text x="${pad.left - 10}" y="${rateY(1)}" class="chart-tick" text-anchor="end">100%</text>
    <text x="${pad.left - 10}" y="${rateY(0.5)}" class="chart-tick" text-anchor="end">50%</text>
    <text x="${pad.left - 10}" y="${rateY(0)}" class="chart-tick" text-anchor="end">0%</text>
    ${rateLines}
    ${!validHours.length ? `<text x="${width / 2}" y="${pad.top + plotHeight / 2}" class="chart-empty-note" text-anchor="middle">暂无失败率数据</text>` : ''}
    ${labels}
    ${points}
  </svg>
    </div>
  </article>`;
}

function normalizeChartHours(hours) {
  const byHour = new Map((Array.isArray(hours) ? hours : []).map((hour) => [Number(hour.hour), hour]));
  return Array.from({ length: 24 }, (_, hour) => {
    const item = byHour.get(hour) || {};
    return {
      hour,
      label: item.label || `${String(hour).padStart(2, '0')}:00`,
      done: Number(item.done || 0),
      failed: Number(item.failed || 0),
      total: Number(item.total || 0),
      successRate: Number(item.successRate || 0)
    };
  });
}

function hourFailureRate(hour) {
  const total = Number(hour?.total || 0);
  return total ? Number(hour?.failed || 0) / total : 0;
}

function renderErrorLogs(logs) {
  const list = Array.isArray(logs) ? logs : [];
  el.errorLogCount.textContent = list.length ? `最近 7 天失败请求 · ${list.length} 条` : '最近 7 天没有失败请求';
  el.errorLogList.innerHTML = list.length
    ? list.map(renderErrorLog).join('')
    : '<div class="empty small">最近 7 天没有失败请求</div>';
}

function renderErrorLog(log) {
  const requestJson = escapeHtml(JSON.stringify(log.request || {}, null, 2));
  const routeText = log.accountRouteId ? `账号 #${log.accountRouteId}` : '未路由账号';
  const sourceText = log.source === 'direct' ? 'URL' : '网页';
  const detail = log.errorDetail || log.error || '未知错误';
  return `<article class="data-row error-log-row">
    <div class="row-main">
      <div class="row-heading">
        <span class="status-badge danger">失败</span>
        <strong>${escapeHtml(log.error || '未知错误')}</strong>
      </div>
      <span class="step-route">${escapeHtml([sourceText, routeText, formatDuration(log.durationMs), formatBeijingDate(log.updatedAt)].filter(Boolean).join(' · '))}</span>
      <details class="error-detail">
        <summary>查看失败原因和请求参数</summary>
        <div class="error-detail-grid">
          <div>
            <strong>失败原因</strong>
            <pre>${escapeHtml(detail)}</pre>
          </div>
          <div>
            <strong>请求参数</strong>
            <pre>${requestJson}</pre>
          </div>
        </div>
      </details>
    </div>
    <div class="pill">${escapeHtml(log.userToken || '-')}</div>
  </article>`;
}

function renderJobs(jobs) {
  const pageCount = Math.max(1, Math.ceil(jobs.length / jobPageSize));
  const start = (state.jobPage - 1) * jobPageSize;
  const pageJobs = jobs.slice(start, start + jobPageSize);
  el.jobCountText.textContent = jobs.length
    ? `${start + 1}-${start + pageJobs.length} / ${jobs.length} 条`
    : '0 条';
  el.jobList.innerHTML = pageJobs.length
    ? pageJobs.map(renderJob).join('')
    : '<div class="empty small">暂无任务</div>';
  el.jobPageText.textContent = `第 ${state.jobPage} / ${pageCount} 页`;
  el.jobPrevBtn.disabled = state.jobPage <= 1;
  el.jobNextBtn.disabled = state.jobPage >= pageCount;
}

function renderUsers(users) {
  const filtered = filteredUsers(users);
  const visible = visibleUsers(users);
  el.userCountText.textContent = el.userSearch.value.trim()
    ? `${filtered.length} / ${users.length} 个密钥`
    : `${users.length} 个密钥`;
  el.userList.innerHTML = visible.length
    ? visible.map(renderUser).join('')
    : '<div class="empty small">没有匹配的密钥</div>';
  syncSelectionControls();
}

function renderImages(data) {
  const total = Number(data?.total ?? state.imageTotal ?? 0);
  const matched = Number(data?.matched ?? state.imageMatched ?? total);
  const rows = selectedImageRows();
  const pageCount = Math.max(1, Math.ceil(matched / state.imagePageSize));
  const offset = data?.offset ?? (state.imagePage - 1) * state.imagePageSize;
  const start = matched ? offset + 1 : 0;
  const end = offset + state.images.length;
  const tierText = el.imageTier.value ? ` · ${el.imageTier.value}` : '';
  el.imageCountText.textContent = el.imageSearch.value.trim() || el.imageTier.value
    ? `${start}-${end} / ${matched} · ${rows} 行`
    : `${start}-${end} / ${total} · ${rows} 行`;
  if (tierText) el.imageCountText.textContent += tierText;
  el.metricImages.textContent = Number.isFinite(total) ? total : '统计中';
  el.imageList.innerHTML = state.images.length
    ? state.images.map(renderImage).join('')
    : '<div class="empty small">暂无缓存图片</div>';
  el.imagePageText.textContent = `第 ${state.imagePage} / ${pageCount} 页`;
  el.imagePrevBtn.disabled = state.imagePage <= 1;
  el.imageNextBtn.disabled = state.imagePage >= pageCount;
}

function renderAccounts(accounts = state.summary?.accounts || []) {
  el.accountList.innerHTML = accounts.length
    ? accounts.map(renderAccount).join('')
    : '<div class="empty small">暂无账号</div>';
}

function changeJobPage(delta) {
  const jobs = state.summary?.jobs || [];
  const pageCount = Math.max(1, Math.ceil(jobs.length / jobPageSize));
  state.jobPage = Math.max(1, Math.min(pageCount, state.jobPage + delta));
  renderJobs(jobs);
}

async function changeImagePage(delta) {
  const pageCount = Math.max(1, Math.ceil(state.imageMatched / state.imagePageSize));
  const nextPage = Math.max(1, Math.min(pageCount, state.imagePage + delta));
  if (nextPage === state.imagePage) return;
  state.imagePage = nextPage;
  await refreshImages(false);
}

function renderAccount(account) {
  const checked = state.selectedAccounts.has(account.id) ? 'checked' : '';
  const testing = state.testingAccounts.has(account.id);
  const status = account.enabled ? '已启用' : '已禁用';
  const statusClass = account.enabled ? 'ok' : 'muted';
  const lastUsed = account.lastUsedAt ? `最近使用 ${formatDate(account.lastUsedAt)}` : '尚未使用';
  const stats1h = account.stats1h || { done: 0, failed: 0, total: 0, successRate: 0 };
  const proxyText = account.proxyUrl ? `SOCKS5 ${account.proxyUrl}` : 'SOCKS5 -';
  const quotaText = account.quotaError
    ? '点数查询失败'
    : account.quotaPoints === null || account.quotaPoints === undefined
      ? '点数未查询'
      : `${formatNumber(account.quotaPoints)} 点`;
  return `<article class="data-row selectable account-row">
    <input class="row-check account-select" type="checkbox" value="${escapeHtml(account.id)}" ${checked} />
    <div class="row-main">
      <div class="row-heading">
        <strong>#${account.routeId || '-'} ${escapeHtml(account.name || 'NovelAI 账号')}</strong>
        <span class="status-badge ${statusClass}">${status}</span>
      </div>
      <span class="token-text">${escapeHtml(account.token)}</span>
      <span class="token-text">${escapeHtml(proxyText)}</span>
      <span>${lastUsed}</span>
    </div>
    <div class="row-stats">
      <span><b>${account.inFlight}</b> 运行中</span>
      <span><b>${escapeHtml(quotaText)}</b></span>
      <span><b>${formatPercent(stats1h.successRate)}</b>% 1h成功率</span>
      <span><b>${stats1h.total || 0}</b> 1h请求</span>
      <button class="row-action account-test-btn" type="button" data-account-id="${escapeHtml(account.id)}" ${testing ? 'disabled' : ''}>${testing ? '测试中' : '测试'}</button>
    </div>
  </article>`;
}

function renderUser(user) {
  const checked = state.selectedUsers.has(user.id) ? 'checked' : '';
  return `<article class="data-row selectable user-row">
    <input class="row-check user-select" type="checkbox" value="${escapeHtml(user.id)}" ${checked} />
    <div class="row-main">
      <strong class="token-text">${escapeHtml(user.token)}</strong>
      <span>${escapeHtml(user.note || user.sourceCard || '未备注')} · ${formatDate(user.createdAt)}</span>
    </div>
    <div class="pill">${user.balance} 点</div>
  </article>`;
}

function renderJob(job) {
  const status = jobStatusText(job.status);
  const statusClass = jobStatusClass(job.status);
  const requestedSteps = Number(job.requestedSteps || 0);
  const routedSteps = Number(job.routedSteps || 0);
  const stepText = requestedSteps && routedSteps
    ? `请求步数 ${requestedSteps} · 路由步数 ${routedSteps}`
    : '';
  const sourceText = job.source === 'direct' ? 'URL' : '网页';
  const accountText = job.accountRouteId ? `路由账号 #${job.accountRouteId}` : '路由账号 -';
  const durationText = jobDurationText(job);
  const queueText = job.status === 'queued' && job.queuePosition
    ? `排队中：第 ${job.queuePosition} / ${job.queuedCount} 个`
    : '';
  return `<article class="data-row job-row">
    <div class="row-main">
      <div class="row-heading">
        <span class="status-badge ${statusClass}">${status}</span>
        <span class="job-time">${escapeHtml(formatDate(job.createdAt))}</span>
      </div>
      <span class="step-route">${escapeHtml([sourceText, accountText, durationText].filter(Boolean).join(' · '))}</span>
      ${stepText ? `<span class="step-route">${escapeHtml(stepText)}</span>` : ''}
      ${queueText ? `<span>${escapeHtml(queueText)}</span>` : ''}
      ${job.error ? `<span class="error-line">${escapeHtml(job.error)}</span>` : ''}
    </div>
    <div class="pill">${job.cost || 0} 点</div>
  </article>`;
}

function selectedImageRows() {
  const rows = Number(el.imageRows?.value || 3);
  return [3, 5, 8].includes(rows) ? rows : 3;
}

function imagePageLimit() {
  return selectedImageRows() * imageGridColumns();
}

function imageGridColumns() {
  const columns = getComputedStyle(el.imageList).gridTemplateColumns
    .split(' ')
    .filter((value) => value && value !== 'none').length;
  if (columns > 0) return columns;
  const width = el.imageList.clientWidth || 1200;
  return Math.max(1, Math.floor(width / 256));
}

function renderImage(image) {
  const requestedSteps = Number(image.requestedSteps || 0);
  const routedSteps = Number(image.routedSteps || 0);
  const stepText = requestedSteps && routedSteps
    ? `步数 ${requestedSteps}${requestedSteps === routedSteps ? '' : ` → ${routedSteps}`}`
    : '';
  return `<article class="image-card">
    <button class="image-preview-trigger" type="button" data-image-id="${escapeHtml(image.id)}">
      <img src="${escapeHtml(image.imageUrl)}" alt="缓存图片预览" loading="lazy" />
    </button>
    <div class="image-card-body">
      <strong title="${escapeHtml(image.prompt || image.id)}">${escapeHtml(image.prompt || image.id)}</strong>
      <div class="image-meta-line">
        <span>${escapeHtml(image.width)}x${escapeHtml(image.height)}</span>
        <span>${escapeHtml(stepText || image.model)}</span>
      </div>
      <div class="image-meta-line">
        <span>${escapeHtml(image.token)}</span>
        <span>${formatDate(image.createdAt)}</span>
      </div>
    </div>
  </article>`;
}

function jobStatusText(status) {
  const labels = {
    queued: '排队中',
    running: '生成中',
    done: '已完成',
    failed: '失败'
  };
  return labels[status] || status || '未知';
}

function jobStatusClass(status) {
  if (status === 'done') return 'ok';
  if (status === 'failed') return 'danger';
  if (status === 'running') return 'active';
  return 'muted';
}

function jobDurationText(job = {}) {
  const rawDuration = Number(job.durationMs);
  if (Number.isFinite(rawDuration) && rawDuration >= 0) return `耗时 ${formatDuration(rawDuration)}`;
  const started = Date.parse(job.createdAt || '');
  if (!started) return '';
  const terminal = ['done', 'failed'].includes(job.status);
  const ended = terminal ? Date.parse(job.completedAt || job.updatedAt || '') : Date.now();
  if (!ended || ended < started) return '';
  return `耗时 ${formatDuration(ended - started)}`;
}

function handleImagePreview(event) {
  const trigger = event.target.closest('.image-preview-trigger');
  if (!trigger) return;
  const image = state.images.find((item) => item.id === trigger.dataset.imageId);
  if (!image) return;
  el.previewImage.src = image.imageUrl;
  el.previewTitle.textContent = image.prompt || image.id;
  el.previewInfo.textContent = `${image.width}x${image.height} · ${image.model} · ${formatDate(image.createdAt)}`;
  el.imagePreview.classList.remove('hidden');
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
}

function closeImagePreview() {
  el.imagePreview.classList.add('hidden');
  el.previewImage.removeAttribute('src');
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
}

function filteredUsers(users) {
  const q = el.userSearch.value.trim().toLowerCase();
  if (!q) return users;
  return users.filter((user) => [user.token, user.note, user.sourceCard, user.id]
    .some((value) => String(value || '').toLowerCase().includes(q)));
}

function visibleUsers(users) {
  return filteredUsers(users).slice(0, userRenderLimit);
}

function handleUserSelection(event) {
  if (!event.target.classList.contains('user-select')) return;
  toggleSelection(state.selectedUsers, event.target.value, event.target.checked);
  syncSelectionControls();
}

function handleAccountSelection(event) {
  if (!event.target.classList.contains('account-select')) return;
  toggleSelection(state.selectedAccounts, event.target.value, event.target.checked);
  syncSelectionControls();
}

function handleAccountAction(event) {
  const testButton = event.target.closest('.account-test-btn');
  if (!testButton) return;
  event.preventDefault();
  event.stopPropagation();
  testAccount(testButton.dataset.accountId);
}

function toggleAllUsers() {
  const users = visibleUsers(state.summary?.users || []);
  if (el.selectAllUsers.checked) users.forEach((user) => state.selectedUsers.add(user.id));
  else users.forEach((user) => state.selectedUsers.delete(user.id));
  renderUsers(state.summary?.users || []);
}

function toggleAllAccounts() {
  const accounts = state.summary?.accounts || [];
  state.selectedAccounts = el.selectAllAccounts.checked ? new Set(accounts.map((account) => account.id)) : new Set();
  renderSummary(state.summary);
}

function toggleSelection(set, value, checked) {
  if (checked) set.add(value);
  else set.delete(value);
}

function pruneSelections() {
  const userIds = new Set((state.summary?.users || []).map((user) => user.id));
  const accountIds = new Set((state.summary?.accounts || []).map((account) => account.id));
  state.selectedUsers.forEach((id) => {
    if (!userIds.has(id)) state.selectedUsers.delete(id);
  });
  state.selectedAccounts.forEach((id) => {
    if (!accountIds.has(id)) state.selectedAccounts.delete(id);
  });
}

function syncSelectionControls() {
  const shownUsers = visibleUsers(state.summary?.users || []);
  const visibleAccounts = state.summary?.accounts || [];
  el.selectAllUsers.checked = Boolean(shownUsers.length) && shownUsers.every((user) => state.selectedUsers.has(user.id));
  el.selectAllAccounts.checked = Boolean(visibleAccounts.length) && visibleAccounts.every((account) => state.selectedAccounts.has(account.id));
}

async function api(path, options = {}) {
  if (options.admin && !state.adminToken) {
    throw new Error('请先输入 Admin Token');
  }
  const headers = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.admin) headers['x-admin-token'] = state.adminToken;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 20000));
  try {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    throw normalizeNetworkError(error);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeNetworkError(error) {
  if (error?.name === 'AbortError') return new Error('连接后台超时，请刷新后重试');
  if (/Failed to fetch|NetworkError/i.test(String(error?.message || ''))) return new Error('连接不到后台服务，请检查部署状态');
  return error;
}

function normalizeErrorMessage(error) {
  const message = String(error?.message || error || '');
  if (message === 'admin token required.') return '请先输入 Admin Token';
  if (message === 'invalid token.') return 'Admin Token 不正确';
  return message;
}

function downloadJson(filename, data) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], { type: 'application/json' });
  downloadBlob(filename, blob);
}

function downloadText(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  downloadBlob(filename, blob);
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function debounce(fn, wait) {
  let timer = null;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function dateStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function formatDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function formatBeijingDate(value) {
  if (!value) return '';
  return new Date(value).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function formatDuration(value) {
  const ms = Math.max(0, Number(value || 0));
  if (ms < 1000) return `${ms}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds % 60);
  return `${minutes}m ${rest}s`;
}

function formatPercent(value) {
  return (Number(value || 0) * 100).toFixed(2);
}

function formatNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return '-';
  return number.toLocaleString('zh-CN', { maximumFractionDigits: 0 });
}

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  state.toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

