import { existsSync, statSync } from 'node:fs';
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
const largeRuntimeCollections = new Set(['jobs', 'images', 'ledger']);
const collectionTables = Object.freeze({
  cards: 'cards',
  users: 'users',
  accounts: 'accounts',
  jobs: 'jobs',
  images: 'images',
  ledger: 'ledger'
});
const recordColumns = [
  'id',
  'order_value',
  'data',
  'token',
  'user_token',
  'account_id',
  'status',
  'source',
  'code',
  'cache_key',
  'image_id',
  'created_at',
  'updated_at',
  'at',
  'enabled',
  'balance',
  'route_id',
  'width',
  'height',
  'mock',
  'mime_type',
  'model',
  'prompt',
  'full_prompt',
  'resolution_tier',
  'search_text'
];

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
    this.pendingPersistScope = null;
    this.pendingPersistTimer = null;
    this.partialCollections = new Set();
  }

  async init() {
    const startedAt = Date.now();
    runtimeLog(`SQLite store init started: ${this.dbPath}`);
    await mkdir(this.dataDir, { recursive: true });
    this.openSqlite();
    this.createSchema();
    this.prepareStatements();

    if (!this.hasSqliteData()) {
      runtimeLog(`No SQLite data found. Checking legacy JSON in ${this.dataDir}`);
      const legacyDb = await this.readLegacyOrDefault();
      const safeDb = trimDb(normalizeDb(legacyDb));
      safeDb.accounts.forEach((account) => {
        account.inFlight = 0;
      });
      runtimeLog(`Migrating legacy data to SQLite: ${formatDbCounts(safeDb)}`);
      this.replaceAll(safeDb);
      await this.markLegacyMigrated();
      this.db = safeDb;
      runtimeLog(`SQLite store init completed in ${Date.now() - startedAt}ms: ${formatDbCounts(this.db)}`);
      return;
    }

    runtimeLog('SQLite data found. Loading tables into runtime cache.');
    this.db = this.loadFromSqlite();
    this.db.accounts.forEach((account) => {
      account.inFlight = 0;
    });
    trimDb(this.db, { collections: ['accounts'] });
    this.persistIncremental(this.db, { collections: ['accounts'] });
    runtimeLog(`SQLite store init completed in ${Date.now() - startedAt}ms: ${formatDbCounts(this.db)}`);
  }

  async read() {
    await this.ensureLoaded();
    return cloneDb(this.db);
  }

  async readCollections(requestedCollections = []) {
    await this.ensureLoaded();
    const snapshot = {};
    for (const key of requestedCollections) {
      if (largeRuntimeCollections.has(key) && this.partialCollections.has(key)) {
        throw new Error(`Refusing to clone partial large collection: ${key}`);
      }
      if (key === 'settings') {
        snapshot.settings = structuredClone(this.db.settings);
      } else if (Array.isArray(this.db[key])) {
        snapshot[key] = structuredClone(this.db[key]);
      }
    }
    return snapshot;
  }

  async readQueueStateCounts() {
    await this.ensureLoaded();
    const rows = this.sqlite.prepare(`
      SELECT status, source, COUNT(*) AS count
      FROM jobs
      WHERE status IN ('queued', 'running')
      GROUP BY status, source
    `).all();
    return rows.reduce((counts, row) => {
      const count = Number(row.count || 0);
      if (row.status === 'queued') {
        counts.queued += count;
        if (row.source === 'direct') counts.directQueued += count;
        if (row.source === 'openai') counts.openAiQueued += count;
      }
      if (row.status === 'running') counts.running += count;
      return counts;
    }, { queued: 0, running: 0, directQueued: 0, openAiQueued: 0 });
  }

  async readImageFiles() {
    await this.ensureLoaded();
    if (this.partialCollections.has('images')) return null;
    return (this.db.images || []).map((image) => image.file).filter(Boolean);
  }

  hasPartialCollection(collection) {
    return this.partialCollections.has(collection);
  }

  async findJobContext(id) {
    await this.ensureLoaded();
    const job = this.db.jobs.find((item) => item.id === id) || this.selectItemById('jobs', id);
    if (!job) return null;
    const account = job.accountId
      ? this.db.accounts.find((item) => item.id === job.accountId) || null
      : null;
    return {
      job: structuredClone(job),
      account: account ? structuredClone(account) : null,
      queue: this.jobQueueProgress(job)
    };
  }

  async readSettings() {
    await this.ensureLoaded();
    return structuredClone(this.db.settings);
  }

  async findImage(id) {
    await this.ensureLoaded();
    const row = this.statements.selectById.images.get(id);
    if (row) return safeJson(row.data, null);
    const image = this.db.images.find((item) => item.id === id);
    return image ? structuredClone(image) : null;
  }

  async findImageByCacheKey(cacheKey) {
    await this.ensureLoaded();
    const row = this.sqlite.prepare(`
      SELECT data FROM images
      WHERE cache_key = ? AND COALESCE(mock, 0) = 0 AND mime_type != 'image/svg+xml'
      ORDER BY order_value DESC
      LIMIT 1
    `).get(String(cacheKey || ''));
    if (row) return safeJson(row.data, null);
    const image = this.db.images.find((item) => item.cacheKey === cacheKey && !item.mock && item.mimeType !== 'image/svg+xml');
    return image ? structuredClone(image) : null;
  }

  async readImagePage(options = {}) {
    await this.ensureLoaded();
    const limit = Math.max(1, Math.min(200, Math.floor(Number(options.limit || 60))));
    const offset = Math.max(0, Math.floor(Number(options.offset || 0)));
    const q = String(options.q || '').trim().toLowerCase();
    const tier = String(options.tier || '').trim().toLowerCase();
    const filters = [];
    const filterParams = {};
    const pageParams = { limit, offset };
    if (tier) {
      filters.push('resolution_tier = @tier');
      filterParams.tier = tier;
      pageParams.tier = tier;
    }
    if (q) {
      filters.push('search_text LIKE @q');
      filterParams.q = `%${q}%`;
      pageParams.q = `%${q}%`;
    }
    const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = Number(this.sqlite.prepare('SELECT COUNT(*) AS count FROM images').get().count || 0);
    const matched = Number(this.sqlite.prepare(`SELECT COUNT(*) AS count FROM images ${whereSql}`).get(filterParams).count || 0);
    const rows = this.sqlite.prepare(`
      SELECT data FROM images
      ${whereSql}
      ORDER BY order_value DESC
      LIMIT @limit OFFSET @offset
    `).all(pageParams);
    return {
      images: rows.map((row) => safeJson(row.data, null)).filter(Boolean),
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
    const statsCutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    return {
      settings: structuredClone(this.db.settings),
      cards: this.selectItems('cards'),
      users: this.selectItems('users'),
      accounts: this.selectItems('accounts'),
      jobs: this.selectItems('jobs', 'ORDER BY order_value DESC LIMIT 50'),
      statsJobs: this.selectJobStatRows(`
        WHERE COALESCE(created_at, '') >= @cutoff
          OR COALESCE(updated_at, '') >= @cutoff
          OR status IN ('queued', 'running')
        ORDER BY order_value DESC
      `, { cutoff: statsCutoff }),
      errorJobs: this.selectItems('jobs', `
        WHERE status = 'failed' AND COALESCE(updated_at, created_at, '') >= @cutoff
        ORDER BY COALESCE(updated_at, created_at, '') DESC
        LIMIT 100
      `, { cutoff: statsCutoff }),
      queueJobs: this.selectItems('jobs', `
        WHERE status IN ('queued', 'running')
        ORDER BY COALESCE(created_at, '') ASC
      `),
      images: this.selectItems('images', 'ORDER BY order_value DESC LIMIT 12'),
      imageCount: this.countRecords('images'),
      imageTotal: this.countRecords('images'),
      cacheImageCount: this.countRecords('images'),
      ledger: this.selectItems('ledger', 'ORDER BY order_value DESC LIMIT 80')
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
    if ([...this.partialCollections].some((collection) => largeRuntimeCollections.has(collection))) {
      throw new Error('Refusing to clone full database while large collections are partially loaded.');
    }
    return cloneDb(this.db);
  }

  async write(db) {
    await this.ensureLoaded();
    this.clearPendingPersist();
    const safeDb = trimDb(normalizeDb(db));
    this.replaceAll(safeDb);
    this.db = safeDb;
  }

  async update(mutator, options = {}) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      await this.ensureLoaded();
      const result = await mutator(this.db);
      const persistOptions = resolvePersistenceOptions(options, result, this.db);
      if (shouldPersistUpdate(result, persistOptions)) {
        const scope = persistenceScope(persistOptions);
        if (shouldDeferPersist(scope, persistOptions)) {
          this.schedulePersist(scope);
        } else {
          this.flushPendingPersistSync();
          if (!scope.hasDirtyRows) trimDb(this.db, { collections: scope.full ? null : scope.collections });
          this.persistIncremental(this.db, scope);
        }
      }
      return cloneValue(result);
    });
    return this.queue;
  }

  scheduleFlush() {
    this.schedulePersist({ full: true, includeSettings: true, collections, dirtyRows: {}, hasDirtyRows: false });
    return this.pendingPersistTimer;
  }

  async flush() {
    await this.ensureLoaded();
    this.flushPendingPersistSync();
    this.persistIncremental(this.db);
  }

  flushSync() {
    if (!this.db) return;
    this.flushPendingPersistSync();
  }

  close() {
    if (!this.sqlite) return;
    this.flushPendingPersistSync();
    this.sqlite.close();
    this.sqlite = null;
    this.statements = null;
  }

  schedulePersist(scope) {
    this.pendingPersistScope = mergePersistenceScopes(this.pendingPersistScope, scope);
    if (this.pendingPersistTimer) return;
    this.pendingPersistTimer = setTimeout(() => {
      this.pendingPersistTimer = null;
      this.flushPendingPersistSync();
    }, sqliteWriteDebounceMs());
    this.pendingPersistTimer.unref?.();
  }

  flushPendingPersistSync() {
    if (!this.pendingPersistScope) return;
    if (this.pendingPersistTimer) {
      clearTimeout(this.pendingPersistTimer);
      this.pendingPersistTimer = null;
    }
    const scope = this.pendingPersistScope;
    this.pendingPersistScope = null;
    if (!scope.hasDirtyRows) trimDb(this.db, { collections: scope.full ? null : scope.collections });
    this.persistIncremental(this.db, scope);
  }

  selectItems(collection, clause = 'ORDER BY order_value DESC', params = {}) {
    const table = collectionTables[collection];
    if (!table) return [];
    const rows = this.sqlite.prepare(`SELECT data FROM ${table} ${clause}`).all(params);
    return rows.map((row) => safeJson(row.data, null)).filter(Boolean);
  }

  selectItemById(collection, id) {
    const statement = this.statements.selectById[collection];
    if (!statement || !id) return null;
    const row = statement.get(String(id));
    return row ? safeJson(row.data, null) : null;
  }

  countRecords(collection) {
    const statement = this.statements.countRecords[collection];
    if (!statement) return 0;
    return Number(statement.get()?.count || 0);
  }

  jobQueueProgress(job) {
    if (!job || !['queued', 'running'].includes(job.status)) return { progress: 0, total: 0 };
    const active = this.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE status IN ('queued', 'running')
    `).get();
    const activeAhead = this.sqlite.prepare(`
      SELECT COUNT(*) AS count
      FROM jobs
      WHERE status IN ('queued', 'running')
        AND id != @id
        AND COALESCE(created_at, '') <= @createdAt
    `).get({ id: job.id, createdAt: job.createdAt || '' });
    const total = Math.max(1, Number(job.queueTotal || 0) || Number(active?.count || 0) || 1);
    return {
      progress: Math.min(total, Number(activeAhead?.count || 0) + 1),
      total
    };
  }

  selectJobStatRows(clause = 'ORDER BY order_value DESC', params = {}) {
    const rows = this.sqlite.prepare(`
      SELECT
        id,
        status,
        account_id AS accountId,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM jobs
      ${clause}
    `).all(params);
    return rows.map((row) => ({
      id: row.id || '',
      status: row.status || '',
      accountId: row.accountId || '',
      createdAt: row.createdAt || '',
      updatedAt: row.updatedAt || ''
    }));
  }

  openSqlite() {
    if (this.sqlite) return;
    const startedAt = Date.now();
    this.sqlite = new Database(this.dbPath);
    this.sqlite.pragma('journal_mode = WAL');
    this.sqlite.pragma('synchronous = NORMAL');
    this.sqlite.pragma('foreign_keys = ON');
    runtimeLog(`SQLite opened in ${Date.now() - startedAt}ms`);
  }

  createSchema() {
    const startedAt = Date.now();
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

    for (const table of Object.values(collectionTables)) {
      this.sqlite.exec(`
        CREATE TABLE IF NOT EXISTS ${table} (
          id TEXT PRIMARY KEY,
          order_value REAL NOT NULL,
          data TEXT NOT NULL,
          token TEXT,
          user_token TEXT,
          account_id TEXT,
          status TEXT,
          source TEXT,
          code TEXT,
          cache_key TEXT,
          image_id TEXT,
          created_at TEXT,
          updated_at TEXT,
          at TEXT,
          enabled INTEGER,
          balance REAL,
          route_id INTEGER,
          width INTEGER,
          height INTEGER,
          mock INTEGER,
          mime_type TEXT,
          model TEXT,
          prompt TEXT,
          full_prompt TEXT,
          resolution_tier TEXT,
          search_text TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_${table}_order
          ON ${table} (order_value DESC);
        CREATE INDEX IF NOT EXISTS idx_${table}_status_created
          ON ${table} (status, created_at);
        CREATE INDEX IF NOT EXISTS idx_${table}_status_updated
          ON ${table} (status, updated_at);
        CREATE INDEX IF NOT EXISTS idx_${table}_account_created
          ON ${table} (account_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_${table}_token
          ON ${table} (token);
      `);
    }

    this.sqlite.exec(`
      CREATE INDEX IF NOT EXISTS idx_images_cache_key
        ON images (cache_key);
      CREATE INDEX IF NOT EXISTS idx_images_tier_order
        ON images (resolution_tier, order_value DESC);
      CREATE INDEX IF NOT EXISTS idx_images_search
        ON images (search_text);
      CREATE INDEX IF NOT EXISTS idx_jobs_user_token
        ON jobs (user_token);
      CREATE INDEX IF NOT EXISTS idx_jobs_image_id
        ON jobs (image_id);
      CREATE INDEX IF NOT EXISTS idx_users_token
        ON users (token);
      CREATE INDEX IF NOT EXISTS idx_accounts_route_id
        ON accounts (route_id);
    `);
    runtimeLog(`SQLite schema checked in ${Date.now() - startedAt}ms`);
  }

  prepareStatements() {
    if (this.statements) return;
    const valueList = recordColumns.map((column) => `@${column}`).join(', ');
    const updateList = recordColumns
      .filter((column) => column !== 'id')
      .map((column) => `${column} = excluded.${column}`)
      .join(', ');
    this.statements = {
      hasSettings: this.sqlite.prepare('SELECT 1 FROM app_settings WHERE key = ? LIMIT 1'),
      hasGenericRecords: this.sqlite.prepare('SELECT 1 FROM app_records LIMIT 1'),
      selectSettings: this.sqlite.prepare('SELECT value FROM app_settings WHERE key = ?'),
      selectGenericRecords: this.sqlite.prepare('SELECT id, order_value AS orderValue, data FROM app_records WHERE collection = ? ORDER BY order_value DESC'),
      replaceSettings: this.sqlite.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      deleteAllSettings: this.sqlite.prepare('DELETE FROM app_settings'),
      deleteGenericRecords: this.sqlite.prepare('DELETE FROM app_records'),
      setMeta: this.sqlite.prepare('INSERT INTO app_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
      hasTypedRecords: {},
      selectRecords: {},
      selectById: {},
      countRecords: {},
      deleteAllRecords: {},
      upsertRecord: {},
      deleteRecord: {}
    };

    for (const [collection, table] of Object.entries(collectionTables)) {
      this.statements.hasTypedRecords[collection] = this.sqlite.prepare(`SELECT 1 FROM ${table} LIMIT 1`);
      this.statements.selectRecords[collection] = this.sqlite.prepare(`SELECT id, order_value AS orderValue, data FROM ${table} ORDER BY order_value DESC`);
      this.statements.selectById[collection] = this.sqlite.prepare(`SELECT data FROM ${table} WHERE id = ? LIMIT 1`);
      this.statements.countRecords[collection] = this.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${table}`);
      this.statements.deleteAllRecords[collection] = this.sqlite.prepare(`DELETE FROM ${table}`);
      this.statements.upsertRecord[collection] = this.sqlite.prepare(`
        INSERT INTO ${table} (${recordColumns.join(', ')})
        VALUES (${valueList})
        ON CONFLICT(id) DO UPDATE SET ${updateList}
      `);
      this.statements.deleteRecord[collection] = this.sqlite.prepare(`DELETE FROM ${table} WHERE id = ?`);
    }
  }

  hasSqliteData() {
    return Boolean(this.statements.hasSettings.get('settings') || this.hasTypedRecords() || this.statements.hasGenericRecords.get());
  }

  hasTypedRecords() {
    return collections.some((collection) => this.statements.hasTypedRecords[collection].get());
  }

  loadFromSqlite() {
    if (!this.hasTypedRecords() && this.statements.hasGenericRecords.get()) {
      const startedAt = Date.now();
      runtimeLog('Legacy SQLite app_records table found. Upgrading to typed tables.');
      const db = this.loadFromGenericRecords();
      runtimeLog(`Loaded legacy app_records in ${Date.now() - startedAt}ms: ${formatDbCounts(db)}`);
      this.replaceAll(db);
      this.statements.deleteGenericRecords.run();
      this.statements.setMeta.run('generic_records_migrated_at', new Date().toISOString());
      runtimeLog(`Upgraded app_records to typed tables in ${Date.now() - startedAt}ms`);
      return this.loadFromSqlite();
    }

    const startedAt = Date.now();
    const settingsRow = this.statements.selectSettings.get('settings');
    const db = {
      ...defaultDb,
      settings: settingsRow ? safeJson(settingsRow.value, defaultSettings) : defaultSettings
    };
    const rowState = emptyCollectionMaps();
    const orderKeys = emptyCollectionMaps();
    const totalCounts = Object.fromEntries(collections.map((collection) => [collection, this.countRecords(collection)]));
    this.partialCollections = new Set();

    for (const collection of collections) {
      const rows = this.runtimeRowsForCollection(collection);
      if (rows.length < totalCounts[collection]) this.partialCollections.add(collection);
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
    runtimeLog(`Loaded typed SQLite runtime cache in ${Date.now() - startedAt}ms: ${formatDbCounts(normalized)} total=${formatDbCounts(totalCounts)} partial=${[...this.partialCollections].join(',') || 'none'}`);
    return normalized;
  }

  runtimeRowsForCollection(collection) {
    const table = collectionTables[collection];
    if (!table) return [];
    if (collection === 'jobs') {
      return this.sqlite.prepare(`
        SELECT id, order_value AS orderValue, data FROM ${table}
        WHERE status IN ('queued', 'running')
           OR id IN (
             SELECT id FROM ${table}
             ORDER BY order_value DESC
             LIMIT @limit
           )
        ORDER BY order_value DESC
      `).all({ limit: runtimeCacheLimit('jobs') });
    }
    if (collection === 'images' || collection === 'ledger') {
      return this.sqlite.prepare(`
        SELECT id, order_value AS orderValue, data FROM ${table}
        ORDER BY order_value DESC
        LIMIT @limit
      `).all({ limit: runtimeCacheLimit(collection) });
    }
    return this.statements.selectRecords[collection].all();
  }

  loadFromGenericRecords() {
    const settingsRow = this.statements.selectSettings.get('settings');
    const db = {
      ...defaultDb,
      settings: settingsRow ? safeJson(settingsRow.value, defaultSettings) : defaultSettings
    };
    for (const collection of collections) {
      const rows = this.statements.selectGenericRecords.all(collection);
      db[collection] = rows.map((row) => safeJson(row.data, null)).filter(Boolean);
    }
    return normalizeDb(db);
  }

  replaceAll(db) {
    this.clearPendingPersist();
    this.partialCollections = new Set();
    const safeDb = trimDb(normalizeDb(db));
    const snapshot = buildSnapshotState(safeDb, emptyCollectionMaps(), { dense: true });
    const startedAt = Date.now();
    const writeAll = this.sqlite.transaction(() => {
      this.statements.deleteAllSettings.run();
      for (const collection of collections) {
        this.statements.deleteAllRecords[collection].run();
      }
      this.statements.replaceSettings.run('settings', snapshot.settingsData);
      for (const collection of collections) {
        for (const [id, row] of snapshot.rowState[collection]) {
          this.statements.upsertRecord[collection].run(row.sql);
        }
      }
    });
    writeAll();
    this.settingsState = snapshot.settingsData;
    this.rowState = snapshot.rowState;
    this.orderKeys = snapshot.orderKeys;
    runtimeLog(`SQLite full replace wrote ${formatDbCounts(safeDb)} in ${Date.now() - startedAt}ms`);
  }

  clearPendingPersist() {
    if (this.pendingPersistTimer) {
      clearTimeout(this.pendingPersistTimer);
      this.pendingPersistTimer = null;
    }
    this.pendingPersistScope = null;
  }

  persistIncremental(db, options = {}) {
    const startedAt = Date.now();
    const scope = persistenceScope(options);
    if (!scope.full && !scope.includeSettings && !scope.collections.length) return;
    if (scope.hasDirtyRows) {
      const fullCollections = scope.collections.filter((collection) => !scope.dirtyRows[collection]?.size);
      if (fullCollections.length) trimDb(db, { collections: fullCollections });
      this.persistDirtyRows(db, scope, startedAt);
      return;
    }
    const safeDb = trimDb(normalizeDb(db), { collections: scope.full ? null : scope.collections });
    const snapshot = buildSnapshotState(safeDb, this.orderKeys, {
      collections: scope.full ? null : scope.collections,
      includeSettings: scope.includeSettings,
      baseRowState: scope.full ? null : this.rowState,
      baseOrderKeys: scope.full ? null : this.orderKeys
    });
    const changes = collectPersistenceChanges({
      previousSettings: this.settingsState,
      previousRows: this.rowState,
      nextSettings: snapshot.settingsData,
      nextRows: snapshot.rowState,
      includeSettings: scope.includeSettings,
      collections: scope.full ? collections : scope.collections
    });
    if (!changes.settingsChanged && !changes.deletes.length && !changes.upserts.length) return;

    const applyChanges = this.sqlite.transaction(() => {
      if (changes.settingsChanged) this.statements.replaceSettings.run('settings', snapshot.settingsData);
      for (const change of changes.deletes) {
        this.statements.deleteRecord[change.collection].run(change.id);
      }
      for (const change of changes.upserts) {
        this.statements.upsertRecord[change.collection].run(change.sql);
      }
    });
    applyChanges();
    if (scope.includeSettings) this.settingsState = snapshot.settingsData;
    for (const collection of (scope.full ? collections : scope.collections)) {
      this.rowState[collection] = snapshot.rowState[collection];
      this.orderKeys[collection] = snapshot.orderKeys[collection];
    }
    const duration = Date.now() - startedAt;
    if (duration >= sqliteSlowLogMs()) {
      const scopeText = scope.full ? 'full' : ['settings', ...scope.collections].filter((item, index, array) => {
        if (item !== 'settings') return true;
        return scope.includeSettings && array.indexOf(item) === index;
      }).join(',');
      runtimeLog(`SQLite incremental persist slow: ${duration}ms scope=${scopeText || 'none'} upserts=${changes.upserts.length} deletes=${changes.deletes.length} settings=${changes.settingsChanged ? 1 : 0}`);
    }
  }

  persistDirtyRows(db, scope, startedAt = Date.now()) {
    const changes = {
      settingsChanged: false,
      deletes: [],
      upserts: []
    };
    const fullCollections = [];

    if (scope.includeSettings) {
      const nextSettings = JSON.stringify(db.settings);
      changes.settingsChanged = this.settingsState !== nextSettings;
      if (changes.settingsChanged) changes.nextSettings = nextSettings;
    }

    for (const collection of scope.collections) {
      const dirtyIds = scope.dirtyRows[collection];
      if (!dirtyIds || !dirtyIds.size) {
        fullCollections.push(collection);
        continue;
      }
      const previousRows = this.rowState[collection] || new Map();
      const previousOrders = this.orderKeys[collection] || new Map();
      const items = Array.isArray(db[collection]) ? db[collection] : [];
      const dirtyIndexes = dirtyItemIndexes(items, dirtyIds);
      for (const id of dirtyIds) {
        const index = dirtyIndexes.get(id) ?? -1;
        if (index < 0) {
          if (previousRows.has(id)) changes.deletes.push({ collection, id });
          continue;
        }
        const item = items[index];
        ensureItemIds(collection, [item]);
        const data = JSON.stringify(item);
        const order = dirtyRowOrder(items, index, previousOrders);
        const row = {
          data,
          order,
          sql: sqlRecord(collection, item, order, data)
        };
        const old = previousRows.get(id);
        if (!old || old.data !== row.data || old.order !== row.order) {
          changes.upserts.push({ collection, id, data: row.data, order: row.order, sql: row.sql });
        }
      }
    }

    if (fullCollections.length) {
      const snapshot = buildSnapshotState(db, this.orderKeys, {
        collections: fullCollections,
        includeSettings: false,
        baseRowState: this.rowState,
        baseOrderKeys: this.orderKeys
      });
      const fullChanges = collectPersistenceChanges({
        previousSettings: this.settingsState,
        previousRows: this.rowState,
        nextSettings: snapshot.settingsData,
        nextRows: snapshot.rowState,
        includeSettings: false,
        collections: fullCollections
      });
      changes.deletes.push(...fullChanges.deletes);
      changes.upserts.push(...fullChanges.upserts);
    }

    if (!changes.settingsChanged && !changes.deletes.length && !changes.upserts.length) return;

    const applyChanges = this.sqlite.transaction(() => {
      if (changes.settingsChanged) this.statements.replaceSettings.run('settings', changes.nextSettings);
      for (const change of changes.deletes) {
        this.statements.deleteRecord[change.collection].run(change.id);
      }
      for (const change of changes.upserts) {
        this.statements.upsertRecord[change.collection].run(change.sql);
      }
    });
    applyChanges();

    if (changes.settingsChanged) this.settingsState = changes.nextSettings;
    for (const change of changes.deletes) {
      this.rowState[change.collection]?.delete(change.id);
      this.orderKeys[change.collection]?.delete(change.id);
    }
    for (const change of changes.upserts) {
      this.rowState[change.collection]?.set(change.id, { data: change.data, order: change.order });
      this.orderKeys[change.collection]?.set(change.id, change.order);
    }

    if (fullCollections.length) {
      const snapshot = buildSnapshotState(db, this.orderKeys, {
        collections: fullCollections,
        includeSettings: false,
        baseRowState: this.rowState,
        baseOrderKeys: this.orderKeys
      });
      for (const collection of fullCollections) {
        this.rowState[collection] = snapshot.rowState[collection];
        this.orderKeys[collection] = snapshot.orderKeys[collection];
      }
    }

    const duration = Date.now() - startedAt;
    if (duration >= sqliteSlowLogMs()) {
      runtimeLog(`SQLite dirty-row persist slow: ${duration}ms scope=${scope.collections.join(',') || 'none'} upserts=${changes.upserts.length} deletes=${changes.deletes.length} settings=${changes.settingsChanged ? 1 : 0}`);
    }
  }

  async readLegacyOrDefault() {
    const candidates = [this.legacyDbPath, this.legacyBackupPath];
    let lastError = null;
    for (const filePath of candidates) {
      if (!existsSync(filePath)) continue;
      try {
        runtimeLog(`Reading legacy JSON: ${filePath} (${formatFileSize(filePath)})`);
        const raw = await readFile(filePath, 'utf8');
        const parsed = normalizeDb(JSON.parse(raw));
        runtimeLog(`Legacy JSON loaded: ${formatDbCounts(parsed)}`);
        return parsed;
      } catch (error) {
        lastError = error;
        runtimeLog(`Failed to read legacy JSON ${filePath}: ${error.message}`);
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
        runtimeLog(`Deleted migrated legacy JSON: ${filePath}`);
      } catch (error) {
        console.error(`Failed to delete migrated legacy JSON ${filePath}:`, error);
      }
    }
    this.statements.setMeta.run('legacy_json_deleted', JSON.stringify(deleted));
    if (deleted.length) console.log(`Migrated legacy JSON data to SQLite and deleted ${deleted.length} old JSON file(s).`);
  }
}

