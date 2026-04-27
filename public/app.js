import { enhanceSelects } from './select-ui.js';

const state = {
  settings: null,
  token: localStorage.getItem('nai.userToken') || '',
  toastTimer: null,
  pollTimer: null,
  queueViewTimer: null,
  queueView: null,
  queueViewCompleteTimer: null,
  generating: false,
  previewScale: 1,
  previewPanX: 0,
  previewPanY: 0,
  previewDragging: false,
  previewDragged: false,
  previewLastX: 0,
  previewLastY: 0,
  lastPreviewWheelAt: 0
};

const ids = [
  'balanceText',
  'userToken',
  'saveTokenBtn',
  'promptInput',
  'artistInput',
  'samplerInput',
  'sizeInput',
  'stepsInput',
  'scaleInput',
  'cfgInput',
  'negativeInput',
  'directGenerateBtn',
  'copySnippetTopBtn',
  'imageFrame',
  'jobText',
  'resultPreview',
  'closeResultPreviewBtn',
  'resultPreviewImage',
  'toast'
];
const el = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));

const maxSteps = 28;
const maxUrlSteps = 28;
const defaultSteps = 28;

const paramOrder = [
  'tag',
  'token',
  'model',
  'artist',
  'size',
  'steps',
  'scale',
  'cfg',
  'sampler',
  'negative',
  'nocache',
  'noise_schedule'
];

const snippetParamOrder = [
  'tag',
  'token',
  'model',
  'artist',
  'size',
  'steps',
  'scale',
  'cfg',
  'sampler',
  'negative',
  'nocache',
  'noise_schedule'
];

await boot();

async function boot() {
  bindEvents();
  el.userToken.value = state.token;
  await loadSettings();
  applyDefaults();
  enhanceSelects();
  updateUrlOutputs();
  if (state.token) await loadMe().catch(() => {});
}

function bindEvents() {
  el.saveTokenBtn.addEventListener('click', saveToken);
  el.directGenerateBtn.addEventListener('click', startJob);
  el.copySnippetTopBtn.addEventListener('click', () => copyText(buildSnippet(), '嵌入代码已复制'));
  el.imageFrame.addEventListener('click', handleResultPreview);
  el.resultPreviewImage.addEventListener('click', toggleResultZoom);
  el.resultPreviewImage.addEventListener('pointerdown', startPreviewDrag);
  el.resultPreview.addEventListener('pointermove', movePreviewDrag);
  el.resultPreview.addEventListener('pointerup', stopPreviewDrag);
  el.resultPreview.addEventListener('pointercancel', stopPreviewDrag);
  el.resultPreview.addEventListener('pointerleave', stopPreviewDrag);
  el.resultPreview.addEventListener('wheel', handlePreviewWheel, { passive: false });
  el.closeResultPreviewBtn.addEventListener('click', closeResultPreview);
  el.resultPreview.addEventListener('click', (event) => {
    if (event.target === el.resultPreview) closeResultPreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.resultPreview.classList.contains('hidden')) closeResultPreview();
  });

  [
    el.userToken,
    el.promptInput,
    el.artistInput,
    el.samplerInput,
    el.sizeInput,
    el.stepsInput,
    el.scaleInput,
    el.cfgInput,
    el.negativeInput
  ].forEach((input) => input.addEventListener('input', updateUrlOutputs));
}

async function loadSettings() {
  state.settings = await api('/api/settings');
}

function applyDefaults() {
  el.artistInput.value = state.settings.defaultArtist || '';
  el.negativeInput.value = state.settings.defaultNegative || '';
  el.samplerInput.value = state.settings.defaults?.sampler || 'k_dpmpp_2m_sde';
  el.sizeInput.value = state.settings.defaults?.size || '竖图';
  el.stepsInput.value = normalizeSteps(state.settings.defaults?.steps || defaultSteps);
  el.scaleInput.value = state.settings.defaults?.scale || 6;
  el.cfgInput.value = state.settings.defaults?.cfg || 0;
}

