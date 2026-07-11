import { enhanceSelects } from './select-ui.js';

const state = {
  settings: null,
  token: localStorage.getItem('nai.userToken') || '',
  userBalance: null,
  toastTimer: null,
  pollTimer: null,
  queueViewTimer: null,
  queueView: null,
  queueViewCompleteTimer: null,
  resultHistory: [],
  resultHistoryIndex: -1,
  generating: false,
  generationCount: 1,
  previewScale: 1,
  previewPanX: 0,
  previewPanY: 0,
  previewDragging: false,
  previewDragged: false,
  previewLastX: 0,
  previewLastY: 0,
  lastPreviewWheelAt: 0,
  convertingPrompt: false
};

const ids = [
  'balanceText',
  'tokenStatusDot',
  'userToken',
  'saveTokenBtn',
  'mergePanel',
  'toggleMergeBtn',
  'mergeToggleHint',
  'mergeFields',
  'mergeSourceToken',
  'mergeTokenBtn',
  'promptInput',
  'promptConvertBtn',
  'promptConvertModal',
  'promptConvertInput',
  'promptConvertSubmitBtn',
  'closePromptConvertBtn',
  'artistPresetInput',
  'artistInput',
  'samplerInput',
  'sizeInput',
  'stepsInput',
  'scaleInput',
  'cfgInput',
  'negativeInput',
  'directGenerateBtn',
  'generationCountControl',
  'copySnippetTopBtn',
  'imageFrame',
  'jobText',
  'resultPreview',
  'closeResultPreviewBtn',
  'prevResultBtn',
  'nextResultBtn',
  'resultPreviewImage',
  'toast'
];
const el = Object.fromEntries(ids.map((id) => [id, document.querySelector(`#${id}`)]));

const maxSteps = 28;
const maxUrlSteps = 28;
const defaultSteps = 28;
const jobPollIntervalMs = 450;
const queueStepIntervalMs = 75;
const queueCompleteStepIntervalMs = 15;
const artistPresets = {
  fresh: {
    label: '韩漫小清新风',
    value: 'masterpiece, best quality,[[[artist:dishwasher1910]]], {{yd_(orange_maru)}}, [artist:ciloranko], [artist:sho_(sho_lwlw)], [ningen mame], soft lighting,year 2024'
  },
  comicDoujin: {
    label: '动漫同人风',
    value: 'masterpiece, best quality, very aesthetic, modern Japanese anime, official anime art, anime key visual, anime screencap, soft cel shading, soft anime coloring, smooth color transitions, natural skin tones, restrained color palette, slightly desaturated, muted colors, soft ambient lighting, gentle contrast, subtle gradients, subtle bloom, detailed anime background'
  },
  '2.5d': {
    label: '2.5D唯美风',
    value: `0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, textless version, The image is highly intricate finished drawn. Only the character's face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,`
  },
  lolita25d: {
    label: '2.5D唯美风（萝）',
    value: `20::best quality, absurdres, very aesthetic, detailed, masterpiece::, 20::highly finished::, 10::ultra detailed::, 5::masterpiece::, 5::best quality::,

2.4::kidmo::, 1.2::omone hokoma agm::, 1.1::dino, wanke, liduke::, 0.8::rurudo, mignon, artist:pottsness, artist:toosaka asagi::, 0.7::misaka_12003-gou::, 0.6::artist:chocoan, artist:ciloranko, artist:rhasta, artist:sho_sho_lwlw::, dino_(dinoartforame), agoto, akakura, 0.9::rurudo(Only body shape), mignon(Only body shape) ::

year 2025, textless version, {{petite,loli}}, Petite figure, no text, The image is highly intricate finished drawn. Only the character's face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has graphic texture, realistic skin surface, and lifelike flesh with little obliques::, smooth line, glossy skin, realistic, 4k,

1.63::photorealistic::, 1.63::photo(medium)::, 3::simple background::, 2::depth of field::,

1.5::vivid color, lively color::, desaturated, muted tones, cinematic desaturation, pale aesthetic, silver-toned,

-2::green::, -1.5::vibrant, colorful, saturated::`
  },
  doujin: {
    label: '本子里番风',
    value: '1.4::asanagi::,{{{{{artist:asanagi}}}}},1.2::xiaoluo_xl::,1.3::Artist: misaka_12003-gou::,1.2::Artist:shexyo::,0.7::Artist:b.sa_(bbbs)::,1::Artist:qiandaiyiyu::,1.05::artist:natedecock::,1.05::artist:kunaboto::,0.75::artist:kandata_nijou::,1.05::artist:zer0.zer0 ::,1.05::artist:jasony::,0.75::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, {textless version, The image is highly intricate finished drawn,write realistically,true to life}, 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::, 1.63::photorealistic::,3::age slider::,1.63::photo(medium)::, 2::best quality, absurdres, very aesthetic, detailed, masterpiece::,-4::Muscle definition, abs::'
  },
  galgame: {
    label: 'GalGame风',
    value: 'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,'
  }
};

