import http from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, MAX_CACHE_IMAGES_LIMIT, createId, createPublicToken, defaultArtist2_5D, hashObject, legacyDefaultArtist, maskToken, normalizeDb } from './store.js';
import { DIRECT_URL_MAX_STEPS, buildErrorImage, fetchNovelAiAccountQuota, generateNovelAiImage, normalizeNovelAiRequest, sizeCostMap } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const imageDir = path.join(dataDir, 'images');
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || '0.0.0.0';
const adminToken = process.env.ADMIN_TOKEN || '123456';
const store = new JsonStore(dataDir);
let queueDrainTimer = null;
let queueDraining = false;
let queueDrainRequested = false;
const jobWaiters = new Map();
const directGenerateTimeoutMs = Number(process.env.DIRECT_GENERATE_TIMEOUT_MS || 60_000);
const openAiChatTimeoutMs = Number(process.env.OPENAI_CHAT_TIMEOUT_MS || 10 * 60_000);
const openAiFixedSteps = 28;
const openAiSamplers = [
  'k_euler_ancestral',
  'k_euler',
  'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde',
  'k_dpmpp_2m',
  'k_dpmpp_sde'
];
const openAiSizeTiers = {
  '2K': {
    label: '[2K]',
    cost: 20,
    sizes: {
      '竖图': { width: 1088, height: 1600 },
      '横图': { width: 1600, height: 1088 },
      '方图': { width: 1344, height: 1344 }
    }
  },
  '4K': {
    label: '[4K]',
    cost: 35,
    sizes: {
      '竖图': { width: 1344, height: 1984 },
      '横图': { width: 1984, height: 1344 },
      '方图': { width: 1728, height: 1728 }
    }
  }
};
const insufficientBalanceMessage = '密钥额度不足，无法生成图片。';

await store.init();
await mkdir(imageDir, { recursive: true });
await migrateInlineImages();
await ensureAccountRouteIds();
await applyRuntimeSettings();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (req.url?.startsWith('/generate')) {
      const image = buildErrorImage(publicErrorMessage(error.message || 'Generation failed'));
      sendImage(res, 200, image.mimeType, image.buffer, { 'x-error': '1' });
      return;
    }
    if (req.url?.startsWith('/v1/')) {
      sendOpenAiError(res, error.statusCode || 500, publicErrorMessage(error.message || 'Internal server error'), openAiErrorType(error));
      return;
    }
    sendJson(res, error.statusCode || 500, { error: publicErrorMessage(error.message || 'Internal server error') });
  }
});

server.listen(port, host, () => {
  console.log(`Nai2API listening on http://${host}:${port}`);
  scheduleQueueDrain();
});

async function applyRuntimeSettings() {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  await store.update((db) => {
    if (publicBaseUrl && !db.settings.publicBaseUrl) db.settings.publicBaseUrl = publicBaseUrl;
    if (!db.settings.defaultArtist || db.settings.defaultArtist === legacyDefaultArtist) {
      db.settings.defaultArtist = defaultArtist2_5D;
    }
  });
}

