import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');

test('stored image content endpoint streams files instead of buffering them', () => {
  assert.match(source, /await sendStoredImage\(res, 200, image\)/);
  assert.doesNotMatch(source, /sendImage\(res,\s*200,\s*image\.mimeType,\s*await readStoredImage\(image\)\)/);
});

test('direct cached image hits stream files instead of buffering them', () => {
  assert.match(source, /await sendStoredImage\(res, 200, cached,/);
  assert.doesNotMatch(source, /cachedBuffer\s*=\s*await readStoredImage\(cached\)/);
});

test('direct newly generated image misses stream the stored file response', () => {
  assert.match(source, /await sendStoredImage\(res, 200, result\.saved,/);
  assert.doesNotMatch(source, /image\.buffer\s*\|\|\s*image/);
});

test('direct and OpenAI jobs force NovelAI stream generation like the frontend', () => {
  const match = source.match(/function shouldUseJobStreamProgress\(job = \{\}\) \{(?<body>[\s\S]*?)\n\}/);
  assert.ok(match?.groups?.body);
  assert.match(match.groups.body, /direct/);
  assert.match(match.groups.body, /openai/);
  assert.doesNotMatch(match.groups.body, /===\s*'web'/);
});
