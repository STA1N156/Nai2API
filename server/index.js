import http from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const runningJobControls = new Map();
const directGenerateTimeoutMs = Number(process.env.DIRECT_GENERATE_TIMEOUT_MS || 60_000);
const openAiChatTimeoutMs = Number(process.env.OPENAI_CHAT_TIMEOUT_MS || 10 * 60_000);
const openAiQueuePollMs = 650;
const openAiFixedSteps = 28;
const beijingOffsetMs = 8 * 60 * 60 * 1000;
const usageChartDays = 7;
const errorLogRetentionMs = usageChartDays * 24 * 60 * 60 * 1000;
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

installRuntimeSafetyHandlers();
await store.init();
await cleanupInterruptedStartupJobs();
await cleanupStaleActiveJobs('startup');
await mkdir(imageDir, { recursive: true });
await migrateInlineImages();
await ensureAccountRouteIds();
await applyRuntimeSettings();
await cleanupImageStorage().catch((error) => console.error('Failed to cleanup image storage:', error));

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
  logStartupQueueState().catch((error) => console.error('[runtime] failed to inspect startup queue:', error)).finally(() => {
    scheduleQueueDrain();
  });
});
installShutdownHandlers(server);

async function applyRuntimeSettings() {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  await store.update((db) => {
    if (publicBaseUrl && !db.settings.publicBaseUrl) db.settings.publicBaseUrl = publicBaseUrl;
    if (!db.settings.defaultArtist || db.settings.defaultArtist === legacyDefaultArtist) {
      db.settings.defaultArtist = defaultArtist2_5D;
    }
  }, { collections: ['settings'] });
}

async function migrateInlineImages() {
  const startedAt = Date.now();
  let migrated = 0;
  migrated = await store.update(async (db) => {
    for (const image of db.images) {
      if (!image.base64 || image.file) continue;
      const imageFile = imageStorageName(image.id, image.mimeType);
      try {
        await writeFile(path.join(dataDir, imageFile), Buffer.from(image.base64, 'base64'));
        image.file = imageFile;
        delete image.base64;
        migrated += 1;
      } catch (error) {
        console.error(`Failed to migrate cached image ${image.id}:`, error);
      }
    }
    return migrated;
  }, { collections: ['images'], shouldPersist: (count) => Number(count || 0) > 0 });
  if (migrated) console.log(`[runtime] migrated ${migrated} inline image(s) in ${Date.now() - startedAt}ms`);
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || 'GET';

  if (method === 'OPTIONS') {
    sendCorsPreflight(res);
    return;
  }

  if (method === 'HEAD') {
    if (url.pathname === '/api/health') {
      sendHead(res, 200, { 'content-type': 'application/json; charset=utf-8' });
      return;
    }
    await serveStatic(url.pathname, res, { head: true });
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
    let trimmedImages = [];
    const settings = await store.update((db) => {
      db.settings = {
        ...db.settings,
        ...body,
        costPerImage: 1,
        publicBaseUrl: normalizePublicBaseUrl(body.publicBaseUrl ?? db.settings.publicBaseUrl ?? ''),
        maxCacheImages: clamp(Number(body.maxCacheImages ?? db.settings.maxCacheImages ?? 500), 0, MAX_CACHE_IMAGES_LIMIT),
        accountConcurrency: 1,
        defaults: {
          ...(db.settings.defaults || {}),
          ...(body.defaults || {})
        }
      };
      trimmedImages = trimImageCacheRecords(db, { force: true });
      return db.settings;
    }, {
      collections: ['settings'],
      dirtyRows: () => imageCacheTrimDirtyRows(trimmedImages)
    });
    await removeStoredImages(trimmedImages);
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
    const startedAt = Date.now();
    assertAdmin(req, url);
    const readStartedAt = Date.now();
    const db = await store.readAdminSummary();
    const readMs = Date.now() - readStartedAt;
    resetStaleAccountLoads(db.accounts);
    const revealTokens = url.searchParams.get('revealTokens') === '1';
    const statsJobs = db.statsJobs || db.jobs || [];
    const errorLogJobs = db.errorJobs || statsJobs;
    const queueJobs = db.queueJobs || statsJobs;
    const computeStartedAt = Date.now();
    const accountStats1h = accountStatsMapSince(statsJobs, 60 * 60 * 1000);
    const queueDb = { ...db, jobs: queueJobs };
    const payload = {
      settings: db.settings,
      cards: db.cards.map(publicCard),
      users: db.users.map(publicUser),
      accounts: db.accounts.map((account) => publicAccount(account, {
        revealToken: revealTokens,
        stats1h: accountStats1h.get(account.id) || finalizeStats({})
      })),
      images: db.images.slice(0, 12).map(publicImage),
      imageCount: db.imageCount ?? db.images.length,
      imageTotal: db.imageCount ?? db.images.length,
      cacheImageCount: db.imageCount ?? db.images.length,
      requestStats1m: requestStatsSince(statsJobs, 60 * 1000),
      jobStats1h: jobStatsSince(statsJobs, 60 * 60 * 1000),
      usageHourlyDays: hourlyUsageStatsByDay(statsJobs),
      errorLogs: errorLogs(errorLogJobs, db, 100),
      jobs: db.jobs.slice(0, 50).map((job) => publicJob(job, queueDb)),
      ledger: db.ledger.slice(0, 80)
    };
    const computeMs = Date.now() - computeStartedAt;
    const sendStartedAt = Date.now();
    sendJson(res, 200, payload);
    const sendMs = Date.now() - sendStartedAt;
    runtimeRequestLog('admin summary', startedAt, {
      readMs,
      computeMs,
      sendMs,
      users: db.users.length,
      accounts: db.accounts.length,
      statsJobs: statsJobs.length,
      recentJobs: db.jobs.length,
      images: db.imageCount ?? db.images.length
    });
    return;
  }

  if (method === 'DELETE' && url.pathname === '/api/admin/logs') {
    assertAdmin(req, url);
    const result = await clearRequestLogs();
    sendJson(res, 200, result);
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
    const startedAt = Date.now();
    assertAdmin(req, url);
    const limit = clamp(Number(url.searchParams.get('limit') || 60), 1, 200);
    const offset = clamp(Number(url.searchParams.get('offset') || 0), 0, Number.MAX_SAFE_INTEGER);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const tier = String(url.searchParams.get('tier') || '').trim();
    const queryStartedAt = Date.now();
    const page = await store.readImagePage({ limit, offset, q, tier });
    const queryMs = Date.now() - queryStartedAt;
    const sendStartedAt = Date.now();
    sendJson(res, 200, {
      images: page.images.map(publicImage),
      total: page.total,
      matched: page.matched,
      offset: page.offset,
      limit: page.limit,
      maxCacheImages: page.maxCacheImages
    });
    const sendMs = Date.now() - sendStartedAt;
    runtimeRequestLog('admin images page', startedAt, {
      queryMs,
      sendMs,
      matched: page.matched,
      total: page.total,
      limit: page.limit,
      offset: page.offset
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

  if (method === 'POST' && url.pathname === '/api/admin/accounts/proxies') {
    assertAdmin(req, url);
    const body = await readJson(req);
    const result = await applyAccountProxies(body);
    scheduleQueueDrain();
    sendJson(res, 200, result);
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

  if (method === 'POST' && url.pathname.startsWith('/api/admin/accounts/') && url.pathname.endsWith('/test')) {
    assertAdmin(req, url);
    const parts = url.pathname.split('/');
    const id = decodeURIComponent(parts.at(-2) || '');
    const result = await testAccount(id);
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
    const snapshot = await store.findJobContext(job.id);
    sendJson(res, 202, publicJob(snapshot?.job || job, snapshot));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const token = tokenFrom(req, url);
    const snapshot = await store.findJobContext(id);
    const job = snapshot?.job;
    if (!job) throw httpError(404, 'job not found.');
    if (job.userToken !== token && !isAdmin(req, url)) throw httpError(403, 'forbidden.');
    sendJson(res, 200, publicJob(job, snapshot));
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
      await timeoutJob(directJob.id);
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
        await markDirectJobFailed(directJob.id, error.message || 'direct generate failed.');
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
  const deadline = Date.now() + openAiChatTimeoutMs;
  const job = await createJob(token, parsed.request, {
    deadlineAt: new Date(deadline).toISOString(),
    source: 'openai'
  });
  scheduleQueueDrain();

  if (body.stream === true) {
    await streamOpenAiImageJob(req, res, job, parsed.model, deadline);
    return;
  }

  const result = await waitForJobResult(job.id, deadline);
  if (!result) {
    await timeoutJob(job.id);
    throw httpError(504, 'direct generate timeout');
  }
  if (result.error) throw httpError(isTimeoutResultMessage(result.error) ? 504 : 500, result.error);

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

async function streamOpenAiImageJob(req, res, job, model, deadline = Date.now() + openAiChatTimeoutMs) {
  sendOpenAiStreamHeaders(res);
  const streamId = `chatcmpl-${job.id}`;
  writeOpenAiChunk(res, { id: streamId, model, content: '<think>\n任务已提交，正在进入队列\n' });
  let lastLine = '';
  let reachedRunning = false;
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

    await sleep(openAiQueuePollMs);
  }

  writeOpenAiChunk(res, { id: streamId, model, content: '连接超时\n</think>\n连接超时\n' });
  await timeoutJob(job.id);
  finishOpenAiStream(res, streamId, model);
}

async function publicJobSnapshot(jobId) {
  const snapshot = await store.findJobContext(jobId);
  return snapshot ? publicJob(snapshot.job, snapshot) : null;
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
  }, { collections: ['cards', 'users', 'ledger'] });
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
  }, { collections: ['cards'] });
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
  }, { collections: ['users', 'ledger'] });
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
  }, { collections: ['users', 'ledger'] });
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
  }, { collections: ['users', 'cards', 'ledger'] });
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
      proxyUrl: normalizeAccountProxyUrl(body.proxyUrl || body.socksProxy || body.proxy || ''),
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
  }, { collections: ['accounts'] });
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
      proxyUrl: normalizeAccountProxyUrl(account.proxyUrl || account.socksProxy || account.proxy || ''),
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
  }, { collections: ['accounts', 'ledger'] });
}