async function migrateInlineImages() {
  await store.update(async (db) => {
    for (const image of db.images) {
      if (!image.base64 || image.file) continue;
      const imageFile = imageStorageName(image.id, image.mimeType);
      try {
        await writeFile(path.join(dataDir, imageFile), Buffer.from(image.base64, 'base64'));
        image.file = imageFile;
        delete image.base64;
      } catch (error) {
        console.error(`Failed to migrate cached image ${image.id}:`, error);
      }
    }
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    sendCorsPreflight(res);
    return;
  }

  if (method === 'GET' && url.pathname === '/v1/models') {
    sendJson(res, 200, openAiModelsResponse());
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/chat/completions') {
    await handleOpenAiChatCompletion(req, res);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/health') {
    const counts = await store.readCounts();
    sendJson(res, 200, {
      ok: true,
      service: 'Nai2API',
      users: counts.users,
      enabledAccounts: counts.enabledAccounts,
      cards: counts.cards,
      adminConfigured: adminToken !== '123456'
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/settings') {
    const settings = await store.readSettings();
    sendJson(res, 200, settings);
    return;
  }

  if (method === 'PUT' && url.pathname === '/api/settings') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const settings = await store.update((db) => {
      db.settings = {
        ...db.settings,
        ...body,
        costPerImage: 1,
        publicBaseUrl: normalizePublicBaseUrl(body.publicBaseUrl ?? db.settings.publicBaseUrl ?? ''),
        maxCacheImages: clamp(Number(body.maxCacheImages ?? db.settings.maxCacheImages ?? 500), 0, MAX_CACHE_IMAGES_LIMIT),
        accountConcurrency: clamp(Number(body.accountConcurrency ?? db.settings.accountConcurrency ?? 2), 1, 20),
        defaults: {
          ...(db.settings.defaults || {}),
          ...(body.defaults || {})
        }
      };
      return db.settings;
    });
    scheduleQueueDrain();
    sendJson(res, 200, settings);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/redeem') {
    const body = await readJson(req);
    const result = await redeemCard(String(body.card || '').trim());
    sendJson(res, 201, result);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/me') {
    const token = tokenFrom(req, url);
    const db = await store.readCollections(['users']);
    const user = getUserOrThrow(db, token);
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (url.pathname === '/api/api/getUser' && ['GET', 'POST'].includes(method)) {
    const body = method === 'POST' ? await readJson(req) : {};
    const token = String(body.toUserId || body.token || url.searchParams.get('toUserId') || url.searchParams.get('token') || '').trim();
    const db = await store.readCollections(['users']);
    const user = db.users.find((item) => item.token === token && item.enabled !== false);
    if (!user) {
      sendJson(res, 200, {
        status: 'error',
        type: token.toUpperCase().startsWith('STA1N') ? 'sta1n' : 'std',
        message: 'user not found',
        data: { value: 0 }
      });
      return;
    }
    sendJson(res, 200, {
      status: 'ok',
      type: token.toUpperCase().startsWith('STA1N') ? 'sta1n' : 'std',
      data: {
        value: Math.max(0, Math.floor(Number(user.balance || 0))),
        balance: Number(user.balance || 0),
        token: user.token,
        enabled: user.enabled !== false
      }
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/admin/summary') {
    assertAdmin(req, url);
    const db = await store.readAdminSummary();
    resetStaleAccountLoads(db.accounts);
    const revealTokens = url.searchParams.get('revealTokens') === '1';
    sendJson(res, 200, {
      settings: db.settings,
      cards: db.cards.map(publicCard),
      users: db.users.map(publicUser),
      accounts: db.accounts.map((account) => publicAccount(account, {
        revealToken: revealTokens,
        stats1h: accountStatsSince(account.id, db.jobs, 60 * 60 * 1000)
      })),
      images: db.images.slice(0, 12).map(publicImage),
      imageCount: db.imageCount ?? db.images.length,
      imageTotal: db.imageCount ?? db.images.length,
      cacheImageCount: db.imageCount ?? db.images.length,
      jobStats1h: jobStatsSince(db.jobs, 60 * 60 * 1000),
      jobs: db.jobs.slice(0, 50).map((job) => publicJob(job, db)),
      ledger: db.ledger.slice(0, 80)
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/cards') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const cards = await createCards(body);
    sendJson(res, 201, { cards: cards.map(publicCard) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/users') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const users = await createUsers(body);
    sendJson(res, 201, { users: users.map(publicUser) });
    return;
  }

  if (method === 'PATCH' && url.pathname === '/api/admin/users') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const users = await adjustUsers(body);
    sendJson(res, 200, { users: users.map(publicUser) });
    return;
  }

  if (method === 'DELETE' && url.pathname === '/api/admin/users') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await deleteUsers(body);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/accounts') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const account = await addAccount(body);
    scheduleQueueDrain();
    sendJson(res, 201, publicAccount(account));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/admin/images') {
    assertAdmin(req, url);
    const limit = clamp(Number(url.searchParams.get('limit') || 60), 1, 200);
    const offset = clamp(Number(url.searchParams.get('offset') || 0), 0, Number.MAX_SAFE_INTEGER);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const tier = String(url.searchParams.get('tier') || '').trim();
    const page = await store.readImagePage({ limit, offset, q, tier });
    sendJson(res, 200, {
      images: page.images.map(publicImage),
      total: page.total,
      matched: page.matched,
      offset: page.offset,
      limit: page.limit,
      maxCacheImages: page.maxCacheImages
    });
    return;
  }

  if (method === 'DELETE' && url.pathname === '/api/admin/images') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await clearImageCache(body);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'GET' && url.pathname === '/api/admin/accounts/export') {
    assertAdmin(req, url);
    const db = await store.readCollections(['accounts']);
    sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      accounts: db.accounts.map(exportAccount)
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/accounts/import') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const accounts = await importAccounts(body);
    scheduleQueueDrain();
    sendJson(res, 200, { accounts: accounts.map((account) => publicAccount(account, { revealToken: true })) });
    return;
  }

  if (method === 'DELETE' && url.pathname === '/api/admin/accounts') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await deleteAccounts(body);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'PATCH' && url.pathname === '/api/admin/accounts') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const accounts = await updateAccounts(body);
    scheduleQueueDrain();
    sendJson(res, 200, { accounts: accounts.map(publicAccount) });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/accounts/reset-stats') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await resetAccountStats(body);
    scheduleQueueDrain();
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/accounts/quota') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await refreshAccountQuotas(body);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'PATCH' && url.pathname.startsWith('/api/admin/accounts/')) {
    assertAdmin(req, url);
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const body = await readJson(req);
    const account = await updateAccount(id, body);
    scheduleQueueDrain();
    sendJson(res, 200, publicAccount(account));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/admin/export') {
    assertAdmin(req, url);
    const db = await store.readCollections(['settings', 'cards', 'users', 'accounts']);
    sendJson(res, 200, {
      exportedAt: new Date().toISOString(),
      app: 'Nai2API',
      version: 2,
      scope: 'migration',
      excludes: ['jobs', 'images', 'ledger'],
      data: exportMigrationData(db)
    });
    return;
  }

  if (method === 'POST' && url.pathname === '/api/admin/import') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await importPackage(body);
    sendJson(res, 200, result);
    return;
  }

  if (method === 'POST' && url.pathname === '/api/jobs') {
    const body = await readJson(req);
    const token = String(body.token || tokenFrom(req, url) || '');
    const job = await createJob(token, body);
    scheduleQueueDrain();
    const db = await store.readCollections(['accounts', 'jobs']);
    const savedJob = db.jobs.find((item) => item.id === job.id) || job;
    sendJson(res, 202, publicJob(savedJob, db));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const token = tokenFrom(req, url);
    const db = await store.readCollections(['accounts', 'jobs']);
    const job = db.jobs.find((item) => item.id === id);
    if (!job) throw httpError(404, 'job not found.');
    if (job.userToken !== token && !isAdmin(req, url)) throw httpError(403, 'forbidden.');
    sendJson(res, 200, publicJob(job, db));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/images/')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
    const image = await store.findImage(id);
    if (!image) throw httpError(404, 'image not found.');
    sendImage(res, 200, image.mimeType, await readStoredImage(image));
    return;
  }

  if (method === 'GET' && url.pathname === '/generate') {
    await handleDirectGenerate(url, res);
    return;
  }

  if (method === 'GET') {
    await serveStatic(url.pathname, res);
    return;
  }

  throw httpError(404, 'not found.');
}

async function handleDirectGenerate(url, res) {
  const token = String(url.searchParams.get('token') || '').trim();
  const rawParams = Object.fromEntries(url.searchParams.entries());
  const db = await store.readCollections(['settings', 'users']);
  const request = normalizeNovelAiRequest(rawParams, db.settings, { maxSteps: DIRECT_URL_MAX_STEPS });
  const cacheKey = requestCacheKey(token, request, rawParams.seed);
  const nocache = rawParams.nocache === '1' || rawParams.nocache === 'true';

  if (!nocache) {
    const cached = await store.findImageByCacheKey(cacheKey);
    if (cached) {
      try {
        const cachedBuffer = await readStoredImage(cached);
        await createDirectJob(token, request, cacheKey, {
          status: 'done',
          accountId: cached.accountId || '',
          imageId: cached.id,
          cost: 0
        });
        sendImage(res, 200, cached.mimeType, cachedBuffer, {
          'x-cache': 'hit',
          'x-balance': String(getUserOrThrow(db, token).balance)
        });
        return;
      } catch (error) {
        console.error(`Cached image ${cached.id} is missing, regenerating:`, error);
      }
    }
  }

  const deadline = Date.now() + directGenerateTimeoutMs;
  let directJob = null;
  try {
    directJob = await createDirectJob(token, request, cacheKey, { deadlineAt: new Date(deadline).toISOString() });
    scheduleQueueDrain();
    const result = await waitForJobResult(directJob.id, deadline);
    if (!result) {
      await timeoutDirectJob(directJob.id);
      sendTimeoutImage(res);
      return;
    }
    if (result.error) throw new Error(result.error);
    const image = result.image || await readStoredImage(result.saved);
    sendImage(res, 200, result.saved.mimeType, image.buffer || image, {
      'x-cache': 'miss',
      'x-balance': String(result.balance ?? '')
    });
  } catch (error) {
    if (directJob) {
      if (isInsufficientBalanceError(error)) {
        await removeJob(directJob.id);
      } else {
        await markDirectJobFailed(directJob.id, publicErrorMessage(error.message || 'direct generate failed.'));
      }
    }
    if (error.message === 'direct generate timeout') {
      sendTimeoutImage(res);
      return;
    }
    if (isNovelAiCapacityError(error)) {
      sendBusyImage(res);
      return;
    }
    throw error;
  }
}

async function handleOpenAiChatCompletion(req, res) {
  const token = bearerToken(req);
  if (!token) throw httpError(401, 'missing API key.');
  const body = await readJson(req);
  const settings = await store.readSettings();
  const parsed = parseOpenAiImageRequest(body, settings);
  const job = await createJob(token, parsed.request);
  scheduleQueueDrain();

  if (body.stream === true) {
    await streamOpenAiImageJob(req, res, job, parsed.model);
    return;
  }

  const deadline = Date.now() + openAiChatTimeoutMs;
  const result = await waitForJobResult(job.id, deadline);
  if (!result) throw httpError(504, '连接超时');
  if (result.error) throw httpError(500, result.error);

  sendJson(res, 200, openAiChatCompletionResponse({
    model: parsed.model,
    content: openAiImageMarkdown(req, result.saved),
    id: `chatcmpl-${job.id}`
  }));
}

function openAiModelsResponse() {
  const created = Math.floor(Date.now() / 1000);
  return {
    object: 'list',
    data: [
      ...openAiSamplers.map((sampler) => ({
        id: `nai-diffusion-4-5-full:${sampler}`,
        object: 'model',
        created,
        owned_by: 'nai2api',
        cost: 1,
        resolution_tier: 'standard'
      })),
      ...Object.entries(openAiSizeTiers).flatMap(([tierName, tier]) => openAiSamplers.map((sampler) => ({
        id: `${tier.label}nai-diffusion-4-5-full:${sampler}`,
        object: 'model',
        created,
        owned_by: 'nai2api',
        cost: tier.cost,
        resolution_tier: tierName
      })))
    ]
  };
}

function parseOpenAiImageRequest(body = {}, settings = {}) {
  const modelParts = parseOpenAiModel(body.model || settings.defaultModel || 'nai-diffusion-4-5-full');
  const messageText = lastUserMessageText(body.messages || []);
  const fields = parseChinesePromptFields(messageText);
  validateOpenAiPromptFormat(fields, messageText);
  const nai = body.nai && typeof body.nai === 'object' ? body.nai : {};
  const prompt = String(nai.tag || nai.prompt || fields.tag || '').trim();
  const negative = String(nai.negative ?? fields.negative ?? '').trim() || settings.defaultNegative || '';
  const sizeName = String(nai.size ?? fields.size ?? settings.defaults?.size ?? '竖图').trim();
  const tierSize = modelParts.tier?.sizes?.[sizeName];

  const request = {
    tag: prompt,
    model: modelParts.model,
    artist: nai.artist ?? fields.artist ?? settings.defaultArtist ?? '',
    size: sizeName,
    width: tierSize?.width ?? nai.width,
    height: tierSize?.height ?? nai.height,
    steps: openAiFixedSteps,
    scale: nai.scale ?? fields.scale ?? settings.defaults?.scale,
    cfg: nai.cfg ?? fields.cfg ?? settings.defaults?.cfg,
    sampler: nai.sampler ?? fields.sampler ?? modelParts.sampler ?? settings.defaults?.sampler,
    negative,
    nocache: nai.nocache ?? body.nocache ?? '1',
    noise_schedule: nai.noise_schedule ?? nai.noiseSchedule ?? settings.defaults?.noiseSchedule ?? 'karras',
    cost: modelParts.tier?.cost ?? generationCost()
  };

  return {
    model: modelParts.original,
    request
  };
}

function validateOpenAiPromptFormat(fields, messageText) {
  const requiredFields = ['tag', 'size', 'scale', 'cfg'];
  const missing = requiredFields.some((key) => !String(fields[key] ?? '').trim());
  const optionalFieldsPresent = Object.hasOwn(fields, 'artist') && Object.hasOwn(fields, 'negative');
  if (missing || !optionalFieldsPresent) throw httpError(400, openAiPromptFormatError());
}

function openAiPromptFormatError() {
  return '请求格式错误，请参考群内使用指南';
}

function parseOpenAiModel(modelValue) {
  const original = String(modelValue || 'nai-diffusion-4-5-full');
  const tierMatch = original.match(/^\[(2K|4K)\]\s*(.+)$/i);
  const tierName = tierMatch ? tierMatch[1].toUpperCase() : '';
  const modelWithSampler = tierMatch ? tierMatch[2] : original;
  const [model, sampler] = modelWithSampler.split(':');
  return {
    original,
    tierName,
    tier: openAiSizeTiers[tierName] || null,
    model: model || 'nai-diffusion-4-5-full',
    sampler: sampler || ''
  };
}

function lastUserMessageText(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const message = [...list].reverse().find((item) => item?.role === 'user') || list.at(-1);
  return messageContentText(message?.content || '');
}

function messageContentText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return String(content || '');
  return content.map((part) => {
    if (typeof part === 'string') return part;
    if (part?.type === 'text') return part.text || '';
    return part?.text || '';
  }).filter(Boolean).join('\n');
}

function parseChinesePromptFields(text) {
  const fieldNames = {
    '提示词': 'tag',
    '畫師串': 'artist',
    '画师串': 'artist',
    '尺寸': 'size',
    '提示词引导值': 'scale',
    '提示詞引導值': 'scale',
    '缩放引导值': 'cfg',
    '縮放引導值': 'cfg',
    '负面提示词': 'negative',
    '負面提示詞': 'negative',
    '采样器': 'sampler',
    '採樣器': 'sampler'
  };
  const fields = {};
  let currentKey = '';
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const match = line.match(/^([^:：]{1,16})\s*[:：]\s*(.*)$/);
    const key = match ? fieldNames[match[1].trim()] : '';
    if (key) {
      currentKey = key;
      fields[currentKey] = appendFieldValue(fields[currentKey], match[2]);
      continue;
    }
    if (currentKey && line.trim()) {
      fields[currentKey] = appendFieldValue(fields[currentKey], line);
    }
  }
  return fields;
}

function appendFieldValue(current, value) {
  const text = String(value || '').trim();
  if (!current) return text;
  if (!text) return current;
  return `${current}\n${text}`;
}

async function streamOpenAiImageJob(req, res, job, model) {
  sendOpenAiStreamHeaders(res);
  const streamId = `chatcmpl-${job.id}`;
  writeOpenAiChunk(res, { id: streamId, model, content: '<think>\n任务已提交，正在进入队列\n' });
  let lastLine = '';
  let reachedRunning = false;
  const deadline = Date.now() + openAiChatTimeoutMs;

  while (Date.now() < deadline) {
    const snapshot = await publicJobSnapshot(job.id);
    if (!snapshot) {
      writeOpenAiChunk(res, { id: streamId, model, content: '任务不存在\n</think>\n任务不存在\n' });
      finishOpenAiStream(res, streamId, model);
      return;
    }

    const line = openAiProgressLine(snapshot);
    const isQueuedAfterRunning = reachedRunning && snapshot.status === 'queued';
    if (snapshot.status === 'running') reachedRunning = true;
    if (line && !isQueuedAfterRunning && line !== lastLine) {
      writeOpenAiChunk(res, { id: streamId, model, content: `${line}\n` });
      lastLine = line;
    }

    if (snapshot.status === 'done') {
      writeOpenAiChunk(res, { id: streamId, model, content: `生成完成\n</think>\n${openAiImageMarkdown(req, snapshot)}\n` });
      finishOpenAiStream(res, streamId, model);
      return;
    }

    if (snapshot.status === 'failed') {
      const message = snapshot.error || '生成失败';
      writeOpenAiChunk(res, { id: streamId, model, content: `${message}\n</think>\n${message}\n` });
      finishOpenAiStream(res, streamId, model);
      return;
    }

    await sleep(1100);
  }

  writeOpenAiChunk(res, { id: streamId, model, content: '连接超时\n</think>\n连接超时\n' });
  finishOpenAiStream(res, streamId, model);
}

async function publicJobSnapshot(jobId) {
  const db = await store.readCollections(['accounts', 'jobs']);
  const job = db.jobs.find((item) => item.id === jobId);
  return job ? publicJob(job, db) : null;
}

function openAiProgressLine(job) {
  if (job.status === 'queued') {
    if (job.queuePosition && job.queuedCount) return `排队中：第 ${job.queuePosition} / ${job.queuedCount} 个`;
    return '排队中，正在等待可用账号';
  }
  if (job.status === 'running') {
    return '已路由账号，正在生成';
  }
  return '';
}

function openAiImageMarkdown(req, imageOrJob) {
  const imageId = imageOrJob.imageId || imageOrJob.id;
  return `![image](${absoluteUrl(req, `/api/images/${imageId}/content`)})`;
}

function openAiChatCompletionResponse({ model, content, id }) {
  return {
    id,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop'
    }],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2
    }
  };
}

