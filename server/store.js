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
    if (!this.db) {
      await this.queue.catch(() => {});
      this.db = await this.readRaw();
    }
    return cloneDb(this.db);
  }

  async readRaw() {
    const raw = await readFile(this.dbPath, 'utf8');
    const db = JSON.parse(raw);
    return normalizeDb(db);
  }

  async write(db) {
    const safeDb = normalizeDb(db);
    const maxCacheImages = clampNumber(safeDb.settings.maxCacheImages, 0, MAX_CACHE_IMAGES_LIMIT);
    safeDb.settings.costPerImage = 1;
    safeDb.settings.maxCacheImages = maxCacheImages;
    safeDb.settings.accountConcurrency = clampNumber(safeDb.settings.accountConcurrency, 1, 20);
    safeDb.jobs = safeDb.jobs.slice(0, 500);
    safeDb.images = safeDb.images.slice(0, maxCacheImages);
    safeDb.ledger = safeDb.ledger.slice(0, 1000);
    this.db = safeDb;
    await writeFile(this.dbPath, `${JSON.stringify(safeDb, null, 2)}\n`, 'utf8');
  }

  async update(mutator) {
    this.queue = this.queue.catch(() => {}).then(async () => {
      const db = cloneDb(this.db || await this.readRaw());
      const result = await mutator(db);
      await this.write(db);
      return result;
    });
    return this.queue;
  }
}

function cloneDb(db) {
  return normalizeDb(structuredClone(db));
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
