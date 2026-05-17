import { existsSync } from 'node:fs';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';
import Database from 'better-sqlite3';

export const MAX_CACHE_IMAGES_LIMIT = 200000;
export const MAX_FREE_STEPS = 28;
export const defaultArtist2_5D =
  `0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, textless version, The image is highly intricate finished drawn. Only the character's face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,`;
export const legacyDefaultArtist =
  'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,';

const collections = ['cards', 'users', 'accounts', 'jobs', 'images', 'ledger'];

const defaultSettings = {
  serviceName: 'Nai2API',
  costPerImage: 1,
  maxCacheImages: 500,
  accountConcurrency: 1,
  publicBaseUrl: '',
  mockWhenNoAccount: true,
  defaultModel: 'nai-diffusion-4-5-full',
  defaultArtist: defaultArtist2_5D,
  defaultNegative:
    '{{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{{missing legs}},mutated hands,{{{mutation}}},normal quality,poorly drawn face,poorly drawn hands,signature,text,{{too many fingers}},{{{ugly}}},username,watermark,worst quality',
  defaults: {
    size: '绔栧浘',
    width: 832,
    height: 1216,
    steps: MAX_FREE_STEPS,
    scale: 6,
    cfg: 0,
    sampler: 'k_dpmpp_2m_sde',
    noiseSchedule: 'karras'
  }
};

const defaultDb = {
  settings: defaultSettings,
  cards: [],
  users: [],
  accounts: [],
  jobs: [],
  images: [],
  ledger: []
};

export class JsonStore {
  constructor(dataDir) {
    this.dataDir = dataDir;
    this.dbPath = path.join(dataDir, 'library.sqlite');
    this.legacyDbPath = path.join(dataDir, 'library.json');
    this.legacyBackupPath = `${this.legacyDbPath}.bak`;
    this.queue = Promise.resolve();
    this.sqlite = null;
    this.statements = null;
    this.db = null;
    this.rowState = emptyCollectionMaps();
    this.orderKeys = emptyCollectionMaps();
    this.settingsState = '';
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    this.openSqlite();
    this.createSchema();
    this.prepareStatements();

    if (!this.hasSqliteData()) {
      const legacyDb = await this.readLegacyOrDefault();
      const safeDb = trimDb(normalizeDb(legacyDb));
      safeDb.accounts.forEach((account) => {
        account.inFlight = 0;
      });
      this.replaceAll(safeDb);
      await this.markLegacyMigrated();
      this.db = safeDb;
      return;
    }

    this.db = this.loadFromSqlite();
    this.db.accounts.forEach((account) => {
      account.inFlight = 0;
    });
    trimDb(this.db);
    this.persistIncremental(this.db);
  }

  async read() {
    await this.ensureLoaded();
    return cloneDb(this.db);
  }

  async readCollections(requestedCollections = []) {
    await this.ensureLoaded();
    const snapshot = {};
    for (const key of requestedCollections) {
      if (key === 'settings') {
        snapshot.settings = structuredClone(this.db.settings);
      } else if (Array.isArray(this.db[key])) {
        snapshot[key] = structuredClone(this.db[key]);
      }
    }
    return snapshot;
  }

  async findJobContext(id) {
    await this.ensureLoaded();
    const job = this.db.jobs.find((item) => item.id === id);
    if (!job) return null;
    const account = job.accountId
      ? this.db.accounts.find((item) => item.id === job.accountId) || null
      : null;
    return {
      job: structuredClone(job),
      account: account ? structuredClone(account) : null,
      queue: jobQueueProgress(job, this.db.jobs)
    };
  }

  async readSettings() {
    await this.ensureLoaded();
    return structuredClone(this.db.settings);
  }

  async findImage(id) {
    await this.ensureLoaded();
    const image = this.db.images.find((item) => item.id === id);
    return image ? structuredClone(image) : null;
  }

  async findImageByCacheKey(cacheKey) {
    await this.ensureLoaded();
    const image = this.db.images.find((item) => item.cacheKey === cacheKey && !item.mock && item.mimeType !== 'image/svg+xml');
    return image ? structuredClone(image) : null;
  }

