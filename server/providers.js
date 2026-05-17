import net from 'node:net';
import tls from 'node:tls';
import zlib from 'node:zlib';

export const MAX_STEPS = 50;
export const DIRECT_URL_MAX_STEPS = 28;

export const sizeMap = {
  '竖图': { width: 832, height: 1216 },
  '横图': { width: 1216, height: 832 },
  '方图': { width: 1024, height: 1024 },
  '2K竖图': { width: 1088, height: 1600 },
  '2K横图': { width: 1600, height: 1088 },
  '2K方图': { width: 1344, height: 1344 },
  '4K竖图': { width: 1344, height: 1984 },
  '4K横图': { width: 1984, height: 1344 },
  '4K方图': { width: 1728, height: 1728 }
};

export const sizeCostMap = {
  '竖图': 1,
  '横图': 1,
  '方图': 1,
  '2K竖图': 20,
  '2K横图': 20,
  '2K方图': 20,
  '4K竖图': 35,
  '4K横图': 35,
  '4K方图': 35
};

export function normalizeNovelAiRequest(input, settings, options = {}) {
  const defaults = settings.defaults || {};
  const maxSteps = Number.isFinite(Number(options.maxSteps)) ? Number(options.maxSteps) : MAX_STEPS;
  const sizeName = normalizeSizeName(input.size || defaults.size || '竖图');
  const mappedSize = sizeMap[sizeName] || {};
  const tag = normalizePromptText(input.tag || input.prompt || '').trim();
  const artist = normalizePromptText(input.artist ?? settings.defaultArtist ?? '').trim();
  const prompt = [artist, tag].filter(Boolean).join('\n');
  const requestedSteps = input.steps ?? defaults.steps;

  return {
    tag,
    prompt,
    artist,
    model: String(input.model || settings.defaultModel || 'nai-diffusion-4-5-full'),
    negative: normalizePromptText(input.negative ?? settings.defaultNegative ?? ''),
    width: clampNumber(input.width ?? mappedSize.width ?? defaults.width, 128, 2048),
    height: clampNumber(input.height ?? mappedSize.height ?? defaults.height, 128, 2048),
    size: sizeName,
    requestedSteps: requestedSteps === undefined || requestedSteps === '' ? undefined : Number(requestedSteps),
    steps: clampNumber(requestedSteps, 1, maxSteps),
    scale: clampNumber(input.scale ?? defaults.scale, 1, 20),
    cfg: clampNumber(input.cfg ?? defaults.cfg, 0, 1),
    sampler: String(input.sampler || defaults.sampler || 'k_dpmpp_2m_sde'),
    noiseSchedule: String(input.noise_schedule || input.noiseSchedule || defaults.noiseSchedule || 'karras'),
    seed: input.seed === undefined || input.seed === '' ? Math.floor(Math.random() * 2 ** 31) : Number(input.seed),
    cost: input.cost === undefined || input.cost === '' ? undefined : Number(input.cost)
  };
}

function normalizePromptText(value) {
  return String(value).replace(/\\n/g, '\n');
}

function normalizeSizeName(value) {
  return String(value || '').replace(/\s*\(-\d+\)\s*$/, '').trim();
}