function writeOpenAiChunk(res, { id, model, content }) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      delta: { content },
      finish_reason: null
    }]
  })}\n\n`);
}

function finishOpenAiStream(res, id, model) {
  res.write(`data: ${JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }]
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

function sendOpenAiStreamHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    ...corsHeaders()
  });
}

function absoluteUrl(req, urlPath) {
  const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${port}`;
  return `${proto}://${hostHeader}${urlPath}`;
}

async function redeemCard(cardCode) {
  if (!cardCode) throw httpError(400, 'card is required.');
  return store.update((db) => {
    const card = db.cards.find((item) => item.code === cardCode);
    if (!card) throw httpError(404, 'card not found.');
    if (card.usedBy) throw httpError(409, 'card already redeemed.');
    if (card.expiresAt && Date.parse(card.expiresAt) < Date.now()) throw httpError(410, 'card expired.');

    const user = {
      id: createId('usr'),
      token: createPublicToken('STA1N'),
      balance: Number(card.credits || 0),
      enabled: true,
      sourceCard: card.code,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    card.usedBy = user.token;
    card.usedAt = new Date().toISOString();
    db.users.unshift(user);
    db.ledger.unshift({
      id: createId('log'),
      type: 'redeem',
      token: user.token,
      amount: user.balance,
      at: new Date().toISOString(),
      note: `Redeemed card ${card.code}`
    });
    return publicUser(user);
  });
}

async function createCards(body) {
  const count = clamp(Number(body.count || 1), 1, 200);
  const credits = clamp(Number(body.credits || 10), 1, 100000);
  const prefix = String(body.prefix || 'CARD').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 16) || 'CARD';
  const cards = Array.from({ length: count }, () => ({
    id: createId('card'),
    code: createPublicToken(prefix),
    credits,
    note: String(body.note || ''),
    createdAt: new Date().toISOString(),
    expiresAt: body.expiresAt || ''
  }));

  await store.update((db) => {
    db.cards.unshift(...cards);
  });
  return cards;
}

async function createUsers(body) {
  const count = clamp(Number(body.count || 1), 1, 200);
  const credits = clamp(Number(body.credits || 10), 1, 100000);
  const note = String(body.note || 'admin issued').slice(0, 120);
  const users = Array.from({ length: count }, () => ({
    id: createId('usr'),
    token: createPublicToken('STA1N'),
    balance: credits,
    enabled: true,
    sourceCard: '',
    note,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  }));

  await store.update((db) => {
    db.users.unshift(...users);
    users.forEach((user) => {
      db.ledger.unshift({
        id: createId('log'),
        type: 'issue',
        token: user.token,
        amount: credits,
        at: new Date().toISOString(),
        note
      });
    });
  });
  return users;
}

async function adjustUsers(body) {
  const setBalance = body.setBalance === undefined ? null : clamp(Number(body.setBalance), 0, 100000000);
  const delta = body.delta === undefined && body.balanceDelta === undefined ? null : Number(body.delta ?? body.balanceDelta);
  if (setBalance === null && !Number.isFinite(delta)) throw httpError(400, 'setBalance or delta is required.');

  return store.update((db) => {
    const users = selectUsers(db, body);
    const now = new Date().toISOString();
    users.forEach((user) => {
      const before = Number(user.balance || 0);
      user.balance = setBalance === null ? Math.max(0, before + delta) : setBalance;
      user.updatedAt = now;
      db.ledger.unshift({
        id: createId('log'),
        type: 'adjust',
        token: user.token,
        amount: user.balance - before,
        at: now,
        note: String(body.note || 'admin balance adjustment').slice(0, 160)
      });
    });
    return users;
  });
}

async function deleteUsers(body) {
  return store.update((db) => {
    const users = selectUsers(db, body);
    const ids = new Set(users.map((user) => user.id));
    const tokens = new Set(users.map((user) => user.token));
    db.users = db.users.filter((user) => !ids.has(user.id));
    db.cards.forEach((card) => {
      if (tokens.has(card.usedBy)) {
        card.usedBy = '';
        card.usedAt = '';
      }
    });
    db.ledger.unshift({
      id: createId('log'),
      type: 'delete-users',
      amount: 0,
      at: new Date().toISOString(),
      note: `Deleted ${users.length} user token(s)`
    });
    return { deleted: users.length };
  });
}