const sizeOptions = [
  { value: '竖图', label: '竖图(-1)', cost: 1 },
  { value: '横图', label: '横图(-1)', cost: 1 },
  { value: '方图', label: '方图(-1)', cost: 1 },
  { value: '2K竖图', label: '2K竖图(-15)', cost: 15 },
  { value: '2K横图', label: '2K横图(-15)', cost: 15 },
  { value: '2K方图', label: '2K方图(-15)', cost: 15 },
  { value: '4K竖图', label: '4K竖图(-25)', cost: 25 },
  { value: '4K横图', label: '4K横图(-25)', cost: 25 },
  { value: '4K方图', label: '4K方图(-25)', cost: 25 }
];

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

await boot().catch((error) => {
  console.error(error);
  renderFrameNotice('连接服务超时，请刷新重试', true);
  showToast(normalizeFetchError(error), true);
});

async function boot() {
  populateArtistPresetOptions();
  populateSizeOptions();
  bindEvents();
  el.userToken.value = state.token;
  await loadSettings();
  applyDefaults();
  updateGenerateCostLabel();
  enhanceSelects();
  updateUrlOutputs();
  if (state.token) await loadMe().catch(() => {});
}

function bindEvents() {
  el.saveTokenBtn.addEventListener('click', saveToken);
  el.toggleMergeBtn.addEventListener('click', () => setMergePanelOpen(el.mergeFields.hidden));
  el.mergeTokenBtn.addEventListener('click', mergeTokenBalance);
  el.promptConvertBtn.addEventListener('click', openPromptConvert);
  el.promptConvertSubmitBtn.addEventListener('click', convertPrompt);
  el.closePromptConvertBtn.addEventListener('click', closePromptConvert);
  el.promptConvertModal.addEventListener('click', (event) => {
    if (event.target === el.promptConvertModal) closePromptConvert();
  });
  el.directGenerateBtn.addEventListener('click', startJob);
  el.generationCountControl.querySelectorAll('[data-generation-count]').forEach((button) => {
    button.addEventListener('click', () => setGenerationCount(button.dataset.generationCount));
  });
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
  el.prevResultBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    showResultHistory(state.resultHistoryIndex - 1);
  });
  el.nextResultBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    showResultHistory(state.resultHistoryIndex + 1);
  });
  el.resultPreview.addEventListener('click', (event) => {
    if (event.target === el.resultPreview) closeResultPreview();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !el.resultPreview.classList.contains('hidden')) closeResultPreview();
    if (event.key === 'Escape' && !el.promptConvertModal.classList.contains('hidden')) closePromptConvert();
  });

  [
    el.userToken,
    el.promptInput,
    el.samplerInput,
    el.sizeInput,
    el.stepsInput,
    el.scaleInput,
    el.cfgInput,
    el.negativeInput
  ].forEach((input) => input.addEventListener('input', updateUrlOutputs));
  el.artistPresetInput.addEventListener('change', applyArtistPreset);
  el.sizeInput.addEventListener('change', updateGenerateCostLabel);
  el.artistInput.addEventListener('input', () => {
    syncArtistPresetSelection();
    updateUrlOutputs();
  });
}