export async function generateNovelAiImage(request, account, env, options = {}) {
  if (!account?.token) {
    if (env.MOCK_WHEN_NO_ACCOUNT === 'false') {
      throw new Error('No enabled NovelAI account is available.');
    }
    return generateMockImage(request);
  }

  const baseUrl = (env.NOVELAI_API_URL || 'https://image.novelai.net').replace(/\/$/, '');
  const response = await novelAiFetch(`${baseUrl}/ai/generate-image`, {
    method: 'POST',
    signal: options.signal,
    headers: {
      authorization: `Bearer ${account.token}`,
      'content-type': 'application/json',
      accept: 'application/x-zip-compressed,image/png,application/json',
      origin: 'https://novelai.net',
      referer: 'https://novelai.net/',
      'user-agent': 'Mozilla/5.0 Nai2API/1.0'
    },
    body: JSON.stringify({
      action: 'generate',
      input: request.prompt,
      model: request.model,
      parameters: buildNovelAiParameters(request)
    })
  }, accountProxyUrl(account));

  const contentType = response.headers.get('content-type') || '';
  const buffer = Buffer.from(await response.arrayBuffer());

  if (!response.ok) {
    const text = buffer.toString('utf8').slice(0, 1000);
    throw new Error(`NovelAI returned ${response.status}: ${text}`);
  }

  if (contentType.includes('application/json')) {
    const payload = JSON.parse(buffer.toString('utf8'));
    const base64 = payload.image || payload.data || payload.images?.[0];
    if (!base64) throw new Error('NovelAI JSON response does not contain image data.');
    return decodeDataUrl(base64);
  }

  if (contentType.includes('zip') || looksLikeZip(buffer)) {
    return extractFirstImageFromZip(buffer);
  }

  return {
    mimeType: contentType.includes('jpeg') ? 'image/jpeg' : 'image/png',
    buffer
  };
}

export async function fetchNovelAiAccountQuota(token, env = {}, options = {}) {
  if (!token) throw new Error('NovelAI account token is required.');
  const baseUrl = (env.NOVELAI_ACCOUNT_API_URL || 'https://api.novelai.net').replace(/\/$/, '');
  const response = await novelAiFetch(`${baseUrl}/user/data`, {
    method: 'GET',
    signal: options.signal,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'application/json',
      origin: 'https://novelai.net',
      referer: 'https://novelai.net/',
      'user-agent': 'Mozilla/5.0 Nai2API/1.0'
    }
  }, normalizeSocksProxyUrl(options.proxyUrl || ''));

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`NovelAI account returned ${response.status}: ${text.slice(0, 500)}`);
  }

  const payload = text ? JSON.parse(text) : {};
  const subscription = payload.subscription || payload.account?.subscription || {};
  const stepsLeft = subscription.trainingStepsLeft || subscription.training_steps_left || {};
  const fixed = numberOrNull(
    stepsLeft.fixedTrainingStepsLeft
    ?? stepsLeft.fixed_training_steps_left
    ?? subscription.fixedTrainingStepsLeft
    ?? subscription.fixed_training_steps_left
  );
  const purchased = numberOrNull(
    stepsLeft.purchasedTrainingSteps
    ?? stepsLeft.purchased_training_steps
    ?? subscription.purchasedTrainingSteps
    ?? subscription.purchased_training_steps
  );
  const values = [fixed, purchased].filter((value) => value !== null);

  return {
    points: values.length ? values.reduce((sum, value) => sum + value, 0) : null,
    fixed,
    purchased,
    tier: subscription.tier ?? subscription.subscriptionTier ?? payload.tier ?? null,
    raw: payload
  };
}

async function novelAiFetch(url, options = {}, proxyUrl = '') {
  const normalizedProxy = normalizeSocksProxyUrl(proxyUrl);
  if (!normalizedProxy) return fetch(url, options);
  return socksFetch(url, options, normalizedProxy);
}

function accountProxyUrl(account = {}) {
  return normalizeSocksProxyUrl(account.proxyUrl || account.socksProxy || account.proxy || '');
}

function normalizeSocksProxyUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  const rawProxy = parseHostPortUserPassProxy(text);
  if (rawProxy) return rawProxy;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `socks5://${text}`;
  const normalized = withScheme.replace(/^sock5:\/\//i, 'socks5://');
  let url;
  try {
    url = new URL(normalized);
  } catch {
    throw new Error('Invalid SOCKS5 proxy URL.');
  }
  if (!['socks5:', 'socks5h:'].includes(url.protocol)) {
    throw new Error('Only socks5:// and socks5h:// proxies are supported.');
  }
  if (!url.hostname) throw new Error('SOCKS5 proxy host is required.');
  if (!url.port) url.port = '1080';
  return url.toString();
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

async function socksFetch(url, options = {}, proxyUrl = '') {
  const target = new URL(url);
  if (target.protocol !== 'https:') throw new Error('SOCKS5 proxy requests only support HTTPS targets.');
  const proxy = new URL(proxyUrl);
  const port = Number(target.port || 443);
  const tunnel = await connectSocks5(proxy, target.hostname, port, options.signal);
  const socket = await connectTls(tunnel, target.hostname, options.signal);
  try {
    const request = buildHttpRequest(target, options);
    const response = await writeAndReadHttpResponse(socket, request, options.signal);
    return response;
  } catch (error) {
    destroySocketQuietly(socket);
    throw error;
  }
}

async function connectSocks5(proxy, targetHost, targetPort, signal) {
  const socket = net.connect({
    host: proxy.hostname,
    port: Number(proxy.port || 1080)
  });
  const abort = () => destroySocketQuietly(socket);
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });

  try {
    await waitForSocket(socket, 'connect', signal);
    const username = decodeURIComponent(proxy.username || '');
    const password = decodeURIComponent(proxy.password || '');
    const methods = username || password ? [0x00, 0x02] : [0x00];
    socket.write(Buffer.from([0x05, methods.length, ...methods]));

    const greeting = await readExact(socket, 2, signal);
    if (greeting[0] !== 0x05 || greeting[1] === 0xff) throw new Error('SOCKS5 proxy rejected authentication methods.');
    if (greeting[1] === 0x02) await authenticateSocks5(socket, username, password, signal);
    if (greeting[1] !== 0x00 && greeting[1] !== 0x02) throw new Error(`SOCKS5 proxy selected unsupported auth method ${greeting[1]}.`);

    socket.write(buildSocks5ConnectRequest(targetHost, targetPort));
    const header = await readExact(socket, 4, signal);
    if (header[0] !== 0x05) throw new Error('Invalid SOCKS5 proxy response.');
    if (header[1] !== 0x00) throw new Error(`SOCKS5 proxy connect failed with code ${header[1]}.`);
    const addressLength = socks5AddressLength(header[3], socket, signal);
    await addressLength;
    signal?.removeEventListener('abort', abort);
    return socket;
  } catch (error) {
    signal?.removeEventListener('abort', abort);
    destroySocketQuietly(socket);
    throw error;
  }
}

async function authenticateSocks5(socket, username, password, signal) {
  const user = Buffer.from(username, 'utf8');
  const pass = Buffer.from(password, 'utf8');
  if (user.length > 255 || pass.length > 255) throw new Error('SOCKS5 proxy username/password is too long.');
  socket.write(Buffer.concat([
    Buffer.from([0x01, user.length]),
    user,
    Buffer.from([pass.length]),
    pass
  ]));
  const response = await readExact(socket, 2, signal);
  if (response[1] !== 0x00) throw new Error('SOCKS5 proxy authentication failed.');
}

function buildSocks5ConnectRequest(host, port) {
  const hostBuffer = Buffer.from(host, 'utf8');
  if (hostBuffer.length > 255) throw new Error('Target host is too long for SOCKS5.');
  return Buffer.concat([
    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuffer.length]),
    hostBuffer,
    Buffer.from([(port >> 8) & 0xff, port & 0xff])
  ]);
}

async function socks5AddressLength(type, socket, signal) {
  if (type === 0x01) {
    await readExact(socket, 4 + 2, signal);
    return;
  }
  if (type === 0x03) {
    const length = await readExact(socket, 1, signal);
    await readExact(socket, length[0] + 2, signal);
    return;
  }
  if (type === 0x04) {
    await readExact(socket, 16 + 2, signal);
    return;
  }
  throw new Error(`Unsupported SOCKS5 address type ${type}.`);
}

async function connectTls(tunnel, host, signal) {
  const socket = tls.connect({
    socket: tunnel,
    servername: host,
    ALPNProtocols: ['http/1.1']
  });
  await waitForSocket(socket, 'secureConnect', signal);
  return socket;
}