function buildSnapshotState(db, previousOrderKeys, options = {}) {
  const settingsData = options.includeSettings === false ? '' : JSON.stringify(db.settings);
  const hasCollectionOption = options.collections !== undefined && options.collections !== null;
  const targetCollections = hasCollectionOption
    ? normalizeCollectionList(options.collections) || []
    : collections;
  const rowState = options.baseRowState ? cloneCollectionMaps(options.baseRowState) : emptyCollectionMaps();
  const orderKeys = options.baseOrderKeys ? cloneCollectionMaps(options.baseOrderKeys) : emptyCollectionMaps();

  for (const collection of targetCollections) {
    const items = Array.isArray(db[collection]) ? db[collection] : [];
    ensureItemIds(collection, items);
    rowState[collection] = new Map();
    const orders = options.dense
      ? denseOrderValues(items)
      : assignOrderValues(items, previousOrderKeys[collection] || new Map());
    orderKeys[collection] = orders;
    for (const item of items) {
      const id = String(item.id);
      const data = JSON.stringify(item);
      const order = Number(orders.get(id));
      rowState[collection].set(id, {
        data,
        order,
        sql: sqlRecord(collection, item, order, data)
      });
    }
  }

  return { settingsData, rowState, orderKeys };
}

function collectPersistenceChanges({ previousSettings, previousRows, nextSettings, nextRows, includeSettings = true, collections: targetCollections = collections }) {
  const deletes = [];
  const upserts = [];
  for (const collection of targetCollections) {
    const previous = previousRows[collection] || new Map();
    const next = nextRows[collection] || new Map();
    for (const id of previous.keys()) {
      if (!next.has(id)) deletes.push({ collection, id });
    }
    for (const [id, row] of next) {
      const old = previous.get(id);
      if (!old || old.data !== row.data || old.order !== row.order) {
        upserts.push({ collection, id, data: row.data, order: row.order, sql: row.sql });
      }
    }
  }
  return {
    settingsChanged: includeSettings && previousSettings !== nextSettings,
    deletes,
    upserts
  };
}

