import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/styles.css', import.meta.url), 'utf8');
const keys = ['steps', 'sampler', 'scale', 'cfg'];
const section = (start, end) => app.slice(app.indexOf(start), app.indexOf(end));

test('four labelled help buttons share an accessible native dialog without changing generation inputs', () => {
  assert.equal((html.match(/data-parameter-help=/g) || []).length, 4);
  for (const key of keys) {
    assert.match(html, new RegExp(`for="${key}Input"`));
    assert.match(html, new RegExp(`data-parameter-help="${key}"[^>]*aria-label="[^"]+"[^>]*aria-haspopup="dialog"`));
  }
  assert.match(html, /<dialog id="parameterHelpDialog"[^>]*aria-labelledby="parameterHelpTitle"[^>]*aria-describedby="parameterHelpText">/);
  assert.match(html, /<form method="dialog">/);
  assert.doesNotMatch(css, /\.advanced-prompts label:last-child/);
  assert.match(css, /\.advanced-prompts > label:last-child/);
  assert.match(css, /\.parameter-grid \{ align-items: start;/);
  assert.match(css, /\.parameter-grid input, \.parameter-grid \.custom-select-button \{ height: 44px;/);
});

test('help buttons show the matching explanation and outside clicks close only the help dialog', () => {
  const buttons = keys.map(key => ({ dataset: { parameterHelp: key }, addEventListener(event, listener) { this[event] = listener; } }));
  const dialog = {
    open: false,
    showModal() { this.open = true; }, close() { this.open = false; },
    getBoundingClientRect: () => ({ left: 100, right: 500, top: 100, bottom: 400 }),
    addEventListener(event, listener) { this[event] = listener; }
  };
  const el = { parameterHelpDialog: dialog, parameterHelpTitle: {}, parameterHelpText: {}, parameterHelpSource: {} };
  vm.runInNewContext(`${section('const parameterHelp =', 'await boot().catch')}
    ${section('function bindEvents() {', "  el.saveTokenBtn.addEventListener")} }
    bindEvents();`, { el, document: { querySelectorAll: () => buttons } });
  for (const button of buttons) {
    button.click();
    assert.equal(dialog.open, true);
    assert.ok(el.parameterHelpTitle.textContent.length > 0);
    assert.ok(el.parameterHelpText.textContent.length > 30);
    assert.ok(el.parameterHelpSource.href.startsWith('https://docs.novelai.net/'));
    dialog.click({ target: dialog, clientX: 200, clientY: 200 });
    assert.equal(dialog.open, true);
    dialog.click({ target: dialog, clientX: 50, clientY: 200 });
    assert.equal(dialog.open, false);
  }
  assert.match(el.parameterHelpText.textContent, /CFG Rescale/);
  assert.match(el.parameterHelpText.textContent, /和提示词引导强度不是同一个参数/);
});

test('Chinese parameter names and the requested steps explanation are consistent', () => {
  const help = vm.runInNewContext(`${section('const parameterHelp =', 'await boot().catch')}; parameterHelp;`);
  for (const [key, name] of [['scale', '提示词引导强度'], ['cfg', '引导重缩放']]) {
    assert.match(html, new RegExp(`<label for="${key}Input">${name}</label>`));
    assert.match(html, new RegExp(`aria-label="${name}说明"`));
    assert.equal(help[key].title, name);
  }
  assert.equal(help.steps.text, '模型逐步完成图片的迭代次数，更多步数通常需要更久，花费更多，高步数可能会提升画面精细程度，也可能适得其反。\n\n支持 1–50 步，超过 28 步会进入更高的扣费档位，具体点数以“生成图片”按钮显示为准。');
  assert.match(css, /\.parameter-help-button \{[^}]*width: 20px; min-height: 20px;/);
  const mobile = css.slice(css.indexOf('@media (max-width: 820px)'), css.indexOf('@media (max-width: 560px)'));
  assert.match(mobile, /scrollbar-width: none !important/);
  assert.match(mobile, /\*::-webkit-scrollbar \{\s*display: none;/);
  assert.doesNotMatch(mobile, /overflow(?:-y)?:\s*(?:hidden|clip)/);
});