function buildHttpRequest(target, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const body = options.body === undefined || options.body === null ? Buffer.alloc(0) : Buffer.from(String(options.body));
  const headers = new Map();
  Object.entries(options.headers || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null) headers.set(key.toLowerCase(), String(value));
  });
  headers.set('host', target.host);
  headers.set('connection', 'close');
  if (body.length && !headers.has('content-length')) headers.set('content-length', String(body.length));

  const path = `${target.pathname || '/'}${target.search || ''}`;
  const headerLines = [`${method} ${path} HTTP/1.1`];
  headers.forEach((value, key) => headerLines.push(`${key}: ${value}`));
  return Buffer.concat([
    Buffer.from(`${headerLines.join('\r\n')}\r\n\r\n`, 'utf8'),
    body
  ]);
}

function writeAndReadHttpResponse(socket, request, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const abort = () => rejectAndClose(abortError(signal?.reason));
    const cleanup = () => {
      signal?.removeEventListener('abort', abort);
      socket.off('data', onData);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const rejectAndClose = (error) => {
      cleanup();
      destroySocketQuietly(socket);
      reject(error);
    };
    const onData = (chunk) => chunks.push(chunk);
    const onEnd = () => {
      cleanup();
      try {
        resolve(parseHttpResponse(Buffer.concat(chunks)));
      } catch (error) {
        reject(error);
      }
    };
    const onError = (error) => rejectAndClose(error);

    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
    socket.on('data', onData);
    socket.once('end', onEnd);
    socket.once('error', onError);
    socket.write(request, (error) => {
      if (error) rejectAndClose(error);
    });
  });
}

function parseHttpResponse(buffer) {
  const headerEnd = buffer.indexOf('\r\n\r\n');
  if (headerEnd < 0) {
    const preview = buffer.length ? buffer.slice(0, 80).toString('latin1').replace(/[^\x20-\x7e]/g, '.') : 'empty response';
    throw new Error(`Invalid HTTP response from NovelAI via SOCKS5 proxy: ${preview}`);
  }
  const headerText = buffer.slice(0, headerEnd).toString('latin1');
  const [statusLine, ...headerLines] = headerText.split('\r\n');
  const status = Number(statusLine.match(/^HTTP\/\d(?:\.\d)?\s+(\d+)/)?.[1] || 0);
  if (!status) throw new Error('Invalid HTTP status from NovelAI.');
  const headers = new Map();
  headerLines.forEach((line) => {
    const index = line.indexOf(':');
    if (index <= 0) return;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    headers.set(key, headers.has(key) ? `${headers.get(key)}, ${value}` : value);
  });

  let body = buffer.slice(headerEnd + 4);
  if (/chunked/i.test(headers.get('transfer-encoding') || '')) body = decodeChunkedBody(body);
  const contentLength = Number(headers.get('content-length') || 0);
  if (contentLength > 0 && body.length > contentLength) body = body.slice(0, contentLength);

  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return headers.get(String(name || '').toLowerCase()) || '';
      }
    },
    async arrayBuffer() {
      return body;
    },
    async text() {
      return body.toString('utf8');
    }
  };
}

function decodeChunkedBody(buffer) {
  const chunks = [];
  let offset = 0;
  while (offset < buffer.length) {
    const lineEnd = buffer.indexOf('\r\n', offset);
    if (lineEnd < 0) throw new Error('Invalid chunked response from NovelAI.');
    const sizeText = buffer.slice(offset, lineEnd).toString('latin1').split(';')[0].trim();
    const size = Number.parseInt(sizeText, 16);
    if (!Number.isFinite(size)) throw new Error('Invalid chunk size from NovelAI.');
    offset = lineEnd + 2;
    if (size === 0) break;
    chunks.push(buffer.slice(offset, offset + size));
    offset += size + 2;
  }
  return Buffer.concat(chunks);
}

function waitForSocket(socket, event, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      socket.off(event, onReady);
      socket.off('error', onError);
    };
    const onReady = () => {
      cleanup();
      resolve();
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      destroySocketQuietly(socket);
      reject(abortError(signal?.reason));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.once(event, onReady);
    socket.once('error', onError);
  });
}

