const promptSystemMessage = `You are a specialist at converting Chinese image requests into precise NovelAI Diffusion prompts.

OUTPUT CONTRACT
- Return exactly one line of English, comma-separated NovelAI/booru-style tags. Never return prose, headings, Markdown, Chinese, JSON or a negative-prompt section.
- For an adult NSFW scene, the first tag must be nsfw.
- Use concise visual tags, not sentences. Split compound ideas into concrete tags; for example, 月下 becomes moonlight, night.
- Describe only people, objects, clothing, background, lighting, camera framing and physical actions that are objectively visible in the requested image. Never include thoughts, memories, metaphors, plans or story exposition.
- Do not invent artist names, model settings, unrelated details or sexual content that the user did not request.

TAG PRIORITY AND ORDER
1. If this is a known copyrighted/fandom character, put the official English character tag or widely used canonical character tag first, followed immediately by its defining appearance. Never fabricate a character identity. For an original character, use original instead of its personal name.
2. Subject count and identity: 1girl, 1boy, multiple girls, species, role or archetype; include age only when visually relevant or needed to establish an adult-only explicit scene.
3. Defining appearance: hairstyle, hair color, eye color, skin, body type and distinctive accessories. These are the highest-priority consistency tags.
4. Clothing and its exact current state: garment type, material and details, whether it is intact, lifted, open, torn, partially removed or absent.
5. Main pose and action: standing, kneeling, walking, sleeping, cooking and other concrete actions.
6. Fine action and interaction details: which hand does what, contact with self, another adult, a prop or the environment; distinguish one hand from both hands and use spatially precise tags.
7. Visible expression and gaze: looking at viewer, looking away, smile, open mouth, blush, tears and other observable reactions.
8. Camera and visible body region: from above, from below, from behind, upper body, lower body, full body, close-up, between legs, dutch angle and focal emphasis.
9. Location, props, time, weather, lighting and atmosphere: bedroom, beach, indoors, morning, night, moonlight, rim lighting and other visible scene information.

CONSISTENCY RULES
- The latest explicit state in the request wins. Remove every conflicting tag instead of outputting both states.
- Adapt features to what the camera can actually see. A lower-body-only frame must omit facial expression, eye color and other invisible upper-body details. A back view must omit invisible eye details; a covered face or blindfold must omit hidden eye details.
- Convert dialogue or narrative claims into visible actions only when the request makes the action visually clear; for example, “showing underwear” becomes lifting skirt, panties.
- Preserve exact relative positions, prop locations, clothing state, lighting and interaction partners. Never swap who performs or receives an action.
- Use explicit absence tags such as no bra or no panties only when the absence is visually important and directly requested; otherwise omit the element.

WEIGHTING
- Emphasize only the most important stable traits or focal actions with NovelAI braces: {tag}, {{tag}}, {{{tag}}}. Prefer defining appearance, then action, clothing and expression. Avoid excessive weighting and never weight every tag.
- De-emphasize minor background details with [tag] or [[tag]] only when needed.
- Keep logically related tags adjacent and allocate more tags to the visual focal point than to minor background details.

For multiple characters, keep each character's appearance and actions unambiguous and adjacent. `;

export const promptApiModel = 'gemini-3.1-flash-image';