function shouldPersistUpdate(result, options = {}) {
  if (options.persist === false) return false;
  if (typeof options.shouldPersist === 'function') return Boolean(options.shouldPersist(result));
  return true;
}

function shouldDeferPersist(scope, options = {}) {
  if (!sqliteBatchWritesEnabled()) return false;
  if (options.immediate === true || options.defer === false) return false;
  return Boolean(scope?.hasDirtyRows && !scope.full);
}

function resolvePersistenceOptions(options = {}, result, db) {
  const resolved = { ...options };
  for (const key of ['dirtyRows', 'rows', 'changedRows']) {
    if (typeof resolved[key] === 'function') resolved[key] = resolved[key](result, db);
  }
  return resolved;
}

function mergePersistenceScopes(current, next) {
  if (!current) return clonePersistenceScope(next);
  if (!next) return clonePersistenceScope(current);
  if (current.full || next.full) {
    return { full: true, includeSettings: true, collections, dirtyRows: {}, hasDirtyRows: false };
  }

  const targetCollections = new Set([...(current.collections || []), ...(next.collections || [])]);
  const fullCollections = new Set();
  const dirtyRows = {};

  for (const scope of [current, next]) {
    for (const collection of scope.collections || []) {
      const ids = scope.dirtyRows?.[collection];
      if (!ids || !ids.size) {
        fullCollections.add(collection);
        delete dirtyRows[collection];
        continue;
      }
      if (fullCollections.has(collection)) continue;
      if (!dirtyRows[collection]) dirtyRows[collection] = new Set();
      for (const id of ids) dirtyRows[collection].add(id);
    }
  }

  return {
    full: false,
    includeSettings: Boolean(current.includeSettings || next.includeSettings),
    collections: [...targetCollections].filter((collection) => collections.includes(collection)),
    dirtyRows,
    hasDirtyRows: Object.keys(dirtyRows).length > 0
  };
}

