import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Standalone, with no shared test/build writes or controller dependencies:
// node --test --test-reporter=tap test/hybrid-editing-id-embed.test.mjs
// Real Chromium, DOM, CM state/view and parser/resolver; only Obsidian's native
// editing-embed boundary is substituted. This is NOT native-app acceptance.
const root = fileURLToPath(new URL('../', import.meta.url));
const pluginCss = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const bundled = await build({
  absWorkingDir: root, bundle: true, platform: 'browser', format: 'iife', write: false,
  logLevel: 'warning', stdin: { resolveDir: root, loader: 'ts', contents: `
import { EditorState, StateEffect, StateField, Compartment } from '@codemirror/state';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { createHybridEditor, hybridRefresh } from './src/hybrid-editor.ts';
import { parseHybrid, indexHybrid, resolveHybrid } from './src/hybrid-core.ts';
const options = { folders: [], publicFolders: [], reservedIds: [] };
const liveMode = StateEffect.define<boolean>();
const live = StateField.define({ create: () => true, update: (value, tr) => {
  for (const effect of tr.effects) if (effect.is(liveMode)) value = effect.value;
  return value;
} });
class NativeEditingEmbed extends WidgetType {
  constructor(readonly target, readonly literal, readonly active, readonly asset, readonly nativeNote) { super(); }
  eq(other) { return this.target === other.target && this.literal === other.literal && this.active === other.active && this.asset === other.asset && this.nativeNote === other.nativeNote; }
  toDOM() {
    const wrapper = document.createElement('div'); wrapper.className = 'native-embed-boundary';
    if (this.active) {
      const raw = document.createElement('span'); raw.className = 'native-raw-source';
      raw.textContent = this.literal; wrapper.append(raw);
    }
    const el = document.createElement('div'); el.className = 'internal-embed'; el.setAttribute('src', this.target);
    if (this.asset) { el.classList.add('image-embed'); el.innerHTML = '<img width="300" height="200" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">'; }
    else if (this.nativeNote) { el.classList.add('markdown-embed', 'is-loaded'); el.innerHTML = '<div class="markdown-embed-content"><div class="markdown-preview-view"><p>Native note body</p></div></div>'; }
    else el.textContent = this.target + ' is not created yet. Click to create. (native boundary fixture)';
    wrapper.append(el); return wrapper;
  }
}
window.editingIdHarness = {
  create(source, targets, config = {}) {
    const parent = document.createElement('div'); parent.className = 'markdown-source-view mod-cm6 is-live-preview'; document.body.append(parent);
    const compartment = new Compartment(), assets = new Set(config.assets || []), nativeNotes = new Set(config.nativeNotes || []), stats = { documents: 0, resolves: 0 };
    let lastSource, lastDocument, index;
    const documents = Object.entries(targets).map(([path, text]) => parseHybrid(path, text, options));
    const parsed = state => {
      const text = state.doc.toString();
      if (text !== lastSource) { lastSource = text; lastDocument = parseHybrid('Host.md', text, options); index = indexHybrid([lastDocument, ...documents]); }
      return lastDocument;
    };
    const host = {
      document: state => { stats.documents++; return state.field(live) ? parsed(state) : null; },
      resolve: (target, path) => { stats.resolves++; return resolveHybrid(index, target, path); },
      nativeEmbed: target => assets.has(target), open() {},
      renderEmbed: (el, target) => { const result = resolveHybrid(index, target, 'Host.md'); el.textContent = result.status === 'resolved' ? result.document.source.slice(result.tree.contentFrom, result.tree.to) : result.message; }
    };
    const nativeBuild = state => {
      const ranges = [], text = state.doc.toString(), pattern = /!\\[\\[([^\\]\\n]+)\\]\\]/g;
      for (let match; (match = pattern.exec(text));) {
        const from = match.index, to = from + match[0].length, target = match[1].split('|')[0];
        const active = state.selection.ranges.some(r => r.from <= to && r.to >= from);
        // Same ranged block-point shape observed natively at the editing caret:
        // startSide=-300000001, endSide=-599999999, point=true. Not a guessed
        // highest-priority native extension or a zero-length end-of-line widget.
        ranges.push(Decoration.replace({ widget: new NativeEditingEmbed(target, match[0], active, assets.has(target), nativeNotes.has(target)), block: true, inclusiveEnd: false, side: 1 }).range(from, to));
      }
      return Decoration.set(ranges, true);
    };
    const native = StateField.define({ create: nativeBuild, update: (value, tr) => tr.docChanged || tr.selection ? nativeBuild(tr.state) : value, provide: f => EditorView.decorations.from(f) });
    const view = new EditorView({ parent, state: EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [live, native, compartment.of(createHybridEditor(host))] }) });
    const snapshot = () => ({
      source: view.state.doc.toString(), selection: view.state.selection.toJSON(),
      raw: [...view.contentDOM.querySelectorAll('.native-raw-source')].map(el => ({ text: el.textContent, display: getComputedStyle(el).display })),
      cards: [...view.contentDOM.querySelectorAll('.internal-embed')].map(el => ({ target: el.getAttribute('src'), display: getComputedStyle(el).display, classes: el.className, pos: view.posAtDOM(el) })),
      hybrid: [...view.contentDOM.querySelectorAll('.hybrid-embed')].map(el => el.textContent), stats: { ...stats }
    });
    const api = {
      view, parent, snapshot, host, parsed, stats,
      cursor: anchor => view.dispatch({ selection: { anchor } }),
      selection: (anchor, head) => view.dispatch({ selection: { anchor, head } }),
      mode: enabled => view.dispatch({ effects: [liveMode.of(enabled), hybridRefresh.of(null)] }),
      refresh: () => view.dispatch({ effects: hybridRefresh.of(null) }),
      unconfigure: () => view.dispatch({ effects: compartment.reconfigure([]) }),
      destroy: () => view.destroy(),
    };
    window.fixture = api; return snapshot();
  }
};
` },
});