async function addAccount(body) {
  const token = String(body.token || '').trim();
  if (!token) throw httpError(400, 'NovelAI account token is required.');
  return store.update((db) => {
    const account = {
      id: createId('acct'),
      routeId: nextAccountRouteId(db.accounts),
      name: String(body.name || `NovelAI ${db.accounts.length + 1}`).slice(0, 80),
      token,
      enabled: body.enabled !== false,
      weight: clamp(Number(body.weight || 1), 1, 100),
      inFlight: 0,
      total: 0,
      failures: 0,
      quotaPoints: null,
      quotaFixed: null,
      quotaPurchased: null,
      quotaTier: null,
      quotaCheckedAt: '',
      quotaError: '',
      cooldownUntil: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastUsedAt: ''
    };
    db.accounts.unshift(account);
    return account;
  });
}

async function importAccounts(body) {
  const mode = body.mode === 'replace' ? 'replace' : 'append';
  const accounts = parseImportedAccounts(body);
  if (!accounts.length) throw httpError(400, 'no account tokens found.');

  return store.update((db) => {
    const now = new Date().toISOString();
    const imported = accounts.map((account, index) => ({
      id: account.id || createId('acct'),
      routeId: Number(account.routeId || 0),
      name: String(account.name || `NovelAI imported ${index + 1}`).slice(0, 80),
      token: String(account.token || '').trim(),
      enabled: account.enabled !== false,
      weight: clamp(Number(account.weight || 1), 1, 100),
      inFlight: 0,
      total: Number(account.total || 0),
      failures: Number(account.failures || 0),
      quotaPoints: numberOrNull(account.quotaPoints),
      quotaFixed: numberOrNull(account.quotaFixed),
      quotaPurchased: numberOrNull(account.quotaPurchased),
      quotaTier: account.quotaTier ?? null,
      quotaCheckedAt: account.quotaCheckedAt || '',
      quotaError: account.quotaError || '',
      cooldownUntil: '',
      createdAt: account.createdAt || now,
      updatedAt: now,
      lastUsedAt: account.lastUsedAt || ''
    }));

    if (mode === 'replace') {
      db.accounts = imported;
    } else {
      const existingTokens = new Set(db.accounts.map((account) => account.token));
      imported.forEach((account) => {
        if (!existingTokens.has(account.token)) {
          db.accounts.unshift(account);
          existingTokens.add(account.token);
        }
      });
    }
    assignAccountRouteIds(db.accounts);

    db.ledger.unshift({
      id: createId('log'),
      type: 'import-accounts',
      amount: imported.length,
      at: now,
      note: `${mode} account import`
    });
    return db.accounts;
  });
}

async function deleteAccounts(body) {
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    if (!ids.size) throw httpError(400, 'account ids are required.');
    const before = db.accounts.length;
    db.accounts = db.accounts.filter((account) => !ids.has(account.id));
    const deleted = before - db.accounts.length;
    db.ledger.unshift({
      id: createId('log'),
      type: 'delete-accounts',
      amount: deleted,
      at: new Date().toISOString(),
      note: `Deleted ${deleted} NovelAI account(s)`
    });
    return { deleted };
  });
}

async function updateAccounts(body) {
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    if (!ids.size) throw httpError(400, 'account ids are required.');
    const accounts = db.accounts.filter((account) => ids.has(account.id));
    if (!accounts.length) throw httpError(404, 'no matching accounts found.');
    const now = new Date().toISOString();
    accounts.forEach((account) => {
      if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
      if (body.weight !== undefined) account.weight = clamp(Number(body.weight), 1, 100);
      account.updatedAt = now;
    });
    db.ledger.unshift({
      id: createId('log'),
      type: 'update-accounts',
      amount: accounts.length,
      at: now,
      note: body.enabled === undefined ? `Updated ${accounts.length} account(s)` : `${body.enabled ? 'Enabled' : 'Disabled'} ${accounts.length} account(s)`
    });
    return accounts;
  });
}

async function resetAccountStats(body) {
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    if (!ids.size) throw httpError(400, 'account ids are required.');
    const accounts = db.accounts.filter((account) => ids.has(account.id));
    if (!accounts.length) throw httpError(404, 'no matching accounts found.');
    const now = new Date().toISOString();
    accounts.forEach((account) => {
      account.inFlight = 0;
      account.total = 0;
      account.failures = 0;
      account.cooldownUntil = '';
      account.lastUsedAt = '';
      account.updatedAt = now;
    });
    db.ledger.unshift({
      id: createId('log'),
      type: 'reset-account-stats',
      amount: accounts.length,
      at: now,
      note: `Reset monitoring stats for ${accounts.length} NovelAI account(s)`
    });
    return { reset: accounts.length };
  });
}

async function refreshAccountQuotas(body) {
  const ids = new Set(collectValues(body.ids || body.accounts));
  const targets = await store.readCollections(['accounts']).then((db) => {
    const accounts = ids.size ? db.accounts.filter((account) => ids.has(account.id)) : db.accounts;
    return accounts.map((account) => ({
      id: account.id,
      token: account.token
    }));
  });
  if (!targets.length) throw httpError(ids.size ? 404 : 400, ids.size ? 'no matching accounts found.' : 'no accounts found.');

  const now = new Date().toISOString();
  const results = [];
  for (const target of targets) {
    try {
      const quota = await fetchNovelAiAccountQuotaWithTimeout(target.token);
      results.push({
        id: target.id,
        ok: true,
        quotaPoints: quota.points,
        quotaFixed: quota.fixed,
        quotaPurchased: quota.purchased,
        quotaTier: quota.tier,
        quotaCheckedAt: now,
        quotaError: ''
      });
    } catch (error) {
      results.push({
        id: target.id,
        ok: false,
        quotaPoints: null,
        quotaFixed: null,
        quotaPurchased: null,
        quotaTier: null,
        quotaCheckedAt: now,
        quotaError: publicErrorMessage(error.message || 'quota query failed.')
      });
    }
  }

  const resultMap = new Map(results.map((result) => [result.id, result]));
  const accounts = await store.update((db) => {
    db.accounts.forEach((account) => {
      const result = resultMap.get(account.id);
      if (!result) return;
      account.quotaPoints = result.quotaPoints;
      account.quotaFixed = result.quotaFixed;
      account.quotaPurchased = result.quotaPurchased;
      account.quotaTier = result.quotaTier;
      account.quotaCheckedAt = result.quotaCheckedAt;
      account.quotaError = result.quotaError;
      account.updatedAt = now;
    });
    return db.accounts.filter((account) => resultMap.has(account.id));
  });

  return {
    checked: results.length,
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    accounts: accounts.map((account) => publicAccount(account, { revealToken: true }))
  };
}

async function fetchNovelAiAccountQuotaWithTimeout(token) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetchNovelAiAccountQuota(token, process.env, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function clearImageCache(body) {
  const deletedImages = [];
  const result = await store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.images));
    const query = String(body.q || body.query || '').trim().toLowerCase();
    const clearAll = body.all === true || body.mode === 'all';
    if (!clearAll && !ids.size && !query) throw httpError(400, 'cache clear target is required.');

    const shouldDelete = (image) => {
      if (clearAll) return true;
      if (ids.has(image.id)) return true;
      if (!query) return false;
      return [image.id, image.token, image.prompt, image.fullPrompt, image.model]
        .some((value) => String(value || '').toLowerCase().includes(query));
    };

    const deletedIds = new Set();
    db.images = db.images.filter((image) => {
      if (!shouldDelete(image)) return true;
      deletedIds.add(image.id);
      deletedImages.push(image);
      return false;
    });

    if (deletedIds.size) {
      db.jobs.forEach((job) => {
        if (deletedIds.has(job.imageId)) job.imageId = '';
      });
    }

    db.ledger.unshift({
      id: createId('log'),
      type: 'clear-cache',
      amount: deletedIds.size,
      at: new Date().toISOString(),
      note: clearAll ? 'Cleared all cached images' : query ? `Cleared cached images matching ${query}` : 'Cleared selected cached images'
    });

    return { deleted: deletedIds.size, remaining: db.images.length };
  });
  await removeStoredImages(deletedImages);
  return result;
}

async function importPackage(body) {
  const mode = body.mode === 'merge' ? 'merge' : 'replace';
  const payload = body.data || body.package || body;
  if (!payload || typeof payload !== 'object') throw httpError(400, 'import package is required.');
  const incoming = normalizeDb(sanitizeMigrationData(payload));

  if (mode === 'replace') {
    const safeDb = normalizeDb({
      ...incoming,
      jobs: [],
      images: [],
      ledger: []
    });
    safeDb.accounts = safeDb.accounts.map((account) => ({ ...account, inFlight: 0 }));
    assignAccountRouteIds(safeDb.accounts);
    await store.write(safeDb);
    return {
      mode,
      users: safeDb.users.length,
      accounts: safeDb.accounts.length,
      images: safeDb.images.length
    };
  }

  return store.update((db) => {
    db.settings = {
      ...db.settings,
      ...incoming.settings,
      defaults: {
        ...(db.settings.defaults || {}),
        ...(incoming.settings.defaults || {})
      }
    };
    db.cards = mergeById(db.cards, incoming.cards);
    db.users = mergeById(db.users, incoming.users);
    db.accounts = mergeById(db.accounts, incoming.accounts).map((account) => ({ ...account, inFlight: 0 }));
    return {
      mode,
      users: db.users.length,
      accounts: db.accounts.length,
      images: db.images.length
    };
  });
}

