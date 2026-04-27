import { mkdir, readFile, writeFile } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export const MAX_CACHE_IMAGES_LIMIT = 200000;
export const MAX_FREE_STEPS = 28;

const defaultSettings = {
  serviceName: 'Nai2API',
  costPerImage: 1,
  maxCacheImages: 500,
  accountConcurrency: 2,
  publicBaseUrl: '',
  mockWhenNoAccount: true,
  defaultModel: 'nai-diffusion-4-5-full',
  defaultArtist:
    'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,',
  defaultNegative:
    '{{{{bad anatomy}}}},{bad feet},bad hands,{{{bad proportions}}},{blurry},cloned face,cropped,{{{deformed}}},{{{disfigured}}},error,{{{extra arms}}},{extra digit},{{{extra legs}}},extra limbs,{{extra limbs}},{fewer digits},{{{fused fingers}}},gross proportions,jpeg artifacts,{{{{long neck}}}},low quality,{malformed limbs},{{missing arms}},{missing fingers},{{missing legs}},mutated hands,{{{mutation}}},normal quality,poorly drawn face,poorly drawn hands,signature,text,{{too many fingers}},{{{ugly}}},username,watermark,worst quality',
  defaults: {
    size: '竖图',
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
    this.dbPath = path.join(dataDir, 'library.json');
    this.queue = Promise.resolve();
    this.flushQueue = Promise.resolve();
    this.flushTimer = null;
    this.db = null;
  }

  async init() {
    await mkdir(this.dataDir, { recursive: true });
    try {
      const db = await this.readRaw();
      db.accounts.forEach((account) => {
        account.inFlight = 0;
      });
      await this.write(db);
    } catch {
      await this.write(defaultDb);
    }
  }

  async read() {
    await this.ensureLoaded();
    return cloneDb(this.db);
  }

  async readCollections(collections = []) {
    await this.ensureLoaded();
    const snapshot = {};
    for (const key of collections) {
      if (key === 'settings') {
        snapshot.settings = structuredClone(this.db.settings);
      } else if (Array.isArray(this.db[key])) {
        snapshot[key] = structuredClone(this.db[key]);
      }
    }
    return snapshot;
  }

  async readSettings() {
    await this.ensureLoaded();
    return structuredClone(this.db.settings);
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
      ledger: structuredClone(this.db.ledger.slice(0, 80))
    };
  }

  async ensureLoaded() {
    if (this.db) return;
    await this.queue.catch(() => {});
    this.db = await this.readRaw();
  }

  async readRaw() {
    const raw = await readFile(this.dbPath, 'utf8');
    const db = JSON.parse(raw);
    return normalizeDb(db);
  }

  async write(db) {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const safeDb = normalizeDb(db);
    trimDb(safeDb);
    this.db = safeDb;
    await this.enqueueWrite(safeDb);
  }

  async update(mutator, options = {}) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      if (!this.db) this.db = await this.readRaw();
      const db = this.db;
      const result = await mutator(db);
      trimDb(db);
      if (options.flush === true) {
        await this.writeSnapshot(db);
      } else {
        this.scheduleFlush();
      }
      return cloneValue(result);
    });
    return this.queue;
  }

  scheduleFlush(delay = 350) {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flush().catch((error) => console.error('Failed to flush data store:', error));
    }, delay);
  }

  async flush() {
    await this.ensureLoaded();
    const snapshot = cloneDb(this.db);
    return this.enqueueWrite(snapshot);
  }

  async enqueueWrite(db) {
    this.flushQueue = this.flushQueue.catch(() => {}).then(() => this.writeSnapshot(db));
    return this.flushQueue;
  }

  async writeSnapshot(db) {
    await writeFile(this.dbPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  }
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
  db.settings.accountConcurrency = clampNumber(db.settings.accountConcurrency, 1, 20);
  db.jobs = db.jobs.slice(0, 500);
  db.images = db.images.slice(0, maxCacheImages);
  db.ledger = db.ledger.slice(0, 1000);
  return db;
}

export function normalizeDb(db = {}) {
  return {
    settings: {
      ...defaultSettings,
      ...(db.settings || {}),
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