function clonePersistenceScope(scope) {
  if (!scope) return null;
  if (scope.full) return { full: true, includeSettings: true, collections, dirtyRows: {}, hasDirtyRows: false };
  const dirtyRows = {};
  for (const [collection, ids] of Object.entries(scope.dirtyRows || {})) {
    dirtyRows[collection] = new Set(ids || []);
  }
  return {
    full: false,
    includeSettings: Boolean(scope.includeSettings),
    collections: normalizeCollectionList(scope.collections) || [],
    dirtyRows,
    hasDirtyRows: Object.keys(dirtyRows).length > 0
  };
}

function persistenceScope(options = {}) {
  if (options.full === true) return { full: true, includeSettings: true, collections, dirtyRows: {}, hasDirtyRows: false };
  const dirtyRows = normalizeDirtyRows(options.dirtyRows ?? options.rows ?? options.changedRows);
  const dirtyCollections = Object.keys(dirtyRows);
  const raw = options.collections ?? options.changedCollections ?? (dirtyCollections.length ? dirtyCollections : undefined);
  if (raw === undefined || raw === null) return { full: true, includeSettings: true, collections, dirtyRows: {}, hasDirtyRows: false };
  const values = Array.isArray(raw) ? raw : [raw];
  const includeSettings = values.includes('settings') || options.includeSettings === true;
  const targetCollections = normalizeCollectionList([...values, ...dirtyCollections]);
  return {
    full: false,
    includeSettings,
    collections: targetCollections || [],
    dirtyRows,
    hasDirtyRows: dirtyCollections.length > 0
  };
}