async function updateAccount(id, body) {
  return store.update((db) => {
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw httpError(404, 'account not found.');
    if (body.name !== undefined) account.name = String(body.name).slice(0, 80);
    if (body.token !== undefined && body.token) account.token = String(body.token).trim();
    if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
    if (body.weight !== undefined) account.weight = clamp(Number(body.weight), 1, 100);
    account.updatedAt = new Date().toISOString();
    return account;
  });
}

async function createJob(token, body) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const request = normalizeNovelAiRequest(body, db.settings, { maxSteps: DIRECT_URL_MAX_STEPS });
    const cacheKey = requestCacheKey(token, request, body.seed);
    const nocache = isNoCache(body.nocache);
    if (!nocache) {
      const cached = db.images.find((image) => image.cacheKey === cacheKey && !image.mock && image.mimeType !== 'image/svg+xml');
      if (cached) {
        const now = new Date().toISOString();
        const job = {
          id: createId('job'),
          userToken: token,
          status: 'done',
          request,
          cacheKey,
          cost: 0,
          accountId: cached.accountId || '',
          createdAt: now,
          updatedAt: now,
          imageId: cached.id,
          error: ''
        };
        db.jobs.unshift(job);
        return job;
      }
    }

    const cost = generationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const queueTotal = activeJobCount(db.jobs) + 1;
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const job = {
      id: createId('job'),
      userToken: token,
      status: 'queued',
      request,
      cacheKey,
      queueTotal,
      cost,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageId: '',
      error: ''
    };
    db.jobs.unshift(job);
    db.ledger.unshift({
      id: createId('log'),
      type: 'reserve',
      token,
      jobId: job.id,
      amount: -cost,
      at: new Date().toISOString()
    });
    return job;
  });
}

async function ensureAccountRouteIds() {
  await store.update((db) => {
    assignAccountRouteIds(db.accounts);
  });
}

async function createDirectJob(token, request, cacheKey, options = {}) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = Number(options.cost ?? generationCost(request));
    const shouldCharge = !options.status && cost > 0;
    if (shouldCharge && user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const now = new Date().toISOString();
    if (shouldCharge) {
      user.balance -= cost;
      user.updatedAt = now;
    }
    const job = {
      id: createId('job'),
      source: 'direct',
      userToken: token,
      status: options.status || 'queued',
      request,
      cacheKey,
      queueTotal: options.status === 'done' ? 1 : activeJobCount(db.jobs) + 1,
      cost: shouldCharge ? cost : Number(options.cost || 0),
      accountId: options.accountId || '',
      deadlineAt: options.deadlineAt || '',
      createdAt: now,
      updatedAt: now,
      imageId: options.imageId || '',
      error: ''
    };
    db.jobs.unshift(job);
    if (shouldCharge) {
      db.ledger.unshift({
        id: createId('log'),
        type: 'reserve',
        token,
        jobId: job.id,
        amount: -cost,
        at: now
      });
    }
    return job;
  });
}

async function markDirectJobRunning(jobId, reservation) {
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.status = 'running';
    job.accountId = reservation.account?.id || '';
    job.cost = Number(reservation.cost || 0);
    job.updatedAt = new Date().toISOString();
  });
}

async function markDirectJobFailed(jobId, message) {
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.status = 'failed';
    job.error = publicErrorMessage(message);
    job.updatedAt = new Date().toISOString();
  });
  notifyJobWaiters(jobId, { error: publicErrorMessage(message) });
}

async function removeJob(jobId) {
  await store.update((db) => {
    db.jobs = db.jobs.filter((job) => job.id !== jobId);
  });
}

async function timeoutDirectJob(jobId) {
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job || ['done', 'failed'].includes(job.status)) return;
    if (job.status !== 'queued') return;
    refundJob(db, job, '连接超时');
    job.status = 'failed';
    job.error = '连接超时';
    job.updatedAt = new Date().toISOString();
  });
}

function waitForJobResult(jobId, deadline) {
  const remainingMs = Math.max(1, deadline - Date.now());
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      removeJobWaiter(jobId, waiter);
      resolve(null);
    }, remainingMs);
    const waiter = { resolve, timer };
    if (!jobWaiters.has(jobId)) jobWaiters.set(jobId, new Set());
    jobWaiters.get(jobId).add(waiter);
  });
}

function notifyJobWaiters(jobId, payload) {
  const waiters = jobWaiters.get(jobId);
  if (!waiters) return;
  jobWaiters.delete(jobId);
  waiters.forEach((waiter) => {
    clearTimeout(waiter.timer);
    waiter.resolve(payload);
  });
}

function removeJobWaiter(jobId, waiter) {
  const waiters = jobWaiters.get(jobId);
  if (!waiters) return;
  waiters.delete(waiter);
  if (!waiters.size) jobWaiters.delete(jobId);
}

async function runJob(jobId) {
  try {
    const reservation = await reserveQueuedJob(jobId);
    await runReservedJob(reservation);
  } catch (error) {
    console.error(error);
  }
}

async function reserveQueuedJob(jobId) {
  return store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) throw new Error('job not found.');
    if (job.status !== 'queued') return { skip: true };
    if (isExpiredJob(job)) {
      refundJob(db, job, '连接超时');
      job.status = 'failed';
      job.error = '连接超时';
      job.updatedAt = new Date().toISOString();
      return { skip: true };
    }
    const account = selectAccount(db.accounts, db.settings, { cost: job.cost });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, job.cost)) {
        refundJob(db, job, 'NovelAI账号点数不足');
        job.status = 'failed';
        job.error = 'NovelAI账号点数不足';
        job.updatedAt = new Date().toISOString();
        return { skip: true };
      }
      job.updatedAt = new Date().toISOString();
      return { queued: true };
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    job.status = 'running';
    job.accountId = account?.id || '';
    job.updatedAt = new Date().toISOString();
    return { job, account: account ? { ...account } : null, token: job.userToken, cost: job.cost, cacheKey: job.cacheKey || '' };
  });
}

async function runReservedJob(reservation) {
  if (!reservation || reservation.skip || reservation.queued) return;
  try {
    const image = await generateWithAccountRetry(reservation, reservation.job.request);
    await completeGeneration(reservation, reservation.job.request, image, { jobId: reservation.job.id });
  } catch (error) {
    if (isNovelAiCapacityError(error)) {
      await requeueReservedJob(reservation, error);
      return;
    }
    await failGeneration(reservation, error);
  }
}

async function generateWithAccountRetry(reservation, request, options = {}) {
  const tried = new Set();
  let firstError = null;
  let current = reservation;

  while (true) {
    if (current.account?.id) tried.add(current.account.id);
    try {
      const image = await generateNovelAiImage(request, current.account, process.env, { signal: options.signal });
      reservation.account = current.account;
      return image;
    } catch (error) {
      if (isAbortError(error)) throw error;
      if (!firstError) firstError = error;
      const next = await retryReservationWithNextAccount(current, error, tried, options);
      if (!next) {
        current.account = null;
        reservation.account = null;
        throw firstError || error;
      }
      current = next;
      reservation.account = current.account;
    }
  }
}

async function retryReservationWithNextAccount(reservation, error, tried, options = {}) {
  if (!reservation.account?.id) return null;
  return store.update((db) => {
    const failedAccount = db.accounts.find((item) => item.id === reservation.account.id);
    if (failedAccount) {
      failedAccount.inFlight = Math.max(0, Number(failedAccount.inFlight || 0) - 1);
      failedAccount.failures = Number(failedAccount.failures || 0) + 1;
      if (isNovelAiCapacityError(error)) failedAccount.cooldownUntil = new Date(Date.now() + accountBusyCooldownMs()).toISOString();
      if (isNovelAiAccountQuotaError(error)) {
        failedAccount.quotaPoints = 0;
        failedAccount.quotaError = '点数不足';
        failedAccount.quotaCheckedAt = new Date().toISOString();
      }
      failedAccount.updatedAt = new Date().toISOString();
    }

    if (options.deadline && Date.now() >= options.deadline) return null;
    const account = selectAccount(db.accounts, db.settings, { excludeIds: tried, cost: reservation.cost });
    if (!account) return null;
    account.inFlight = Number(account.inFlight || 0) + 1;
    account.lastUsedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();

    if (reservation.job?.id) {
      const job = db.jobs.find((item) => item.id === reservation.job.id);
      if (job) {
        job.status = 'running';
        job.error = '';
        job.updatedAt = new Date().toISOString();
      }
    }

    return {
      ...reservation,
      account: { ...account },
      job: reservation.job ? { ...reservation.job, accountId: account.id } : reservation.job
    };
  });
}