function openPromptConvert() {
  if (!state.settings?.promptApi?.configured) {
    showToast('管理员尚未配置提示词 API', true);
    return;
  }
  if (!el.userToken.value.trim()) {
    showToast('请先连接密钥', true);
    return;
  }
  el.promptConvertModal.classList.remove('hidden');
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
  requestAnimationFrame(() => el.promptConvertInput.focus());
}

function closePromptConvert() {
  if (state.convertingPrompt) return;
  el.promptConvertModal.classList.add('hidden');
  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
}

async function convertPrompt() {
  const prompt = el.promptConvertInput.value.trim();
  if (!prompt) {
    showToast('请先输入中文画面描述', true);
    el.promptConvertInput.focus();
    return;
  }

  state.convertingPrompt = true;
  el.promptConvertSubmitBtn.disabled = true;
  el.promptConvertSubmitBtn.textContent = '正在转换...';
  try {
    const result = await api('/api/prompt/convert', {
      method: 'POST',
      body: { prompt, token: el.userToken.value.trim() },
      timeoutMs: 60000
    });
    el.promptInput.value = result.prompt;
    updateUrlOutputs();
    state.convertingPrompt = false;
    closePromptConvert();
    showToast('已转换为 NAI 提示词');
  } catch (error) {
    showToast(error.message, true);
  } finally {
    state.convertingPrompt = false;
    el.promptConvertSubmitBtn.disabled = false;
    el.promptConvertSubmitBtn.textContent = '转换并填入';
  }
}

function populateArtistPresetOptions() {
  const options = Object.entries(artistPresets)
    .map(([value, preset]) => `<option value="${value}">${preset.label}</option>`)
    .join('');
  el.artistPresetInput.innerHTML = `${options}<option value="custom">自定义</option>`;
}

function populateSizeOptions() {
  el.sizeInput.innerHTML = sizeOptions
    .map((option) => `<option value="${option.value}">${option.label}</option>`)
    .join('');
}

async function loadSettings() {
  state.settings = await api('/api/settings');
}

function applyDefaults() {
  el.artistInput.value = artistPresets['2.5d'].value;
  syncArtistPresetSelection();
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
    if (!state.token) {
      state.userBalance = null;
      el.balanceText.textContent = '尚未连接';
      el.tokenStatusDot.classList.remove('connected');
      return;
    }
    await loadMe();
  } catch (error) {
    state.userBalance = null;
    el.balanceText.textContent = '连接失败';
    el.tokenStatusDot.classList.remove('connected');
    showToast(error.message, true);
  }
}

async function loadMe() {
  if (!state.token) return;
  const user = await api(`/api/me?token=${encodeURIComponent(state.token)}`);
  state.userBalance = Number(user.balance);
  el.balanceText.textContent = `${user.balance} 点可用`;
  el.tokenStatusDot.classList.add('connected');
}

