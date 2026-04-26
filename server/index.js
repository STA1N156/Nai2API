import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JsonStore, MAX_CACHE_IMAGES_LIMIT, createId, createPublicToken, hashObject, maskToken, normalizeDb } from './store.js';
import { DIRECT_URL_MAX_STEPS, buildErrorImage, generateNovelAiImage, normalizeNovelAiRequest } from './providers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const dataDir = process.env.DATA_DIR || path.join(rootDir, 'data');
const port = Number(process.env.PORT || 8080);
const adminToken = process.env.ADMIN_TOKEN || '123456';
const store = new JsonStore(dataDir);
let queueDrainTimer = null;
let queueDraining = false;
const directGenerateTimeoutMs = Number(process.env.DIRECT_GENERATE_TIMEOUT_MS || 60_000);

await store.init();
await applyRuntimeSettings();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    if (req.url?.startsWith('/generate')) {
      const image = buildErrorImage(error.message || 'Generation failed');
      sendImage(res, 200, image.mimeType, image.buffer, { 'x-error': '1' });
      return;
    }
    sendJson(res, error.statusCode || 500, { error: error.message || 'Internal server error' });
  }
});

server.listen(port, () => {
  console.log(`Nai2API listening on http://localhost:${port}`);
  scheduleQueueDrain();
});

