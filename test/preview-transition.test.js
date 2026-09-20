import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const section = (start, end) => source.slice(source.indexOf(start), source.indexOf(end));
const deferred = () => Promise.withResolvers();

function element() {
  const node = { children: [], className: '', attributes: {} };
  node.classList = {
    contains: name => node.className.split(' ').includes(name),
    add: name => { node.className += ` ${name}`; },
    remove: name => { node.className = node.className.split(' ').filter(n => n !== name).join(' '); }
  };
  node.append = child => node.children.push(child);
  node.replaceChildren = (...children) => { node.children = children; };
  node.setAttribute = (name, value) => { node.attributes[name] = value; };
  return node;
}

test('image preload waits for decode and returns the same ready-to-display image', async () => {
  const decode = deferred();
  let image;
  class Image {
    constructor() { image = this; }
    decode() { return decode.promise; }
  }
  const context = vm.createContext({ Image });
  vm.runInContext(section('function preloadImage(', 'function toggleResultZoom('), context);
  const result = context.preloadImage('/final.png');
  let ready = false;
  result.then(() => { ready = true; });
  image.onload();
  await new Promise(setImmediate);
  assert.equal(ready, false);
  decode.resolve();
  assert.equal(await result, image);
  assert.equal(image.src, '/final.png');
});

for (const index of [null, 0, 3]) {
  test(`single/batch ${index}: preview stays until decoded final image fades in, then is released`, async () => {
    const loaded = deferred(), finished = deferred(), target = element();
    target.className = 'has-generation-preview';
    const preview = element(), progress = element();
    target.children = [preview, progress];
    let duration;
    const context = vm.createContext({
      preloadImage: () => loaded.promise,
      window: { matchMedia: () => ({ matches: false }) },
      document: { createElement: () => {
        const node = element();
        node.animate = (_, options) => { duration = options.duration; return { finished: finished.promise }; };
        return node;
      } }
    });
    vm.runInContext(section('async function replaceGenerationImage(', 'function handleResultPreview('), context);
    const operation = context.replaceGenerationImage(target, '/final.png', index);
    assert.deepEqual(target.children, [preview, progress]);
    const image = element();
    loaded.resolve(image);
    await new Promise(setImmediate);
    assert.equal(target.children.length, 3);
    assert.equal(target.children[0], preview);
    assert.equal(target.children[1], progress);
    assert.equal(duration, 180);
    const button = target.children[2];
    assert.equal(button.children[0], image);
    assert.equal(button.classList.contains('from-generation-preview'), true);
    finished.resolve();
    await operation;
    assert.deepEqual(target.children, [button]);
    assert.equal(target.classList.contains('finishing-generation'), false);
    if (index !== null) assert.equal(button.children[1].textContent, String(index + 1).padStart(2, '0'));
  });
}

test('failed final image load leaves preview intact and never claims completion', async () => {
  const target = element(), preview = element();
  target.children = [preview];
  const context = vm.createContext({ preloadImage: async () => { throw new Error('load failed'); } });
  vm.runInContext(section('async function replaceGenerationImage(', 'function handleResultPreview('), context);
  await assert.rejects(context.replaceGenerationImage(target, '/bad.png'), /load failed/);
  assert.deepEqual(target.children, [preview]);
});

test('previews show bars instead of step counts and SSE updates both single and batch progress', () => {
  assert.doesNotMatch(source + css, /generation-preview-step/);
  const feed = section('function startPreviewFeed(', 'function stopPreviewFeed(');
  assert.match(feed, /setGenerationStreamProgress\(frame\.progress, true\)/);
  assert.match(feed, /updateBatchCard\(index, '', percent\)/);
  assert.match(css, /loading-state > :not\(\.generation-stream-panel\)/);
  assert.match(css, /batch-card-state > :not\(\.batch-card-progress\)/);
  assert.match(source, /await renderBatchImage\(index, job\.imageUrl\)/);
  assert.match(source, /await renderResultImage\(job\.imageUrl\)/);
});

test('waiting screens hide bars; live previews use a visible inset bar that fades with the final image', () => {
  assert.match(css, /\.image-frame:not\(\.has-generation-preview\) > \.loading-state > \.generation-stream-panel,[\s\S]*?display: none;/);
  assert.match(css, /\.batch-result-card:not\(\.has-generation-preview\) > \.batch-card-state > \.batch-card-progress,[\s\S]*?display: none;/);
  assert.match(css, /\.generation-stream-panel\[hidden\] \{\s*display: none;/);
  assert.match(css, /\.generation-stream-track,\s*\.batch-card-progress \{[^}]*height: 6px;/);
  assert.match(css, /\.has-generation-preview > \.batch-card-state \{[^}]*bottom: 14px;[^}]*background: transparent;/);
  assert.match(css, /\.finishing-generation > \.batch-card-state \{\s*opacity: 0;/);
  assert.doesNotMatch(css, /progressSweep/);
});