async function mergeTokenBalance() {
  const targetToken = el.userToken.value.trim();
  const sourceToken = el.mergeSourceToken.value.trim();
  if (!targetToken) {
    showToast('请先输入需要保留额度的密钥', true);
    return;
  }
  if (!sourceToken) {
    showToast('请输入被融合的密钥', true);
    return;
  }
  if (sourceToken === targetToken) {
    showToast('两个密钥不能相同', true);
    return;
  }

  el.mergeTokenBtn.disabled = true;
  el.mergeTokenBtn.textContent = '融合中...';
  try {
    const result = await api('/api/me/merge', {
      method: 'POST',
      timeoutMs: 20000,
      body: { token: sourceToken, targetToken }
    });
    state.token = result.target.token;
    state.userBalance = Number(result.target.balance);
    el.userToken.value = state.token;
    el.mergeSourceToken.value = '';
    setMergePanelOpen(false);
    localStorage.setItem('nai.userToken', state.token);
    el.balanceText.textContent = `${result.target.balance} 点可用`;
    el.tokenStatusDot.classList.add('connected');
    updateUrlOutputs();
    showToast(`已融合 ${result.amount} 点额度`);
  } catch (error) {
    showToast(error.message, true);
  } finally {
    el.mergeTokenBtn.disabled = false;
    el.mergeTokenBtn.textContent = '确认融合';
  }
}

function setMergePanelOpen(isOpen) {
  el.mergeFields.hidden = !isOpen;
  el.mergePanel.classList.toggle('open', isOpen);
  el.toggleMergeBtn.setAttribute('aria-expanded', String(isOpen));
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
    noise_schedule: 'karras',
    cost: generationCost()
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
  return `<div style="width: auto; height: auto; max-width: 100%; box-sizing: border-box; padding: 2px; border: 1px solid rgba(255,255,255,0.58); background: rgba(255,255,255,0.32); position: relative; border-radius: 12px; overflow: hidden; display: inline-flex; justify-content: center; align-items: center; box-shadow: 0 4px 14px rgba(148,163,184,0.06);"><img src="${url}"  alt="生成图片" style="max-width: 100%; height: auto; width: auto; display: block; object-fit: contain; border-radius: 9px; transition: transform 0.3s ease;"></div>`;
}

function updateUrlOutputs() {
  // The embed code is generated on demand for the copy button.
  if (!state.generating) updateGenerateCostLabel();
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
  const currentToken = el.userToken.value.trim();
  if (state.token === currentToken && Number.isFinite(state.userBalance) && state.userBalance < totalGenerationCost()) {
    showToast(`当前额度不足，需要 ${totalGenerationCost()} 点`, true);
    return;
  }
  if (state.generationCount > 1) {
    await startBatchJobs(state.generationCount);
    return;
  }
  setGenerateBusy(true);
  renderLoadingFrame();
  clearInterval(state.pollTimer);
  try {
    const params = collectParams();
    const job = await api('/api/jobs', {
      method: 'POST',
      body: jobRequestBody(params)
    });
    resetQueueView(job);
    el.jobText.textContent = jobStatusText(job);
    updateLoadingStatus(job);
    state.pollTimer = setInterval(() => pollJob(job.id), jobPollIntervalMs);
    loadMe().catch(() => {});
    await pollJob(job.id);
  } catch (error) {
    renderFrameNotice('生成失败', true);
    setGenerateBusy(false);
    showToast(error.message, true);
  }
}

async function startBatchJobs(count) {
  setGenerateBusy(true);
  clearInterval(state.pollTimer);
  renderBatchLoading(count);
  const params = collectParams();
  const results = await Promise.allSettled(
    Array.from({ length: count }, (_, index) => runBatchJob(index, params))
  );
  const completed = results.filter((result) => result.status === 'fulfilled').length;
  const failed = count - completed;
  el.imageFrame.classList.remove('loading');
  el.imageFrame.classList.add('result-ready', 'batch-ready');
  el.jobText.textContent = failed ? `${completed} 张完成 · ${failed} 张失败` : `${completed} 张已完成`;
  await loadMe().catch(() => {});
  setGenerateBusy(false);
  showToast(failed ? `${completed} 张生成成功，${failed} 张失败` : `${completed} 张图片已生成`, failed > 0);
}

async function runBatchJob(index, params) {
  try {
    updateBatchCard(index, '正在提交', 0);
    const job = await api('/api/jobs', {
      method: 'POST',
      body: jobRequestBody(params)
    });
    updateBatchJobStatus(index, job);
    return await pollBatchJob(job.id, index, params.token);
  } catch (error) {
    renderBatchError(index, error.message || '生成失败');
    throw error;
  }
}