async function requeueReservedJob(reservation, error) {
  let delay = accountBusyCooldownMs();
  await store.update((db) => {
    if (reservation.account?.id) {
      const account = db.accounts.find((item) => item.id === reservation.account.id);
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.cooldownUntil = new Date(Date.now() + delay).toISOString();
        account.updatedAt = new Date().toISOString();
      }
    }
    const job = reservation.job?.id ? db.jobs.find((item) => item.id === reservation.job.id) : null;
    if (job) {
      job.status = 'queued';
      job.accountId = '';
      job.error = '';
      job.retryCount = Number(job.retryCount || 0) + 1;
      job.updatedAt = new Date().toISOString();
    }
    delay = Math.max(250, nextAccountReadyDelay(db.accounts, db.settings) || delay);
  });
  scheduleQueueDrain(delay);
}

async function reserveCreditAndAccount(token, request, cacheKey) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = generationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const account = selectAccount(db.accounts, db.settings, { cost });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, cost)) throw httpError(503, 'NovelAI账号点数不足');
      throw httpError(429, 'all NovelAI accounts are busy, retry shortly.');
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    db.ledger.unshift({
      id: createId('log'),
      type: 'charge',
      token,
      accountId: account?.id || '',
      amount: -cost,
      at: new Date().toISOString()
    });
    return { token, account: account ? { ...account } : null, cost, cacheKey };
  });
}

async function reserveCreditAndAccountWhenAvailable(token, request, cacheKey, deadline) {
  while (Date.now() < deadline) {
    const result = await tryReserveCreditAndAccount(token, request, cacheKey);
    if (!result.busy) return result.reservation;
    await sleep(Math.min(750, Math.max(50, deadline - Date.now())));
  }
  return null;
}

async function tryReserveCreditAndAccount(token, request, cacheKey) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = generationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const account = selectAccount(db.accounts, db.settings, { cost });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, cost)) throw httpError(503, 'NovelAI账号点数不足');
      return { busy: true };
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    db.ledger.unshift({
      id: createId('log'),
      type: 'charge',
      token,
      accountId: account?.id || '',
      amount: -cost,
      at: new Date().toISOString()
    });
    return { busy: false, reservation: { token, account: account ? { ...account } : null, cost, cacheKey } };
  });
}

async function completeGeneration(reservation, request, image, meta = {}) {
  const imageId = createId('img');
  const imageFile = await writeStoredImage(imageId, image);
  const savedImage = await store.update((db) => {
    const user = getUserOrThrow(db, reservation.token);
    const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      account.total = Number(account.total || 0) + 1;
      if (Number.isFinite(Number(account.quotaPoints))) {
        account.quotaPoints = Math.max(0, Number(account.quotaPoints) - Number(reservation.cost || 0));
      }
      account.updatedAt = new Date().toISOString();
    }

    const saved = {
      id: imageId,
      token: reservation.token,
      accountId: reservation.account?.id || '',
      cacheKey: image.mock ? '' : reservation.cacheKey || '',
      mock: Boolean(image.mock),
      prompt: request.tag,
      fullPrompt: request.prompt,
      model: request.model,
      width: request.width,
      height: request.height,
      requestedSteps: request.requestedSteps ?? request.steps,
      routedSteps: request.steps,
      cost: reservation.cost,
      mimeType: image.mimeType,
      file: imageFile,
      createdAt: new Date().toISOString()
    };
    db.images.unshift(saved);

    if (meta.jobId) {
      const job = db.jobs.find((item) => item.id === meta.jobId);
      if (job) {
        job.status = 'done';
        job.imageId = saved.id;
        job.accountId = reservation.account?.id || job.accountId || '';
        job.error = '';
        job.updatedAt = new Date().toISOString();
      }
    }

    return { ...saved, balance: user.balance };
  });
  scheduleQueueDrain();
  if (meta.jobId) notifyJobWaiters(meta.jobId, { saved: savedImage, image, balance: savedImage.balance });
  return savedImage;
}

async function failGeneration(reservation, error) {
  await store.update((db) => {
    const user = db.users.find((item) => item.token === reservation.token);
    if (user) {
      user.balance += Number(reservation.cost || 0);
      user.updatedAt = new Date().toISOString();
    }
    const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      account.failures = Number(account.failures || 0) + 1;
      account.updatedAt = new Date().toISOString();
    }
    if (reservation.job?.id) {
      const job = db.jobs.find((item) => item.id === reservation.job.id);
      if (job) {
        job.status = 'failed';
        job.error = publicErrorMessage(error.message);
        job.updatedAt = new Date().toISOString();
      }
    }
    db.ledger.unshift({
      id: createId('log'),
      type: 'refund',
      token: reservation.token,
      amount: Number(reservation.cost || 0),
      at: new Date().toISOString(),
      note: publicErrorMessage(error.message)
    });
  });
  scheduleQueueDrain();
  if (reservation.job?.id) notifyJobWaiters(reservation.job.id, { error: publicErrorMessage(error.message) });
}

function selectAccount(accounts, settings = {}, options = {}) {
  resetStaleAccountLoads(accounts);
  const excludeIds = options.excludeIds || new Set();
  const cost = Math.max(1, Number(options.cost || 1));
  const now = Date.now();
  const enabled = accounts.filter((account) => account.enabled !== false && !isAccountCoolingDown(account, now));
  if (!enabled.length) return null;
  const maxConcurrency = maxAccountConcurrency(settings);
  const available = enabled.filter((account) => {
    if (excludeIds.has(account.id)) return false;
    if (Number(account.inFlight || 0) >= maxConcurrency) return false;
    const quota = accountQuotaPoints(account);
    return quota === null || quota >= cost;
  });
  if (!available.length) return null;
  return available.sort((a, b) => {
    const quotaA = accountQuotaPoints(a);
    const quotaB = accountQuotaPoints(b);
    if (quotaA !== null || quotaB !== null) {
      if (quotaA === null) return 1;
      if (quotaB === null) return -1;
      if (quotaA !== quotaB) return quotaB - quotaA;
    }
    const loadA = Number(a.inFlight || 0) / maxConcurrency;
    const loadB = Number(b.inFlight || 0) / maxConcurrency;
    if (loadA !== loadB) return loadA - loadB;
    return Date.parse(a.lastUsedAt || 0) - Date.parse(b.lastUsedAt || 0);
  })[0];
}

function accountQuotaPoints(account) {
  const value = Number(account?.quotaPoints);
  return Number.isFinite(value) ? value : null;
}

function maxAccountConcurrency(settings = {}) {
  return clamp(Number(settings.accountConcurrency || 2), 1, 20);
}

function availableAccountSlots(accounts, settings = {}) {
  resetStaleAccountLoads(accounts);
  const now = Date.now();
  const allEnabled = accounts.filter((account) => account.enabled !== false);
  if (!allEnabled.length) return 1;
  const enabled = allEnabled.filter((account) => !isAccountCoolingDown(account, now));
  if (!enabled.length) return 0;
  const maxConcurrency = maxAccountConcurrency(settings);
  return enabled.reduce((sum, account) => sum + Math.max(0, maxConcurrency - Number(account.inFlight || 0)), 0);
}

function nextAccountReadyDelay(accounts, settings = {}) {
  resetStaleAccountLoads(accounts);
  const now = Date.now();
  const maxConcurrency = maxAccountConcurrency(settings);
  const enabled = accounts.filter((account) => account.enabled !== false);
  if (!enabled.length) return 0;
  if (enabled.some((account) => !isAccountCoolingDown(account, now) && Number(account.inFlight || 0) < maxConcurrency)) return 0;
  const waits = enabled
    .map((account) => Date.parse(account.cooldownUntil || '') - now)
    .filter((wait) => Number.isFinite(wait) && wait > 0);
  return waits.length ? Math.min(...waits) + 50 : 1000;
}

function scheduleQueueDrain(delay = 0) {
  if (queueDrainTimer || queueDraining) {
    queueDrainRequested = true;
    return;
  }
  queueDrainTimer = setTimeout(() => {
    queueDrainTimer = null;
    drainQueuedJobs();
  }, delay);
}

async function drainQueuedJobs() {
  if (queueDraining) {
    queueDrainRequested = true;
    return;
  }
  queueDraining = true;
  queueDrainRequested = false;
  try {
    const drainPlan = await store.update((db) => {
      const slots = availableAccountSlots(db.accounts, db.settings);
      if (slots <= 0) return { jobIds: [], delay: nextAccountReadyDelay(db.accounts, db.settings) };
      return {
        jobIds: db.jobs
          .filter((job) => job.status === 'queued')
          .reverse()
          .slice(0, slots)
          .map((job) => job.id),
        delay: 0
      };
    });
    const jobIds = drainPlan.jobIds || [];
    if (!jobIds.length && drainPlan.delay > 0) queueDrainRequested = true;
    const reservations = await Promise.all(jobIds.map((id) => reserveQueuedJob(id).catch((error) => ({ error }))));
    reservations.forEach((reservation) => {
      if (reservation?.error) {
        console.error(reservation.error);
        return;
      }
      runReservedJob(reservation);
    });
  } finally {
    queueDraining = false;
    if (queueDrainRequested) {
      const delay = await queueRetryDelay();
      scheduleQueueDrain(delay);
    }
  }
}