function normalizeCollectionList(value) {
  if (value === undefined || value === null) return null;
  const values = Array.isArray(value) ? value : [value];
  const selected = [];
  const seen = new Set();
  for (const item of values) {
    const collection = String(item || '');
    if (!collections.includes(collection) || seen.has(collection)) continue;
    seen.add(collection);
    selected.push(collection);
  }
  return selected.length ? selected : null;
}

function normalizeDirtyRows(value) {
  const dirtyRows = {};
  if (!value) return dirtyRows;
  const entries = value instanceof Map ? value.entries() : Object.entries(value);
  for (const [rawCollection, rawIds] of entries) {
    const collection = String(rawCollection || '');
    if (!collections.includes(collection)) continue;
    const ids = rawIds instanceof Set
      ? [...rawIds]
      : Array.isArray(rawIds)
        ? rawIds
        : [rawIds];
    const selected = ids
      .map((id) => String(id || '').trim())
      .filter(Boolean);
    if (!selected.length) continue;
    dirtyRows[collection] = new Set([...(dirtyRows[collection] || []), ...selected]);
  }
  return dirtyRows;
}

function cloneCollectionMaps(source = {}) {
  const maps = emptyCollectionMaps();
  for (const collection of collections) {
    maps[collection] = new Map(source[collection] || []);
  }
  return maps;
}