async function pollBatchJob(id, index, token) {
  while (state.generating) {
    let job;
    try {
      job = await api(`/api/jobs/${id}?token=${encodeURIComponent(token)}`);
    } catch (error) {
      if (error.status >= 500 || /Unexpected end of JSON input/i.test(error.message)) {
        updateBatchCard(index, '连接重试中');
        await wait(jobPollIntervalMs);
        continue;
      }
      throw error;
    }

    updateBatchJobStatus(index, job);
    if (job.status === 'done') {
      renderBatchImage(index, job.imageUrl);
      return job.imageUrl;
    }
    if (job.status === 'failed') throw new Error(job.error || '任务失败');
    await wait(jobPollIntervalMs);
  }
  throw new Error('生成已停止');
}

function jobRequestBody(params) {
  return {
    token: params.token,
    tag: params.tag,
    model: params.model,
    artist: params.artist,
    size: params.size,
    cost: params.cost,
    steps: Number(params.steps),
    scale: Number(params.scale),
    cfg: Number(params.cfg),
    sampler: params.sampler,
    negative: params.negative,
    nocache: '1',
    noise_schedule: params.noise_schedule
  };
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
  el.imageFrame.classList.remove('result-ready', 'batch-ready', 'batch-mode', 'batch-landscape');
  el.imageFrame.classList.add('loading');
  el.imageFrame.innerHTML = `<div class="loading-state" role="status" aria-live="polite">
    <div class="loading-orbit" aria-hidden="true"></div>
    <strong>正在生成图片</strong>
    <p id="loadingStatusText">任务已提交，正在分配账号</p>
    <div id="generationStream" class="generation-stream-panel" role="progressbar" aria-label="NovelAI 生成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" hidden>
      <div class="generation-stream-track">
        <span id="generationStreamBar"></span>
      </div>
    </div>
    <div class="loading-steps" aria-hidden="true">
      <span class="active current">提交任务</span>
      <span>路由账号</span>
      <span>等待成图</span>
    </div>
  </div>`;
}

function renderBatchLoading(count) {
  clearQueueView();
  closeResultPreview();
  el.jobText.textContent = `0 / ${count} 完成`;
  el.imageFrame.classList.remove('result-ready', 'batch-ready');
  el.imageFrame.classList.add('loading', 'batch-mode');
  el.imageFrame.classList.toggle('batch-landscape', el.sizeInput.value.includes('横图'));
  el.imageFrame.innerHTML = `<div class="batch-result-grid" aria-live="polite">
    ${Array.from({ length: count }, (_, index) => `<article class="batch-result-card is-loading" data-batch-index="${index}">
      <div class="batch-card-state">
        <div class="batch-card-orbit" aria-hidden="true"></div>
        <strong class="batch-card-number">${String(index + 1).padStart(2, '0')}</strong>
        <span class="batch-card-status">等待提交</span>
        <div class="batch-card-progress" role="progressbar" aria-label="图片 ${index + 1} 生成进度" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0"><span></span></div>
      </div>
    </article>`).join('')}
  </div>`;
}

function updateBatchJobStatus(index, job) {
  if (job.status === 'queued') {
    const position = Number(job.queuePosition || 0);
    const total = Number(job.queuedCount || 0);
    updateBatchCard(index, position && total ? `排队中 · ${position} / ${total}` : '等待可用账号', 0);
    return;
  }
  if (job.status === 'running') {
    updateBatchCard(index, '', clampGenerationPercent(job.generationProgress?.percent));
  }
}

