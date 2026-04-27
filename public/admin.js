import { enhanceSelects } from './select-ui.js';

const state = {
  adminToken: localStorage.getItem('nai.adminToken') || '',
  selectedUsers: new Set(),
  selectedAccounts: new Set(),
  summary: null,
  images: [],
  imagePage: 1,
  imagePageSize: 1,
  imageMatched: 0,
  jobPage: 1,
  toastTimer: null
};

const jobPageSize = 10;

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
  'userCount',
  'userCredits',
  'userNote',
  'createUsersBtn',
  'newUsersOutput',
  'maxCacheImages',
  'accountConcurrency',
  'saveSettingsBtn',
  'accountName',
  'accountToken',
  'addAccountBtn',
  'exportAccountsBtn',
  'accountImportText',
  'importAccountsBtn',
  'replaceAccountsBtn',
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
  'resetAccountStatsBtn',
  'deleteAccountsBtn',
  'userSearch',
  'selectAllUsers',
  'balanceAdjustValue',
  'setBalanceBtn',
  'addBalanceBtn',
  'deleteUsersBtn',
  'imageSearch',
  'imageRows',
  'refreshImagesBtn',
  'clearImagesBtn',
  'jobPrevBtn',
  'jobNextBtn',
  'jobPageText',
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
  el.resetAccountStatsBtn.addEventListener('click', resetSelectedAccountStats);
  el.deleteAccountsBtn.addEventListener('click', deleteSelectedAccounts);
  el.refreshImagesBtn.addEventListener('click', refreshImages);
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
  el.imageRows.addEventListener('change', () => {
    state.imagePage = 1;
    refreshImages();
  });
  el.userList.addEventListener('change', handleUserSelection);
  el.accountList.addEventListener('change', handleAccountSelection);
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
    renderSummary(summary);
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
    renderSummary(summary);
    await refreshImages(false);
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
    const accountConcurrency = Number(el.accountConcurrency.value);
    if (!Number.isFinite(maxCacheImages)) return showToast('请输入有效缓存数量', true);
    if (!Number.isFinite(accountConcurrency)) return showToast('请输入有效并发数', true);
    const settings = await api('/api/settings', {
      method: 'PUT',
      admin: true,
      body: {
        maxCacheImages,
        accountConcurrency
      }
    });
    el.maxCacheImages.value = settings.maxCacheImages;
    el.accountConcurrency.value = settings.accountConcurrency;
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
        token: el.accountToken.value.trim()
      }
    });
    el.accountToken.value = '';
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
    el.accountImportText.value = data.accounts.map((account) => account.token).join('\n');
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
    const data = await api(`/api/admin/images?${params.toString()}`, { admin: true });
    const matched = data.matched ?? 0;
    const pageCount = Math.max(1, Math.ceil(matched / limit));
    if (state.imagePage > pageCount) {
      state.imagePage = pageCount;
      return refreshImages(withToast);
    }
    state.images = data.images || [];
    state.imagePageSize = limit;
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

function renderSummary(summary) {
  const enabledAccounts = summary.accounts.filter((account) => account.enabled).length;
  const requestStats = requestStats1h(summary);
  const jobPageCount = Math.max(1, Math.ceil(summary.jobs.length / jobPageSize));
  if (state.jobPage > jobPageCount) state.jobPage = jobPageCount;
  el.metricUsers.textContent = summary.users.length;
  el.metricCredits.textContent = `${formatPercent(requestStats.successRate)}%`;
  el.metricAccounts.textContent = enabledAccounts;
  el.metricImages.textContent = summary.imageCount || 0;
  el.accountCount.textContent = `${summary.accounts.length} 个账号`;
  el.maxCacheImages.value = summary.settings?.maxCacheImages ?? 500;
  el.accountConcurrency.value = summary.settings?.accountConcurrency ?? 2;

  el.accountList.innerHTML = summary.accounts.length
    ? summary.accounts.map(renderAccount).join('')
    : '<div class="empty small">暂无账号</div>';

  renderUsers(summary.users);

  renderJobs(summary.jobs);

  syncSelectionControls();
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
  el.userCountText.textContent = el.userSearch.value.trim()
    ? `${filtered.length} / ${users.length} 个密钥`
    : `${users.length} 个密钥`;
  el.userList.innerHTML = filtered.length
    ? filtered.map(renderUser).join('')
    : '<div class="empty small">没有匹配的密钥</div>';
  syncSelectionControls();
}