async function chromiumExecutable() {
  if (process.env.HYBRID_CHROMIUM) return process.env.HYBRID_CHROMIUM;
  const cache = join(homedir(), '.cache/ms-playwright');
  const candidates = (await readdir(cache)).filter(name => name.startsWith('chromium_headless_shell-'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  for (const candidate of candidates) {
    const executable = join(cache, candidate, 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (await access(executable).then(() => true, () => false)) return executable;
  }
  assert.fail('Set HYBRID_CHROMIUM to an installed Chromium executable');
}
let browser;
before(async () => { browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true }); });
after(async () => { await browser?.close(); });
async function fixture(t, source, targets = { '博物館本文.md': '---\nforester-id: 6B4C0F\n---\n# 博物館\n\nFIRST-PARAGRAPH\n\nSECOND-PARAGRAPH\n' }, config) {
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { assert.deepEqual(errors, [], 'no browser/CM lifecycle errors'); await page.close(); });
  await page.setContent('<!doctype html><html><body></body></html>');
  await page.addStyleTag({ content: pluginCss });
  await page.addScriptTag({ content: bundled.outputFiles[0].text });
  await page.evaluate(({ source, targets, config }) => window.editingIdHarness.create(source, targets, config), { source, targets, config });
  return page;
}
async function settled(page) {
  // Flush native DOM creation, plugin coalescing and CM measurements, not sleeps
  // that guess the callback's timing or replace the real MutationObserver.
  return page.evaluate(async () => {
    for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame);
    return window.fixture.snapshot();
  });
}
const source = '# Host\n\n![[6B4C0F]]\n\nEnd';
const literal = '![[6B4C0F]]';