function updateBatchCard(index, status, progress) {
  const card = el.imageFrame.querySelector(`[data-batch-index="${index}"]`);
  if (!card) return;
  const statusText = card.querySelector('.batch-card-status');
  const progressBar = card.querySelector('.batch-card-progress');
  const bar = progressBar?.querySelector('span');
  if (statusText) statusText.textContent = status;
  if (progress !== undefined) {
    const percent = Math.round(clampGenerationPercent(progress));
    if (bar) bar.style.width = `${percent}%`;
    if (progressBar) progressBar.setAttribute('aria-valuenow', String(percent));
  }
}

function renderBatchImage(index, src) {
  const card = el.imageFrame.querySelector(`[data-batch-index="${index}"]`);
  if (!card) return;
  pushResultHistory(src);
  card.className = 'batch-result-card is-done';
  card.innerHTML = `<button class="result-image-button batch-image-button" type="button" aria-label="放大预览图片 ${index + 1}">
    <img src="${src}" alt="生成图片 ${index + 1}">
    <span class="batch-image-index">${String(index + 1).padStart(2, '0')}</span>
  </button>`;
  updateBatchCompletedText();
}

function renderBatchError(index, message) {
  const card = el.imageFrame.querySelector(`[data-batch-index="${index}"]`);
  if (!card) return;
  card.className = 'batch-result-card is-failed';
  card.innerHTML = `<div class="batch-card-error"><strong class="batch-card-number">${String(index + 1).padStart(2, '0')}</strong><span></span></div>`;
  card.querySelector('.batch-card-error span').textContent = message;
}

function updateBatchCompletedText() {
  const total = el.imageFrame.querySelectorAll('.batch-result-card').length;
  const completed = el.imageFrame.querySelectorAll('.batch-result-card.is-done').length;
  el.jobText.textContent = `${completed} / ${total} 完成`;
}

function updateLoadingStatus(job) {
  const target = document.querySelector('#loadingStatusText');
  if (!target) return;
  if (job.status === 'queued') {
    const view = updateQueueView(job);
    const count = Number(view.count || 0);
    const position = Number(view.position || 0);
    target.textContent = queueLoadingText(position, count);
    el.jobText.textContent = queueStatusText(position, count);
    setGenerationStreamProgress(null, false);
    setLoadingStep(1);
    return;
  }
  if (job.status === 'running') {
    if (finishQueueView(job)) return;
    clearQueueView();
    target.textContent = '账号已分配，NovelAI 正在生成';
    setGenerationStreamProgress(job.generationProgress, true);
    setLoadingStep(2);
    return;
  }
  if (job.status === 'done') {
    target.textContent = '生成完成，正在载入图片';
    setGenerationStreamProgress({ percent: 100 }, false);
  }
}

function resetQueueView(job = {}) {
  clearQueueView();
  const total = Number(job.queuedCount || 0);
  const position = Number(job.queuePosition || 0);
  if (job.status !== 'queued' || !total || !position) return;
  const target = Math.max(1, position);
  state.queueView = {
    position: 1,
    target,
    count: Math.max(1, total),
    completing: false,
    fastForward: target > 1
  };
}

function updateQueueView(job = {}) {
  const total = Math.max(1, Number(job.queuedCount || 1));
  const target = Math.max(1, Number(job.queuePosition || 1));
  let restartFastForward = false;
  if (!state.queueView) {
    state.queueView = { position: 1, target, count: total, completing: false, fastForward: target > 1 };
    restartFastForward = state.queueView.fastForward;
  } else {
    const wasFastForward = Boolean(state.queueView.fastForward || state.queueView.completing);
    state.queueView.count = Math.max(Number(state.queueView.count || 0), total);
    state.queueView.target = Math.max(Number(state.queueView.target || 0), target);
    state.queueView.fastForward = state.queueView.position < state.queueView.target;
    restartFastForward = !wasFastForward && state.queueView.fastForward;
  }
  ensureQueueViewTimer(restartFastForward);
  return state.queueView;
}

function applyArtistPreset() {
  const preset = artistPresets[el.artistPresetInput.value];
  if (preset) {
    el.artistInput.value = preset.value;
    setArtistInputLocked(true);
  } else {
    el.artistInput.value = '';
    setArtistInputLocked(false);
  }
  updateUrlOutputs();
}