async function applyAccountProxies(body) {
  const proxies = parseProxyLines(body.proxies || body.proxyText || body.text || body.proxy || '');
  if (!proxies.length) throw httpError(400, 'no SOCKS5 proxies found.');
  return store.update((db) => {
    const ids = new Set(collectValues(body.ids || body.accounts));
    const accounts = ids.size ? db.accounts.filter((account) => ids.has(account.id)) : db.accounts;
    if (!accounts.length) throw httpError(ids.size ? 404 : 400, ids.size ? 'no matching accounts found.' : 'no accounts found.');
    const now = new Date().toISOString();
    const applied = Math.min(accounts.length, proxies.length);
    for (let index = 0; index < applied; index += 1) {
      accounts[index].proxyUrl = proxies[index];
      accounts[index].updatedAt = now;
    }
    db.ledger.unshift({
      id: createId('log'),
      type: 'apply-account-proxies',
      amount: applied,
      at: now,
      note: `Applied ${applied} SOCKS5 proxy setting(s)`
    });
    return {
      applied,
      proxies: proxies.length,
      accounts: accounts.slice(0, applied)
    };
  }, { collections: ['accounts', 'ledger'] });
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
  }, { collections: ['accounts', 'ledger'] });
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
  }, { collections: ['accounts', 'ledger'] });
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
  }, { collections: ['accounts', 'ledger'] });
}

async function refreshAccountQuotas(body) {
  const ids = new Set(collectValues(body.ids || body.accounts));
  const targets = await store.readCollections(['accounts']).then((db) => {
    const accounts = ids.size ? db.accounts.filter((account) => ids.has(account.id)) : db.accounts;
    return accounts.map((account) => ({
      id: account.id,
      token: account.token,
      proxyUrl: account.proxyUrl || ''
    }));
  });
  if (!targets.length) throw httpError(ids.size ? 404 : 400, ids.size ? 'no matching accounts found.' : 'no accounts found.');

  const now = new Date().toISOString();
  const results = [];
  for (const target of targets) {
    try {
      const quota = await fetchNovelAiAccountQuotaWithTimeout(target.token, target.proxyUrl);
      results.push(accountQuotaResult(target.id, quota, now));
    } catch (error) {
      results.push(accountQuotaErrorResult(target.id, error, now));
    }
  }

  const resultMap = new Map(results.map((result) => [result.id, result]));
  const accounts = await store.update((db) => {
    db.accounts.forEach((account) => {
      const result = resultMap.get(account.id);
      if (!result) return;
      applyAccountQuotaResult(account, result, now);
    });
    return db.accounts.filter((account) => resultMap.has(account.id));
  }, { collections: ['accounts'] });

  return {
    checked: results.length,
    ok: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    accounts: accounts.map((account) => publicAccount(account, { revealToken: true }))
  };
}

async function testAccount(id) {
  const db = await store.readCollections(['settings', 'accounts']);
  const target = db.accounts.find((account) => account.id === id);
  if (!target) throw httpError(404, 'account not found.');

  const now = new Date().toISOString();
  let result;
  try {
    const quota = await fetchNovelAiAccountQuotaWithTimeout(target.token, target.proxyUrl);
    result = accountQuotaResult(target.id, quota, now);
  } catch (error) {
    result = accountQuotaErrorResult(target.id, error, now);
  }

  const account = await store.update((writeDb) => {
    const item = writeDb.accounts.find((entry) => entry.id === id);
    if (!item) throw httpError(404, 'account not found.');
    applyAccountQuotaResult(item, result, now);
    return item;
  }, { collections: ['accounts'] });
  const availability = accountAvailability(account, db.settings);
  const ok = Boolean(result.ok);
  const available = ok && availability.available;

  return {
    ok,
    available,
    message: accountTestMessage(result, availability),
    checkedAt: now,
    availability,
    account: publicAccount(account, { revealToken: true })
  };
}

function accountQuotaResult(id, quota, now) {
  return {
    id,
    ok: true,
    quotaPoints: quota.points,
    quotaFixed: quota.fixed,
    quotaPurchased: quota.purchased,
    quotaTier: quota.tier,
    quotaCheckedAt: now,
    quotaError: ''
  };
}

function accountQuotaErrorResult(id, error, now) {
  return {
    id,
    ok: false,
    quotaPoints: null,
    quotaFixed: null,
    quotaPurchased: null,
    quotaTier: null,
    quotaCheckedAt: now,
    quotaError: publicErrorMessage(error.message || 'quota query failed.')
  };
}

function applyAccountQuotaResult(account, result, now) {
  account.quotaPoints = result.quotaPoints;
  account.quotaFixed = result.quotaFixed;
  account.quotaPurchased = result.quotaPurchased;
  account.quotaTier = result.quotaTier;
  account.quotaCheckedAt = result.quotaCheckedAt;
  account.quotaError = result.quotaError;
  if (result.ok) account.cooldownUntil = '';
  account.updatedAt = now;
}

