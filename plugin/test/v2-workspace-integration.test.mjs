import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { HybridController } from './build/v2-workspace-controller.mjs';
import ForesterPlugin from './build/v2-workspace/main.mjs';
import { ForesterSettingTab } from './build/v2-workspace/settings.mjs';
import { createHarness, document, window, notices, modals, TFile } from './controller-obsidian-mock.mjs';
const options = (excludedFolders = []) => ({ folders: [], excludedFolders, publicFolders: [], reservedIds: [] });
const drain = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
async function setup(entries, excludedFolders = []) {
  const h = createHarness(entries, options(excludedFolders));
  const controller = new HybridController(h.plugin, h.getter); await controller.initialize();
  return { h, c: controller };
}

test('controller treats legacy forester-mode values as metadata, not an adapter activation override', async () => {
  const { h, c } = await setup({ 'Page.md': '---\nforester-mode: hybrid-v0\n---\n# Page\n' });
  h.open('Page.md');
  assert.equal(c.currentIndex().documents.get('Page.md').enabled, true);
  h.plugin.unload();
});

test('configuration snapshots clone excluded folders and include them in the cache identity', async () => {
  const h = createHarness({}, options(['Ignored']));
  const c = new HybridController(h.plugin, h.getter);
  const first = c.configuration();
  assert.deepEqual(first.options.excludedFolders, ['Ignored']);
  h.options.excludedFolders.push('More');
  assert.deepEqual(first.options.excludedFolders, ['Ignored']);
  assert.notEqual(c.configuration().key, first.key);
  h.plugin.unload();
});

test('default-on entrypoint never starts a body observer or reactivates excluded notes through legacy paths', async () => {
  const h = createHarness({ 'Ignored/Native.md': '# Native\n\n## Section\nBody\n<!-- id -->' }, options(['Ignored']));
  let observers = 0;
  globalThis.MutationObserver = class { constructor() { observers++; } observe() {} disconnect() {} };
  const plugin = new ForesterPlugin(h.app);
  plugin.loadData = async () => ({ hybrid: options(['Ignored']), mintOnSave: 'notes' });
  const originalSave = h.app.commands.commands['editor:save-file'].callback;
  await plugin.onload();
  assert.equal(observers, 0, 'hybrid rendering is scoped; no legacy body-wide scans');
  assert.equal(h.app.commands.commands['editor:save-file'].callback, originalSave, 'no second save wrapper');
  const view = h.open('Ignored/Native.md');
  await plugin.commands.get('mint-subtree-address').editorCallback(view.editor, view);
  await plugin.commands.get('mint-note-address').editorCallback(view.editor, view);
  await plugin.lintActiveNote('notes');
  await plugin.retargetVault();
  const section = document.createElement('section'); section.innerHTML = '<h2>Section</h2>';
  for (const process of plugin.postprocessors) await process(section, h.context('Ignored/Native.md', 2, 3));
  assert.equal(h.vault.processes.length, 0);
  assert.equal(section.querySelector('[data-forester], [data-hybrid-heading]'), null);
  plugin.unload();
});

test('settings expose exclusion scope rather than opt-in folders and keep publication separate', () => {
  const h = createHarness(); const plugin = new ForesterPlugin(h.app);
  const tab = new ForesterSettingTab(h.app, plugin); tab.display();
  assert.match(tab.containerEl.textContent, /Hybrid Markdown/);
  assert.ok(!tab.containerEl.textContent.includes('opt-in'));
  const names = [...tab.containerEl.querySelectorAll('[data-setting-name]')].map(el => el.getAttribute('data-setting-name'));
  assert.ok(names.includes('Excluded folders')); assert.ok(!names.includes('Hybrid folders'));
  assert.ok(names.includes('Public folders')); assert.ok(names.includes('Reserved IDs'));
  assert.ok(!names.includes('Alphabet') && !names.includes('What it mints'), 'legacy policies must not pretend to control the fixed hybrid ID scheme');
  assert.ok(tab.containerEl.textContent.includes('No automatic upload'));
  plugin.unload(); h.plugin.unload();
});

