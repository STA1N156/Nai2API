import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { JobPreviews } from '../server/job-previews.js';
import { generateNovelAiImage } from '../server/providers.js';

function response() {
  const res = new EventEmitter();
  res.messages = [];
  res.writeHead = () => {};
  res.write = (message) => { res.messages.push(message); return true; };
  res.frames = () => res.messages.filter(m => m.startsWith('data:')).map(m => JSON.parse(m.slice(6)));
  return res;
}
const job = (id, token = 'owner') => ({ id, userToken: token, status: 'running' });
const progress = (step = 1) => ({ percent: step * 3, step, total: 28, previewBuffer: Buffer.from('preview'), previewMimeType: 'image/jpeg' });

test('one connection multiplexes jobs, isolates owners, replays latest frames and cleans up', () => {
  const hub = new JobPreviews();
  const owner = response(), other = response();
  hub.subscribe('owner', owner);
  hub.subscribe('other', other);
  hub.update(job('one'), progress());
  hub.update(job('two'), progress(2));
  assert.deepEqual(owner.frames().map(f => f.jobId), ['one', 'two']);
  assert.equal(other.frames().length, 0);
  assert.ok(!JSON.stringify(owner.frames()).includes('owner'));
  const reconnect = response();
  hub.subscribe('owner', reconnect);
  assert.equal(reconnect.frames().length, 2);
  hub.clear('one'); hub.clear('two');
  assert.equal(hub.frames.size, 0);
  for (const res of [owner, other, reconnect]) res.emit('close');
  assert.equal(hub.listeners.size, 0);
});

test('preview memory is bounded to the latest frame and slow clients do not accumulate writes', () => {
  const hub = new JobPreviews(), res = response();
  hub.subscribe('owner', res);
  for (let i = 1; i <= 27; i++) hub.update(job('one'), progress(i));
  assert.equal(hub.frames.size, 1);
  assert.equal(hub.frames.get('one').progress.step, 27);
  assert.equal(res.frames().length, 1);
  res.writableNeedDrain = true;
  hub.update(job('two'), progress());
  assert.equal(res.frames().length, 1);
  hub.update(job('oversize'), { ...progress(), previewBuffer: Buffer.alloc(512 * 1024 + 1) });
  hub.update({ ...job('done'), status: 'done' }, progress());
  assert.equal(hub.frames.size, 2);
  res.emit('close');
});

// Minimal encoder for the actual msgpack event shapes returned by NovelAI.
function pack(value) {
  if (typeof value === 'number') return Buffer.from([value]);
  if (typeof value === 'string') return Buffer.concat([Buffer.from([0xa0 + value.length]), Buffer.from(value)]);
  if (Buffer.isBuffer(value)) return Buffer.concat([Buffer.from([0xc4, value.length]), value]);
  const pairs = Object.entries(value);
  return Buffer.concat([Buffer.from([0x80 + pairs.length]), ...pairs.flatMap(([key, val]) => [pack(key), pack(val)])]);
}
function frame(value) {
  const body = pack(value), length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

test('stream callbacks carry JPEG previews and real zero-based step_ix, final image stays separate', async t => {
  const preview = Buffer.from([255, 216, 255, 1]), final = Buffer.from([137, 80, 78, 71]);
  const bytes = Buffer.concat([
    frame({ event_type: 'intermediate', step_ix: 0, image: preview }),
    frame({ event_type: 'intermediate', step_ix: 8, image: preview }),
    frame({ event_type: 'final', image: final })
  ]);
  t.mock.method(globalThis, 'fetch', async () => new Response(bytes, { headers: { 'content-type': 'application/msgpack' } }));
  const events = [];
  const result = await generateNovelAiImage({ model: 'nai-diffusion-4-5-full', prompt: 'test', steps: 28 }, { token: 'test' }, {}, { forceStream: true, onProgress: p => events.push(p) });
  assert.deepEqual(events.slice(0, 2).map(p => p.step), [1, 9]);
  assert.equal(events[0].previewMimeType, 'image/jpeg');
  assert.deepEqual(events[0].previewBuffer, preview);
  assert.equal(events.at(-1).previewBuffer, undefined);
  assert.deepEqual(result.buffer, final);
});

test('ordinary JSON response reads images[0].image instead of decoding an object', async t => {
  const png = Buffer.from([137, 80, 78, 71]);
  t.mock.method(globalThis, 'fetch', async () => Response.json({ images: [{ image: png.toString('base64'), index: 0, seed: 1 }] }));
  const result = await generateNovelAiImage({ model: 'nai-diffusion-4-5-full', prompt: 'test' }, { token: 'test' }, {}, { forceStream: false });
  assert.deepEqual(result.buffer, png);
});

test('preview buffers never enter persisted progress and all terminal paths clear the preview', () => {
  const source = readFileSync(new URL('../server/index.js', import.meta.url), 'utf8');
  const snapshot = source.slice(source.indexOf('function publicProgressSnapshot('), source.indexOf('function isTimeoutResultMessage('));
  const { publicProgressSnapshot } = vm.runInNewContext(`${snapshot}; ({ publicProgressSnapshot })`, { clamp: (n, a, b) => Math.max(a, Math.min(b, n)) });
  const result = publicProgressSnapshot(progress());
  assert.deepEqual(Object.keys(result), ['percent', 'step', 'total', 'updatedAt']);
  for (const [start, end] of [
    ['async function completeGeneration(', 'async function cancelReservedJob('],
    ['async function cancelReservedJob(', 'async function failGeneration('],
    ['async function failGeneration(', 'function '],
    ['async function requeueReservedJob(', 'async function ']
  ]) {
    const from = source.indexOf(start), to = source.indexOf(end, from + start.length);
    assert.ok(from >= 0);
    assert.match(source.slice(from, to < 0 ? undefined : to), /clearJobStreamProgress\(/);
  }
});