function accountAvailability(account, settings = {}) {
  const now = Date.now();
  const maxConcurrency = maxAccountConcurrency(settings);
  const inFlight = Number(account.inFlight || 0);
  const cooldownUntilMs = Date.parse(account.cooldownUntil || '');
  const coolingDown = Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now;
  const quotaPoints = accountQuotaPoints(account);
  const enabled = account.enabled !== false;
  const hasSlot = inFlight < maxConcurrency;
  const standardAvailable = enabled && !coolingDown && hasSlot;
  const highResolutionAvailable = standardAvailable && (quotaPoints === null || quotaPoints >= 20);

  return {
    enabled,
    coolingDown,
    cooldownUntil: coolingDown ? account.cooldownUntil : '',
    inFlight,
    maxConcurrency,
    hasSlot,
    quotaPoints,
    available: standardAvailable,
    standardAvailable,
    highResolutionAvailable
  };
}

function accountTestMessage(result, availability) {
  if (!result.ok) return `测试失败：${result.quotaError || '账号不可用'}`;
  if (!availability.enabled) return '测试通过：Token 有效，但这个账号已禁用';
  if (availability.coolingDown) return '测试通过：Token 有效，但账号正在冷却中';
  if (!availability.hasSlot) return '测试通过：Token 有效，但账号当前并发已满';
  const quotaText = availability.quotaPoints === null ? '点数未知' : `剩余 ${availability.quotaPoints} 点`;
  if (!availability.highResolutionAvailable) return `测试通过：普通生成可用，2K/4K 点数不足（${quotaText}）`;
  return `测试通过：账号当前可用（${quotaText}）`;
}

async function fetchNovelAiAccountQuotaWithTimeout(token, proxyUrl = '') {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    return await fetchNovelAiAccountQuota(token, process.env, {
      signal: controller.signal,
      proxyUrl
    });
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
  }, { collections: ['images', 'jobs', 'ledger'] });
  await removeStoredImages(deletedImages);
  return result;
}

async function clearRequestLogs() {
  return store.update((db) => {
    const before = Array.isArray(db.jobs) ? db.jobs.length : 0;
    db.jobs = (Array.isArray(db.jobs) ? db.jobs : []).filter((job) => ['queued', 'running'].includes(job.status));
    return {
      removed: before - db.jobs.length,
      remaining: db.jobs.length
    };
  }, { collections: ['jobs'] });
}

async function cleanupStaleActiveJobs(reason = 'stale active job cleanup') {
  const result = await store.update((db) => {
    const now = Date.now();
    const failedJobIds = [];
    const message = publicErrorMessage('direct generate timeout');
    const jobs = Array.isArray(db.jobs) ? db.jobs : [];
    jobs.forEach((job) => {
      if (!isStaleActiveJob(job, now)) return;
      const detail = staleActiveJobDetail(job, now);
      const account = job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null;
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.updatedAt = new Date().toISOString();
      }
      refundJob(db, job, message);
      job.status = 'failed';
      job.error = message;
      job.errorDetail = `${reason}: ${detail}`;
      job.updatedAt = new Date().toISOString();
      job.completedAt = job.updatedAt;
      failedJobIds.push(job.id);
    });
    return {
      changed: failedJobIds.length,
      jobIds: failedJobIds
    };
  }, {
    dirtyRows: dirtyJobListRows,
    shouldPersist: (result) => Number(result?.changed || 0) > 0
  });

  if (!result?.changed) return result;
  result.jobIds.forEach((jobId) => notifyJobWaiters(jobId, { error: 'direct generate timeout' }));
  return result;
}

async function cleanupInterruptedStartupJobs() {
  const startedAt = Date.now();
  const result = await store.update((db) => {
    const now = Date.now();
    const updatedAt = new Date(now).toISOString();
    const message = publicErrorMessage('direct generate timeout');
    const jobs = Array.isArray(db.jobs) ? db.jobs : [];
    const failedJobIds = [];
    let running = 0;
    let direct = 0;
    let openai = 0;
    let expired = 0;

    jobs.forEach((job) => {
      if (!['queued', 'running'].includes(job.status)) return;
      const isRunning = job.status === 'running';
      const isDirect = job.source === 'direct';
      const isOpenAi = job.source === 'openai';
      const isExpired = isExpiredJobAt(job, now);
      if (!isRunning && !isDirect && !isOpenAi && !isExpired) return;

      if (isRunning) running += 1;
      if (isDirect) direct += 1;
      if (isOpenAi) openai += 1;
      if (isExpired) expired += 1;

      const account = job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null;
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.updatedAt = updatedAt;
      }
      refundJob(db, job, message);
      job.status = 'failed';
      job.error = message;
      job.errorDetail = isDirect || isOpenAi
        ? 'startup: request-bound job was interrupted by server restart'
        : isRunning
          ? 'startup: running job was interrupted by server restart'
          : 'startup: job deadline expired before restart completed';
      job.updatedAt = updatedAt;
      job.completedAt = updatedAt;
      failedJobIds.push(job.id);
    });

    return {
      changed: failedJobIds.length,
      running,
      direct,
      openai,
      expired,
      queuedRemaining: jobs.filter((job) => job.status === 'queued').length,
      runningRemaining: jobs.filter((job) => job.status === 'running').length,
      jobIds: failedJobIds
    };
  }, {
    dirtyRows: dirtyJobListRows,
    shouldPersist: (result) => Number(result?.changed || 0) > 0
  });

  console.log(`[runtime] startup interrupted job cleanup completed in ${Date.now() - startedAt}ms: changed=${result.changed} running=${result.running} direct=${result.direct} openai=${result.openai} expired=${result.expired} queuedRemaining=${result.queuedRemaining} runningRemaining=${result.runningRemaining}`);
  if (result.changed) result.jobIds.forEach((jobId) => notifyJobWaiters(jobId, { error: 'direct generate timeout' }));
  return result;
}

async function logStartupQueueState() {
  const counts = await store.readQueueStateCounts();
  console.log(`[runtime] startup queue resume state: queued=${counts.queued} running=${counts.running} directQueued=${counts.directQueued} openaiQueued=${counts.openAiQueued}`);
}

async function cleanupImageStorage() {
  const startedAt = Date.now();
  const trimmedImages = await store.update((db) => trimImageCacheRecords(db, { force: true }), {
    collections: ['settings'],
    dirtyRows: imageCacheTrimDirtyRows,
    shouldPersist: (images) => Array.isArray(images) && images.length > 0
  }) || [];
  await removeStoredImages(trimmedImages);

  const imageFiles = await store.readImageFiles();
  if (!imageFiles) {
    if (trimmedImages.length) {
      console.log(`[runtime] image cache cleanup removed ${trimmedImages.length} expired records and skipped orphan scan because image cache is partially loaded in ${Date.now() - startedAt}ms`);
    } else {
      console.log(`[runtime] image cache cleanup skipped orphan scan because image cache is partially loaded in ${Date.now() - startedAt}ms`);
    }
    return;
  }
  const referencedFiles = new Set(imageFiles
    .map((file) => path.resolve(dataDir, file)));

  let entries = [];
  try {
    entries = await readdir(imageDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }

  const orphanFiles = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('img_'))
    .map((entry) => path.join(imageDir, entry.name))
    .filter((file) => !referencedFiles.has(path.resolve(file)));

  await Promise.all(orphanFiles.map(async (file) => {
    try {
      await rm(file, { force: true });
    } catch (error) {
      console.error(`Failed to delete orphan cached image ${path.basename(file)}:`, error);
    }
  }));

  if (trimmedImages.length || orphanFiles.length) {
    console.log(`[runtime] image cache cleanup removed ${trimmedImages.length} expired records and ${orphanFiles.length} orphan files in ${Date.now() - startedAt}ms`);
  } else {
    runtimeSlowLog('image cache cleanup', startedAt, 'removed=0');
  }
}

