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
