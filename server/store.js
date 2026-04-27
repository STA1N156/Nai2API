import { createWriteStream } from 'node:fs';
import { copyFile, mkdir, readFile, rename, unlink } from 'node:fs/promises';
import crypto from 'node:crypto';
import path from 'node:path';

export const MAX_CACHE_IMAGES_LIMIT = 200000;
export const MAX_FREE_STEPS = 28;
export const defaultArtist2_5D =
  `0.9::misaka_12003-gou ::, dino_(dinoartforame), wanke, liduke, year 2025, realistic, 4k, -2::green ::, textless version, The image is highly intricate finished drawn. Only the character's face is in anime style, but their body is in realistic style. 1.35::A highly finished photo-style artwork that has lively color, graphic texture, realistic skin surface, and lifelike flesh with little obliques::. 1.63::photorealistic::, 1.63::photo(medium)::, \\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,, very aesthetic, masterpiece, no text,`;
export const legacyDefaultArtist =
  'artist:ningen_mame,, noyu_(noyu23386566),, toosaka asagi,, location,\n20::best quality, absurdres, very aesthetic, detailed, masterpiece::,:,, very aesthetic, masterpiece, no text,';

const defaultSettings = {
  serviceName: 'Nai2API',
  costPerImage: 1,
  maxCacheImages: 500,
  accountConcurrency: 2,
  publicBaseUrl: '',
  mockWhenNoAccount: true,
  defaultModel: 'nai-diffusion-4-5-full',
  defaultArtist: defaultArtist2_5D,
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
    } catch (error) {
      const backupDb = await this.readBackup().catch(() => null);
      if (backupDb) {
        backupDb.accounts.forEach((account) => {
          account.inFlight = 0;
        });
        await this.write(backupDb);
        return;
      }
      if (error?.code === 'ENOENT') {
        await this.write(defaultDb);
        return;
      }
      throw error;
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
    await this.queue.catch(() => {});
    this.db = await this.readRaw();
  }

  async readRaw() {
    const raw = await readFile(this.dbPath, 'utf8');
    const db = JSON.parse(raw);
    return normalizeDb(db);
  }

  async readBackup() {
    const raw = await readFile(`${this.dbPath}.bak`, 'utf8');
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
    return this.enqueueWrite(this.db);
  }

  async enqueueWrite(db) {
    this.flushQueue = this.flushQueue.catch(() => {}).then(() => this.writeSnapshot(db));
    return this.flushQueue;
  }

  async writeSnapshot(db) {
    const tempPath = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
    await writeJsonSnapshot(tempPath, db);
    await renameWithRetry(tempPath, this.dbPath);
    await copyFile(this.dbPath, `${this.dbPath}.bak`).catch(() => {});
  }
}

function imageResolutionTier(image) {
  const width = Number(image?.width || 0);
  const height = Number(image?.height || 0);
  if (width >= 1700 || height >= 1900) return '4K';
  if (width >= 1300 || height >= 1500) return '2K';
  return 'standard';
}

function cloneDb(db) {
  return normalizeDb(structuredClone(db));
}

function cloneValue(value) {
  if (value === undefined || value === null) return value;
  return structuredClone(value);
}

async function writeJsonSnapshot(filePath, db) {
  const snapshot = snapshotDb(db);
  const stream = createWriteStream(filePath, { encoding: 'utf8' });
  try {
    await writeChunk(stream, '{');
    await writeObjectProperty(stream, 'settings', snapshot.settings, true);
    await writeArrayProperty(stream, 'cards', snapshot.cards);
    await writeArrayProperty(stream, 'users', snapshot.users);
    await writeArrayProperty(stream, 'accounts', snapshot.accounts);
    await writeArrayProperty(stream, 'jobs', snapshot.jobs);
    await writeArrayProperty(stream, 'images', snapshot.images);
    await writeArrayProperty(stream, 'ledger', snapshot.ledger);
    await writeChunk(stream, '\n}\n');
    await closeStream(stream);
  } catch (error) {
    stream.destroy();
    await unlink(filePath).catch(() => {});
    throw error;
  }
}

function snapshotDb(db) {
  return {
    settings: db.settings,
    cards: db.cards.slice(),
    users: db.users.slice(),
    accounts: db.accounts.slice(),
    jobs: db.jobs.slice(),
    images: db.images.slice(),
    ledger: db.ledger.slice()
  };
}

async function writeObjectProperty(stream, key, value, first = false) {
  await writeChunk(stream, `${first ? '\n' : ',\n'}${JSON.stringify(key)}:`);
  await writeChunk(stream, JSON.stringify(value));
}

async function writeArrayProperty(stream, key, values) {
  await writeChunk(stream, `,\n${JSON.stringify(key)}:[`);
  for (let index = 0; index < values.length; index += 1) {
    if (index > 0) await writeChunk(stream, ',');
    await writeChunk(stream, JSON.stringify(values[index]));
    if (index > 0 && index % 200 === 0) await yieldToEventLoop();
  }
  await writeChunk(stream, ']');
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('drain', onDrain);
      reject(error);
    };
    const onDrain = () => {
      stream.off('error', onError);
      resolve();
    };
    stream.once('error', onError);
    if (stream.write(chunk)) {
      stream.off('error', onError);
      resolve();
    } else {
      stream.once('drain', onDrain);
    }
  });
}

function closeStream(stream) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      stream.off('finish', onFinish);
      reject(error);
    };
    const onFinish = () => {
      stream.off('error', onError);
      resolve();
    };
    stream.once('error', onError);
    stream.once('finish', onFinish);
    stream.end();
  });
}

async function renameWithRetry(source, target) {
  let lastError = null;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await rename(source, target);
      return;
    } catch (error) {
      lastError = error;
      await sleep(50 * (attempt + 1));
    }
  }
  throw lastError;
}

function yieldToEventLoop() {
  return new Promise((resolve) => setImmediate(resolve));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
