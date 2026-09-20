import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));
const syncFunction = section('function updateParameterValue(', 'function openPromptConvert(');
const keys = ['steps', 'scale', 'cfg'];

test('parameter sliders retain their ranges, defaults and visible numeric values', () => {
  const limits = { steps: [1, 50, 1, 28], scale: [1, 20, 0.5, 6], cfg: [0, 1, 0.1, 0] };
  for (const key of keys) {
    const [min, max, step, value] = limits[key];
    const input = html.match(new RegExp(`<input id="${key}Input"[^>]+>`))?.[0];
    assert.ok(input);
    for (const [name, expected] of Object.entries({ type: 'range', min, max, step, value })) {
      assert.ok(input.includes(`${name}="${expected}"`));
    }
    assert.match(html, new RegExp(`<output for="${key}Input"[^>]*>${value}</output>`));
  }
});

test('dragging updates numeric readouts and prices immediately without changing other parameters', () => {
  const el = Object.fromEntries(keys.map(key => [`${key}Input`, {
    value: '', nextElementSibling: {}, addEventListener(event, listener) { this[event] = listener; }
  }]));
  let priceUpdates = 0;
  let sizeUpdates = 0;
  vm.runInNewContext(`${syncFunction}
    ${section('  [el.stepsInput, el.scaleInput, el.cfgInput].forEach(input =>', "  el.artistPresetInput.addEventListener")}`, {
    el,
    populateSizeOptions: () => { sizeUpdates++; },
    updateUrlOutputs: () => { priceUpdates++; }
  });
  for (const value of ['1', '28', '29', '35', '36', '45', '46', '50']) {
    el.stepsInput.value = value;
    el.stepsInput.input();
    assert.equal(el.stepsInput.nextElementSibling.value, value);
  }
  assert.equal(sizeUpdates, 8);
  for (const [key, value] of [['scale', '7.5'], ['cfg', '0.6']]) {
    el[`${key}Input`].value = value;
    el[`${key}Input`].input();
    assert.equal(el[`${key}Input`].nextElementSibling.value, value);
  }
  assert.equal(sizeUpdates, 8);
  assert.equal(priceUpdates, 10);
  assert.equal(el.stepsInput.value, '50');
});

test('server defaults are reflected in all slider readouts on page load', () => {
  const inputNames = [...keys.map(key => `${key}Input`), 'modelInput', 'artistInput', 'negativeInput', 'samplerInput', 'sizeInput'];
  const el = Object.fromEntries(inputNames.map(key => [key, { value: '', nextElementSibling: {} }]));
  vm.runInNewContext(`${syncFunction}
    ${section('function applyDefaults()', 'async function saveToken()')}
    applyDefaults();`, {
    el, state: { settings: { defaults: { steps: 48, scale: 7.5, cfg: 0.6 } } },
    defaultSteps: 28, normalizeSteps: Number,
    artistPresets: { '2.5d': { value: 'test' } },
    syncArtistPresetSelection() {}, populateSizeOptions() {}
  });
  for (const key of keys) assert.equal(el[`${key}Input`].nextElementSibling.value, el[`${key}Input`].value);
});