async function applyRuntimeSettings() {
  const publicBaseUrl = normalizePublicBaseUrl(process.env.PUBLIC_BASE_URL || '');
  if (!publicBaseUrl) return;
  await store.update((db) => {
    if (!db.settings.publicBaseUrl) db.settings.publicBaseUrl = publicBaseUrl;
  });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || 'GET';

  if (method === 'GET' && url.pathname === '/api/health') {
    const db = await store.read();
    sendJson(res, 200, {
      ok: true,
      service: 'Nai2API',
      users: db.users.length,
      enabledAccounts: db.accounts.filter((account) => account.enabled !== false).length,
      cards: db.cards.length,
      adminConfigured: adminToken !== '123456'
    });
    return;
  }

  if (method === 'GET' && url.pathname === '/api/settings') {
    const db = await store.read();
    sendJson(res, 200, db.settings);
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
    const db = await store.read();
    const user = getUserOrThrow(db, token);
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (method === 'GET' && url.pathname === '/api/admin/summary') {
    assertAdmin(req, url);
    const db = await store.read();
    const revealTokens = url.searchParams.get('revealTokens') === '1';
    sendJson(res, 200, {
      settings: db.settings,
      cards: db.cards.map(publicCard),
      users: db.users.map(publicUser),
      accounts: db.accounts.map((account) => publicAccount(account, { revealToken: revealTokens })),
      images: db.images.slice(0, 12).map(publicImage),
      imageCount: db.images.length,
      jobStats24h: jobStatsSince(db.jobs, 24 * 60 * 60 * 1000),
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
    const db = await store.read();
    const limit = clamp(Number(url.searchParams.get('limit') || 60), 1, 200);
    const offset = clamp(Number(url.searchParams.get('offset') || 0), 0, Number.MAX_SAFE_INTEGER);
    const q = String(url.searchParams.get('q') || '').trim().toLowerCase();
    const images = db.images.filter((image) => {
      if (!q) return true;
      return [image.id, image.token, image.prompt, image.fullPrompt, image.model]
        .some((value) => String(value || '').toLowerCase().includes(q));
    });
    sendJson(res, 200, {
      images: images.slice(offset, offset + limit).map(publicImage),
      total: db.images.length,
      matched: images.length,
      offset,
      limit,
      maxCacheImages: db.settings.maxCacheImages
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
    const db = await store.read();
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
    const db = await store.read();
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
    await drainQueuedJobs();
    const db = await store.read();
    const savedJob = db.jobs.find((item) => item.id === job.id) || job;
    sendJson(res, 202, publicJob(savedJob, db));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/jobs/')) {
    const id = decodeURIComponent(url.pathname.split('/').pop() || '');
    const token = tokenFrom(req, url);
    const db = await store.read();
    const job = db.jobs.find((item) => item.id === id);
    if (!job) throw httpError(404, 'job not found.');
    if (job.userToken !== token && !isAdmin(req, url)) throw httpError(403, 'forbidden.');
    sendJson(res, 200, publicJob(job, db));
    return;
  }

  if (method === 'GET' && url.pathname.startsWith('/api/images/')) {
    const id = decodeURIComponent(url.pathname.split('/').at(-2) || '');
    const db = await store.read();
    const image = db.images.find((item) => item.id === id);
    if (!image) throw httpError(404, 'image not found.');
    sendImage(res, 200, image.mimeType, Buffer.from(image.base64, 'base64'));
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
  const db = await store.read();
  const request = normalizeNovelAiRequest(rawParams, db.settings, { maxSteps: DIRECT_URL_MAX_STEPS });
  const cacheKey = hashObject({ token, request: cacheableRequest({ ...request, seed: rawParams.seed || '' }) });
  const nocache = rawParams.nocache === '1' || rawParams.nocache === 'true';

  if (!nocache) {
    const cached = db.images.find((image) => image.cacheKey === cacheKey && !image.mock && image.mimeType !== 'image/svg+xml');
    if (cached) {
      sendImage(res, 200, cached.mimeType, Buffer.from(cached.base64, 'base64'), {
        'x-cache': 'hit',
        'x-balance': String(getUserOrThrow(db, token).balance)
      });
      return;
    }
  }

  const deadline = Date.now() + directGenerateTimeoutMs;
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), Math.max(1, directGenerateTimeoutMs));
  let generationTimeout = null;
  let result = null;
  try {
    result = await reserveCreditAndAccountWhenAvailable(token, request, cacheKey, deadline);
    if (!result) {
      sendBusyImage(res);
      return;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error('direct generate timeout');
    clearTimeout(timeout);
    generationTimeout = setTimeout(() => abortController.abort(), Math.max(1, remainingMs));
    const image = await generateNovelAiImage(request, result.account, process.env, { signal: abortController.signal });
    clearTimeout(generationTimeout);
    const saved = await completeGeneration(result, request, image, { direct: true });
    sendImage(res, 200, saved.mimeType, Buffer.from(saved.base64, 'base64'), {
      'x-cache': 'miss',
      'x-balance': String(saved.balance)
    });
  } catch (error) {
    if (result) await failGeneration(result, error);
    if (abortController.signal.aborted || error.message === 'direct generate timeout') {
      sendBusyImage(res);
      return;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    clearTimeout(generationTimeout);
  }
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
      name: String(body.name || `NovelAI ${db.accounts.length + 1}`).slice(0, 80),
      token,
      enabled: body.enabled !== false,
      weight: clamp(Number(body.weight || 1), 1, 100),
      inFlight: 0,
      total: 0,
      failures: 0,
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
      name: String(account.name || `NovelAI imported ${index + 1}`).slice(0, 80),
      token: String(account.token || '').trim(),
      enabled: account.enabled !== false,
      weight: clamp(Number(account.weight || 1), 1, 100),
      inFlight: 0,
      total: Number(account.total || 0),
      failures: Number(account.failures || 0),
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

async function clearImageCache(body) {
  return store.update((db) => {
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
    const request = normalizeNovelAiRequest(body, db.settings);
    const cost = generationCost();
    if (user.balance < cost) throw httpError(402, 'insufficient balance.');
    user.balance -= cost;
    user.updatedAt = new Date().toISOString();
    const job = {
      id: createId('job'),
      userToken: token,
      status: 'queued',
      request,
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
    const account = selectAccount(db.accounts, db.settings);
    if (!account && hasEnabledAccounts(db.accounts)) {
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
    return { job, account: account ? { ...account } : null, token: job.userToken, cost: job.cost };
  });
}

async function runReservedJob(reservation) {
  if (!reservation || reservation.skip || reservation.queued) return;
  try {
    const image = await generateNovelAiImage(reservation.job.request, reservation.account, process.env);
    await completeGeneration(reservation, reservation.job.request, image, { jobId: reservation.job.id });
  } catch (error) {
    await failGeneration(reservation, error);
  }
}

async function reserveCreditAndAccount(token, request, cacheKey) {
  return store.update((db) => {
    const user = getUserOrThrow(db, token);
    const cost = generationCost();
    if (user.balance < cost) throw httpError(402, 'insufficient balance.');
    const account = selectAccount(db.accounts, db.settings);
    if (!account && hasEnabledAccounts(db.accounts)) {
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
    const cost = generationCost();
    if (user.balance < cost) throw httpError(402, 'insufficient balance.');
    const account = selectAccount(db.accounts, db.settings);
    if (!account && hasEnabledAccounts(db.accounts)) return { busy: true };
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
  const savedImage = await store.update((db) => {
    const user = getUserOrThrow(db, reservation.token);
    const account = reservation.account ? db.accounts.find((item) => item.id === reservation.account.id) : null;
    if (account) {
      account.inFlight = Math.max(0, Number(account.inFlight || 0) - 1);
      account.total = Number(account.total || 0) + 1;
      account.updatedAt = new Date().toISOString();
    }

    const saved = {
      id: createId('img'),
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
      base64: image.buffer.toString('base64'),
      createdAt: new Date().toISOString()
    };
    db.images.unshift(saved);

    if (meta.jobId) {
      const job = db.jobs.find((item) => item.id === meta.jobId);
      if (job) {
        job.status = 'done';
        job.imageId = saved.id;
        job.updatedAt = new Date().toISOString();
      }
    }

    return { ...saved, balance: user.balance };
  });
  scheduleQueueDrain();
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
        job.error = error.message;
        job.updatedAt = new Date().toISOString();
      }
    }
    db.ledger.unshift({
      id: createId('log'),
      type: 'refund',
      token: reservation.token,
      amount: Number(reservation.cost || 0),
      at: new Date().toISOString(),
      note: error.message
    });
  });
  scheduleQueueDrain();
}

function selectAccount(accounts, settings = {}) {
  resetStaleAccountLoads(accounts);
  const enabled = accounts.filter((account) => account.enabled !== false);
  if (!enabled.length) return null;
  const maxConcurrency = maxAccountConcurrency(settings);
  const available = enabled.filter((account) => Number(account.inFlight || 0) < maxConcurrency);
  if (!available.length) return null;
  return available.sort((a, b) => {
    const loadA = Number(a.inFlight || 0) / maxConcurrency;
    const loadB = Number(b.inFlight || 0) / maxConcurrency;
    if (loadA !== loadB) return loadA - loadB;
    return Date.parse(a.lastUsedAt || 0) - Date.parse(b.lastUsedAt || 0);
  })[0];
}

function maxAccountConcurrency(settings = {}) {
  return clamp(Number(settings.accountConcurrency || 2), 1, 20);
}

function availableAccountSlots(accounts, settings = {}) {
  resetStaleAccountLoads(accounts);
  const enabled = accounts.filter((account) => account.enabled !== false);
  if (!enabled.length) return 1;
  const maxConcurrency = maxAccountConcurrency(settings);
  return enabled.reduce((sum, account) => sum + Math.max(0, maxConcurrency - Number(account.inFlight || 0)), 0);
}

function scheduleQueueDrain(delay = 0) {
  if (queueDrainTimer) return;
  queueDrainTimer = setTimeout(() => {
    queueDrainTimer = null;
    drainQueuedJobs();
  }, delay);
}

async function drainQueuedJobs() {
  if (queueDraining) return;
  queueDraining = true;
  try {
    const jobIds = await store.update((db) => {
      const slots = availableAccountSlots(db.accounts, db.settings);
      if (slots <= 0) return [];
      return db.jobs
        .filter((job) => job.status === 'queued')
        .reverse()
        .slice(0, slots)
        .map((job) => job.id);
    });
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
  }
}

function hasEnabledAccounts(accounts) {
  return accounts.some((account) => account.enabled !== false);
}

function resetStaleAccountLoads(accounts) {
  const staleAfterMs = Number(process.env.ACCOUNT_INFLIGHT_TIMEOUT_MS || 10 * 60 * 1000);
  const now = Date.now();
  accounts.forEach((account) => {
    if (Number(account.inFlight || 0) <= 0) return;
    const lastUsed = Date.parse(account.lastUsedAt || 0);
    if (!lastUsed || now - lastUsed > staleAfterMs) account.inFlight = 0;
  });
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
    name: account.name,
    token: options.revealToken ? account.token : maskToken(account.token),
    enabled: account.enabled !== false,
    weight: account.weight || 1,
    inFlight: account.inFlight || 0,
    total: account.total || 0,
    failures: account.failures || 0,
    lastUsedAt: account.lastUsedAt || ''
  };
}

function exportAccount(account) {
  return {
    id: account.id,
    name: account.name,
    token: account.token,
    enabled: account.enabled !== false,
    weight: account.weight || 1,
    total: account.total || 0,
    failures: account.failures || 0,
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
  const queuedJobs = db ? db.jobs.filter((item) => item.status === 'queued').reverse() : [];
  const queuePosition = job.status === 'queued' ? queuedJobs.findIndex((item) => item.id === job.id) + 1 : 0;
  const request = job.request || {};
  return {
    id: job.id,
    status: job.status,
    prompt: request.tag || '',
    model: request.model || '',
    requestedSteps: request.requestedSteps ?? request.steps ?? 0,
    routedSteps: request.steps ?? 0,
    accountId: job.accountId || '',
    cost: job.cost,
    imageId: job.imageId || '',
    imageUrl: job.imageId ? `/api/images/${job.imageId}/content` : '',
    error: job.error || '',
    queuePosition,
    queuedCount: queuedJobs.length,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function jobStatsSince(jobs, rangeMs) {
  const since = Date.now() - rangeMs;
  return jobs.reduce((stats, job) => {
    const createdAt = Date.parse(job.createdAt || '');
    if (!createdAt || createdAt < since) return stats;
    if (job.status === 'done') stats.done += 1;
    if (job.status === 'failed') stats.failed += 1;
    return stats;
  }, { done: 0, failed: 0 });
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

function generationCost() {
  return 1;
}

function cacheableRequest(request) {
  const { requestedSteps, ...cacheRequest } = request;
  return cacheRequest;
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
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