function trimImageCacheRecords(db, options = {}) {
  db.settings = db.settings || {};
  db.images = Array.isArray(db.images) ? db.images : [];
  const maxCacheImages = normalizeCacheImageLimit(db.settings.maxCacheImages);
  db.settings.maxCacheImages = maxCacheImages;

  const force = options.force === true || maxCacheImages <= 0;
  const trimBuffer = force ? 0 : imageCacheTrimBuffer(maxCacheImages);
  const trimAt = maxCacheImages + trimBuffer;
  if (db.images.length < trimAt) return [];

  const removedImages = db.images.slice(maxCacheImages);
  db.images = db.images.slice(0, maxCacheImages);

  const removedIds = new Set(removedImages.map((image) => image.id).filter(Boolean));
  const affectedJobIds = [];
  if (removedIds.size && Array.isArray(db.jobs)) {
    db.jobs.forEach((job) => {
      if (!removedIds.has(job.imageId)) return;
      job.imageId = '';
      if (job.id) affectedJobIds.push(job.id);
    });
  }

  removedImages.affectedJobIds = affectedJobIds;
  return removedImages;
}

function imageCacheTrimDirtyRows(trimmedImages = []) {
  const images = uniqueIds((Array.isArray(trimmedImages) ? trimmedImages : []).map((image) => image?.id));
  const jobs = uniqueIds(trimmedImages?.affectedJobIds || []);
  return {
    ...(images.length ? { images } : {}),
    ...(jobs.length ? { jobs } : {})
  };
}

function uniqueIds(values = []) {
  return [...new Set(values.map((value) => String(value || '').trim()).filter(Boolean))];
}

function imageCacheTrimBuffer(maxCacheImages) {
  return maxCacheImages > 0 ? 100 : 0;
}

function normalizeCacheImageLimit(value) {
  const number = Number(value ?? 500);
  if (!Number.isFinite(number)) return 500;
  return Math.max(0, Math.min(MAX_CACHE_IMAGES_LIMIT, Math.floor(number)));
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
    await cleanupImageStorage();
    return {
      mode,
      users: safeDb.users.length,
      accounts: safeDb.accounts.length,
      images: safeDb.images.length
    };
  }

  let trimmedImages = [];
  const result = await store.update((db) => {
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
    trimmedImages = trimImageCacheRecords(db, { force: true });
    return {
      mode,
      users: db.users.length,
      accounts: db.accounts.length,
      images: db.images.length
    };
  }, {
    collections: ['settings', 'cards', 'users', 'accounts'],
    dirtyRows: () => imageCacheTrimDirtyRows(trimmedImages)
  });
  await removeStoredImages(trimmedImages);
  return result;
}

async function updateAccount(id, body) {
  return store.update((db) => {
    const account = db.accounts.find((item) => item.id === id);
    if (!account) throw httpError(404, 'account not found.');
    if (body.name !== undefined) account.name = String(body.name).slice(0, 80);
    if (body.token !== undefined && body.token) account.token = String(body.token).trim();
    if (body.proxyUrl !== undefined || body.socksProxy !== undefined || body.proxy !== undefined) {
      account.proxyUrl = normalizeAccountProxyUrl(body.proxyUrl || body.socksProxy || body.proxy || '');
    }
    if (body.enabled !== undefined) account.enabled = Boolean(body.enabled);
    if (body.weight !== undefined) account.weight = clamp(Number(body.weight), 1, 100);
    account.updatedAt = new Date().toISOString();
    return account;
  }, { collections: ['accounts'] });
}

function dirtyJobRows(jobId) {
  return jobId ? { jobs: [jobId] } : {};
}

function dirtyResultJobRows(result, db) {
  return dirtyJobMutationRows(result, db);
}

function dirtyReservationJobRows(reservation) {
  return (result, db) => dirtyJobMutationRows({
    job: result?.job || reservation?.job,
    jobId: result?.job?.id || result?.jobId || reservation?.job?.id,
    token: result?.token || reservation?.token || reservation?.job?.userToken,
    accountIds: [reservation?.account?.id, result?.account?.id, result?.job?.accountId]
  }, db);
}

function dirtyJobMutationRows(source = {}, db = {}) {
  const jobId = source?.job?.id || source?.jobId || source?.id || '';
  const job = source?.job || (jobId ? db.jobs?.find((item) => item.id === jobId) : null);
  const token = source?.token || source?.userToken || job?.userToken || '';
  const accountIds = uniqueIds([
    ...(Array.isArray(source?.accountIds) ? source.accountIds : []),
    source?.account?.id,
    source?.accountId,
    job?.accountId
  ]);
  const ledgerIds = uniqueIds([
    source?.ledgerId,
    ...(jobId ? (db.ledger || []).filter((entry) => entry.jobId === jobId).map((entry) => entry.id) : [])
  ]);
  const user = token && ledgerIds.length ? db.users?.find((item) => item.token === token) : null;
  return {
    ...(jobId ? { jobs: [jobId] } : {}),
    ...(user?.id ? { users: [user.id] } : {}),
    ...(accountIds.length ? { accounts: accountIds } : {}),
    ...(ledgerIds.length ? { ledger: ledgerIds } : {})
  };
}

function dirtyJobListRows(result = {}, db = {}) {
  const rows = {};
  for (const jobId of result?.jobIds || []) {
    mergeDirtyRows(rows, dirtyJobMutationRows({ jobId }, db));
  }
  return rows;
}

function dirtyCreditReservationRows(result) {
  const reservation = result?.reservation || result || {};
  return {
    ...(reservation.userId ? { users: [reservation.userId] } : {}),
    ...(reservation.account?.id ? { accounts: [reservation.account.id] } : {}),
    ...(reservation.ledgerId ? { ledger: [reservation.ledgerId] } : {})
  };
}

function mergeDirtyRows(target, source = {}) {
  Object.entries(source).forEach(([collection, ids]) => {
    target[collection] = uniqueIds([...(target[collection] || []), ...(Array.isArray(ids) ? ids : [ids])]);
  });
  return target;
}

async function createJob(token, body, options = {}) {
  await cleanupStaleActiveJobs('create job');
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
          source: options.source || 'web',
          userToken: token,
          status: 'done',
          request,
          cacheKey,
          cost: 0,
          accountCost: 0,
          accountId: cached.accountId || '',
          createdAt: now,
          updatedAt: now,
          completedAt: now,
          imageId: cached.id,
          error: '',
          errorDetail: ''
        };
        db.jobs.unshift(job);
        return job;
      }
    }

    const cost = generationCost(request);
    const accountCost = accountGenerationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const queueTotal = activeJobCount(db.jobs) + 1;
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const job = {
      id: createId('job'),
      source: options.source || 'web',
      userToken: token,
      status: 'queued',
      request,
      cacheKey,
      queueTotal,
      cost,
      accountCost,
      deadlineAt: options.deadlineAt || '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      imageId: '',
      error: '',
      errorDetail: ''
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
  }, {
    dirtyRows: dirtyResultJobRows
  });
}

async function ensureAccountRouteIds() {
  await store.update((db) => {
    assignAccountRouteIds(db.accounts);
  }, { collections: ['accounts'] });
}

async function createDirectJob(token, request, cacheKey, options = {}) {
  if (options.status !== 'done') await cleanupStaleActiveJobs('create direct job');
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = Number(options.cost ?? generationCost(request));
    const accountCost = Number(options.accountCost ?? (options.status ? 0 : accountGenerationCost(request)));
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
      accountCost,
      accountId: options.accountId || '',
      deadlineAt: options.deadlineAt || '',
      createdAt: now,
      updatedAt: now,
      completedAt: options.status === 'done' ? now : '',
      imageId: options.imageId || '',
      error: '',
      errorDetail: ''
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
  }, {
    dirtyRows: dirtyResultJobRows
  });
}