const imageRepairPrompt = `请对输入图片进行专业级 4K 修复与整体美化。输入图片是唯一的内容与风格参考。

保留原图的主题、人物身份、角色特征、服装设计、画风、色彩倾向、镜头角度、画面比例和主要构图，不要无故改变人物或故事内容。

全面检查并修复人体结构、姿势、关节、身体比例、手指、手脚、五官、头发、服饰以及物体结构错误；清除多余、缺失、融合、扭曲或互相穿透的肢体与物体。修复人物与背景粘连、物体悬空、遮挡错误、重复物体、透视错误、比例失衡、空间关系混乱、光影不统一、阴影与反射异常、材质不自然、模糊、噪点、压缩痕迹、涂抹感、断裂线条和细节缺失。

必要时允许重新绘制或重构有问题的人体、手部、面部、服装、物体和局部场景，使结构正确自然，但重构范围应尽量小。如果原场景严重混乱，可以在保留主体、画面含义和整体风格的前提下重新组织背景、道具和空间关系，提升构图、层次与观感。

将人体与背景修复列为最高优先级。人体必须符合可靠的骨架和肌肉连接关系，重点检查头身比、颈肩连接、胸腔与骨盆关系、肩胯方向、四肢长度、关节位置、手脚大小、重心、承重腿、接触点和动作受力，修正头大身小、躯干过长或过短、关节漂移、肢体粗细突变和不可能姿势。背景必须服务主体并具有清楚的前中后景，统一地平线、消失点、镜头高度、空间尺度、光源和阴影，让所有建筑、家具、道路、道具及装饰物具有合理结构、用途、摆放、支撑、接触和遮挡关系；必要时重构混乱背景，不保留没有意义的错误细节。

补充合理的纹理、材质、环境细节、光影过渡和景深，使主体与背景自然融合。避免过度锐化、塑料质感、虚假纹理和杂乱细节。保持人物面部身份、发型、发色、瞳色、服装和主要配饰一致。写实图片保持自然真实，动漫或插画保持原有画风。

消除明显的 AI 生成痕迹，让画面看起来像经过人工认真设计和修整的成品。主动清除塑料皮肤、蜡像质感、过度磨皮、假锐化、脏乱高频细节、无意义纹理、重复图案、融化结构、弯曲直线、伪文字、物体半融合、边缘光晕和局部精细度不一致。背景必须干净、和谐、有明确层次，避免元素无意义堆叠、重复、粘连和视觉噪音。头发应按头骨和发型自然生长，整理成方向明确、疏密有序的发束，修复乱线、断裂、粘连、穿插、融入背景、无来源碎发和意大利面状发丝，同时保留自然蓬松感与原有发型。

对模糊区域进行保守合理的推断，不添加无关人物、文字、标志、水印、边框或装饰。最终输出干净、自然、结构正确、视觉和谐的 4K 成品，而不是简单放大。

请先在内部分析整张图片，再完成修复。只输出修复后的图片，不输出说明、分析文字或对比图。`;

export function normalizePromptApiConfig(value = {}) {
  return {
    baseUrl: normalizePromptApiBaseUrl(value.baseUrl || ''),
    apiKey: String(value.apiKey || '').trim(),
    model: String(value.model || '').trim()
  };
}

export function publicPromptApiConfig(value = {}) {
  const config = normalizePromptApiConfig(value);
  return { configured: isPromptApiConfigured(config) };
}

export function adminPromptApiConfig(value = {}) {
  const config = normalizePromptApiConfig(value);
  return {
    baseUrl: config.baseUrl,
    model: config.model,
    configured: isPromptApiConfigured(config),
    apiKeyConfigured: Boolean(config.apiKey)
  };
}

export function isPromptApiConfigured(value = {}) {
  const config = normalizePromptApiConfig(value);
  return Boolean(config.baseUrl && config.apiKey && config.model);
}

export function normalizePromptApiBaseUrl(value = '') {
  const text = String(value || '').trim();
  if (!text) return '';
  let url;
  try {
    url = new URL(text);
  } catch {
    throw promptApiError(400, 'API 地址格式不正确');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw promptApiError(400, 'API 地址仅支持 HTTP 或 HTTPS');
  url.search = '';
  url.hash = '';
  url.pathname = url.pathname
    .replace(/\/(?:models|chat\/completions)\/?$/i, '')
    .replace(/\/+$/, '');
  return url.toString().replace(/\/$/, '');
}

export async function fetchPromptApiModels(value, options = {}) {
  const config = requirePromptApiCredentials(value);
  const payload = await requestPromptApi(`${config.baseUrl}/models`, {
    apiKey: config.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || 15_000
  });
  const source = Array.isArray(payload?.data)
    ? payload.data
    : Array.isArray(payload?.models)
      ? payload.models
      : [];
  const models = source
    .map((item) => typeof item === 'string' ? item : item?.id || item?.name)
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .filter((item, index, array) => array.indexOf(item) === index)
    .sort((a, b) => a.localeCompare(b));
  if (!models.length) throw promptApiError(502, 'API 没有返回可用模型');
  return models;
}

export async function repairImage(value, image, options = {}) {
  const config = requirePromptApiCredentials(value);
  const payload = await requestPromptApi(imageRepairEndpoint(config.baseUrl), {
    method: 'POST',
    apiKey: config.apiKey,
    fetchImpl: options.fetchImpl,
    serviceName: '图片优化 API',
    sse: true,
    timeoutMs: options.timeoutMs || 10 * 60_000,
    body: {
      contents: [{
        role: 'user',
        parts: [
          { text: imageRepairPrompt },
          { inlineData: { mimeType: image.mimeType || 'image/png', data: image.buffer.toString('base64') } }
        ]
      }],
      generationConfig: {
        candidateCount: 1,
        responseModalities: ['IMAGE'],
        imageConfig: {
          aspectRatio: imageAspectRatio(image.width, image.height),
          imageSize: '4K'
        }
      }
    }
  });
  const part = imageResponseParts(payload).find((item) => item?.inlineData?.data || item?.inline_data?.data);
  const inlineData = part?.inlineData || part?.inline_data;
  if (!inlineData?.data) throw promptApiError(502, '图片优化 API 没有返回图片');
  return {
    mimeType: inlineData.mimeType || inlineData.mime_type || 'image/png',
    buffer: Buffer.from(inlineData.data, 'base64')
  };
}

export function imageAspectRatio(width, height) {
  const ratio = Number(width || 0) / Number(height || 0);
  if (!Number.isFinite(ratio) || Math.abs(ratio - 1) < 0.08) return '1:1';
  return ratio > 1 ? '3:2' : '2:3';
}

export async function convertChinesePrompt(value, prompt, options = {}) {
  const config = normalizePromptApiConfig(value);
  if (!isPromptApiConfigured(config)) throw promptApiError(503, '管理员尚未完成提示词 API 配置');
  const input = String(prompt || '').trim();
  if (!input) throw promptApiError(400, '请输入中文画面描述');
  if (input.length > 3000) throw promptApiError(400, '中文画面描述不能超过 3000 字');
  const payload = await requestPromptApi(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    apiKey: config.apiKey,
    fetchImpl: options.fetchImpl,
    timeoutMs: options.timeoutMs || 60_000,
    body: {
      model: config.model,
      messages: [
        { role: 'system', content: promptSystemMessage },
        { role: 'user', content: input }
      ],
      temperature: 0.35,
      max_tokens: 1000,
      stream: false
    }
  });
  const content = promptApiContent(payload);
  if (!content) throw promptApiError(502, 'API 没有返回提示词');
  return content;
}