function sqlRecord(collection, item, order, data) {
  const createdAt = item.createdAt || '';
  const updatedAt = item.updatedAt || '';
  const row = {
    id: String(item.id),
    order_value: Number(order),
    data,
    token: null,
    user_token: null,
    account_id: null,
    status: null,
    source: null,
    code: null,
    cache_key: null,
    image_id: null,
    created_at: createdAt || null,
    updated_at: updatedAt || null,
    at: item.at || null,
    enabled: item.enabled === undefined ? null : item.enabled !== false ? 1 : 0,
    balance: numberOrNull(item.balance),
    route_id: numberOrNull(item.routeId),
    width: numberOrNull(item.width),
    height: numberOrNull(item.height),
    mock: item.mock === undefined ? null : item.mock ? 1 : 0,
    mime_type: item.mimeType || null,
    model: item.model || item.request?.model || null,
    prompt: item.prompt || item.request?.tag || null,
    full_prompt: item.fullPrompt || item.request?.prompt || null,
    resolution_tier: null,
    search_text: ''
  };

  if (collection === 'cards') {
    row.code = item.code || null;
    row.token = item.token || null;
  }
  if (collection === 'users') {
    row.token = item.token || null;
  }
  if (collection === 'accounts') {
    row.token = item.token || null;
  }
  if (collection === 'jobs') {
    row.user_token = item.userToken || null;
    row.account_id = item.accountId || null;
    row.status = item.status || null;
    row.source = item.source || 'web';
    row.cache_key = item.cacheKey || null;
    row.image_id = item.imageId || null;
    row.prompt = item.request?.tag || item.prompt || null;
    row.full_prompt = item.request?.prompt || item.fullPrompt || null;
    row.model = item.request?.model || item.model || null;
  }
  if (collection === 'images') {
    row.token = item.token || null;
    row.account_id = item.accountId || null;
    row.cache_key = item.cacheKey || null;
    row.resolution_tier = imageResolutionTier(item).toLowerCase();
  }
  if (collection === 'ledger') {
    row.token = item.token || null;
    row.user_token = item.token || null;
    row.account_id = item.accountId || null;
    row.status = item.type || null;
    row.source = item.type || null;
    row.image_id = item.imageId || null;
  }

  row.search_text = searchableText(item, row);
  return row;
}