function renderImages(data) {
  const total = data?.total ?? state.images.length;
  const matched = data?.matched ?? state.images.length;
  const rows = selectedImageRows();
  const pageCount = Math.max(1, Math.ceil(matched / state.imagePageSize));
  const offset = data?.offset ?? (state.imagePage - 1) * state.imagePageSize;
  const start = matched ? offset + 1 : 0;
  const end = offset + state.images.length;
  el.imageCountText.textContent = el.imageSearch.value.trim()
    ? `${start}-${end} / ${matched} · ${rows} 行`
    : `${start}-${end} / ${total} · ${rows} 行`;
  el.metricImages.textContent = total;
  el.imageList.innerHTML = state.images.length
    ? state.images.map(renderImage).join('')
    : '<div class="empty small">暂无缓存图片</div>';
  el.imagePageText.textContent = `第 ${state.imagePage} / ${pageCount} 页`;
  el.imagePrevBtn.disabled = state.imagePage <= 1;
  el.imageNextBtn.disabled = state.imagePage >= pageCount;
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
  const status = account.enabled ? '已启用' : '已禁用';
  const statusClass = account.enabled ? 'ok' : 'muted';
  const lastUsed = account.lastUsedAt ? `最近使用 ${formatDate(account.lastUsedAt)}` : '尚未使用';
  const stats1h = account.stats1h || { done: 0, failed: 0, total: 0, successRate: 0 };
  return `<article class="data-row selectable account-row">
    <input class="row-check account-select" type="checkbox" value="${escapeHtml(account.id)}" ${checked} />
    <div class="row-main">
      <div class="row-heading">
        <strong>#${account.routeId || '-'} ${escapeHtml(account.name || 'NovelAI 账号')}</strong>
        <span class="status-badge ${statusClass}">${status}</span>
      </div>
      <span class="token-text">${escapeHtml(account.token)}</span>
      <span>${lastUsed}</span>
    </div>
    <div class="row-stats">
      <span><b>${account.inFlight}</b> 运行中</span>
      <span><b>${formatPercent(stats1h.successRate)}</b>% 1h成功率</span>
      <span><b>${stats1h.total || 0}</b> 1h请求</span>
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
  const prompt = job.prompt || job.id;
  const requestedSteps = Number(job.requestedSteps || 0);
  const routedSteps = Number(job.routedSteps || 0);
  const stepText = requestedSteps && routedSteps
    ? `请求步数 ${requestedSteps} · 路由步数 ${routedSteps}`
    : '';
  const sourceText = job.source === 'direct' ? 'URL' : '网页';
  const accountText = job.accountRouteId ? `路由账号 #${job.accountRouteId}` : '路由账号 -';
  const durationText = job.durationMs ? `耗时 ${formatDuration(job.durationMs)}` : '';
  const queueText = job.status === 'queued' && job.queuePosition
    ? `排队中：第 ${job.queuePosition} / ${job.queuedCount} 个`
    : '';
  return `<article class="data-row job-row">
    <div class="row-main">
      <div class="row-heading">
        <span class="status-badge ${statusClass}">${status}</span>
        <span class="job-time">${escapeHtml(formatDate(job.createdAt))}</span>
      </div>
      <strong title="${escapeHtml(prompt)}">${escapeHtml(prompt)}</strong>
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

function toggleAllUsers() {
  const users = filteredUsers(state.summary?.users || []);
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
  const visibleUsers = filteredUsers(state.summary?.users || []);
  const visibleAccounts = state.summary?.accounts || [];
  el.selectAllUsers.checked = Boolean(visibleUsers.length) && visibleUsers.every((user) => state.selectedUsers.has(user.id));
  el.selectAllAccounts.checked = Boolean(visibleAccounts.length) && visibleAccounts.every((account) => state.selectedAccounts.has(account.id));
}

async function api(path, options = {}) {
  if (options.admin && !state.adminToken) {
    throw new Error('请先输入 Admin Token');
  }
  const headers = {};
  if (options.body) headers['content-type'] = 'application/json';
  if (options.admin) headers['x-admin-token'] = state.adminToken;
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
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