async function markDirectJobRunning(jobId, reservation) {
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.status = 'running';
    job.accountId = reservation.account?.id || '';
    job.cost = Number(reservation.cost || 0);
    job.accountCost = Number(reservation.accountCost || 0);
    job.completedAt = '';
    job.error = '';
    job.errorDetail = '';
    job.updatedAt = new Date().toISOString();
  }, { collections: ['jobs'], dirtyRows: dirtyJobRows(jobId) });
}

async function markDirectJobFailed(jobId, message) {
  const detail = errorDetailMessage(message);
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job) return;
    job.status = 'failed';
    job.error = publicErrorMessage(detail);
    job.errorDetail = detail;
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
  }, { collections: ['jobs'], dirtyRows: dirtyJobRows(jobId) });
  notifyJobWaiters(jobId, { error: publicErrorMessage(detail) });
}

async function removeJob(jobId) {
  await store.update((db) => {
    db.jobs = db.jobs.filter((job) => job.id !== jobId);
  }, { collections: ['jobs'], dirtyRows: dirtyJobRows(jobId) });
}

async function timeoutJob(jobId) {
  const control = runningJobControls.get(jobId);
  if (control) {
    abortRunningJob(jobId, 'direct generate timeout');
    await control.done;
    return;
  }
  await cancelQueuedOrRunningJob(jobId, 'direct generate timeout', 'job timed out before completion');
}

async function cancelQueuedOrRunningJob(jobId, message, detail = message) {
  let changed = false;
  const publicMessage = publicErrorMessage(message);
  await store.update((db) => {
    const job = db.jobs.find((item) => item.id === jobId);
    if (!job || ['done', 'failed'].includes(job.status)) return;
    const account = job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      account.updatedAt = new Date().toISOString();
    }
    refundJob(db, job, publicMessage);
    job.status = 'failed';
    job.error = publicMessage;
    job.errorDetail = detail;
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
    changed = true;
  }, {
    dirtyRows: (_result, db) => dirtyJobMutationRows({ jobId }, db),
    shouldPersist: () => changed
  });
  if (!changed) return;
  scheduleQueueDrain();
  notifyJobWaiters(jobId, { error: message });
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

function isTimeoutResultMessage(message) {
  return /direct generate timeout|job timed out|aborted|abort|timeout/i.test(String(message || ''));
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
    if (job.status !== 'queued') return { skip: true, changed: false };
    const accountCost = jobAccountCost(job);
    job.accountCost = accountCost;
    if (isStaleActiveJob(job)) {
      const detail = staleActiveJobDetail(job);
      refundJob(db, job, '连接超时');
      job.status = 'failed';
      job.error = '连接超时';
      job.errorDetail = detail;
      job.updatedAt = new Date().toISOString();
      job.completedAt = job.updatedAt;
      return { skip: true, jobId: job.id };
    }
    const account = selectAccount(db.accounts, db.settings, { cost: accountCost });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, accountCost)) {
        refundJob(db, job, 'NovelAI账号点数不足');
        job.status = 'failed';
        job.error = 'NovelAI账号点数不足';
        job.errorDetail = `No NovelAI account has enough quota for accountCost=${accountCost}`;
        job.updatedAt = new Date().toISOString();
        job.completedAt = job.updatedAt;
        return { skip: true, jobId: job.id };
      }
      job.updatedAt = new Date().toISOString();
      return { queued: true, jobId: job.id };
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    job.status = 'running';
    job.accountId = account?.id || '';
    job.completedAt = '';
    job.updatedAt = new Date().toISOString();
    return { job, account: account ? { ...account } : null, token: job.userToken, cost: job.cost, accountCost, cacheKey: job.cacheKey || '' };
  }, {
    dirtyRows: dirtyResultJobRows,
    shouldPersist: (result) => result?.changed !== false
  });
}

async function runReservedJob(reservation) {
  if (!reservation || reservation.skip || reservation.queued) return;
  const control = createRunningJobControl(reservation.job);
  try {
    const image = await generateWithAccountRetry(reservation, reservation.job.request, {
      signal: control.controller.signal,
      deadline: jobDeadlineTimestamp(reservation.job)
    });
    if (control.controller.signal.aborted) throw control.controller.signal.reason || new Error(control.reason || 'direct generate timeout');
    await completeGeneration(reservation, reservation.job.request, image, { jobId: reservation.job.id });
  } catch (error) {
    if (control.controller.signal.aborted || isAbortError(error)) {
      await cancelReservedJob(reservation, error);
      return;
    }
    if (isNovelAiCapacityError(error)) {
      await requeueReservedJob(reservation, error);
      return;
    }
    await failGeneration(reservation, error);
  } finally {
    finishRunningJobControl(reservation.job?.id, control);
  }
}

function createRunningJobControl(job = {}) {
  const controller = new AbortController();
  let resolveDone = () => {};
  const control = {
    controller,
    done: new Promise((resolve) => {
      resolveDone = resolve;
    }),
    resolveDone,
    reason: '',
    timer: null
  };
  const jobId = job?.id || '';
  if (!jobId) return control;
  const delay = runningJobTimeoutDelay(job);
  control.timer = setTimeout(() => abortRunningJob(jobId, 'direct generate timeout'), delay);
  runningJobControls.set(jobId, control);
  return control;
}

function finishRunningJobControl(jobId, control) {
  if (!control) return;
  if (control.timer) clearTimeout(control.timer);
  if (jobId && runningJobControls.get(jobId) === control) runningJobControls.delete(jobId);
  control.resolveDone();
}

function abortRunningJob(jobId, reason = 'direct generate timeout') {
  const control = runningJobControls.get(jobId);
  if (!control) return false;
  control.reason = reason;
  if (!control.controller.signal.aborted) control.controller.abort(new Error(reason));
  return true;
}

function runningJobTimeoutDelay(job = {}) {
  const deadline = jobDeadlineTimestamp(job);
  const delays = [novelAiGenerateTimeoutMs()];
  if (deadline) delays.push(Math.max(1, deadline - Date.now()));
  return Math.max(1, Math.min(...delays));
}

function jobDeadlineTimestamp(job = {}) {
  const deadline = Date.parse(job.deadlineAt || '');
  return Number.isFinite(deadline) && deadline > 0 ? deadline : 0;
}

function novelAiGenerateTimeoutMs() {
  const configured = Number(process.env.NOVELAI_GENERATE_TIMEOUT_MS || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(1000, Math.floor(configured));
  return Math.max(1, accountInflightTimeoutMs() - 1000);
}

function accountInflightTimeoutMs() {
  const configured = Number(process.env.ACCOUNT_INFLIGHT_TIMEOUT_MS || 10 * 60 * 1000);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1000, Math.floor(configured)) : 10 * 60 * 1000;
}

async function generateWithAccountRetry(reservation, request, options = {}) {
  const tried = new Set();
  let firstError = null;
  let current = reservation;

  while (true) {
    if (options.signal?.aborted) throw options.signal.reason || new Error('direct generate timeout');
    if (current.account?.id) tried.add(current.account.id);
    try {
      const image = await generateNovelAiImage(request, current.account, process.env, { signal: options.signal });
      reservation.account = current.account;
      return image;
    } catch (error) {
      if (options.signal?.aborted || isAbortError(error)) throw error;
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
    const accountCost = reservationAccountCost(reservation, reservation.job?.request);
    const account = selectAccount(db.accounts, db.settings, { excludeIds: tried, cost: accountCost });
    if (!account) return null;
    account.inFlight = Number(account.inFlight || 0) + 1;
    account.lastUsedAt = new Date().toISOString();
    account.updatedAt = new Date().toISOString();

    if (reservation.job?.id) {
      const job = db.jobs.find((item) => item.id === reservation.job.id);
      if (job) {
        job.status = 'running';
        job.accountId = account.id;
        job.completedAt = '';
        job.error = '';
        job.errorDetail = '';
        job.updatedAt = new Date().toISOString();
      }
    }

    return {
      ...reservation,
      accountCost,
      account: { ...account },
      job: reservation.job ? { ...reservation.job, accountId: account.id } : reservation.job
    };
  }, { dirtyRows: dirtyReservationJobRows(reservation) });
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
      job.completedAt = '';
      job.error = '';
      job.errorDetail = '';
      job.retryCount = Number(job.retryCount || 0) + 1;
      job.updatedAt = new Date().toISOString();
    }
    delay = Math.max(250, nextAccountReadyDelay(db.accounts, db.settings) || delay);
  }, { dirtyRows: dirtyReservationJobRows(reservation) });
  scheduleQueueDrain(delay);
}