function syncArtistPresetSelection() {
  const current = el.artistInput.value;
  const found = Object.entries(artistPresets).find(([, preset]) => preset.value === current);
  el.artistPresetInput.value = found ? found[0] : 'custom';
  setArtistInputLocked(Boolean(found));
}

function setArtistInputLocked(isLocked) {
  el.artistInput.readOnly = isLocked;
  el.artistInput.classList.toggle('locked', isLocked);
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
  ensureQueueViewTimer(true);
  renderQueueText();
  return true;
}

function ensureQueueViewTimer(restart = false) {
  if (restart && state.queueViewTimer) {
    clearInterval(state.queueViewTimer);
    state.queueViewTimer = null;
  }
  if (state.queueViewTimer) return;
  state.queueViewTimer = setInterval(() => {
    if (!state.queueView) {
      clearQueueView();
      return;
    }
    if (state.queueView.position < state.queueView.target) {
      state.queueView.position += 1;
      renderQueueText();
      if (state.queueView.position >= state.queueView.target) {
        state.queueView.fastForward = false;
      }
      return;
    }
    if (state.queueView.completing) {
      const target = document.querySelector('#loadingStatusText');
      state.queueView.completing = false;
      clearQueueView();
      if (target) target.textContent = '账号已分配，NovelAI 正在生成';
      el.jobText.textContent = '生成中';
      setGenerationStreamProgress({ percent: 0 }, true);
      setLoadingStep(2);
    }
  }, state.queueView?.completing || state.queueView?.fastForward ? queueCompleteStepIntervalMs : queueStepIntervalMs);
}

function renderQueueText() {
  const target = document.querySelector('#loadingStatusText');
  if (!target || !state.queueView) return;
  const { position, count } = state.queueView;
  el.jobText.textContent = queueStatusText(position, count);
  target.textContent = queueLoadingText(position, count);
}

function setLoadingStep(activeIndex) {
  document.querySelectorAll('.loading-steps span').forEach((item, index) => {
    item.classList.toggle('active', index <= activeIndex);
    item.classList.toggle('current', index === activeIndex);
  });
}

function setGenerationStreamProgress(progress = null, isVisible = true) {
  const stream = document.querySelector('#generationStream');
  if (!stream) return;
  stream.hidden = !isVisible;
  const percent = clampGenerationPercent(progress?.percent);
  const bar = document.querySelector('#generationStreamBar');
  const roundedPercent = Math.round(isVisible ? percent : 0);
  if (bar) bar.style.width = `${isVisible ? percent : 0}%`;
  stream.setAttribute('aria-valuenow', String(roundedPercent));
}

function clampGenerationPercent(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(100, number));
}

function clearQueueView() {
  if (state.queueViewTimer) clearInterval(state.queueViewTimer);
  if (state.queueViewCompleteTimer) clearTimeout(state.queueViewCompleteTimer);
  state.queueViewTimer = null;
  state.queueViewCompleteTimer = null;
  state.queueView = null;
}

function renderFrameNotice(message, isError = false) {
  el.imageFrame.classList.remove('result-ready', 'loading', 'batch-ready', 'batch-mode', 'batch-landscape');
  el.imageFrame.innerHTML = `<span class="${isError ? 'frame-error' : ''}">${message}</span>`;
}

function renderResultImage(src) {
  pushResultHistory(src);
  el.imageFrame.classList.remove('loading', 'batch-ready', 'batch-mode', 'batch-landscape');
  el.imageFrame.classList.add('result-ready');
  el.imageFrame.innerHTML = `<button class="result-image-button" type="button" aria-label="放大预览生成图片"><img src="${src}" alt="生成图片"></button>`;
}