  async readImagePage(options = {}) {
    await this.ensureLoaded();
    const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit || 60))));
    const offset = Math.max(0, Math.floor(Number(options.offset || 0)));
    const q = String(options.q || '').trim().toLowerCase();
    const tier = String(options.tier || '').trim().toLowerCase();
    const source = tier ? this.db.images.filter((image) => imageResolutionTier(image).toLowerCase() === tier) : this.db.images;
    const total = tier ? this.db.images.length : source.length;

    if (!q) {
      const page = source.slice(offset, offset + limit);
      return {
        images: structuredClone(page),
        total,
        matched: source.length,
        offset,
        limit,
        maxCacheImages: this.db.settings.maxCacheImages
      };
    }

    const page = [];
    let matched = 0;
    for (const image of source) {
      const isMatch = [image.id, image.token, image.prompt, image.fullPrompt, image.model]
        .some((value) => String(value || '').toLowerCase().includes(q));
      if (!isMatch) continue;
      if (matched >= offset && page.length < limit) page.push(image);
      matched += 1;
    }

    return {
      images: structuredClone(page),
      total,
      matched,
      offset,
      limit,
      maxCacheImages: this.db.settings.maxCacheImages
    };
  }

  async readCounts() {
    await this.ensureLoaded();
    return {
      users: this.db.users.length,
      enabledAccounts: this.db.accounts.filter((account) => account.enabled !== false).length,
      cards: this.db.cards.length
    };
  }

  async readAdminSummary() {
    await this.ensureLoaded();
    return {
      settings: structuredClone(this.db.settings),
      cards: structuredClone(this.db.cards),
      users: structuredClone(this.db.users),
      accounts: structuredClone(this.db.accounts),
      jobs: structuredClone(this.db.jobs),
      images: structuredClone(this.db.images.slice(0, 12)),
      imageCount: this.db.images.length,
      imageTotal: this.db.images.length,
      cacheImageCount: this.db.images.length,
      ledger: structuredClone(this.db.ledger.slice(0, 80))
    };
  }

  async ensureLoaded() {
    if (this.db) return;
    this.openSqlite();
    this.createSchema();
    this.prepareStatements();
    this.db = this.hasSqliteData() ? this.loadFromSqlite() : trimDb(normalizeDb(defaultDb));
    if (!this.hasSqliteData()) this.replaceAll(this.db);
  }

  async readRaw() {
    await this.ensureLoaded();
    return cloneDb(this.db);
  }

  async write(db) {
    await this.ensureLoaded();
    const safeDb = trimDb(normalizeDb(db));
    this.replaceAll(safeDb);
    this.db = safeDb;
  }

  async update(mutator) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.ensureLoaded();
      const result = await mutator(this.db);
      trimDb(this.db);
      this.persistIncremental(this.db);
      return cloneValue(result);
    });
    return this.queue;
  }

  scheduleFlush() {
    return null;
  }

  async flush() {
    await this.ensureLoaded();
    this.persistIncremental(this.db);
  }

  close() {
    if (!this.sqlite) return;
    this.sqlite.close();
    this.sqlite = null;
    this.statements = null;
  }

  openSqlite() {
    if (this.sqlite) return;
    this.sqlite = new Database(this.dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.sqlite.pragma('foreign_keys = ON');
  }

  createSchema() {
    this.sqlite.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS app_records (
        collection TEXT NOT NULL,
        id TEXT NOT NULL,
        order_value REAL NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (collection, id)
      );

      CREATE INDEX IF NOT EXISTS idx_app_records_collection_order
        ON app_records (collection, order_value DESC);
    `);
  }

  prepareStatements() {
    if (this.statements) return;
    this.statements = {
      hasSettings: this.sqlite.prepare('SELECT 1 FROM app_settings WHERE key = ? LIMIT 1'),
      hasRecords: this.sqlite.prepare('SELECT 1 FROM app_records LIMIT 1'),
      selectSettings: this.sqlite.prepare('SELECT value FROM app_settings WHERE key = ?'),
      selectRecords: this.sqlite.prepare('SELECT id, order_value AS orderValue, data FROM app_records WHERE collection = ? ORDER BY order_value DESC'),
      replaceSettings: this.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      deleteAllSettings: this.sqlite.prepare('DELETE FROM app_settings'),
      deleteAllRecords: this.sqlite.prepare('DELETE FROM app_records'),
      upsertRecord: this.sqlite.prepare(`
        INSERT INTO app_records (collection, id, order_value, data)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(collection, id) DO UPDATE SET
          order_value = excluded.order_value,
          data = excluded.data
      `),
      deleteRecord: this.sqlite.prepare('DELETE FROM app_records WHERE collection = ? AND id = ?'),
      setMeta: this.sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    };
  }

  hasSqliteData() {
    return Boolean(this.statements.hasSettings.get('settings') || this.statements.hasRecords.get());
  }

  loadFromSqlite() {
    const settingsRow = this.statements.selectSettings.get('settings');
    const db = {
      ...defaultDb,
      settings: settingsRow ? safeJson(settingsRow.value, defaultSettings) : defaultSettings
    };
    const rowState = emptyCollectionMaps();
    const orderKeys = emptyCollectionMaps();

    for (const collection of collections) {
      const rows = this.statements.selectRecords.all(collection);
      db[collection] = rows.map((row) => {
        rowState[collection].set(row.id, { data: row.data, order: Number(row.orderValue) });
        orderKeys[collection].set(row.id, Number(row.orderValue));
        return safeJson(row.data, null);
      }).filter(Boolean);
    }

    const normalized = normalizeDb(db);
    this.rowState = rowState;
    this.orderKeys = orderKeys;
    this.settingsState = JSON.stringify(normalized.settings);
    return normalized;
  }

  replaceAll(db) {
    const safeDb = trimDb(normalizeDb(db));
    const snapshot = buildSnapshotState(safeDb, emptyCollectionMaps(), { dense: true });
    const writeAll = this.sqlite.transaction(() => {
      this.statements.deleteAllSettings.run();
      this.statements.deleteAllRecords.run();
      this.statements.replaceSettings.run('settings', snapshot.settingsData);
      for (const collection of collections) {
        for (const [id, row] of snapshot.rowState[collection]) {
          this.statements.upsertRecord.run(collection, id, row.order, row.data);
        }
      }
    });
    writeAll();
    this.settingsState = snapshot.settingsData;
    this.rowState = snapshot.rowState;
    this.orderKeys = snapshot.orderKeys;
  }

  persistIncremental(db) {
    const safeDb = trimDb(normalizeDb(db));
    const snapshot = buildSnapshotState(safeDb, this.orderKeys);
    const changes = collectPersistenceChanges({
      previousSettings: this.settingsState,
      previousRows: this.rowState,
      nextSettings: snapshot.settingsData,
      nextRows: snapshot.rowState
    });
    if (!changes.settingsChanged && !changes.deletes.length && !changes.upserts.length) return;

    const applyChanges = this.sqlite.transaction(() => {
      if (changes.settingsChanged) this.statements.replaceSettings.run('settings', snapshot.settingsData);
      for (const change of changes.deletes) {
        this.statements.deleteRecord.run(change.collection, change.id);
      }
      for (const change of changes.upserts) {
        this.statements.upsertRecord.run(change.collection, change.id, change.order, change.data);
      }
    });
    applyChanges();
    this.settingsState = snapshot.settingsData;
    this.rowState = snapshot.rowState;
    this.orderKeys = snapshot.orderKeys;
  }

  async readLegacyOrDefault() {
    const candidates = [this.legacyDbPath, this.legacyBackupPath];
    let lastError = null;
    for (const filePath of candidates) {
      if (!existsSync(filePath)) continue;
      try {
        const raw = await readFile(filePath, 'utf8');
        return normalizeDb(JSON.parse(raw));
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) throw lastError;
    return normalizeDb(defaultDb);
  }

  async markLegacyMigrated() {
    const migratedAt = new Date().toISOString();
    this.statements.setMeta.run('schema_version', '1');
    this.statements.setMeta.run('last_migrated_at', migratedAt);
    const deleted = [];
    for (const filePath of [this.legacyDbPath, this.legacyBackupPath]) {
      if (!existsSync(filePath)) continue;
      try {
        await unlink(filePath);
        deleted.push(filePath);
      } catch (error) {
        console.error(`Failed to delete migrated legacy JSON ${filePath}:`, error);
      }
    }
    this.statements.setMeta.run('legacy_json_deleted', JSON.stringify(deleted));
    if (deleted.length) console.log(`Migrated legacy JSON data to SQLite and deleted ${deleted.length} old JSON file(s).`);
  }
}

function buildSnapshotState(db, previousOrderKeys, options = {}) {
  const settingsData = JSON.stringify(db.settings);
  const rowState = emptyCollectionMaps();
  const orderKeys = emptyCollectionMaps();

  for (const collection of collections) {
    const items = Array.isArray(db[collection]) ? db[collection] : [];
    ensureItemIds(collection, items);
    const orders = options.dense
      ? denseOrderValues(items)
      : assignOrderValues(items, previousOrderKeys[collection] || new Map());
    orderKeys[collection] = orders;
    for (const item of items) {
      const id = String(item.id);
      rowState[collection].set(id, {
        data: JSON.stringify(item),
        order: Number(orders.get(id))
      });
    }
  }

  return { settingsData, rowState, orderKeys };
}

function collectPersistenceChanges({ previousSettings, previousRows, nextSettings, nextRows }) {
  const deletes = [];
  const upserts = [];
  for (const collection of collections) {
    const previous = previousRows[collection] || new Map();
    const next = nextRows[collection] || new Map();
    for (const id of previous.keys()) {
      if (!next.has(id)) deletes.push({ collection, id });
    }
    for (const [id, row] of next) {
      const old = previous.get(id);
      if (!old || old.data !== row.data || old.order !== row.order) {
        upserts.push({ collection, id, ...row });
      }
    }
  }
  return {
    settingsChanged: previousSettings !== nextSettings,
    deletes,
    upserts
  };
}

function ensureItemIds(collection, items) {
  const prefix = collection === 'accounts' ? 'acct' : collection.slice(0, 4);
  items.forEach((item) => {
    if (item && !item.id) item.id = createId(prefix);
  });
}

function denseOrderValues(items) {
  const orders = new Map();
  const total = items.length;
  items.forEach((item, index) => {
    if (item?.id) orders.set(String(item.id), total - index);
  });
  return orders;
}

function assignOrderValues(items, previousOrders) {
  if (!items.length) return new Map();
  if (!existingOrderSequenceIsStable(items, previousOrders)) return denseOrderValues(items);

  const orders = new Map();
  let index = 0;
  while (index < items.length) {
    const id = String(items[index]?.id || '');
    if (previousOrders.has(id)) {
      orders.set(id, previousOrders.get(id));
      index += 1;
      continue;
    }

    const runStart = index;
    while (index < items.length && !previousOrders.has(String(items[index]?.id || ''))) index += 1;
    const runLength = index - runStart;
    const previousItem = runStart > 0 ? items[runStart - 1] : null;
    const nextItem = index < items.length ? items[index] : null;
    const before = previousItem ? orders.get(String(previousItem.id)) : null;
    const after = nextItem ? previousOrders.get(String(nextItem.id)) : null;
    const values = orderValuesForRun(runLength, before, after);
    for (let offset = 0; offset < runLength; offset += 1) {
      orders.set(String(items[runStart + offset].id), values[offset]);
    }
  }
  return orders;
}

function existingOrderSequenceIsStable(items, previousOrders) {
  let last = Number.POSITIVE_INFINITY;
  for (const item of items) {
    const id = String(item?.id || '');
    if (!previousOrders.has(id)) continue;
    const value = Number(previousOrders.get(id));
    if (!Number.isFinite(value) || value >= last) return false;
    last = value;
  }
  return true;
}

function orderValuesForRun(length, before, after) {
  if (before === null && after === null) {
    return Array.from({ length }, (_, index) => length - index);
  }
  if (before === null) {
    return Array.from({ length }, (_, index) => Number(after) + length - index);
  }
  if (after === null) {
    return Array.from({ length }, (_, index) => Number(before) - index - 1);
  }
  const gap = Number(before) - Number(after);
  if (!Number.isFinite(gap) || gap <= 0) {
    return Array.from({ length }, (_, index) => Number(before) - index - 1);
  }
  const step = gap / (length + 1);
  return Array.from({ length }, (_, index) => Number(before) - step * (index + 1));
}

function emptyCollectionMaps() {
  return Object.fromEntries(collections.map((collection) => [collection, new Map()]));
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function imageResolutionTier(image) {
  const width = Number(image?.width || 0);
  const height = Number(image?.height || 0);
  if (width >= 1700 || height >= 1900) return '4K';
  if (width >= 1300 || height >= 1500) return '2K';
  return 'standard';
}

function jobQueueProgress(job, jobs) {
  if (job.status === 'running' && Number(job.queueTotal || 0) > 1) {
    const total = Number(job.queueTotal || 0);
    return { progress: total, total };
  }
  const now = Date.now();
  if (!isQueueActiveJob(job, now)) return { progress: 0, total: 0 };
  const activeJobs = (Array.isArray(jobs) ? jobs : []).filter((item) => isQueueActiveJob(item, now));
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

function activeJobCount(jobs) {
  const now = Date.now();
  return (Array.isArray(jobs) ? jobs : []).filter((job) => isQueueActiveJob(job, now)).length;
}

function isQueueActiveJob(job, now = Date.now()) {
  if (!job || !['queued', 'running'].includes(job.status)) return false;
  return !isStaleActiveJob(job, now);
}

function isStaleActiveJob(job, now = Date.now()) {
  if (!job || !['queued', 'running'].includes(job.status)) return false;
  if (isExpiredJob(job, now)) return true;
  const updatedAt = Date.parse(job.updatedAt || job.createdAt || '');
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return false;
  if (job.status === 'running') return now - updatedAt > staleRunningJobMs();
  if (job.status === 'queued' && !jobDeadlineTimestamp(job)) return now - updatedAt > staleQueuedJobMs();
  return false;
}

function isExpiredJob(job, now = Date.now()) {
  const deadline = jobDeadlineTimestamp(job);
  return deadline > 0 && now >= deadline;
}

function jobDeadlineTimestamp(job = {}) {
  const deadline = Date.parse(job.deadlineAt || '');
  return Number.isFinite(deadline) && deadline > 0 ? deadline : 0;
}

function staleQueuedJobMs() {
  return configuredTimeoutMs('STALE_QUEUED_JOB_MS', configuredTimeoutMs('STALE_ACTIVE_JOB_MS', 30 * 60 * 1000));
}

function staleRunningJobMs() {
  return configuredTimeoutMs('STALE_RUNNING_JOB_MS', accountInflightTimeoutMs() + 60 * 1000);
}

function accountInflightTimeoutMs() {
  const configured = Number(process.env.ACCOUNT_INFLIGHT_TIMEOUT_MS || 10 * 60 * 1000);
  return Number.isFinite(configured) && configured > 0 ? Math.max(1000, Math.floor(configured)) : 10 * 60 * 1000;
}

function configuredTimeoutMs(name, fallback) {
  const configured = Number(process.env[name] || 0);
  if (Number.isFinite(configured) && configured > 0) return Math.max(60_000, Math.floor(configured));
  return Math.max(60_000, Math.floor(Number(fallback) || 60_000));
}

function cloneDb(db) {
  return normalizeDb(structuredClone(db));
}

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

function trimDb(db) {
  const maxCacheImages = clampNumber(db.settings.maxCacheImages, 0, MAX_CACHE_IMAGES_LIMIT);
  db.settings.costPerImage = 1;
  db.settings.maxCacheImages = maxCacheImages;
  db.settings.accountConcurrency = 1;
  db.jobs = trimJobs(db.jobs);
  db.images = db.images.slice(0, maxCacheImages);
  db.ledger = db.ledger.slice(0, 1000);
  return db;
}

function trimJobs(jobs) {
  const now = Date.now();
  const retainMs = clampNumber(process.env.JOB_HISTORY_RETENTION_MS ?? 7 * 24 * 60 * 60 * 1000, 60_000, 7 * 24 * 60 * 60 * 1000);
  return jobs.filter((job) => {
    if (['queued', 'running'].includes(job.status)) return true;
    const updatedAt = Date.parse(job.updatedAt || job.createdAt || '');
    if (!updatedAt || now - updatedAt > retainMs) return false;
    return true;
  });
}

export function normalizeDb(db = {}) {
  return {
    settings: {
      ...defaultSettings,
      ...(db.settings || {}),
      accountConcurrency: 1,
      defaults: {
        ...defaultSettings.defaults,
        ...(db.settings?.defaults || {})
      }
    },
    cards: Array.isArray(db.cards) ? db.cards : [],
    users: Array.isArray(db.users) ? db.users : [],
    accounts: Array.isArray(db.accounts) ? db.accounts : [],
    jobs: Array.isArray(db.jobs) ? db.jobs : [],
    images: Array.isArray(db.images) ? db.images : [],
    ledger: Array.isArray(db.ledger) ? db.ledger : []
  };
}

export function createId(prefix = 'item') {
  const random = crypto.randomBytes(5).toString('hex');
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

export function createPublicToken(prefix = 'STD') {
  return `${prefix}-${crypto.randomBytes(18).toString('base64url')}`;
}

export function hashObject(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function maskToken(token = '') {
  if (token.length <= 12) return token ? '******' : '';
  return `${token.slice(0, 6)}...${token.slice(-4)}`;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return max;
  return Math.max(min, Math.min(max, Math.floor(number)));
}