async function requestPromptApi(url, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const serviceName = options.serviceName || '提示词 API';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs || 15_000);
  try {
    const response = await fetchImpl(url, {
      method: options.method || 'GET',
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${options.apiKey}`,
        ...(options.body ? { 'content-type': 'application/json' } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    const payload = response.ok && options.sse ? parseSsePayload(text) : safeJson(text);
    if (!response.ok) {
      const detail = String(payload?.error?.message || payload?.message || '').trim();
      if (response.status === 401 || response.status === 403) throw promptApiError(502, 'API 密钥无效或没有权限');
      if (response.status === 429) throw promptApiError(502, 'API 请求过于频繁，请稍后重试');
      throw promptApiError(502, detail ? `上游 API：${detail}` : `上游 API 返回 HTTP ${response.status}`);
    }
    return payload;
  } catch (error) {
    if (error?.statusCode) throw error;
    if (error?.name === 'AbortError') throw promptApiError(504, `${serviceName} 请求超时`);
    const code = String(error?.cause?.code || error?.code || '').trim();
    throw promptApiError(502, `无法连接${serviceName}${code ? `（${code}）` : ''}`);
  } finally {
    clearTimeout(timer);
  }
}

function requirePromptApiCredentials(value = {}) {
  const config = normalizePromptApiConfig(value);
  if (!config.baseUrl) throw promptApiError(400, '请输入 API 地址');
  if (!config.apiKey) throw promptApiError(400, '请输入 API 密钥');
  return config;
}

function promptApiContent(payload = {}) {
  const content = payload?.choices?.[0]?.message?.content ?? payload?.choices?.[0]?.text ?? '';
  const text = Array.isArray(content)
    ? content.map((item) => typeof item === 'string' ? item : item?.text || '').join('')
    : String(content || '');
  return text
    .trim()
    .replace(/^```(?:\w+)?\s*/i, '')
    .replace(/\s*```$/, '')
    .replace(/^prompt\s*:\s*/i, '')
    .replace(/^(["'])|(["'])$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function imageRepairEndpoint(baseUrl) {
  const url = new URL(baseUrl);
  return `${url.origin}/v1beta/models/${encodeURIComponent(promptApiModel)}:streamGenerateContent?alt=sse`;
}

function imageResponseParts(payload = {}) {
  const response = payload.response || payload;
  return response?.candidates?.[0]?.content?.parts || [];
}

function parseSsePayload(text) {
  const parts = String(text || '')
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => safeJson(line.slice(5).trim()))
    .flatMap((payload) => payload?.candidates?.[0]?.content?.parts || []);
  if (!parts.length) throw promptApiError(502, '图片含有NSFW内容，无法重构');
  return { candidates: [{ content: { parts } }] };
}

function safeJson(text) {
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw promptApiError(502, '上游 API 返回了无效数据');
  }
}

function promptApiError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