async function queueRetryDelay() {
  const db = await store.readCollections(['settings', 'accounts']);
  return Math.max(25, nextAccountReadyDelay(db.accounts, db.settings) || 25);
}

function hasEnabledAccounts(accounts) {
  return accounts.some((account) => account.enabled !== false);
}

function hasAccountWithEnoughQuota(accounts, cost = 1) {
  const required = Math.max(1, Number(cost || 1));
  return accounts.some((account) => {
    if (account.enabled === false) return false;
    const quota = accountQuotaPoints(account);
    return quota === null || quota >= required;
  });
}

function resetStaleAccountLoads(accounts) {
  const staleAfterMs = Number(process.env.ACCOUNT_INFLIGHT_TIMEOUT_MS || 10 * 60 * 1000);
  const now = Date.now();
  accounts.forEach((account) => {
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) <= now) account.cooldownUntil = '';
    if (Number(account.inFlight || 0) <= 0) return;
    const lastUsed = Date.parse(account.lastUsedAt || 0);
    if (!lastUsed || now - lastUsed > staleAfterMs) account.inFlight = 0;
  });
}

function isAccountCoolingDown(account, now = Date.now()) {
  const until = Date.parse(account.cooldownUntil || '');
  return Number.isFinite(until) && until > now;
}

function accountBusyCooldownMs() {
  return clamp(Number(process.env.ACCOUNT_429_COOLDOWN_MS || 800), 200, 120_000);
}

function assignAccountRouteIds(accounts) {
  const used = new Set();
  let next = 1;
  accounts.forEach((account) => {
    const current = Number(account.routeId || 0);
    if (Number.isInteger(current) && current > 0 && !used.has(current)) {
      account.routeId = current;
      used.add(current);
      next = Math.max(next, current + 1);
      return;
    }
    while (used.has(next)) next += 1;
    account.routeId = next;
    used.add(next);
    next += 1;
  });
}

function nextAccountRouteId(accounts) {
  return accounts.reduce((max, account) => Math.max(max, Number(account.routeId || 0)), 0) + 1;
}

function normalizePublicBaseUrl(value = '') {
  const text = String(value || '').trim().replace(/\/+$/, '');
  if (!text) return '';
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const pathname = url.pathname === '/' ? '' : url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return '';
  }
}

function getUserOrThrow(db, token) {
  const user = db.users.find((item) => item.token === token);
  if (!user || user.enabled === false) throw httpError(401, 'invalid token.');
  return user;
}

function publicUser(user) {
  return {
    id: user.id,
    token: user.token,
    balance: user.balance,
    enabled: user.enabled !== false,
    sourceCard: user.sourceCard,
    note: user.note || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

function publicCard(card) {
  return {
    id: card.id,
    code: card.code,
    credits: card.credits,
    used: Boolean(card.usedBy),
    usedBy: card.usedBy ? maskToken(card.usedBy) : '',
    usedAt: card.usedAt || '',
    createdAt: card.createdAt,
    expiresAt: card.expiresAt || '',
    note: card.note || ''
  };
}

function publicAccount(account, options = {}) {
  return {
    id: account.id,
    routeId: account.routeId || 0,
    name: account.name,
    token: options.revealToken ? account.token : maskToken(account.token),
    enabled: account.enabled !== false,
    weight: account.weight || 1,
    inFlight: account.inFlight || 0,
    total: account.total || 0,
    failures: account.failures || 0,
    quotaPoints: account.quotaPoints ?? null,
    quotaFixed: account.quotaFixed ?? null,
    quotaPurchased: account.quotaPurchased ?? null,
    quotaTier: account.quotaTier ?? null,
    quotaCheckedAt: account.quotaCheckedAt || '',
    quotaError: account.quotaError || '',
    cooldownUntil: account.cooldownUntil || '',
    stats1h: options.stats1h || { done: 0, failed: 0, total: 0, successRate: 0 },
    lastUsedAt: account.lastUsedAt || ''
  };
}

function exportAccount(account) {
  return {
    id: account.id,
    routeId: account.routeId || 0,
    name: account.name,
    token: account.token,
    enabled: account.enabled !== false,
    weight: account.weight || 1,
    total: account.total || 0,
    failures: account.failures || 0,
    quotaPoints: account.quotaPoints ?? null,
    quotaFixed: account.quotaFixed ?? null,
    quotaPurchased: account.quotaPurchased ?? null,
    quotaTier: account.quotaTier ?? null,
    quotaCheckedAt: account.quotaCheckedAt || '',
    quotaError: account.quotaError || '',
    createdAt: account.createdAt || '',
    updatedAt: account.updatedAt || '',
    lastUsedAt: account.lastUsedAt || ''
  };
}

function exportMigrationData(db) {
  return {
    settings: db.settings,
    cards: db.cards,
    users: db.users,
    accounts: db.accounts.map((account) => ({ ...account, inFlight: 0 })),
    jobs: [],
    images: [],
    ledger: []
  };
}

async function writeStoredImage(id, image) {
  const imageFile = imageStorageName(id, image.mimeType);
  await writeFile(path.join(dataDir, imageFile), image.buffer);
  return imageFile;
}

async function readStoredImage(image) {
  if (image.file) {
    return readFile(imageFilePath(image.file));
  }
  if (image.base64) {
    return Buffer.from(image.base64, 'base64');
  }
  throw httpError(404, 'image content not found.');
}

async function removeStoredImages(images) {
  await Promise.all(images.map(async (image) => {
    if (!image.file) return;
    try {
      await rm(imageFilePath(image.file), { force: true });
    } catch (error) {
      console.error(`Failed to delete cached image ${image.id}:`, error);
    }
  }));
}

function imageStorageName(id, mimeType = '') {
  return path.join('images', `${id}.${imageExtension(mimeType)}`);
}

function imageFilePath(file) {
  const resolved = path.resolve(dataDir, file);
  const root = path.resolve(imageDir);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) throw httpError(403, 'invalid image path.');
  return resolved;
}

function imageExtension(mimeType = '') {
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('svg')) return 'svg';
  return 'png';
}

function sanitizeMigrationData(payload) {
  return {
    settings: payload.settings || {},
    cards: Array.isArray(payload.cards) ? payload.cards : [],
    users: Array.isArray(payload.users) ? payload.users : [],
    accounts: Array.isArray(payload.accounts) ? payload.accounts : [],
    jobs: [],
    images: [],
    ledger: []
  };
}