test('sidebar follows an explicit tree page per Markdown leaf, never cursor or sidebar focus', async () => {
  const page = '# Page\n\n## Part ^part-id\nText\n\n### Child ^child-id\nMore';
  const { h, c } = await setup({ 'Page.md': page, 'Other.md': '# Other' });
  const view = h.open('Page.md');
  assert.equal(typeof c.current, 'function', 'real controller exposes sidebar context');
  assert.equal(c.current().tree.level, 1);
  view.editor.setCursor({ line: 3, ch: 0 }); assert.equal(c.current().tree.level, 1);
  const tree = c.currentIndex().ids.get('part-id')[0];
  await c.openTree(tree, false);
  assert.equal(h.workspace.opens.at(-1)[0], 'Page.md#^part-id');
  assert.equal(c.current().tree.id, 'part-id');
  assert.deepEqual(c.outline(c.current().document, c.current().tree).map(e => e.title), ['Child']);
  h.workspace.active = { sidebar: true }; await h.workspace.emit('active-leaf-change', { view: h.workspace.active });
  assert.equal(c.current().tree.id, 'part-id', 'sidebar has not discarded viewed tree');
  const other = h.open('Other.md'); await h.workspace.emit('active-leaf-change', { view: other });
  assert.equal(c.current().tree.meta.title, 'Other');
  h.workspace.active = view; await h.workspace.emit('active-leaf-change', { view });
  assert.equal(c.current().tree.id, 'part-id', 'independent leaf page contexts are retained');
  h.plugin.unload();
});

test('real controller installs input and all four sidebars and coalesces graph updates after refresh', async () => {
  const entries = { 'Page.md': '# Page\n\n[[friend-id]]\n\n## Part ^part-id\n[[ref-id]]', 'Friend.md': '---\nforester-id: friend-id\n---\n# Friend', 'Ref.md': '---\nforester-id: ref-id\ntaxon: Reference\n---\n# Ref' };
  const { h, c } = await setup(entries); h.open('Page.md');
  assert.ok(h.plugin.suggesters.length >= 1, 'input is registered during initialize');
  for (const type of ['forester-toc', 'forester-backlinks', 'forester-related', 'forester-references']) assert.ok(h.plugin.views.has(type), type);
  let updates = 0; const unsubscribe = c.subscribe(() => updates++);
  const root = c.current().tree;
  assert.deepEqual(c.relations(root).related.map(t => t.id), ['friend-id']);
  assert.deepEqual(c.relations(root).references.map(t => t.id), ['ref-id']);
  const graph = c.relationGraph; c.relations(root); assert.equal(c.relationGraph, graph, 'same index reuses relation graph');
  await c.refresh(); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(updates, 0, 'unchanged index does not redraw sidebar');
  const changed = entries['Friend.md'] + '\n[[Page]]'; h.vault.data.set('Friend.md', changed);
  await Promise.all([h.app.metadataCache.emit('changed', h.vault.files.get('Friend.md'), changed), h.workspace.emit('active-leaf-change', { view: h.workspace.active }), h.workspace.emit('file-open', h.workspace.active.file)]);
  await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(updates, 1);
  assert.deepEqual(c.relations(root).backlinks.map(t => t.id), ['friend-id']);
  assert.notEqual(c.relationGraph, graph, 'new source index invalidates relation snapshot');
  unsubscribe(); await h.workspace.emit('file-open', h.workspace.active.file); await new Promise(resolve => setTimeout(resolve, 5)); assert.equal(updates, 1);
  h.plugin.unload();
});