test('editing an existing bare-ID embed hides only the false native card and retains literal/source/caret', { timeout: 30_000 }, async t => {
  const page = await fixture(t, source);
  const before = await settled(page);
  assert.ok(before.hybrid.some(text => text.includes('FIRST-PARAGRAPH') && text.includes('SECOND-PARAGRAPH')), 'outside the literal the full target body is rendered');
  const from = source.indexOf(literal), anchor = from + 4;
  await page.evaluate(anchor => window.fixture.cursor(anchor), anchor);
  const editing = await settled(page);
  assert.equal(editing.hybrid.length, 0, 'editing deliberately removes the hybrid replacement');
  assert.equal(editing.cards.length, 1, 'native card is retained, not rewritten or removed');
  assert.equal(editing.cards[0].pos, from + literal.length, 'actual posAtDOM maps the native ranged block card to the end of this occurrence');
  assert.equal(editing.raw[0].text, literal);
  assert.notEqual(editing.raw[0].display, 'none', 'raw ID syntax remains visible for editing');
  assert.equal(editing.source, source);
  assert.deepEqual(editing.selection, { ranges: [{ anchor, head: anchor }], main: 0 });
  assert.equal(editing.cards[0].display, 'none', 'existing bare-ID target must not say it is not created yet');
  await page.evaluate(() => window.fixture.cursor(window.fixture.view.state.doc.length));
  const restored = await settled(page);
  assert.ok(restored.hybrid.some(text => text.includes('SECOND-PARAGRAPH')));
  assert.equal(restored.source, source);
});

test('late native card replacement is coalesced inside contentDOM without attribute feedback', { timeout: 30_000 }, async t => {
  const page = await fixture(t, source);
  await page.evaluate(anchor => window.fixture.cursor(anchor), source.indexOf(literal) + 4);
  const initial = await settled(page);
  assert.equal(initial.cards[0].display, 'none');
  await page.evaluate(() => {
    window.retained = window.fixture.view.contentDOM.querySelector('.internal-embed');
    const wrapper = window.retained.parentElement;
    for (let i = 0; i < 12; i++) {
      const card = document.createElement('div'); card.className = 'internal-embed'; card.setAttribute('src', '6B4C0F');
      card.textContent = 'Native async population: not created yet';
      wrapper.querySelector('.internal-embed').replaceWith(card);
    }
  });
  const replaced = await settled(page);
  assert.equal(replaced.cards.length, 1);
  assert.equal(replaced.cards[0].display, 'none', 'late native population must not bring back the false missing card');
  assert.equal(await page.evaluate(() => window.retained.classList.contains('hybrid-editing-id-embed')), false, 'detached card ownership is released');
  assert.ok(replaced.stats.documents - initial.stats.documents <= 2, 'the mutation burst is coalesced, not twelve source scans');
  const idle = await settled(page);
  assert.deepEqual(idle.stats, replaced.stats, 'owned class writes do not cause an observer feedback scan');
  await page.evaluate(() => {
    window.fixture.view.contentDOM.querySelector('.internal-embed').classList.add('native-unrelated-class');
    const foreign = document.createElement('div'); foreign.className = 'internal-embed'; foreign.setAttribute('src', '6B4C0F'); foreign.id = 'foreign'; document.body.append(foreign);
  });
  const attributeOnly = await settled(page);
  assert.deepEqual(attributeOnly.stats, idle.stats, 'neither class mutations nor other views are observed');
  assert.equal(await page.locator('#foreign').evaluate(el => el.classList.contains('hybrid-editing-id-embed')), false);
  assert.equal(replaced.source, source);
  assert.deepEqual(replaced.selection, initial.selection);
});

test('a successfully loaded native Markdown embed is never hidden even if its filename is also its tree ID', { timeout: 30_000 }, async t => {
  const page = await fixture(t, source, { '6B4C0F.md': '---\nforester-id: 6B4C0F\n---\n# Native note\n\nBody' }, { nativeNotes: ['6B4C0F'] });
  await page.evaluate(anchor => window.fixture.cursor(anchor), source.indexOf(literal) + 4);
  const editing = await settled(page);
  assert.equal(editing.cards.length, 1);
  assert.notEqual(editing.cards[0].display, 'none', 'a real native note body is not a missing-ID placeholder');
  assert.equal(await page.locator('.markdown-preview-view').textContent(), 'Native note body');
  assert.equal(editing.cards[0].classes.includes('hybrid-editing-id-embed'), false);
  assert.equal(editing.source, source);
});