function readExact(socket, length, signal) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort);
      socket.off('readable', onReadable);
      socket.off('end', onEnd);
      socket.off('error', onError);
    };
    const finish = () => {
      cleanup();
      resolve(Buffer.concat(chunks, length));
    };
    const onReadable = () => {
      let chunk;
      while (total < length && (chunk = socket.read(length - total)) !== null) {
        chunks.push(chunk);
        total += chunk.length;
      }
      if (total >= length) finish();
    };
    const onEnd = () => {
      cleanup();
      reject(new Error('SOCKS5 proxy closed the connection early.'));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      destroySocketQuietly(socket);
      reject(abortError(signal?.reason));
    };

    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    socket.on('readable', onReadable);
    socket.once('end', onEnd);
    socket.once('error', onError);
    onReadable();
  });
}

function abortError(reason) {
  if (reason instanceof Error) return reason;
  const error = new Error('This operation was aborted');
  error.name = 'AbortError';
  return error;
}

function destroySocketQuietly(socket) {
  if (!socket || socket.destroyed) return;
  socket.once('error', noop);
  socket.destroy();
}

function noop() {}

function buildNovelAiParameters(request) {
  if (isV4Model(request.model)) {
    return buildV4Parameters(request);
  }

  return {
    width: request.width,
    height: request.height,
    scale: request.scale,
    cfg_rescale: request.cfg,
    sampler: request.sampler,
    steps: request.steps,
    seed: request.seed,
    n_samples: 1,
    ucPreset: 0,
    qualityToggle: true,
    sm: false,
    sm_dyn: false,
    dynamic_thresholding: false,
    noise_schedule: request.noiseSchedule,
    negative_prompt: request.negative
  };
}

function buildV4Parameters(request) {
  return {
    params_version: 3,
    width: request.width,
    height: request.height,
    scale: request.scale,
    steps: request.steps,
    uncond_scale: 0,
    cfg_rescale: request.cfg,
    seed: request.seed,
    n_samples: 1,
    noise_schedule: request.noiseSchedule,
    legacy_v3_extend: false,
    reference_image_multiple: [],
    reference_information_extracted_multiple: [],
    reference_strength_multiple: [],
    v4_prompt: {
      caption: {
        base_caption: request.prompt,
        char_captions: []
      },
      use_coords: false,
      use_order: true,
      legacy_uc: false
    },
    v4_negative_prompt: {
      caption: {
        base_caption: request.negative,
        char_captions: []
      },
      use_coords: false,
      use_order: false,
      legacy_uc: false
    },
    negative_prompt: request.negative,
    uc: request.negative,
    sampler: normalizeV4Sampler(request.sampler),
    controlnet_strength: 1,
    controlnet_model: null,
    dynamic_thresholding: false,
    dynamic_thresholding_percentile: 0.999,
    dynamic_thresholding_mimic_scale: 10,
    sm: false,
    sm_dyn: false,
    skip_cfg_above_sigma: null,
    skip_cfg_below_sigma: 0,
    lora_unet_weights: null,
    lora_clip_weights: null,
    deliberate_euler_ancestral_bug: false,
    prefer_brownian: true,
    cfg_sched_eligibility: 'enable_for_post_summer_samplers',
    explike_fine_detail: false,
    minimize_sigma_inf: false,
    uncond_per_vibe: true,
    wonky_vibe_correlation: true,
    stream: 'none',
    version: 1
  };
}

function isV4Model(model) {
  return /^nai-diffusion-4/.test(String(model || ''));
}

function normalizeV4Sampler(sampler) {
  const supported = new Set([
    'k_euler',
    'k_euler_ancestral',
    'k_dpmpp_2m',
    'k_dpmpp_sde',
    'k_dpmpp_2s_ancestral'
  ]);
  return supported.has(sampler) ? sampler : 'k_euler_ancestral';
}

