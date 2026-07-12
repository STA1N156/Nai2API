import assert from 'node:assert/strict';
import test from 'node:test';
import { convertChinesePrompt, fetchPromptApiModels, imageAspectRatio, normalizePromptApiBaseUrl, promptApiModel, publicPromptApiConfig, repairImage } from '../server/prompt-api.js';
import { normalizeDb } from '../server/store.js';

test('normalizes prompt API settings without exposing the API key publicly', () => {
  assert.equal(normalizePromptApiBaseUrl('https://api.example.com/v1/chat/completions'), 'https://api.example.com/v1');
  assert.deepEqual(publicPromptApiConfig({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret', model: 'model-a' }), { configured: true });
  assert.deepEqual(normalizeDb({ settings: { promptApi: { baseUrl: 'https://api.example.com/v1' } } }).settings.promptApi, {
    baseUrl: 'https://api.example.com/v1',
    apiKey: '',
    model: ''
  });
});

test('fetches and sorts OpenAI-compatible model ids', async () => {
  const models = await fetchPromptApiModels({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret' }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.example.com/v1/models');
      assert.equal(options.headers.authorization, 'Bearer secret');
      return new Response(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }] }), { status: 200 });
    }
  });
  assert.deepEqual(models, ['model-a', 'model-b']);
});

test('builds a 4K image repair request with the source orientation', async () => {
  const output = Buffer.from('repaired image');
  const image = await repairImage({ baseUrl: 'https://api.example.com/v1', apiKey: 'secret' }, {
    buffer: Buffer.from('source image'),
    mimeType: 'image/png',
    width: 832,
    height: 1216
  }, {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.example.com/v1beta/models/gemini-3.1-flash-image:streamGenerateContent?alt=sse');
      assert.equal(options.headers.authorization, 'Bearer secret');
      const body = JSON.parse(options.body);
      assert.equal(body.generationConfig.imageConfig.aspectRatio, '2:3');
      assert.equal(body.generationConfig.imageConfig.imageSize, '4K');
      assert.match(body.contents[0].parts[0].text, /肢体与物体/);
      assert.equal(body.contents[0].parts[1].inlineData.data, Buffer.from('source image').toString('base64'));
      return new Response(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/png', data: output.toString('base64') } }] } }] })}\n\n`, {
        status: 200,
        headers: { 'content-type': 'text/event-stream' }
      });
    }
  });
  assert.equal(image.buffer.toString(), output.toString());
  assert.equal(imageAspectRatio(1600, 1088), '3:2');
  assert.equal(imageAspectRatio(1024, 1024), '1:1');
});

test('converts Chinese descriptions and strips response wrappers', async () => {
  const prompt = await convertChinesePrompt({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'secret',
    model: 'model-a'
  }, '雨夜街道上的银发少女', {
    fetchImpl: async (url, options) => {
      assert.equal(url, 'https://api.example.com/v1/chat/completions');
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'model-a');
      assert.equal(body.messages[1].content, '雨夜街道上的银发少女');
      assert.match(body.messages[0].content, /official English character tag/);
      assert.match(body.messages[0].content, /camera can actually see/);
      assert.match(body.messages[0].content, /\{\{\{tag\}\}\}/);
      assert.match(body.messages[0].content, /first tag must be nsfw/);
      return new Response(JSON.stringify({
        choices: [{ message: { content: '```text\n1girl, silver hair, rainy night, neon street\n```' } }]
      }), { status: 200 });
    }
  });
  assert.equal(prompt, '1girl, silver hair, rainy night, neon street');
});