async function reserveCreditAndAccount(token, request, cacheKey) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = generationCost(request);
    const accountCost = accountGenerationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const account = selectAccount(db.accounts, db.settings, { cost: accountCost });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, accountCost)) throw httpError(503, 'NovelAI账号点数不足');
      throw httpError(429, 'all NovelAI accounts are busy, retry shortly.');
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const ledger = {
      id: createId('log'),
      type: 'charge',
      token,
      accountId: account?.id || '',
      amount: -cost,
      at: new Date().toISOString()
    };
    db.ledger.unshift(ledger);
    return { token, userId: user.id, account: account ? { ...account } : null, ledgerId: ledger.id, cost, accountCost, cacheKey };
  }, {
    dirtyRows: dirtyCreditReservationRows
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
    const accountCost = accountGenerationCost(request);
    if (user.balance < cost) throw httpError(402, insufficientBalanceMessage);
    const account = selectAccount(db.accounts, db.settings, { cost: accountCost });
    if (!account && hasEnabledAccounts(db.accounts)) {
      if (!hasAccountWithEnoughQuota(db.accounts, accountCost)) throw httpError(503, 'NovelAI账号点数不足');
      return { busy: true };
    }
    if (account) {
      account.inFlight = Number(account.inFlight || 0) + 1;
      account.lastUsedAt = new Date().toISOString();
    }
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const ledger = {
      id: createId('log'),
      type: 'charge',
      token,
      accountId: account?.id || '',
      amount: -cost,
      at: new Date().toISOString()
    };
    db.ledger.unshift(ledger);
    return { busy: false, reservation: { token, userId: user.id, account: account ? { ...account } : null, ledgerId: ledger.id, cost, accountCost, cacheKey } };
  }, {
    dirtyRows: dirtyCreditReservationRows,
    shouldPersist: (result) => !result?.busy
  });
}

async function completeGeneration(reservation, request, image, meta = {}) {
  const imageId = createId('img');
  const imageFile = await writeStoredImage(imageId, image);
  const accountCost = reservationAccountCost(reservation, request);
  let trimmedImages = [];
  let savedImage;
  try {
    savedImage = await store.update((db) => {
      const user = getUserOrThrow(db, reservation.token);
      const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
      if (account) {
        account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
        account.total = Number(account.total || 0) + 1;
        if (accountCost > 0 && Number.isFinite(Number(account.quotaPoints))) {
          account.quotaPoints = Math.max(0, Number(account.quotaPoints) - accountCost);
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
        accountCost,
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
          job.errorDetail = '';
          job.updatedAt = new Date().toISOString();
          job.completedAt = job.updatedAt;
        }
      }

      trimmedImages = trimImageCacheRecords(db);

      return { ...saved, balance: user.balance };
    }, {
      dirtyRows: (saved) => ({
        ...imageCacheTrimDirtyRows(trimmedImages),
        accounts: uniqueIds([reservation.account?.id]),
        images: uniqueIds([saved?.id, ...trimmedImages.map((item) => item?.id)]),
        jobs: uniqueIds([meta.jobId, ...(trimmedImages.affectedJobIds || [])])
      })
    });
  } catch (error) {
    await removeStoredImages([{ id: imageId, file: imageFile }]);
    throw error;
  }
  await removeStoredImages(trimmedImages);
  scheduleQueueDrain();
  if (meta.jobId) notifyJobWaiters(meta.jobId, { saved: savedImage, image, balance: savedImage.balance });
  return savedImage;
}

async function cancelReservedJob(reservation, error) {
  const detail = errorDetailMessage(error);
  const waiterMessage = error?.message || detail || 'direct generate timeout';
  const message = publicErrorMessage(waiterMessage);
  let changed = false;
  await store.update((db) => {
    const job = reservation.job?.id ? db.jobs.find((item) => item.id === reservation.job.id) : null;
    if (!job || ['done', 'failed'].includes(job.status)) return;
    const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      account.updatedAt = new Date().toISOString();
    }
    refundJob(db, job, message);
    job.status = 'failed';
    job.error = message;
    job.errorDetail = detail || 'job aborted';
    job.updatedAt = new Date().toISOString();
    job.completedAt = job.updatedAt;
    changed = true;
  }, {
    dirtyRows: dirtyReservationJobRows(reservation),
    shouldPersist: () => changed
  });
  if (!changed) return;
  scheduleQueueDrain();
  if (reservation.job?.id) notifyJobWaiters(reservation.job.id, { error: waiterMessage });
}

async function failGeneration(reservation, error) {
  const detail = errorDetailMessage(error);
  const message = publicErrorMessage(error?.message || detail);
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
        job.error = message;
        job.errorDetail = detail;
        job.updatedAt = new Date().toISOString();
        job.completedAt = job.updatedAt;
      }
    }
    db.ledger.unshift({
      id: createId('log'),
      type: 'refund',
      token: reservation.token,
      jobId: reservation.job?.id || '',
      amount: Number(reservation.cost || 0),
      at: new Date().toISOString(),
      note: message
    });
  }, {
    dirtyRows: dirtyReservationJobRows(reservation)
  });
  scheduleQueueDrain();
  if (reservation.job?.id) notifyJobWaiters(reservation.job.id, { error: message });
}