test('missing and ambiguous targets retain their native missing UI while editing', { timeout: 30_000 }, async t => {
  for (const [name, targets] of [
    ['missing', {}],
    ['ambiguous ID', { 'One.md': '---\nforester-id: 6B4C0F\n---\nOne', 'Two.md': '---\nforester-id: 6B4C0F\n---\nTwo' }],
    ['ID/file collision', { 'Book.md': '---\nforester-id: 6B4C0F\n---\nOne', '6B4C0F.md': '# Different note' }],
  ]) {
    await t.test(name, async t => {
      const page = await fixture(t, source, targets);
      await page.evaluate(anchor => window.fixture.cursor(anchor), source.indexOf(literal) + 4);
      const editing = await settled(page);
      assert.equal(editing.cards.length, 1);
      assert.notEqual(editing.cards[0].display, 'none');
      assert.equal(editing.cards[0].classes.includes('hybrid-editing-id-embed'), false);
      assert.equal(editing.source, source);
    });
  }
});

test('ordinary filenames and native assets remain native-owned with their syntax and dimensions intact', { timeout: 30_000 }, async t => {
  for (const [literal, targets, config] of [
    ['![[Plain]]', { 'Plain.md': '# Ordinary Markdown\n\nNative body' }, { nativeNotes: ['Plain'] }],
    ['![[image.png|300x200]]', {}, { assets: ['image.png'] }],
    ['![[guide.pdf#page=2|400]]', {}, { assets: ['guide.pdf#page=2'] }],
    ['![[6B4C0F|300x200]]', { 'Book.md': '---\nforester-id: 6B4C0F\n---\nTree body' }, { assets: ['6B4C0F'] }],
  ]) {
    await t.test(literal, async t => {
      const text = '# Host\n\n' + literal + '\n\nEnd';
      const page = await fixture(t, text, targets, config);
      await page.evaluate(anchor => window.fixture.cursor(anchor), text.indexOf(literal) + 4);
      const editing = await settled(page);
      assert.equal(editing.cards.length, 1);
      assert.notEqual(editing.cards[0].display, 'none');
      assert.equal(editing.cards[0].classes.includes('hybrid-editing-id-embed'), false);
      assert.equal(editing.raw[0].text, literal);
      assert.equal(editing.source, text);
      if (config.assets) assert.deepEqual(await page.locator('.internal-embed img').evaluate(el => [el.getAttribute('width'), el.getAttribute('height')]), ['300', '200']);
    });
  }
});