function handleResultPreview(event) {
  const image = event.target.closest('.result-image-button img');
  if (!image) return;
  const src = image.currentSrc || image.src;
  const index = state.resultHistory.indexOf(src);
  openResultPreview(index >= 0 ? index : state.resultHistoryIndex);
}

function pushResultHistory(src) {
  if (!src) return;
  const existingIndex = state.resultHistory.indexOf(src);
  if (existingIndex >= 0) {
    state.resultHistoryIndex = existingIndex;
    return;
  }
  state.resultHistory.push(src);
  state.resultHistoryIndex = state.resultHistory.length - 1;
}

function openResultPreview(index = state.resultHistoryIndex) {
  if (!state.resultHistory.length) return;
  showResultHistory(index);
  el.resultPreview.classList.remove('hidden');
  el.resultPreview.setAttribute('aria-hidden', 'false');
  document.documentElement.classList.add('modal-open');
  document.body.classList.add('modal-open');
}

function showResultHistory(index) {
  if (!state.resultHistory.length) return;
  state.resultHistoryIndex = Math.max(0, Math.min(state.resultHistory.length - 1, Number(index || 0)));
  el.resultPreviewImage.src = state.resultHistory[state.resultHistoryIndex];
  setPreviewScale(1);
  updateResultHistoryNav();
}

function updateResultHistoryNav() {
  const hasMultiple = state.resultHistory.length > 1;
  el.prevResultBtn.hidden = !hasMultiple;
  el.nextResultBtn.hidden = !hasMultiple;
  el.prevResultBtn.disabled = state.resultHistoryIndex <= 0;
  el.nextResultBtn.disabled = state.resultHistoryIndex >= state.resultHistory.length - 1;
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
  updateResultHistoryNav();
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
  return job.status || '';
}

function queueStatusText(position, count) {
  const total = Number(count || 0);
  const current = Number(position || 0);
  if (current <= 1 && total <= 1) return '准备生成中';
  return current ? `排队中（第 ${current} / ${total} 个）` : `排队中（${total} 个）`;
}

function queueLoadingText(position, count) {
  const total = Number(count || 0);
  const current = Number(position || 0);
  if (total > 1 && current > 0) return `正在排队，当前第 ${current} / ${total} 个`;
  return '准备生成，正在等待可用账号';
}

function setGenerateBusy(isBusy) {
  state.generating = isBusy;
  el.directGenerateBtn.disabled = isBusy;
  el.generationCountControl.querySelectorAll('button').forEach((button) => {
    button.disabled = isBusy;
  });
  el.directGenerateBtn.textContent = isBusy ? '生成中...' : `生成图片（${totalGenerationCost()}点）`;
}

function updateGenerateCostLabel() {
  el.directGenerateBtn.textContent = `生成图片（${totalGenerationCost()}点）`;
}

function setGenerationCount(value) {
  const count = [1, 2, 4].includes(Number(value)) ? Number(value) : 1;
  state.generationCount = count;
  el.generationCountControl.querySelectorAll('[data-generation-count]').forEach((button) => {
    const selected = Number(button.dataset.generationCount) === count;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
  updateGenerateCostLabel();
}

function totalGenerationCost() {
  return generationCost() * state.generationCount;
}

function generationCost() {
  const selected = sizeOptions.find((option) => option.value === el.sizeInput.value);
  return selected?.cost || 1;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(path, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || 15000));
  try {
    const response = await fetch(path, {
      method: options.method || 'GET',
      headers: options.body ? { 'content-type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    const payload = text ? safeJson(text) : {};
    if (!response.ok) {
      const error = new Error(payload.error || text || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  } catch (error) {
    throw normalizeFetchError(error);
  } finally {
    clearTimeout(timer);
  }
}

function normalizeFetchError(error) {
  if (error?.name === 'AbortError') return new Error('连接服务超时，请稍后重试');
  if (/Failed to fetch|NetworkError/i.test(String(error?.message || ''))) return new Error('连接不到服务，请检查部署状态');
  return error;
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