export function generateMockImage(request, message = 'Mock NovelAI preview') {
  const width = Number(request.width) || 832;
  const height = Number(request.height) || 1216;
  const prompt = String(request.tag || request.prompt || 'NovelAI image');
  const hue = hashString(`${prompt}:${request.seed}`) % 360;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0%" stop-color="hsl(${hue}, 86%, 78%)"/>
      <stop offset="50%" stop-color="hsl(${(hue + 55) % 360}, 90%, 86%)"/>
      <stop offset="100%" stop-color="hsl(${(hue + 175) % 360}, 82%, 78%)"/>
    </linearGradient>
  </defs>
  <rect width="100%" height="100%" fill="url(#bg)"/>
  <rect x="7%" y="68%" width="86%" height="20%" rx="24" fill="rgba(255,255,255,.78)"/>
  <text x="10%" y="75%" font-family="Arial, sans-serif" font-size="32" font-weight="700" fill="#19202a">${escapeXml(message)}</text>
  <text x="10%" y="81%" font-family="Arial, sans-serif" font-size="22" fill="#475467">${escapeXml(prompt.slice(0, 88))}</text>
  <text x="10%" y="86%" font-family="Arial, sans-serif" font-size="18" fill="#667085">${width}x${height} · seed ${escapeXml(request.seed ?? '')}</text>
</svg>`;
  return {
    mimeType: 'image/svg+xml',
    buffer: Buffer.from(svg),
    mock: true
  };
}

export function buildErrorImage(message) {
  return generateMockImage({ tag: message, width: 900, height: 480, seed: 0 }, '生成失败');
}

function extractFirstImageFromZip(buffer) {
  const entries = readZipCentralDirectory(buffer);
  for (const entry of entries) {
    const lowerName = entry.fileName.toLowerCase();
    const isImage = lowerName.endsWith('.png') || lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') || !entry.fileName.includes('.');
    if (!isImage) continue;

    if (buffer.readUInt32LE(entry.localHeaderOffset) !== 0x04034b50) continue;
    const fileNameLength = buffer.readUInt16LE(entry.localHeaderOffset + 26);
    const extraLength = buffer.readUInt16LE(entry.localHeaderOffset + 28);
    const dataStart = entry.localHeaderOffset + 30 + fileNameLength + extraLength;
    const dataEnd = dataStart + entry.compressedSize;
    const compressed = buffer.slice(dataStart, dataEnd);
    const image = entry.method === 8 ? zlib.inflateRawSync(compressed) : compressed;
    return {
      mimeType: lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg') ? 'image/jpeg' : 'image/png',
      buffer: image
    };
  }
  throw new Error('No image file found in NovelAI ZIP response.');
}

function readZipCentralDirectory(buffer) {
  const maxCommentLength = 0xffff;
  const searchStart = Math.max(0, buffer.length - maxCommentLength - 22);
  let eocdOffset = -1;
  for (let offset = buffer.length - 22; offset >= searchStart; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) {
      eocdOffset = offset;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error('ZIP end of central directory not found.');

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let offset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const fileNameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localHeaderOffset = buffer.readUInt32LE(offset + 42);
    const fileName = buffer.slice(offset + 46, offset + 46 + fileNameLength).toString('utf8');
    entries.push({ method, compressedSize, fileName, localHeaderOffset });
    offset += 46 + fileNameLength + extraLength + commentLength;
  }

  return entries;
}

function decodeDataUrl(value) {
  const text = String(value);
  const match = text.match(/^data:([^;]+);base64,(.+)$/);
  if (match) {
    return {
      mimeType: match[1],
      buffer: Buffer.from(match[2], 'base64')
    };
  }
  return {
    mimeType: 'image/png',
    buffer: Buffer.from(text, 'base64')
  };
}

function looksLikeZip(buffer) {
  return buffer.length > 4 && buffer.readUInt32LE(0) === 0x04034b50;
}

function clampNumber(value, min, max) {
  const number = Number(value);
  if (!Number.isFinite(number)) return min;
  return Math.max(min, Math.min(max, number));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function hashString(value) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash);
}
