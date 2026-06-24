import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const indexSource = await readFile(new URL('../server/index.js', import.meta.url), 'utf8');

test('memory diagnostics exposes process and cgroup memory fields', () => {
  assert.match(indexSource, /url\.pathname === '\/memory'/);
  assert.match(indexSource, /process\.memoryUsage\(\)/);
  assert.match(indexSource, /readCgroupMemory\(/);
  assert.match(indexSource, /jobWaiters/);
  assert.match(indexSource, /jobStreamProgress/);
});
