import zlib from 'node:zlib';

export const MAX_STEPS = 50;
export const DIRECT_URL_MAX_STEPS = 28;

export const sizeMap = {
  '竖图': { width: 832, height: 1216 },
  '横图': { width: 1216, height: 832 },
  '方图': { width: 1024, height: 1024 }
};

export function normalizeNovelAiRequest(input, settings, options = {}) {
  const defaults = settings.defaults || {};
  const maxSteps = Number.isFinite(Number(options.maxSteps)) ? Number(options.maxSteps) : MAX_STEPS;
  const sizeName = String(input.size || defaults.size || '竖图');
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
    seed: input.seed === undefined || input.seed === '' ? Math.floor(Math.random() * 2 ** 31) : Number(input.seed)
  };
}

function normalizePromptText(value) {
  return String(value).replace(/\\n/g, '\n');
}

export async function generateNovelAiImage(request, account, env, options = {}) {
  if (!account?.token) {
    if (env.MOCK_WHEN_NO_ACCOUNT === 'false') {
      throw new Error('No enabled NovelAI account is available.');
    }
    return generateMockImage(request);
  }

  const baseUrl = (env.NOVELAI_API_URL || 'https://image.novelai.net').replace(/\/$/, '');
  const response = await fetch(`${baseUrl}/ai/generate-image`, {
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
  });

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
    'k_dpmpp_2s_ancestral',
    'ddim_v3'
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