function searchableText(item, row) {
  return [
    item.id,
    row.token,
    row.user_token,
    row.account_id,
    row.status,
    row.source,
    row.code,
    row.cache_key,
    row.image_id,
    row.model,
    row.prompt,
    row.full_prompt,
    item.name,
    item.note,
    item.file
  ].filter(Boolean).join('\n').toLowerCase();
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
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

function dirtyRowOrder(items, index, previousOrders) {
  const id = String(items[index]?.id || '');
  if (previousOrders.has(id)) return Number(previousOrders.get(id));

  let before = null;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const previousId = String(items[cursor]?.id || '');
    if (!previousOrders.has(previousId)) continue;
    before = Number(previousOrders.get(previousId));
    break;
  }

  let after = null;
  for (let cursor = index + 1; cursor < items.length; cursor += 1) {
    const nextId = String(items[cursor]?.id || '');
    if (!previousOrders.has(nextId)) continue;
    after = Number(previousOrders.get(nextId));
    break;
  }

  return orderValuesForRun(1, before, after)[0];
}

function dirtyItemIndexes(items, dirtyIds) {
  const indexes = new Map();
  let remaining = dirtyIds.size;
  for (let index = 0; index < items.length && remaining > 0; index += 1) {
    const id = String(items[index]?.id || '');
    if (!dirtyIds.has(id) || indexes.has(id)) continue;
    indexes.set(id, index);
    remaining -= 1;
  }
  return indexes;
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

function runtimeLog(message) {
  console.log(`[runtime] ${message}`);
}

function sqliteSlowLogMs() {
  const configured = Number(process.env.SQLITE_SLOW_LOG_MS || 500);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return 500;
}

function sqliteBatchWritesEnabled() {
  return process.env.SQLITE_BATCH_WRITES !== 'false';
}

function sqliteWriteDebounceMs() {
  const configured = Number(process.env.SQLITE_WRITE_DEBOUNCE_MS || 500);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return 500;
}

function runtimeCacheLimit(collection) {
  const defaults = {
    jobs: 3000,
    images: 1000,
    ledger: 1000
  };
  const envName = `RUNTIME_${collection.toUpperCase()}_CACHE_LIMIT`;
  const configured = Number(process.env[envName] || defaults[collection] || 1000);
  if (Number.isFinite(configured) && configured >= 0) return Math.floor(configured);
  return defaults[collection] || 1000;
}

function formatDbCounts(db = {}) {
  const count = (value) => Array.isArray(value) ? value.length : Number(value || 0);
  return [
    `users=${count(db.users)}`,
    `accounts=${count(db.accounts)}`,
    `jobs=${count(db.jobs)}`,
    `images=${count(db.images)}`,
    `cards=${count(db.cards)}`,
    `ledger=${count(db.ledger)}`
  ].join(' ');
}

function formatFileSize(filePath) {
  try {
    const bytes = statSync(filePath).size;
    if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
    if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
    return `${bytes} B`;
  } catch {
    return 'unknown size';
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

function trimDb(db, options = {}) {
  const hasCollectionOption = options.collections !== undefined && options.collections !== null;
  const targetCollections = hasCollectionOption ? normalizeCollectionList(options.collections) || [] : null;
  const shouldTrim = (collection) => !hasCollectionOption || targetCollections.includes(collection);
  const maxCacheImages = clampNumber(db.settings.maxCacheImages, 0, MAX_CACHE_IMAGES_LIMIT);
  db.settings.costPerImage = 1;
  db.settings.maxCacheImages = maxCacheImages;
  db.settings.accountConcurrency = 1;
  if (shouldTrim('jobs')) db.jobs = trimJobs(db.jobs);
  if (shouldTrim('images')) db.images = db.images.slice(0, maxCacheImages);
  if (shouldTrim('ledger')) db.ledger = db.ledger.slice(0, 1000);
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