function selectAccount(accounts, settings = {}, options = {}) {
  resetStaleAccountLoads(accounts);
  const excludeIds = options.excludeIds || new Set();
  const cost = normalizeAccountCost(options.cost);
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
    if (cost > 0 && (quotaA !== null || quotaB !== null)) {
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
  if (account?.quotaPoints === null || account?.quotaPoints === undefined || account?.quotaPoints === '') return null;
  const value = Number(account?.quotaPoints);
  return Number.isFinite(value) ? value : null;
}

function maxAccountConcurrency(settings = {}) {
  return 1;
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
          .filter((job) => job.status === 'queued' && isQueueActiveJob(job))
          .reverse()
          .slice(0, slots)
          .map((job) => job.id),
        delay: 0
      };
    }, { collections: ['accounts'], persist: false });
    const jobIds = drainPlan.jobIds || [];
    if (!jobIds.length && drainPlan.delay > 0) queueDrainRequested = true;
    const reservations = await Promise.all(jobIds.map((id) => reserveQueuedJob(id).catch((error) => ({ error }))));
    reservations.forEach((reservation) => {
      if (reservation?.error) {
        console.error(reservation.error);
        return;
      }
      if (reservation?.skip || reservation?.queued) {
        queueDrainRequested = true;
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
  const required = normalizeAccountCost(cost);
  return accounts.some((account) => {
    if (account.enabled === false) return false;
    const quota = accountQuotaPoints(account);
    return quota === null || quota >= required;
  });
}

function resetStaleAccountLoads(accounts) {
  const staleAfterMs = accountInflightTimeoutMs();
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
    proxyUrl: options.revealToken ? account.proxyUrl || '' : maskProxyUrl(account.proxyUrl || ''),
    hasProxy: Boolean(account.proxyUrl),
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
    proxyUrl: account.proxyUrl || '',
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
  const queue = db?.queue || (db && job.status === 'queued'
    ? stableQueueProgress(job, db.jobs)
    : job.status === 'running' && Number(job.queueTotal || 0) > 1
      ? { progress: Number(job.queueTotal || 0), total: Number(job.queueTotal || 0) }
      : { progress: 0, total: 0 });
  const request = job.request || {};
  const account = db?.account || (db && job.accountId ? db.accounts.find((item) => item.id === job.accountId) : null);
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
    accountCost: jobAccountCost(job),
    imageId: job.imageId || '',
    imageUrl: job.imageId ? `/api/images/${job.imageId}/content` : '',
    error: publicErrorMessage(job.error || ''),
    queuePosition: queue.progress,
    queuedCount: queue.total,
    durationMs: jobDurationMs(job),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || (['done', 'failed'].includes(job.status) ? job.updatedAt : '')
  };
}

function stableQueueProgress(job, jobs) {
  const now = Date.now();
  const activeJobs = (Array.isArray(jobs) ? jobs : []).filter((item) => isQueueActiveJob(item, now));
  if (!isQueueActiveJob(job, now)) return { progress: 0, total: 0 };
  const total = Math.max(1, Number(job.queueTotal || 0) || activeJobs.length || 1);
  const createdAt = Date.parse(job.createdAt || '') || 0;
  const activeAhead = activeJobs.filter((item) => {
    if (item.id === job.id) return false;
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
  const ended = terminal ? Date.parse(job.completedAt || job.updatedAt || '') : Date.now();
  if (!ended || ended < started) return 0;
  return ended - started;
}

function activeJobCount(jobs) {
  const now = Date.now();
  return jobs.filter((job) => isQueueActiveJob(job, now)).length;
}

function isQueueActiveJob(job, now = Date.now()) {
  if (!job || !['queued', 'running'].includes(job.status)) return false;
  return !isStaleActiveJob(job, now);
}

function isStaleActiveJob(job, now = Date.now()) {
  if (!job || !['queued', 'running'].includes(job.status)) return false;
  if (isExpiredJobAt(job, now)) return true;
  const updatedAt = Date.parse(job.updatedAt || job.createdAt || '');
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  if (job.status === 'running') return now - updatedAt > staleRunningJobMs();
  if (job.status === 'queued' && !jobDeadlineTimestamp(job)) return now - updatedAt > staleQueuedJobMs();
  return false;
}

function staleActiveJobDetail(job, now = Date.now()) {
  if (isExpiredJobAt(job, now)) return 'job deadline expired';
  return `${job.status || 'active'} job exceeded stale timeout`;
}

function isExpiredJob(job) {
  return isExpiredJobAt(job);
}

function isExpiredJobAt(job, now = Date.now()) {
  const deadline = Date.parse(job.deadlineAt || '');
  return Number.isFinite(deadline) && deadline > 0 && now >= deadline;
}

function staleQueuedJobMs() {
  return configuredTimeoutMs('STALE_QUEUED_JOB_MS', configuredTimeoutMs('STALE_ACTIVE_JOB_MS', 30 * 60 * 1000));
}

function staleRunningJobMs() {
  return configuredTimeoutMs('STALE_RUNNING_JOB_MS', accountInflightTimeoutMs() + 60 * 1000);
}

function configuredTimeoutMs(name, fallback) {
  const configured = Number(process.env[name] || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(60_000, Math.floor(configured));
  return Math.max(60_000, Math.floor(Number(fallback) || 60_000));
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
    jobId: job.id || '',
    amount: cost,
    at: job.refundedAt,
    note
  });
}

function hourlyUsageStatsByDay(jobs, days = usageChartDays) {
  const keys = recentBeijingDateKeys(days);
  const buckets = new Map(keys.map((key) => [key, {
    date: key,
    label: key.slice(5),
    done: 0,
    failed: 0,
    total: 0,
    successRate: 0,
    hours: Array.from({ length: 24 }, (_, hour) => ({
      hour,
      label: `${String(hour).padStart(2, '0')}:00`,
      done: 0,
      failed: 0,
      total: 0,
      successRate: 0
    }))
  }]));

  jobs.forEach((job) => {
    if (!['done', 'failed'].includes(job.status)) return;
    const timestamp = Date.parse(job.updatedAt || job.createdAt || '');
    if (!timestamp) return;
    const key = beijingDateKey(timestamp);
    const bucket = buckets.get(key);
    if (!bucket) return;
    const hourBucket = bucket.hours[beijingHour(timestamp)];
    if (!hourBucket) return;
    if (job.status === 'done') bucket.done += 1;
    if (job.status === 'failed') bucket.failed += 1;
    if (job.status === 'done') hourBucket.done += 1;
    if (job.status === 'failed') hourBucket.failed += 1;
  });

  return keys.map((key) => {
    const bucket = buckets.get(key);
    bucket.total = bucket.done + bucket.failed;
    bucket.successRate = bucket.total ? bucket.done / bucket.total : 0;
    bucket.hours.forEach((hour) => {
      hour.total = hour.done + hour.failed;
      hour.successRate = hour.total ? hour.done / hour.total : 0;
    });
    return bucket;
  });
}

function errorLogs(jobs, db = {}, limit = 100) {
  const cutoff = Date.now() - errorLogRetentionMs;
  return jobs
    .filter((job) => job.status === 'failed')
    .filter((job) => {
      const timestamp = Date.parse(job.updatedAt || job.createdAt || '');
      return timestamp && timestamp >= cutoff;
    })
    .sort((a, b) => Date.parse(b.updatedAt || b.createdAt || '') - Date.parse(a.updatedAt || a.createdAt || ''))
    .slice(0, limit)
    .map((job) => publicErrorLog(job, db));
}

function publicErrorLog(job, db = {}) {
  const request = job.request || {};
  const account = job.accountId && Array.isArray(db.accounts)
    ? db.accounts.find((item) => item.id === job.accountId)
    : null;
  return {
    id: job.id,
    source: job.source || 'web',
    userToken: maskToken(job.userToken || ''),
    accountId: job.accountId || '',
    accountRouteId: account?.routeId || 0,
    status: job.status,
    error: publicErrorMessage(job.error || ''),
    errorDetail: errorDetailMessage(job.errorDetail || job.error || ''),
    retryCount: Number(job.retryCount || 0),
    cost: Number(job.cost || 0),
    accountCost: jobAccountCost(job),
    queueTotal: Number(job.queueTotal || 0),
    durationMs: jobDurationMs(job),
    request: errorLogRequest(request),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    completedAt: job.completedAt || (['done', 'failed'].includes(job.status) ? job.updatedAt : ''),
    beijingDate: beijingDateKey(Date.parse(job.updatedAt || job.createdAt || ''))
  };
}

function errorLogRequest(request = {}) {
  return {
    tag: request.tag || '',
    prompt: request.prompt || '',
    artist: request.artist || '',
    negative: request.negative || '',
    model: request.model || '',
    size: request.size || '',
    width: request.width || 0,
    height: request.height || 0,
    requestedSteps: request.requestedSteps ?? request.steps ?? 0,
    routedSteps: request.steps ?? 0,
    scale: request.scale ?? '',
    cfg: request.cfg ?? '',
    sampler: request.sampler || '',
    noiseSchedule: request.noiseSchedule || '',
    seed: request.seed ?? ''
  };
}

function recentBeijingDateKeys(days) {
  const now = new Date(Date.now() + beijingOffsetMs);
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Array.from({ length: days }, (_, index) => {
    const dayOffset = index - days + 1;
    return new Date(midnight + dayOffset * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  });
}

function beijingDateKey(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return '';
  return new Date(value + beijingOffsetMs).toISOString().slice(0, 10);
}

function beijingHour(timestamp) {
  const value = Number(timestamp);
  if (!Number.isFinite(value)) return 0;
  return new Date(value + beijingOffsetMs).getUTCHours();
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

function requestStatsSince(jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  const total = jobs.reduce((sum, job) => {
    const createdAt = Date.parse(job.createdAt || '');
    return createdAt && createdAt >= since ? sum + 1 : sum;
  }, 0);
  return { total };
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

function accountStatsMapSince(jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  const map = new Map();
  jobs.forEach((job) => {
    if (isQuotaFailureJob(job) || !job.accountId) return;
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return;
    let stats = map.get(job.accountId);
    if (!stats) {
      stats = { done: 0, failed: 0 };
      map.set(job.accountId, stats);
    }
    if (job.status === 'done') stats.done += 1;
    if (job.status === 'failed') stats.failed += 1;
  });
  map.forEach((stats, accountId) => {
    map.set(accountId, finalizeStats(stats));
  });
  return map;
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
    accountCost: image.accountCost || 0,
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

function accountGenerationCost(request = null) {
  const sizeCost = sizeCostMap[normalizeSizeName(request?.size)] || 1;
  const resolutionCost = resolutionGenerationCost(request);
  const cost = Math.max(sizeCost, resolutionCost);
  return cost > 1 ? cost : 0;
}

function resolutionGenerationCost(request = null) {
  const width = Number(request?.width || 0);
  const height = Number(request?.height || 0);
  if (width >= 1700 || height >= 1900) return 35;
  if (width >= 1300 || height >= 1500) return 20;
  return 1;
}

function jobAccountCost(job = {}) {
  const stored = Number(job.accountCost);
  if (Number.isFinite(stored) && stored >= 0) return normalizeAccountCost(stored);
  return accountGenerationCost(job.request);
}

function reservationAccountCost(reservation = {}, request = null) {
  const stored = Number(reservation.accountCost);
  if (Number.isFinite(stored) && stored >= 0) return normalizeAccountCost(stored);
  return accountGenerationCost(request);
}

function normalizeAccountCost(value) {
  const cost = Number(value);
  return Number.isFinite(cost) && cost > 0 ? Math.ceil(cost) : 0;
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

function errorDetailMessage(error) {
  const detail = String(error?.stack || error?.message || error || '').trim();
  return detail.slice(0, 4000);
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
      const parts = line.includes(',') ? line.split(',').map((part) => part.trim()) : ['', line, '', ''];
      const [name, token, third, fourth] = parts;
      const proxyUrl = looksLikeProxyUrl(third) ? third : '';
      const weight = proxyUrl ? fourth : third;
      return {
        name: name || `NovelAI imported ${index + 1}`,
        token: token || line,
        proxyUrl,
        weight: weight ? Number(weight) : 1
      };
    });
}

function normalizeAccountProxyUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const rawProxy = parseHostPortUserPassProxy(text);
  if (rawProxy) return rawProxy;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `socks5://${text}`;
  let url;
  try {
    url = new URL(withScheme.replace(/^sock5:\/\//i, 'socks5://'));
  } catch {
    throw httpError(400, 'invalid SOCKS5 proxy URL.');
  }
  if (!['socks5:', 'socks5h:'].includes(url.protocol)) {
    throw httpError(400, 'only socks5:// and socks5h:// proxies are supported.');
  }
  if (!url.hostname) throw httpError(400, 'SOCKS5 proxy host is required.');
  if (!url.port) url.port = '1080';
  return url.toString();
}

function parseProxyLines(value = '') {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => normalizeAccountProxyUrl(line));
}

function parseHostPortUserPassProxy(value = '') {
  const parts = String(value || '').trim().split(':');
  if (parts.length !== 4) return '';
  const [host, port, username, password] = parts.map((part) => part.trim());
  if (!host || !port || !username || !password || !/^\d{1,5}$/.test(port)) return '';
  const url = new URL(`socks5://${host}:${port}`);
  url.username = username;
  url.password = password;
  return url.toString();
}

function looksLikeProxyUrl(value = '') {
  const text = String(value || '').trim();
  return Boolean(text && (/^(sock5|socks5h?):\/\//i.test(text) || /^[^:@\s]+:\d{2,5}$/i.test(text) || /^[^:\s]+:\d{2,5}:[^:\s]+:.+/.test(text)));
}

function maskProxyUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  try {
    const url = new URL(text);
    if (url.password) url.password = '******';
    if (url.username) url.username = `${url.username.slice(0, 2)}***`;
    return url.toString();
  } catch {
    return text.replace(/:\/\/([^:@]+):([^@]+)@/, '://$1:******@');
  }
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

async function serveStatic(urlPath, res, options = {}) {
  const pathname = urlPath === '/'
    ? '/index.html'
    : urlPath === '/admin' || urlPath === '/admin/'
      ? '/admin.html'
      : decodeURIComponent(urlPath);
  const filePath = path.resolve(publicDir, `.${pathname}`);
  if (!filePath.startsWith(publicDir)) throw httpError(403, 'forbidden.');

  try {
    const content = await readFile(filePath);
    res.writeHead(200, {
      'content-type': contentType(filePath),
      'cache-control': 'no-store',
      'content-length': content.length
    });
    res.end(options.head ? undefined : content);
  } catch {
    const content = await readFile(path.join(publicDir, 'index.html'));
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': content.length
    });
    res.end(options.head ? undefined : content);
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
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    ...corsHeaders()
  });
  res.end(body);
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
    ...corsHeaders(),
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

function sendHead(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    'cache-control': 'no-store',
    ...corsHeaders(),
    ...headers
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

function runtimeSlowLog(label, startedAt, detail = '', thresholdMs = 500) {
  const duration = Date.now() - startedAt;
  if (duration < thresholdMs) return;
  console.log(`[runtime] slow ${label}: ${duration}ms${detail ? ` (${detail})` : ''}`);
}

function runtimeRequestLog(label, startedAt, detail = {}) {
  const duration = Date.now() - startedAt;
  const parts = Object.entries(detail)
    .map(([key, value]) => `${key}=${value}`)
    .join(' ');
  console.log(`[runtime] ${label}: total=${duration}ms${parts ? ` ${parts}` : ''}`);
}

function installRuntimeSafetyHandlers() {
  if (installRuntimeSafetyHandlers.installed) return;
  installRuntimeSafetyHandlers.installed = true;
  process.on('uncaughtException', (error) => {
    if (isRecoverableRuntimeAbort(error)) {
      console.error(`[runtime] recovered from async abort/socket error: ${error?.message || error}`);
      return;
    }
    console.error('[runtime] uncaught exception:', error);
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason));
    if (isRecoverableRuntimeAbort(error)) {
      console.error(`[runtime] recovered from async abort/socket rejection: ${error.message}`);
      return;
    }
    console.error('[runtime] unhandled rejection:', reason);
    process.exit(1);
  });
}

function installShutdownHandlers(serverInstance) {
  if (installShutdownHandlers.installed) return;
  installShutdownHandlers.installed = true;
  let shuttingDown = false;
  const shutdown = (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[runtime] ${signal} received. Flushing SQLite changes before shutdown.`);
    try {
      store.flushSync();
    } catch (error) {
      console.error('[runtime] failed to flush SQLite changes during shutdown:', error);
    }
    const forceTimer = setTimeout(() => process.exit(0), 5000);
    forceTimer.unref?.();
    serverInstance.close(() => process.exit(0));
  };
  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

function isRecoverableRuntimeAbort(error) {
  const text = String(error?.stack || error?.message || error || '');
  return isAbortError(error)
    || /direct generate timeout|This operation was aborted|ECONNRESET|ERR_STREAM_DESTROYED|socket hang up/i.test(text);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