async function saveToken() {
  try {
    state.token = el.userToken.value.trim();
    localStorage.setItem('nai.userToken', state.token);
    updateUrlOutputs();
    await loadMe();
  } catch (error) {
    showToast(error.message, true);
  }
}

async function loadMe() {
  if (!state.token) return;
  const user = await api(`/api/me?token=${encodeURIComponent(state.token)}`);
  el.balanceText.textContent = `${user.balance} 点可用`;
}

function collectParams() {
  return {
    token: el.userToken.value.trim(),
    tag: el.promptInput.value.trim(),
    model: 'nai-diffusion-4-5-full',
    artist: el.artistInput.value.trim(),
    size: el.sizeInput.value,
    steps: normalizeSteps(el.stepsInput.value),
    scale: el.scaleInput.value,
    cfg: el.cfgInput.value,
    sampler: el.samplerInput.value,
    negative: el.negativeInput.value.trim(),
    nocache: '1',
    noise_schedule: 'karras'
  };
}

function normalizeSteps(value) {
  const steps = Number(value);
  if (!Number.isFinite(steps)) return defaultSteps;
  return Math.max(1, Math.min(maxSteps, Math.floor(steps)));
}

function buildGenerateUrl(overrides = {}) {
  const values = clampUrlParams({ ...collectParams(), ...overrides });
  const params = new URLSearchParams();
  paramOrder.forEach((key) => {
    const value = values[key];
    if (value !== undefined && value !== '') params.set(key, value);
  });
  return `${location.origin}/generate?${params.toString()}`;
}