test('TOC title focus uses real Reading placements, including repeated embeds, without opening definitions', async () => {
  const page = '# Page\n\n![[part-id]]\n\n![[part-id]]\n\n## Own ^own-id\nText';
  const book = '# Book\n\n## Part ^part-id\nBody\n\n### Child ^child-id\nText';
  const { h, c } = await setup({ 'Page.md': page, 'Book.md': book });
  const view = h.open('Page.md'); view.mode = 'preview';
  h.app.renderOverride = async (source, el) => { el.innerHTML = source.replace(/^### (.+)$/gm, '<details><h3>$1</h3></details>'); };
  const section = document.createElement('section'); section.innerHTML = '<div class="internal-embed" src="part-id"></div><div class="internal-embed" src="part-id"></div><details><h2>Own</h2></details>';
  view.containerEl.append(section);
  await h.plugin.postprocessors[0](section, h.context('Page.md', 2, 7)); await drain();
  const entries = c.outline(c.current().document, c.current().tree);
  assert.notEqual(entries[0].occurrenceKey, entries[1].occurrenceKey);
  assert.equal(typeof c.focusOccurrence, 'function', 'real local-page adapter is available');
  const scrolled = []; window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  await c.focusOccurrence(entries[1]);
  const wrappers = section.querySelectorAll('.hybrid-embed');
  assert.ok(wrappers[1].contains(scrolled.at(-1)) || scrolled.at(-1) === wrappers[1], 'focus second placement, not first ID match');
  await c.focusOccurrence(entries[1].children[0]);
  assert.ok(wrappers[1].contains(scrolled.at(-1))); assert.equal(scrolled.at(-1).tagName, 'H3');
  assert.ok(scrolled.at(-1).parentElement.hasAttribute('open'), 'unfold section ancestors');
  await c.focusOccurrence(entries[2]); assert.equal(scrolled.at(-1).tagName, 'H2');
  assert.equal(h.workspace.opens.length, 0); assert.equal(c.current().tree.level, 1, 'TOC focus is not a new tree page');
  view.mode = 'source'; await c.focusOccurrence(entries[2]); assert.deepEqual(view.editor.getCursor(), { line: 6, ch: 0 });
  assert.equal(h.workspace.opens.length, 0); assert.equal(c.current().tree.level, 1);
  h.plugin.unload();
});

test('input replacement is committed through guarded disk/editor snapshots with safe semantic labels', async () => {
  const source = '# Page\n\n## Own\nText\n\n/transclude';
  const book = '---\nforester-id: book-id\ntitle: "A | B ] ` $ % { < C"\n---\n# Book';
  const { h, c } = await setup({ 'Page.md': source, 'Book.md': book }); const view = h.open('Page.md');
  view.editor.setCursor({ line: 5, ch: 11 }); const tree = c.currentIndex().ids.get('book-id')[0];
  assert.equal(typeof c.insertTarget, 'function', 'real input host adapter is available');
  await c.insertTarget(view.editor, view.file, tree, false, { from: { line: 5, ch: 0 }, to: { line: 5, ch: 11 }, before: source });
  const after = h.vault.data.get('Page.md');
  assert.equal(view.editor.getValue(), after); assert.ok(!after.includes('/transclude'));
  assert.match(after, /## Own \^[A-F0-9]{6}/);
  assert.ok(after.includes('[[book-id|A &#124; B &#93; &#96; &#36; &#37; &#123; &lt; C]]'));
  assert.ok(view.editor.replacements.every(r => r.end - r.start < source.length), 'minimal undoable source patch');
  assert.equal(h.vault.data.get('Book.md'), book, 'identified targets need no write');
  h.plugin.unload();
});

test('input can mint an unaddressed target root and self-subtree without committing prospective slash text', async () => {
  for (const self of [false, true]) {
    const source = '# Page\n\n## Own\nText\n\n/transclude'; const book = '# Book\n\nBody';
    const { h, c } = await setup({ 'Page.md': source, 'Book.md': book }); const view = h.open('Page.md');
    const index = c.currentIndex(); const target = self ? index.documents.get('Page.md').trees[1] : index.documents.get('Book.md').root;
    await c.insertTarget(view.editor, view.file, target, true, { from: { line: 5, ch: 0 }, to: { line: 5, ch: 11 }, before: source });
    const targetAfter = c.currentIndex().documents.get(self ? 'Page.md' : 'Book.md');
    const id = self ? targetAfter.trees[1].id : targetAfter.root.id;
    assert.match(id ?? '', /^[0-9A-F]{6}$/); assert.ok(!/^\d{6}$/.test(id));
    assert.ok(h.vault.data.get('Page.md').includes(`![[${id}]]`));
    assert.equal(view.editor.getValue(), h.vault.data.get('Page.md'));
    assert.ok(!h.vault.data.get('Page.md').includes('/transclude'));
    if (!self) assert.equal(h.vault.processes[0], 'Book.md', 'target identity exists before source reference');
    h.plugin.unload();
  }
});

test('input refuses a selected target changed on disk or a new ID/file ambiguity during native I/O', async () => {
  for (const scenario of ['edited-target', 'new-ambiguity', 'existing-file-ambiguity']) {
    const source = '# Page\n\n/transclude'; const book = '---\nforester-id: book-id\n---\n# Book';
    const { h, c } = await setup({ 'Page.md': source, 'Book.md': book, 'Other.md': '# Other' }); const view = h.open('Page.md');
    const target = c.currentIndex().ids.get('book-id')[0];
    if (scenario === 'edited-target') h.vault.data.set('Book.md', book.replace('book-id', 'new-id'));
    else if (scenario === 'existing-file-ambiguity') h.vault.beforeProcess = async () => { const changed = '---\naliases: [book-id]\n---\n# Other'; h.vault.data.set('Other.md', changed); await h.app.metadataCache.emit('changed', h.vault.files.get('Other.md'), changed); };
    else h.vault.beforeProcess = async () => { if (!h.vault.files.has('book-id.md')) { const file = new TFile('book-id.md'); h.vault.files.set(file.path, file); h.vault.data.set(file.path, '# Collision'); await h.vault.emit('create', file); } };
    await c.insertTarget(view.editor, view.file, target, true, { from: { line: 2, ch: 0 }, to: { line: 2, ch: 11 }, before: source });
    assert.equal(h.vault.data.get('Page.md'), source, scenario); assert.equal(view.editor.getValue(), source, scenario);
    h.plugin.unload();
  }
});

test('native ID commands preserve their IDs and mint cursor-owned trees through the real controller', async () => {
  const source = '# Page\n\n## First\nText\n\n## Second\nMore';
  const h = createHarness({ 'Page.md': source }, options()); const plugin = new ForesterPlugin(h.app); await plugin.onload();
  const view = h.open('Page.md'); view.editor.setCursor({ line: 6, ch: 1 });
  await plugin.commands.get('mint-subtree-address').editorCallback(view.editor, view);
  const after = h.vault.data.get('Page.md');
  assert.match(after, /## Second \^[0-9A-F]{6}/); assert.match(after, /## First \^[0-9A-F]{6}/);
  assert.equal(view.editor.getValue(), after); assert.ok(!after.includes('forester-id:'), 'subtrees do not force an otherwise unnecessary root ID');
  await plugin.commands.get('mint-note-address').editorCallback(view.editor, view);
  const root = plugin.hybridController.currentIndex().documents.get('Page.md').root;
  assert.match(root.id ?? '', /^[0-9A-F]{6}$/); assert.ok(!/^\d{6}$/.test(root.id));
  assert.equal(view.editor.getValue(), h.vault.data.get('Page.md'));
  const count = h.vault.processes.length; await plugin.commands.get('mint-note-address').editorCallback(view.editor, view); assert.equal(h.vault.processes.length, count, 'existing identity is preserved');
  plugin.unload(); h.plugin.unload();
});

test('bare-ID navigation changes the tree page while actual inline TOC widget titles only focus locally', async () => {
  const page = '# Page\n\n## Part ^part-id\nText\n\n### Child ^child-id\nMore';
  const { h, c } = await setup({ 'Page.md': page }); const view = h.open('Page.md');
  const state = view.editor.attach(h.plugin.extensions); const dom = document.createElement('div');
  let toc;
  for (const ds of state.facet((await import('@codemirror/view')).EditorView.decorations)) if (typeof ds.between === 'function') ds.between(0, state.doc.length, (_f, _t, d) => { if (d.spec.widget?.entries) toc = d.spec.widget; });
  dom.append(toc.toDOM()); view.containerEl.append(dom);
  const native = { dom, state, posAtDOM: () => page.indexOf('## Part') };
  let capture; const add = dom.addEventListener.bind(dom);
  dom.addEventListener = (type, listener, options) => { if (type === 'click' && options === true) capture = listener; add(type, listener, options); };
  const lifecycle = h.plugin.extensions[0][1].create(native);
  // linkedom does not implement parent-before-target capture ordering. Deliver
  // the native CM capture event at that boundary; adapter/parser/focus are real.
  const event = new window.Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: dom.querySelector('.hybrid-toc a') });
  capture(event); await drain();
  assert.equal(h.workspace.opens.length, 0, 'actual inline TOC capture prevents definition navigation');
  assert.equal(c.current().tree.level, 1); assert.equal(view.editor.getCursor().line, 2);
  c.open('part-id', 'Page.md'); await drain(); assert.equal(c.current().tree.id, 'part-id', 'ID links select a new tree page');
  lifecycle.destroy(); h.plugin.unload();
});

test('manual root mint preserves BOM/frontmatter and root ID type in the real adapter', async () => {
  const source = '\uFEFF---\r\ntitle: Existing\r\n---\r\n# Page\r\nBody';
  const { h, c } = await setup({ 'Page.md': source }); const view = h.open('Page.md');
  await c.mintNoteAddress(view.editor, view.file);
  const after = h.vault.data.get('Page.md');
  assert.ok(after.startsWith('\uFEFF---\r\n'), 'BOM remains at the beginning of YAML');
  assert.ok(after.endsWith('# Page\r\nBody')); assert.equal(c.currentIndex().documents.get('Page.md').frontmatter.title, 'Existing');
  assert.equal(typeof c.currentIndex().documents.get('Page.md').root.id, 'string');
  h.plugin.unload();
});



test('the real slash picker mints a root and replaces its captured input only after native CAS', async () => {
  const source = '# Page\n\n/link', { h, c } = await setup({ 'Page.md': source, 'Book.md': '# Book\n\nBody' }); const view = h.open('Page.md');
  view.editor.setCursor({ line: 2, ch: 5 });
  const suggest = h.plugin.suggesters[0], trigger = suggest.onTrigger(view.editor.getCursor(), view.editor, view.file);
  assert.ok(trigger); const context = { ...trigger, editor: view.editor, file: view.file }; suggest.context = context;
  const choice = suggest.getSuggestions(context).find(choice => choice.command === 'link'); suggest.selectSuggestion(choice);
  const picker = (await import('./controller-obsidian-mock.mjs')).modals.at(-1);
  assert.ok(picker); const target = picker.getSuggestions('Book')[0]; assert.ok(target);
  picker.selectSuggestion(target, new window.Event('click')); await c.saveTail;
  const id = c.currentIndex().documents.get('Book.md').root.id;
  assert.match(id, /^[0-9A-F]{6}$/); assert.ok(h.vault.data.get('Page.md').includes(`[[${id}|Book]]`));
  assert.equal(view.editor.getValue(), h.vault.data.get('Page.md')); assert.equal(h.vault.processes[0], 'Book.md');
  h.plugin.unload();
});

test('normal file opening resets to the root but sidebar activation preserves the viewed tree', async () => {
  const { h, c } = await setup({ 'Page.md': '# Page\n\n## Part ^part-id\nBody' }); const view = h.open('Page.md');
  await c.openTree(c.currentIndex().ids.get('part-id')[0], false); assert.equal(c.current().tree.id, 'part-id');
  h.workspace.active = { sidebar: true }; await h.workspace.emit('active-leaf-change', { view: h.workspace.active });
  assert.equal(c.current().tree.id, 'part-id');
  h.workspace.active = view; await h.workspace.emit('file-open', view.file); assert.equal(c.current().tree.level, 1);
  h.plugin.unload();
});

test('public index getter cannot repopulate unloaded source, leaf, or overlay state', async () => {
  const { h, c } = await setup({ 'Page.md': '# Page' }); h.open('Page.md'); c.currentIndex();
  h.plugin.unload(); assert.equal(c.currentIndex().documents.size, 0); assert.equal(c.parsed.size, 0); assert.equal(c.lastMarkdown, undefined);
});

test('excluded Forester fences preserve native rendered code without hybrid formatting', async () => {
  const { h } = await setup({ 'Native/Page.md': '# Native\n\n```forester\n\\title{Example}\n```' }, ['Native']);
  const el = document.createElement('section'); el.innerHTML = '<pre><code class="language-forester">\\title{Example}</code></pre>'; const before = el.innerHTML;
  await h.plugin.codeblocks.get('forester')('\\title{Example}', el, h.context('Native/Page.md', 2, 4));
  assert.equal(el.innerHTML, before); assert.equal(el.querySelector('[class*=hybrid]'), null); h.plugin.unload();
});

test('rendered header routes pass native modifiers through to explicit file/subtree navigation', async () => {
  const source = '---\nforester-id: root-id\n---\n# Page\n\n## Part ^part-id\nBody', { h } = await setup({ 'Page.md': source }); h.open('Page.md');
  const captures = [], original = window.HTMLElement.prototype.addEventListener;
  window.HTMLElement.prototype.addEventListener = function(type, listener, options) { if (type === 'click' && options?.capture) captures.push({ el: this, listener }); return original.call(this, type, listener, options); };
  try {
    const el = document.createElement('section'); el.innerHTML = '<h1>Page</h1><h2>Part</h2>';
    await h.plugin.postprocessors[0](el, h.context('Page.md', 3, 6));
    const slug = el.querySelector('h2 .hybrid-slug'), capture = captures.find(({ el }) => el === slug);
    assert.ok(capture, 'rendered header owns a modifier-aware native route handler');
    const event = new window.Event('click'); Object.defineProperty(event, 'ctrlKey', { value: true }); capture.listener(event); await drain();
    assert.equal(h.workspace.opens.at(-1)[0], 'Page.md#^part-id'); assert.equal(h.workspace.opens.at(-1)[2], true);
  } finally { window.HTMLElement.prototype.addEventListener = original; h.plugin.unload(); }
});


test('invalid YAML keeps activation scope but cannot authorize UI, TOC, code formatting, or target insertion', async () => {
  const source = '---\nbad: [unclosed\n---\n# Invalid\n\n```\n{ref:[[book-id]]}\n![[book-id]]\n```\n\n\\{ [[book-id]] }';
  const { h, c } = await setup({ 'Invalid.md': source, 'Page.md': '# Page\n\n/link', 'Book.md': '---\nforester-id: book-id\ncitation-authors: [Bates]\npublication-year: 2024\n---\n# Book' });
  const view = h.open('Invalid.md'); assert.equal(c.isEnabled('Invalid.md'), true, 'scope remains independent of parser validity');
  const state = view.editor.attach(h.plugin.extensions);
  assert.ok(state.facet((await import('@codemirror/view')).EditorView.decorations).every(ds => typeof ds.between !== 'function' || ds.size === 0));
  const invalid = c.currentIndex().documents.get('Invalid.md'); assert.deepEqual(c.outline(invalid, invalid.root), []); assert.equal(c.current(), null);
  const el = document.createElement('section'); el.innerHTML = '<p>{ref:[[book-id]]}</p><div class="internal-embed" src="book-id">Native</div>';
  const before = el.innerHTML; await h.plugin.postprocessors[0](el, h.context('Invalid.md', 3, 12)); await drain(); assert.equal(el.innerHTML, before);
  const code = document.createElement('div'); code.innerHTML = '<pre><code>Example</code></pre>'; const codeBefore = code.innerHTML;
  await h.plugin.codeblocks.get('forester')('\\title{Example}', code, h.context('Invalid.md', 3, 12)); assert.equal(code.innerHTML, codeBefore);
  const author = h.open('Page.md'), authorBefore = author.editor.getValue();
  await c.insertTarget(author.editor, author.file, invalid.root, true, { from: { line: 2, ch: 0 }, to: { line: 2, ch: 5 }, before: authorBefore });
  assert.equal(author.editor.getValue(), authorBefore); assert.deepEqual(h.vault.processes, []); h.plugin.unload();
});


test('Live Preview TOC focuses a repeated nested embed in the visible CM leaf, not hidden Reading DOM', async () => {
  const page = '# Page\n\n![[book-id]]\n\n![[book-id]]\n\nEnd';
  const book = '---\nforester-id: book-id\n---\n# Book\n\n![[part-id]]\n\n![[part-id]]';
  const part = '# Part note\n\n## Part ^part-id\nBody\n\n### Child ^child-id\nText';
  const { h, c } = await setup({ 'Page.md': page, 'Book.md': book, 'Part.md': part }); const view = h.open('Page.md');
  h.app.renderOverride = async (source, el) => { el.innerHTML = source.replace(/^### (.+)$/gm, '<h3>$1</h3>'); };
  const state = view.editor.attach(h.plugin.extensions), widgets = [];
  for (const ds of state.facet((await import('@codemirror/view')).EditorView.decorations)) if (typeof ds.between === 'function') ds.between(0, state.doc.length, (_f, _t, d) => { if (d.spec.widget?.span?.kind === 'embed') widgets.push(d.spec.widget); });
  const sourceDom = document.createElement('div'); sourceDom.className = 'markdown-source-view'; view.containerEl.append(sourceDom);
  const wrappers = widgets.map(widget => widget.toDOM({ dispatch() {}, focus() {} })); wrappers.forEach(el => sourceDom.append(el)); await drain();
  const native = { dom: sourceDom, state, posAtDOM: el => { const root = wrappers.findIndex(wrapper => wrapper === el || wrapper.contains(el)); if (root < 0) throw new Error('unbound'); return root === 0 ? page.indexOf('![[book-id]]') : page.lastIndexOf('![[book-id]]'); } };
  const lifecycle = h.plugin.extensions[0][1].create(native);
  const entries = c.outline(c.current().document, c.current().tree), entry = entries[1].children[1].children[0];
  const hidden = document.createElement('div'); hidden.className = 'markdown-preview-view'; hidden.setAttribute('data-hybrid-occurrence', entry.occurrenceKey); view.containerEl.prepend(hidden);
  const scrolled = []; window.HTMLElement.prototype.scrollIntoView = function () { scrolled.push(this); };
  await c.focusOccurrence(entry);
  const wanted = wrappers[1].querySelectorAll('h3')[1]; assert.ok(scrolled.at(-1) === wanted, 'second child of second placement is the exact target');
  assert.equal(h.workspace.opens.length, 0); assert.equal(c.current().tree.level, 1);
  lifecycle.destroy(); widgets.forEach(widget => widget.destroy()); h.plugin.unload();
});


test('self-root selection at the beginning of a note retains newly minted frontmatter outside the replacement', async () => {
  for (const source of ['/link', '']) {
    const { h, c } = await setup({ 'Page.md': source }); const view = h.open('Page.md'), tree = c.currentIndex().documents.get('Page.md').root;
    await c.insertTarget(view.editor, view.file, tree, false, { from: { line: 0, ch: 0 }, to: { line: 0, ch: source.length }, before: source });
    const current = c.currentIndex().documents.get('Page.md');
    assert.match(current.root.id ?? '', /^[A-F0-9]{6}$/, 'root identity is retained, not replaced together with the old slash range');
    assert.ok(current.source.startsWith('---\nforester-id: ')); assert.ok(current.source.includes(`[[${current.root.id}|Page]]`));
    assert.equal(view.editor.getValue(), h.vault.data.get('Page.md')); h.plugin.unload();
  }
});


test('replacing the selected definition cancels rather than inserting a dangling newly minted ID', async () => {
  const source = '# Page\n\n## Selected\nBody', { h, c } = await setup({ 'Page.md': source }); const view = h.open('Page.md');
  const target = c.currentIndex().documents.get('Page.md').trees[1];
  await c.insertTarget(view.editor, view.file, target, false, { from: { line: 0, ch: 0 }, to: view.editor.offsetToPos(source.length), before: source });
  assert.equal(h.vault.data.get('Page.md'), source); assert.equal(view.editor.getValue(), source); assert.deepEqual(h.vault.processes, []); h.plugin.unload();
});

for (const addressed of [true, false]) {
  test(`real slash picker cancels cursor movement during awaited target I/O: addressed=${addressed}`, async () => {
    const source = '# Source\n\n/link';
    const target = addressed ? '---\nforester-id: ABCDEF\n---\n# Target\n' : '# Target\n';
    const { h, c } = await setup({ 'Source.md': source, 'Target.md': target });
    const view = h.open('Source.md'); view.editor.setCursor({ line: 2, ch: 5 });
    const suggest = h.plugin.suggesters[0];
    const trigger = suggest.onTrigger(view.editor.getCursor(), view.editor, view.file);
    assert.ok(trigger); suggest.context = { ...trigger, editor: view.editor, file: view.file };
    suggest.selectSuggestion(suggest.getSuggestions(suggest.context).find(choice => choice.command === 'link'));
    const picker = modals.at(-1), choice = picker.getSuggestions('Target')[0]; assert.ok(choice);
    let release, began;
    const started = new Promise(resolve => { began = resolve; }), gate = new Promise(resolve => { release = resolve; });
    const read = h.vault.read; let armed = true;
    h.vault.read = async file => { const value = await read(file); if (armed) { armed = false; began(); await gate; } return value; };
    try {
      picker.selectSuggestion(choice, new window.Event('click'));
      await started; view.editor.setCursor({ line: 0, ch: 1 }); release(); await c.saveTail;
      assert.equal(h.vault.data.get('Source.md'), source, 'old captured slash range must not be replaced');
      assert.equal(view.editor.getValue(), source);
      assert.equal(h.vault.data.get('Target.md'), target, 'cancel before minting target');
      assert.deepEqual(h.vault.processes, []);
    } finally { release(); h.plugin.unload(); }
  });
}