test('protected and invalid syntax does not authorize hiding the same existing ID', { timeout: 30_000 }, async t => {
  for (const text of [
    '# Host\n\n```md\n![[6B4C0F]]\n```\n\nEnd',
    '# Host\n\n`![[6B4C0F]]`\n\nEnd',
    '# Host\n\n$$\n![[6B4C0F]]\n$$\n\nEnd',
    '# Host\n\n%%\n![[6B4C0F]]\n%%\n\nEnd',
    '# Host\n\n\\{\n![[6B4C0F]]\n}\n\nEnd',
    '---\nexample: |\n  ![[6B4C0F]]\n---\n# Host\n\nEnd',
    '---\ninvalid: [unterminated\n---\n# Host\n\n![[6B4C0F]]\n\nEnd',
    '# Host\n\n> ![[6B4C0F]]\n\nEnd',
    '# Host\n\nText ![[6B4C0F]] inline\n\nEnd',
    '# Host\n\n![[6B4C0F]] %%x%%\n\nEnd',
  ]) {
    await t.test(text.split('\n').find(line => /```|`!|\$\$|^%%|^\\\{|example:|invalid:|^>|inline|%%x%%/.test(line)), async t => {
      const page = await fixture(t, text);
      await page.evaluate(anchor => window.fixture.cursor(anchor), text.indexOf(literal) + 4);
      const editing = await settled(page);
      assert.equal(editing.cards.length, 1);
      assert.notEqual(editing.cards[0].display, 'none');
      assert.equal(editing.cards[0].classes.includes('hybrid-editing-id-embed'), false);
      assert.equal(editing.source, text);
    });
  }
});

test('ownership is occurrence-scoped rather than hiding all native cards with the same ID', { timeout: 30_000 }, async t => {
  const text = '# Host\n\n![[6B4C0F]]\n\n```md\n![[6B4C0F]]\n```\n\nEnd';
  const page = await fixture(t, text);
  await page.evaluate(anchor => window.fixture.cursor(anchor), text.indexOf(literal) + 4);
  const editing = await settled(page);
  assert.equal(editing.cards.length, 2);
  assert.deepEqual(editing.cards.map(card => card.display), ['none', 'block']);
  assert.notEqual(editing.cards[0].pos, editing.cards[1].pos);
  await page.evaluate(anchor => window.fixture.cursor(anchor), text.lastIndexOf(literal) + 4);
  const code = await settled(page);
  assert.equal(code.cards.length, 1);
  assert.notEqual(code.cards[0].display, 'none', 'the protected occurrence does not borrow permission from a matching live embed');
  assert.equal(code.source, text);
});

test('source mode and cleanup restore the retained native card and cancel scheduled work', { timeout: 30_000 }, async t => {
  const page = await fixture(t, source);
  await page.evaluate(anchor => window.fixture.cursor(anchor), source.indexOf(literal) + 4);
  const editing = await settled(page);
  assert.equal(editing.cards[0].display, 'none');
  await page.evaluate(() => { window.retained = window.fixture.view.contentDOM.querySelector('.internal-embed'); window.fixture.mode(false); });
  const mode = await settled(page);
  assert.notEqual(mode.cards[0].display, 'none');
  assert.equal(mode.cards[0].classes.includes('hybrid-editing-id-embed'), false);
  assert.equal(await page.evaluate(() => window.retained === window.fixture.view.contentDOM.querySelector('.internal-embed')), true, 'native card identity is unchanged');
  assert.equal(mode.source, source);
  assert.deepEqual(mode.selection, editing.selection);
  await page.evaluate(() => window.fixture.mode(true));
  assert.equal((await settled(page)).cards[0].display, 'none');
  await page.evaluate(() => { window.fixture.refresh(); window.fixture.unconfigure(); });
  const cleaned = await settled(page);
  assert.equal(cleaned.cards[0].classes.includes('hybrid-editing-id-embed'), false);
  assert.notEqual(cleaned.cards[0].display, 'none');
  await page.evaluate(() => window.retained.append(document.createElement('span')));
  assert.deepEqual((await settled(page)).stats, cleaned.stats, 'destroy disconnects the scoped observer and scheduled callback');
  assert.equal(cleaned.source, source);
  assert.deepEqual(cleaned.selection, editing.selection);
});

test('document edits release the old card without rewriting the edited source or caret', { timeout: 30_000 }, async t => {
  const page = await fixture(t, source);
  const from = source.indexOf(literal), anchor = from + 4;
  await page.evaluate(anchor => window.fixture.cursor(anchor), anchor);
  assert.equal((await settled(page)).cards[0].display, 'none');
  await page.evaluate(({ from, anchor }) => {
    window.retained = window.fixture.view.contentDOM.querySelector('.internal-embed');
    window.fixture.view.dispatch({ changes: { from: from + 3, to: from + 9, insert: 'ABCDEF' }, selection: { anchor } });
  }, { from, anchor });
  const edited = await settled(page);
  assert.equal(edited.cards[0].target, 'ABCDEF');
  assert.notEqual(edited.cards[0].display, 'none', 'new missing identity is visible');
  assert.equal(await page.evaluate(() => window.retained.classList.contains('hybrid-editing-id-embed')), false);
  assert.equal(edited.source, source.replace('6B4C0F', 'ABCDEF'));
  assert.deepEqual(edited.selection, { ranges: [{ anchor, head: anchor }], main: 0 });
});

test('selection ranges over a subtree ID retain anchor/head and only hide their own native card', { timeout: 30_000 }, async t => {
  const text = source.replace('6B4C0F', 'child-id');
  const page = await fixture(t, text, { 'Book.md': '# Book\n\n## Child ^child-id\n\nChild body\n\n## Other ^other-id\n\nNot child' });
  const anchor = text.indexOf('child-id'), head = anchor + 'child-id'.length;
  await page.evaluate(({ anchor, head }) => window.fixture.selection(anchor, head), { anchor, head });
  const selected = await settled(page);
  assert.equal(selected.cards[0].display, 'none');
  assert.equal(selected.source, text);
  assert.deepEqual(selected.selection, { ranges: [{ anchor, head }], main: 0 });
});

test('hybrid-rendered nested content and unmappable or wrong-position native DOM are left alone', { timeout: 30_000 }, async t => {
  const page = await fixture(t, source);
  await page.evaluate(anchor => window.fixture.cursor(anchor), source.indexOf(literal) + 4);
  assert.equal((await settled(page)).cards[0].display, 'none');
  await page.evaluate(() => {
    const wrapper = window.fixture.view.contentDOM.querySelector('.native-embed-boundary');
    wrapper.classList.add('hybrid-embed'); window.fixture.refresh();
  });
  const nested = await settled(page);
  assert.notEqual(nested.cards[0].display, 'none', 'rendered nested content is outside this native-card ownership');
  await page.evaluate(() => {
    window.fixture.view.contentDOM.querySelector('.native-embed-boundary').classList.remove('hybrid-embed');
    window.originalPosAtDOM = window.fixture.view.posAtDOM;
    window.fixture.view.posAtDOM = () => 0; window.fixture.refresh();
  });
  // snapshot uses posAtDOM as well, so a wrong position remains a scalar here.
  assert.notEqual((await settled(page)).cards[0].display, 'none');
  await page.evaluate(() => { window.fixture.view.posAtDOM = () => { throw Error('native DOM not mapped'); }; window.fixture.refresh(); });
  await page.evaluate(async () => { for (let i = 0; i < 4; i++) await new Promise(requestAnimationFrame); });
  assert.equal(await page.locator('.internal-embed').evaluate(el => el.classList.contains('hybrid-editing-id-embed')), false);
  await page.evaluate(() => { window.fixture.view.posAtDOM = window.originalPosAtDOM; window.fixture.refresh(); });
  assert.equal((await settled(page)).cards[0].display, 'none');
});

test('native-rendered ancestor content cannot borrow ownership from the selected source ID', { timeout: 30_000 }, async t => {
  const page = await fixture(t, source);
  await page.evaluate(anchor => window.fixture.cursor(anchor), source.indexOf(literal) + 4);
  assert.equal((await settled(page)).cards[0].display, 'none');
  await page.evaluate(() => {
    const wrapper = window.fixture.view.contentDOM.querySelector('.native-embed-boundary');
    wrapper.classList.add('markdown-rendered');
    window.fixture.refresh();
  });
  const nativeNested = await settled(page);
  assert.notEqual(nativeNested.cards[0].display, 'none');
  assert.equal(nativeNested.cards[0].classes.includes('hybrid-editing-id-embed'), false);
  assert.equal(nativeNested.source, source);
});

test('unrelated rendered-content mutations never request a fresh semantic display plan', { timeout: 30_000 }, async t => {
  const text = source + '\n\n```md\n![[6B4C0F]]\n```';
  const page = await fixture(t, text);
  const initial = await settled(page);
  assert.equal(initial.cards.length, 1, 'only an off-cursor protected native occurrence is visible');
  await page.evaluate(() => {
    const el = window.fixture.view.contentDOM.querySelector('.hybrid-embed');
    el.append(document.createElement('span'));
  });
  const changed = await settled(page);
  assert.deepEqual(changed.stats, initial.stats, 'the card guard must not repeat document/outline/resolver work when no selected native bare-ID literal exists');
  assert.equal(changed.source, text);
});