function publicJob(job, db = null) {
  const queue = db && job.status === 'queued'
    ? stableQueueProgress(job, db.jobs)
    : job.status === 'running' && Number(job.queueTotal || 0) > 1
      ? { progress: Number(job.queueTotal || 0), total: Number(job.queueTotal || 0) }
      : { progress: 0, total: 0 };
  const request = job.request || {};
  const account = db && job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null;
  return {
    id: job.id,
    source: job.source || 'web',
    status: job.status,
    prompt: request.tag || '',
    model: request.model || '',
    requestedSteps: request.requestedSteps ?? request.steps ?? 0,
    routedSteps: request.steps ?? 0,
    accountId: job.accountId || '',
    accountRouteId: account?.routeId || 0,
    cost: job.cost,
    imageId: job.imageId || '',
    imageUrl: job.imageId ? `/api/images/${job.imageId}/content` : '',
    error: publicErrorMessage(job.error || ''),
    queuePosition: queue.progress,
    queuedCount: queue.total,
    durationMs: jobDurationMs(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function stableQueueProgress(job, jobs) {
  const total = Math.max(1, Number(job.queueTotal || 0));
  const createdAt = Date.parse(job.createdAt || '') || 0;
  const activeAhead = jobs.filter((item) => {
    if (item.id === job.id) return false;
    if (!['queued', 'running'].includes(item.status)) return false;
    const itemTime = Date.parse(item.createdAt || '') || 0;
    return itemTime <= createdAt;
  }).length;
  return {
    progress: Math.max(1, Math.min(total, total - activeAhead)),
    total
  };
}

function jobDurationMs(job) {
  const started = Date.parse(job.createdAt || '');
  if (!started) return 0;
  const terminal = ['done', 'failed'].includes(job.status);
  const ended = terminal ? Date.parse(job.updatedAt || '') : Date.now();
  if (!ended || ended < started) return 0;
  return ended - started;
}

function activeJobCount(jobs) {
  return jobs.filter((job) => ['queued', 'running'].includes(job.status)).length;
}

function isExpiredJob(job) {
  const deadline = Date.parse(job.deadlineAt || '');
  return Number.isFinite(deadline) && deadline > 0 && Date.now() >= deadline;
}

function refundJob(db, job, note) {
  if (job.refundedAt) return;
  const cost = Number(job.cost || 0);
  if (cost <= 0) return;
  const user = db.users.find((item) => item.token === job.userToken);
  if (!user) return;
  user.balance += cost;
  user.updatedAt = new Date().toISOString();
  job.refundedAt = new Date().toISOString();
  db.ledger.unshift({
    id: createId('log'),
    type: 'refund',
    token: job.userToken,
    amount: cost,
    at: job.refundedAt,
    note
  });
}

function jobStatsSince(jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  return finalizeStats(jobs.reduce((stats, job) => {
    if (isQuotaFailureJob(job)) return stats;
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return stats;
    if (job.status === 'done') stats.done += 1;
    if (job.status === 'failed') stats.failed += 1;
    return stats;
  }, { done: 0, failed: 0 }));
}

function accountStatsSince(accountId, jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  return finalizeStats(jobs.reduce((stats, job) => {
    if (isQuotaFailureJob(job)) return stats;
    if (job.accountId !== accountId) return stats;
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return stats;
    if (job.status === 'done') stats.done += 1;
    if (job.status === 'failed') stats.failed += 1;
    return stats;
  }, { done: 0, failed: 0 }));
}

function finalizeStats(stats) {
  const done = Number(stats.done || 0);
  const failed = Number(stats.failed || 0);
  const total = done + failed;
  return {
    done,
    failed,
    total,
    successRate: total ? done / total : 0
  };
}

function publicImage(image) {
  return {
    id: image.id,
    imageUrl: `/api/images/${image.id}/content`,
    token: maskToken(image.token || ''),
    accountId: image.accountId || '',
    prompt: image.prompt || '',
    fullPrompt: image.fullPrompt || '',
    model: image.model || '',
    width: image.width || 0,
    height: image.height || 0,
    requestedSteps: image.requestedSteps ?? image.routedSteps ?? 0,
    routedSteps: image.routedSteps ?? image.requestedSteps ?? 0,
    cost: image.cost || 1,
    mock: Boolean(image.mock),
    mimeType: image.mimeType || '',
    createdAt: image.createdAt || ''
  };
}

function generationCost(request = null) {
  const requestedCost = Number(request?.cost);
  const sizeCost = sizeCostMap[normalizeSizeName(request?.size)] || 1;
  const costs = [sizeCost];
  if (Number.isFinite(requestedCost) && requestedCost > 0) costs.push(Math.ceil(requestedCost));
  return Math.max(...costs);
}

function normalizeSizeName(value) {
  return String(value || '').replace(/\s*\(-\d+\)\s*$/, '').trim();
}

function requestCacheKey(token, request, explicitSeed = '') {
  return hashObject({
    token,
    request: cacheableRequest({
      ...request,
      seed: explicitSeed === undefined || explicitSeed === '' ? '' : Number(explicitSeed)
    })
  });
}

function cacheableRequest(request) {
  const { requestedSteps, ...cacheRequest } = request;
  return cacheRequest;
}

function isNoCache(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function isInsufficientBalanceError(error) {
  return Number(error?.statusCode || error?.status) === 402 || /insufficient balance|额度不足|余额不足/i.test(String(error?.message || error || ''));
}

function isNovelAiAccountQuotaError(error) {
  const text = String(error?.message || error || '');
  return /NovelAI returned (402|400|403).*?(insufficient|balance|quota|anlas|training|point|额度|余额|点数)|insufficient.*?(quota|anlas|training|point|balance)/i.test(text);
}

function isNovelAiCapacityError(error) {
  const text = String(error?.message || error || '');
  return /NovelAI returned 429|statusCode["']?\s*:\s*429|Concurrent generation is locked|并发生成被锁定|concurrent generation/i.test(text);
}

function isQuotaFailureJob(job) {
  return job?.status === 'failed' && isInsufficientBalanceError({ message: job.error });
}

function publicErrorMessage(message) {
  const text = String(message || '');
  if (isInsufficientBalanceError({ message: text })) return insufficientBalanceMessage;
  if (/This operation was aborted|operation was aborted|direct generate timeout|AbortError/i.test(text)) return '连接超时';
  if (/invalid token/i.test(text)) return '密钥无效或已被禁用。';
  if (/all NovelAI accounts are busy|server busy/i.test(text)) return '服务器繁忙，请稍后再试。';
  return text;
}

function isAbortError(error) {
  return error?.name === 'AbortError' || /aborted|abort/i.test(String(error?.message || ''));
}

function selectUsers(db, body) {
  const ids = new Set(collectValues(body.ids || body.users));
  const tokens = new Set(collectValues(body.tokens || body.token));
  if (!ids.size && !tokens.size) throw httpError(400, 'user ids or tokens are required.');
  const users = db.users.filter((user) => ids.has(user.id) || tokens.has(user.token));
  if (!users.length) throw httpError(404, 'no matching user tokens found.');
  return users;
}

function parseImportedAccounts(body) {
  if (Array.isArray(body.accounts)) {
    return body.accounts
      .map((account) => (typeof account === 'string' ? { token: account } : account))
      .filter((account) => String(account?.token || '').trim());
  }

  const text = String(body.tokens || body.tokenText || body.text || '').trim();
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line, index) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      const [name, token, weight] = line.includes(',') ? line.split(',').map((part) => part.trim()) : ['', line, ''];
      return {
        name: name || `NovelAI imported ${index + 1}`,
        token: token || line,
        weight: weight ? Number(weight) : 1
      };
    });
}

function mergeById(current, incoming) {
  const map = new Map();
  current.forEach((item) => map.set(item.id || createId('item'), item));
  incoming.forEach((item) => {
    const key = item.id || createId('item');
    map.set(key, { ...map.get(key), ...item, id: key });
  });
  return Array.from(map.values());
}

function collectValues(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  if (value === undefined || value === null || value === '') return [];
  return [String(value).trim()].filter(Boolean);
}

async function serveStatic(urlPath, res) {
  const pathname = urlPath === '/' ? '/index.html' : urlPath === '/admin' ? '/admin.html' : decodeURIComponent(urlPath);
  const filePath = path.resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(publicDir)) throw httpError(403, 'forbidden.');

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-store'
    });
    res.end(content);
  } catch {
    const content = await readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store'
    });
    res.end(content);
  }
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON body.');
  }
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...corsHeaders()
  });
  res.end(JSON.stringify(payload));
}

function sendOpenAiError(res, statusCode, message, type = 'invalid_request_error') {
  sendJson(res, statusCode, {
    error: {
      message: publicErrorMessage(message),
      type,
      param: null,
      code: type
    }
  });
}

function sendImage(res, statusCode, mimeType, buffer, extraHeaders = {}) {
  res.writeHead(statusCode, {
    'content-type': mimeType,
    'cache-control': 'public, max-age=31536000, immutable',
    'content-length': buffer.length,
    ...extraHeaders
  });
  res.end(buffer);
}

function sendBusyImage(res) {
  const image = buildErrorImage('服务器繁忙，请稍后再试');
  sendImage(res, 200, image.mimeType, image.buffer, {
    'cache-control': 'no-store',
    'x-error': '1',
    'x-busy': '1',
    'retry-after': '15'
  });
}

function sendTimeoutImage(res) {
  const image = buildErrorImage('连接超时');
  sendImage(res, 200, image.mimeType, image.buffer, {
    'cache-control': 'no-store',
    'x-error': '1',
    'x-timeout': '1'
  });
}

function sendCorsPreflight(res) {
  res.writeHead(204, {
    ...corsHeaders(),
    'access-control-max-age': '86400'
  });
  res.end();
}

function corsHeaders() {
  return {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization,x-admin-token,x-user-token'
  };
}

function contentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (filePath.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

function tokenFrom(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7).trim();
  return String(url.searchParams.get('token') || req.headers['x-user-token'] || '').trim();
}

function bearerToken(req) {
  const header = String(req.headers.authorization || '');
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function openAiErrorType(error) {
  const statusCode = Number(error?.statusCode || 500);
  if (statusCode === 401 || statusCode === 403) return 'authentication_error';
  if (statusCode === 429) return 'rate_limit_error';
  if (statusCode >= 500) return 'server_error';
  return 'invalid_request_error';
}

function isAdmin(req, url) {
  const header = String(req.headers['x-admin-token'] || '');
  const query = String(url.searchParams.get('adminToken') || '');
  return Boolean(adminToken) && (header === adminToken || query === adminToken);
}

function assertAdmin(req, url) {
  if (isAdmin(req, url)) return;
  const suppliedToken = String(req.headers['x-admin-token'] || url.searchParams.get('adminToken') || '').trim();
  throw httpError(suppliedToken ? 401 : 403, suppliedToken ? 'invalid token.' : 'admin token required.');
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