function readableQueryValue(value) {
  return String(value)
    .replace(/\r?\n/g, '\\n')
    .replace(/&/g, '%26')
    .replace(/=/g, '%3D')
    .replace(/#/g, '%23')
    .replace(/"/g, '%22')
    .replace(/</g, '%3C')
    .replace(/>/g, '%3E');
}

function buildReadableGenerateUrl(overrides = {}) {
  const values = clampUrlParams({ ...collectParams(), nocache: '0', ...overrides });
  const query = snippetParamOrder
    .filter((key) => values[key] !== undefined && values[key] !== '')
    .map((key) => `${key}=${readableQueryValue(values[key])}`)
    .join('&');
  return `${location.origin}/generate?${query}`;
}

function clampUrlParams(values) {
  return {
    ...values,
    steps: Math.min(maxUrlSteps, normalizeSteps(values.steps))
  };
}

function buildSnippet() {
  const url = buildReadableGenerateUrl({ token: collectParams().token || 'STA1N-XXXXXX', tag: '$1' });
  return `<div style="width: auto; height: auto; max-width: 100%; border: 8px solid transparent; background-image: linear-gradient(45deg, #FFC9D9, #CCE5FF); position: relative; border-radius: 16px; overflow: hidden; display: flex; justify-content: center; align-items: center; animation: gradientBG 3s ease infinite; box-shadow: 0 4px 15px rgba(204,229,255,0.3);"><div style="background: rgba(255,255,255,0.85); backdrop-filter: blur(5px); width: 100%; height: 100%; position: absolute; top: 0; left: 0;"></div><img src="${url}"  alt="生成图片" style="max-width: 100%; height: auto; width: auto; display: block; object-fit: contain; transition: transform 0.3s ease; position: relative; z-index: 1;"></div><style>@keyframes gradientBG {0% {background-image: linear-gradient(45deg, #FFC9D9, #CCE5FF);}50% {background-image: linear-gradient(225deg, #FFC9D9, #CCE5FF);}100% {background-image: linear-gradient(45deg, #FFC9D9, #CCE5FF);}}</style>`;
}

function updateUrlOutputs() {
  // The embed code is generated on demand for the copy button.
}

async function directGenerate() {
  if (state.generating) return;
  setGenerateBusy(true);
  updateUrlOutputs();
  renderLoadingFrame();
  const img = new Image();
  img.alt = '生成图片';
  img.onload = async () => {
    renderResultImage(img.src);
    await loadMe().catch(() => {});
    showToast('图片已生成');
    setGenerateBusy(false);
  };
  img.onerror = () => {
    renderFrameNotice('图片加载失败', true);
    showToast('图片加载失败', true);
    setGenerateBusy(false);
  };
  img.src = `${buildGenerateUrl()}&t=${Date.now()}`;
}

async function startJob() {
  if (state.generating) return;
  setGenerateBusy(true);
  renderLoadingFrame();
  clearInterval(state.pollTimer);
  try {
    const params = collectParams();
    const job = await api('/api/jobs', {
      method: 'POST',
      body: {
        token: params.token,
        tag: params.tag,
        model: params.model,
        artist: params.artist,
        size: params.size,
        steps: Number(params.steps),
        scale: Number(params.scale),
        cfg: Number(params.cfg),
        sampler: params.sampler,
        negative: params.negative,
        nocache: '1',
        noise_schedule: params.noise_schedule
      }
    });
    resetQueueView(job);
    el.jobText.textContent = jobStatusText(job);
    updateLoadingStatus(job);
    await loadMe().catch(() => {});
    state.pollTimer = setInterval(() => pollJob(job.id), 1100);
    await pollJob(job.id);
  } catch (error) {
    renderFrameNotice('生成失败', true);
    setGenerateBusy(false);
    showToast(error.message, true);
  }
}

async function pollJob(id) {
  let job;
  try {
    job = await api(`/api/jobs/${id}?token=${encodeURIComponent(el.userToken.value.trim())}`);
  } catch (error) {
    if (error.status >= 500 || /Unexpected end of JSON input/i.test(error.message)) {
      el.jobText.textContent = '连接重试中';
      return;
    }
    clearInterval(state.pollTimer);
    renderFrameNotice('生成失败', true);
    showToast(error.message, true);
    setGenerateBusy(false);
    return;
  }

  el.jobText.textContent = jobStatusText(job);
  updateLoadingStatus(job);
  if (job.status === 'done') {
    clearInterval(state.pollTimer);
    clearQueueView();
    renderResultImage(job.imageUrl);
    await loadMe().catch(() => {});
    showToast('图片已生成');
    setGenerateBusy(false);
  }
  if (job.status === 'failed') {
    clearInterval(state.pollTimer);
    clearQueueView();
    renderFrameNotice('生成失败', true);
    showToast(job.error || '任务失败', true);
    setGenerateBusy(false);
  }
}

function renderLoadingFrame() {
  clearQueueView();
  closeResultPreview();
  el.jobText.textContent = '生成中';
  el.imageFrame.classList.remove('result-ready');
  el.imageFrame.classList.add('loading');
  el.imageFrame.innerHTML = `<div class="loading-state" role="status" aria-live="polite">
    <div class="loading-orbit"><span></span><span></span><span></span></div>
    <strong>正在生成图片</strong>
    <p id="loadingStatusText">任务已提交，正在分配账号</p>
    <div class="loading-steps" aria-hidden="true">
      <span class="active">提交任务</span>
      <span>路由账号</span>
      <span>等待成图</span>
    </div>
  </div>`;
}

function updateLoadingStatus(job) {
  const target = document.querySelector('#loadingStatusText');
  if (!target) return;
  if (job.status === 'queued') {
    const view = updateQueueView(job);
    const count = Number(view.count || 0);
    const position = Number(view.position || 0);
    target.textContent = position > 1 ? `正在排队，当前第 ${position} / ${count} 个` : '准备生成，正在等待可用账号';
    el.jobText.textContent = queueStatusText(position, count);
    setLoadingStep(1);
    return;
  }
  if (job.status === 'running') {
    if (finishQueueView(job)) return;
    clearQueueView();
    target.textContent = '账号已分配，NovelAI 正在生成';
    setLoadingStep(2);
    return;
  }
  if (job.status === 'done') target.textContent = '生成完成，正在载入图片';
}

function resetQueueView(job = {}) {
  clearQueueView();
  const total = Number(job.queuedCount || 0);
  const position = Number(job.queuePosition || 0);
  if (job.status !== 'queued' || !total || !position) return;
  state.queueView = {
    position: Math.max(1, position),
    target: Math.max(1, position),
    count: Math.max(1, total)
  };
}

function updateQueueView(job = {}) {
  const total = Math.max(1, Number(job.queuedCount || 1));
  const target = Math.max(1, Number(job.queuePosition || 1));
  if (!state.queueView) {
    state.queueView = { position: target, target, count: total, completing: false };
  } else {
    state.queueView.count = Math.max(state.queueView.count, total);
    state.queueView.target = Math.max(state.queueView.target, target);
  }
  ensureQueueViewTimer();
  return state.queueView;
}

function finishQueueView(job = {}) {
  if (!state.queueView) return false;
  const total = Math.max(
    Number(state.queueView.count || 0),
    Number(job.queuedCount || 0),
    Number(job.queuePosition || 0)
  );
  if (total <= 1 || state.queueView.position >= total) {
    clearQueueView();
    return false;
  }
  state.queueView.count = total;
  state.queueView.target = total;
  state.queueView.completing = true;
  if (state.queueViewTimer) {
    clearInterval(state.queueViewTimer);
    state.queueViewTimer = null;
  }
  ensureQueueViewTimer();
  renderQueueText();
  return true;
}

function ensureQueueViewTimer() {
  if (state.queueViewTimer) return;
  state.queueViewTimer = setInterval(() => {
    if (!state.queueView) {
      clearQueueView();
      return;
    }
    if (state.queueView.position < state.queueView.target) {
      state.queueView.position += 1;
      renderQueueText();
      return;
    }
    if (state.queueView.completing) {
      const target = document.querySelector('#loadingStatusText');
      state.queueView.completing = false;
      clearQueueView();
      if (target) target.textContent = '账号已分配，NovelAI 正在生成';
      el.jobText.textContent = '生成中';
      setLoadingStep(2);
    }
  }, state.queueView?.completing ? 120 : 420);
}

function renderQueueText() {
  const target = document.querySelector('#loadingStatusText');
  if (!target || !state.queueView) return;
  const { position, count } = state.queueView;
  el.jobText.textContent = queueStatusText(position, count);
  target.textContent = position > 1
    ? `正在排队，当前第 ${position} / ${count} 个`
    : '准备生成，正在等待可用账号';
}

function setLoadingStep(activeIndex) {
  document.querySelectorAll('.loading-steps span').forEach((item, index) => {
    item.classList.toggle('active', index <= activeIndex);
  });
}

function clearQueueView() {
  if (state.queueViewTimer) clearInterval(state.queueViewTimer);
  if (state.queueViewCompleteTimer) clearTimeout(state.queueViewCompleteTimer);
  state.queueViewTimer = null;
  state.queueViewCompleteTimer = null;
  state.queueView = null;
}

function renderFrameNotice(message, isError = false) {
  el.imageFrame.classList.remove('result-ready', 'loading');
  el.imageFrame.innerHTML = `<span class="${isError ? 'frame-error' : ''}">${message}</span>`;
}

function renderResultImage(src) {
  el.imageFrame.classList.remove('loading');
  el.imageFrame.classList.add('result-ready');
  el.imageFrame.innerHTML = `<button class="result-image-button" type="button" aria-label="放大预览生成图片"><img src="${src}" alt="生成图片"></button>`;
}

function handleResultPreview(event) {
  const image = event.target.closest('.result-image-button img');
  if (!image) return;
  el.resultPreviewImage.src = image.currentSrc || image.src;
  setPreviewScale(1);
  el.resultPreview.classList.remove('hidden');
  el.resultPreview.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
}

function toggleResultZoom(event) {
  event.stopPropagation();
  if (state.previewDragged) {
    state.previewDragged = false;
    return;
  }
  setPreviewScale(state.previewScale > 1 ? 1 : (isCoarsePointer() ? 1.55 : 1.75));
}

function handlePreviewWheel(event) {
  if (isCoarsePointer() || el.resultPreview.classList.contains('hidden')) return;
  event.preventDefault();
  const now = performance.now();
  if (now - state.lastPreviewWheelAt < 22) return;
  state.lastPreviewWheelAt = now;
  const delta = Math.max(-120, Math.min(120, event.deltaY));
  const nextScale = state.previewScale * Math.exp(-delta * 0.0012);
  setPreviewScale(nextScale);
}

function setPreviewScale(value) {
  const scale = Math.max(1, Math.min(3.5, Number(value) || 1));
  state.previewScale = scale;
  el.resultPreview.classList.toggle('zoomed', scale > 1.01);
  el.resultPreviewImage.classList.toggle('zoomed', scale > 1.01);
  el.resultPreviewImage.style.setProperty('--preview-scale', String(scale));
  if (scale <= 1.01) {
    state.previewPanX = 0;
    state.previewPanY = 0;
  }
  applyPreviewTransform();
}

function startPreviewDrag(event) {
  if (state.previewScale <= 1.01 || isCoarsePointer()) return;
  event.preventDefault();
  state.previewDragging = true;
  state.previewDragged = false;
  state.previewLastX = event.clientX;
  state.previewLastY = event.clientY;
  el.resultPreviewImage.setPointerCapture?.(event.pointerId);
}

function movePreviewDrag(event) {
  if (!state.previewDragging) return;
  event.preventDefault();
  const dx = event.clientX - state.previewLastX;
  const dy = event.clientY - state.previewLastY;
  if (Math.abs(dx) + Math.abs(dy) > 2) state.previewDragged = true;
  state.previewPanX += dx;
  state.previewPanY += dy;
  state.previewLastX = event.clientX;
  state.previewLastY = event.clientY;
  applyPreviewTransform();
}

function stopPreviewDrag() {
  state.previewDragging = false;
}

function applyPreviewTransform() {
  el.resultPreviewImage.style.transform = `translate(${state.previewPanX}px, ${state.previewPanY}px) scale(${state.previewScale})`;
}

function isCoarsePointer() {
  return window.matchMedia('(pointer: coarse)').matches;
}

function closeResultPreview() {
  el.resultPreview.classList.add('hidden');
  el.resultPreview.classList.remove('zoomed');
  el.resultPreview.setAttribute('aria-hidden', 'true');
  el.resultPreviewImage.classList.remove('zoomed');
  el.resultPreviewImage.style.removeProperty('--preview-scale');
  el.resultPreviewImage.style.removeProperty('transform');
  state.previewScale = 1;
  state.previewPanX = 0;
  state.previewPanY = 0;
  state.previewDragging = false;
  state.previewDragged = false;
  el.resultPreviewImage.removeAttribute('src');
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
}

function jobStatusText(job) {
  if (job.status === 'queued') {
    const view = state.queueView || {
      count: Number(job.queuedCount || 0),
      position: Number(job.queuePosition || 0)
    };
    return queueStatusText(view.position, view.count);
  }
  if (job.status === 'running') return '生成中';
  if (job.status === 'done') return '生成完成';
  if (job.status === 'failed') return '生成失败';
  return job.status || '等待请求';
}

function queueStatusText(position, count) {
  const total = Number(count || 0);
  const current = Number(position || 0);
  if (current <= 1 && total <= 1) return '准备生成中';
  return current ? `排队中（第 ${current} / ${total} 个）` : `排队中（${total} 个）`;
}

function setGenerateBusy(isBusy) {
  state.generating = isBusy;
  el.directGenerateBtn.disabled = isBusy;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'content-type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  const text = await response.text();
  const payload = text ? safeJson(text) : {};
  if (!response.ok) {
    const error = new Error(payload.error || text || `HTTP ${response.status}`);
    error.status = response.status;
    throw error;
  }
  return payload;
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

async function copyText(text, message) {
  await navigator.clipboard.writeText(text);
  showToast(message);
}

function showToast(message, isError = false) {
  clearTimeout(state.toastTimer);
  el.toast.textContent = message;
  el.toast.classList.toggle('error', isError);
  el.toast.classList.add('show');
  state.toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2600);
}
