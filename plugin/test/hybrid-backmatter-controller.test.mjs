import assert from 'node:assert/strict';
import test from 'node:test';
import { createHarness, document, window } from './controller-obsidian-mock.mjs';
import { HybridController } from './build/hybrid-controller.mjs';
import { EditorView } from '@codemirror/view';
const footerWidgets = state => {
  const widgets = [];
  for (const decorations of state.facet(EditorView.decorations)) if (typeof decorations.between === 'function') decorations.between(0, state.doc.length, (from, to, decoration) => {
    if (decoration.spec.widget?.backmatter) widgets.push({ from, to, decoration, widget: decoration.spec.widget });
  });
  return widgets;
};

const note = (id, title, body, extra = '') => `---\nforester-id: ${id}\ntitle: ${title}\n${extra}---\n# ${title}\n\n${body}\n`;
const entries = {
  'Page.md': note('PAGE', 'Page', 'See [[REF]] and [[RELATED]].\n\n## Local section ^SECTION\nSection body.'),
  'Ref.md': note('REF', 'Reference title', 'Reference body.', 'taxon: Reference\n'),
  'Related.md': note('RELATED', 'Related title', 'Related body.'),
  'Incoming.md': note('INCOMING', 'Incoming title', 'Links to [[PAGE]].'),
};
const settle = () => new Promise(resolve => setTimeout(resolve, 80));
async function prepared(c, view) {
  for (let i = 0; i < 200; i++) {
    if (c.backmatterRequests.get(view.editor)?.done) return view.editor.cm.state;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail('real asynchronous backmatter preparation did not finish');
}
async function live(c, h, view, ...args) {
  view.editor.attach(h.plugin.extensions, ...args);
  return prepared(c, view);
}
function preview(h, path) {
  const view = h.open(path); view.mode = 'preview';
  const root = document.createElement('div'); root.className = 'markdown-preview-view';
  const sizer = document.createElement('div'); sizer.className = 'markdown-preview-sizer';
  const content = document.createElement('section'); content.innerHTML = '<h1>Page</h1><p>Native body remains</p>';
  sizer.append(content); root.append(sizer); view.containerEl.append(root);
  return { view, root, sizer, content };
}
async function start(t, h) {
  const c = new HybridController(h.plugin, h.getter); await c.initialize(); t.after(() => h.plugin.unload()); return c;
}

test('2502-document edits never construct a relation graph inside CM transactions', { timeout: 30_000 }, async t => {
  const large = { 'Page.md': note('PAGE', 'Page', '[[REF]]'), 'Ref.md': note('REF', 'Ref', 'Body.', 'taxon: Reference\n') };
  for (let i = 0; i < 2500; i++) large[`N${i}.md`] = note(`n-${i}`, `Note ${i}`, 'Plain text '.repeat(120) + '[[REF]]');
  const h = createHarness(large), c = await start(t, h), view = h.open('Page.md');
  let inTransaction = false, graphCalls = 0;
  const original = c.graphFor.bind(c);
  c.graphFor = index => { if (inTransaction) graphCalls++; return original(index); };
  view.editor.attach(h.plugin.extensions);
  let heartbeat, activeYields = 0, maxPreparationGapMs = 0, previousBeat = performance.now();
  const beat = () => {
    const now = performance.now();
    if (c.backmatterPreparing) { activeYields++; maxPreparationGapMs = Math.max(maxPreparationGapMs, now - previousBeat); }
    previousBeat = now; heartbeat = setTimeout(beat, 0);
  };
  beat(); t.after(() => clearTimeout(heartbeat));
  let published = 0; const setGraph = c.backmatterGraphs.set.bind(c.backmatterGraphs);
  c.backmatterGraphs.set = (index, graph) => { published++; return setGraph(index, graph); };
  const edit_ms = [];
  for (let i = 0; i < 3; i++) {
    const at = performance.now(); inTransaction = true;
    view.editor.cm.dispatch({ changes: { from: view.editor.cm.state.doc.length, insert: 'x' } });
    inTransaction = false; edit_ms.push(performance.now() - at);
  }
  t.diagnostic(JSON.stringify({ documents: Object.keys(large).length, source_characters: Object.values(large).reduce((n, s) => n + s.length, 0), graphCalls, edit_ms }));
  assert.equal(graphCalls, 0, 'fresh graph construction in a keystroke is forbidden, independent of machine speed');
  assert.equal(footerWidgets(view.editor.cm.state).length, 0, 'a changed draft omits its footer until matching asynchronous preparation');
  await settle();
  for (let i = 0; i < 100 && !footerWidgets(view.editor.cm.state).length; i++) await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(footerWidgets(view.editor.cm.state)[0]?.widget.backmatter.groups.references.map(tree => tree.id), ['REF']);
  assert.equal(published, 1, 'only the coalesced final draft publishes a graph');
  assert.ok(activeYields > 5, 'preparation yields to input/paint repeatedly instead of deferring one monolithic scan');
  t.diagnostic(JSON.stringify({ activeYields, maxPreparationGapMs, published }));
  assert.equal(h.vault.processes.length, 0);
});

test('prepared graph is shared with sidebars and rapid typing publishes only the final draft', async t => {
  const h = createHarness(entries), c = await start(t, h), view = h.open('Page.md');
  let publications = 0;
  const set = c.backmatterGraphs.set.bind(c.backmatterGraphs);
  c.backmatterGraphs.set = (index, graph) => { publications++; return set(index, graph); };
  await live(c, h, view);
  const canonical = c.backmatterGraphs.get(c.index);
  assert.ok(canonical); c.relations(c.current().tree);
  assert.equal(c.relationGraph, canonical, 'canonical index shares the exact sidebar/footer graph');
  const before = publications, dispatches = view.editor.cm.dispatches.length;
  const state = view.editor.cm.state, at = state.doc.toString().indexOf('[[RELATED]]');
  view.editor.cm.dispatch({ changes: { from: at, to: at + '[[RELATED]]'.length, insert: 'plain' } });
  for (let i = 0; i < 12; i++) view.editor.cm.dispatch({ changes: { from: view.editor.cm.state.doc.length, insert: 'x' } });
  assert.equal(footerWidgets(view.editor.cm.state).length, 0);
  await prepared(c, view);
  const widget = footerWidgets(view.editor.cm.state)[0].widget;
  assert.equal(widget.backmatter.groups.related.length, 0);
  assert.equal(publications - before, 1, 'intermediate keystrokes never publish graphs');
  assert.equal(view.editor.cm.dispatches.length - dispatches, 14, '13 edits plus one final refresh effect');
  assert.equal(h.vault.processes.length, 0);
});

test('two same-file leaves keep separate prepared tree-page context, including a mismatched bridge', async t => {
  const local = { 'Page.md': note('PAGE', 'Page', '[[REF]]\n\n## Part ^PART\n[[SECOND]]'), 'Ref.md': entries['Ref.md'], 'Second.md': note('SECOND', 'Second', 'Second body.', 'taxon: Reference\n') };
  const h = createHarness(local), c = await start(t, h), part = h.open('Page.md');
  await c.openTree(c.currentIndex().ids.get('part')[0], false);
  const root = h.open('Page.md');
  part.editor.attach(h.plugin.extensions); root.editor.attach(h.plugin.extensions);
  await prepared(c, part); await prepared(c, root);
  assert.deepEqual(footerWidgets(part.editor.cm.state)[0].widget.backmatter.groups.references.map(tree => tree.id), ['SECOND']);
  assert.deepEqual(footerWidgets(root.editor.cm.state)[0].widget.backmatter.groups.references.map(tree => tree.id), ['REF', 'SECOND']);
  const bridged = await live(c, h, part, true, local['Ref.md'], 'Ref.md');
  assert.equal(footerWidgets(bridged)[0].widget.backmatter.contextKey, 'Ref.md:root', 'the owning editor cannot lend Page subtree context to Ref');
});

test('deferred old widgets retain one immutable remote summary/body snapshot', async t => {
  const h = createHarness(entries), c = await start(t, h), view = h.open('Page.md');
  const oldWidget = footerWidgets(await live(c, h, view))[0].widget;
  const updated = entries['Ref.md'].replaceAll('Reference title', 'New title').replace('Reference body.', 'NEW body.');
  h.vault.data.set('Ref.md', updated); await h.app.metadataCache.emit('changed', h.vault.files.get('Ref.md'), updated, {});
  await prepared(c, view);
  const current = footerWidgets(view.editor.cm.state)[0].widget;
  for (const [widget, title, body] of [[oldWidget, 'Reference title', 'Reference body.'], [current, 'New title', 'NEW body.']]) {
    const el = widget.toDOM(), row = el.querySelector('[data-hybrid-backmatter-group="references"] details');
    assert.ok(row.querySelector('summary').textContent.includes(title));
    row.open = true; row.dispatchEvent(new window.Event('toggle')); await settle();
    assert.ok(row.querySelector('.hybrid-backmatter-body').textContent.includes(body)); widget.destroy();
  }
});

for (const gate of ['unload', 'excluded', 'syntax', 'source', 'closed']) test(`pending preparation cannot refresh after ${gate}`, async t => {
  const h = createHarness(entries), c = await start(t, h), view = h.open('Page.md');
  view.editor.attach(h.plugin.extensions);
  if (gate === 'unload') h.plugin.unload();
  if (gate === 'excluded') h.options.excludedFolders = ['/'];
  if (gate === 'syntax') view.editor.attach(h.plugin.extensions, true, '---\nauthors: [\n---\n[[REF]]');
  if (gate === 'source') view.editor.attach(h.plugin.extensions, false);
  if (gate === 'closed') h.workspace.views = [];
  const before = view.editor.cm.dispatches.length; await settle();
  assert.equal(view.editor.cm.dispatches.length, before, 'retired request sends no refresh');
  assert.equal(footerWidgets(view.editor.cm.state).length, 0); assert.equal(h.vault.processes.length, 0);
});

for (const gate of ['edit', 'revision', 'context', 'unload']) test(`cooperative in-progress preparation retires obsolete ${gate} work`, async t => {
  const local = { ...entries };
  for (let i = 0; i < 80; i++) local[`N${i}.md`] = note(`n-${i}`, `Note ${i}`, '[[REF]]');
  const h = createHarness(local), c = await start(t, h), view = h.open('Page.md');
  let publications = 0; const set = c.backmatterGraphs.set.bind(c.backmatterGraphs);
  c.backmatterGraphs.set = (index, graph) => { publications++; return set(index, graph); };
  view.editor.attach(h.plugin.extensions);
  for (let i = 0; i < 200 && !c.backmatterPreparing; i++) await new Promise(resolve => setTimeout(resolve, 1));
  assert.ok(c.backmatterPreparing, 'exercise the actual yielded graph build, not just a pending timer');
  const old = c.backmatterRequests.get(view.editor), dispatches = view.editor.cm.dispatches.length;
  if (gate === 'edit') view.editor.cm.dispatch({ changes: { from: view.editor.cm.state.doc.length, insert: 'Final draft' } });
  if (gate === 'context') await c.openTree(c.currentIndex().ids.get('section')[0], false);
  if (gate === 'revision') {
    const updated = entries['Ref.md'].replaceAll('Reference title', 'Newest reference');
    h.vault.data.set('Ref.md', updated); await h.app.metadataCache.emit('changed', h.vault.files.get('Ref.md'), updated, {});
  }
  if (gate === 'unload') { h.plugin.unload(); await settle(); assert.equal(view.editor.cm.dispatches.length, dispatches); assert.equal(publications, 0); }
  else {
    await prepared(c, view); assert.equal(old.done, false, 'obsolete graph must not publish its result');
    assert.equal(publications, 1);
    if (gate === 'context') assert.equal(footerWidgets(view.editor.cm.state).length, 0);
    if (gate === 'revision') assert.equal(footerWidgets(view.editor.cm.state)[0].widget.backmatter.groups.references[0].meta.title, 'Newest reference');
  }
  assert.equal(h.vault.processes.length, 0);
});

test('closed Reading leaves release prepared source/context requests', async t => {
  const h = createHarness(entries), c = await start(t, h), page = preview(h, 'Page.md');
  await h.workspace.emit('layout-change'); await settle();
  assert.ok(c.backmatterRequests.has(page.view));
  h.workspace.views = []; await h.workspace.emit('layout-change'); await settle();
  assert.equal(c.backmatterRequests.has(page.view), false, 'closed leaf must not retain source/index/owner');
});

for (const mode of ['CM', 'Reading']) test(`${mode} ordinary self-related body starts a fresh traversal`, async t => {
  const text = note('PAGE', 'Page', 'Own body [[PAGE]].');
  const h = createHarness({ 'Page.md': text }), c = await start(t, h);
  let el, widget;
  if (mode === 'CM') { const view = h.open('Page.md'); widget = footerWidgets(await live(c, h, view))[0].widget; el = widget.toDOM(); }
  else { const p = preview(h, 'Page.md'); await h.workspace.emit('layout-change'); await settle(); el = p.sizer; }
  const row = el.querySelector('[data-hybrid-backmatter-group="related"] details');
  row.open = true; row.dispatchEvent(new window.Event('toggle')); await settle();
  const body = row.querySelector('.hybrid-backmatter-body').textContent;
  assert.ok(body.includes('Own body [[PAGE]].'), `ordinary self link must render its body, got ${body}`);
  assert.ok(!body.includes('Hybrid embed cycle')); widget?.destroy();
});

for (const cyclic of [false, true]) test(`footer target embedding current page ${cyclic ? 'bounds a real cycle' : 'is not a cycle'}`, async t => {
  const h = createHarness({ 'Page.md': note('PAGE', 'Page', `Current body [[TARGET]].${cyclic ? '\n![[TARGET]]' : ''}`), 'Target.md': note('TARGET', 'Target', 'Target body\n![[PAGE]]') });
  // The unavoidable native Markdown boundary must preserve actual embed slots.
  h.app.renderOverride = async (source, el) => { el.innerHTML = source; };
  const c = await start(t, h), view = h.open('Page.md');
  const widget = footerWidgets(await live(c, h, view))[0].widget, el = widget.toDOM();
  const row = el.querySelector('[data-hybrid-backmatter-group="related"] details');
  row.open = true; row.dispatchEvent(new window.Event('toggle')); await settle();
  const body = row.querySelector('.hybrid-backmatter-body');
  assert.ok(body.textContent.includes('Current body'), body.textContent);
  assert.equal(body.textContent.includes('Hybrid embed cycle'), cyclic);
  assert.ok(body.querySelectorAll('.hybrid-embed').length <= 3, 'real recursion stays bounded'); widget.destroy();
});

test('Reading adds one local Forester footer after native note content through registered hooks', async t => {
  const h = createHarness(entries), c = await start(t, h), p = preview(h, 'Page.md');
  const ctx = h.context('Page.md', 0, entries['Page.md'].split('\n').length - 1);
  await h.plugin.postprocessors[0](p.content, ctx); await settle();
  assert.equal(p.sizer.querySelectorAll('[data-hybrid-backmatter]').length, 1);
  const footer = p.sizer.querySelector('[data-hybrid-backmatter]');
  assert.ok(footer.textContent.includes('References'));
  assert.ok(footer.textContent.includes('Backlinks'));
  assert.ok(footer.textContent.includes('Related'));
  assert.ok(p.content.textContent.includes('Native body remains'));
  assert.equal(p.view.editor.getValue(), entries['Page.md']);
  assert.equal(h.vault.processes.length, 0, 'footer is view-only');
  await h.plugin.postprocessors[0](p.content, ctx); await settle();
  assert.equal(p.sizer.querySelectorAll('[data-hybrid-backmatter]').length, 1);
});

test('each Reading leaf uses its own file instead of the globally active note', async t => {
  const h = createHarness(entries), c = await start(t, h);
  const page = preview(h, 'Page.md'), ref = preview(h, 'Ref.md');
  await h.workspace.emit('layout-change'); await settle();
  assert.ok(page.sizer.textContent.includes('Incoming title'));
  assert.ok(page.sizer.textContent.includes('Related title'));
  assert.ok(ref.sizer.querySelector('[data-hybrid-backmatter]').textContent.includes('Page'));
  assert.ok(!ref.sizer.querySelector('[data-hybrid-backmatter]').textContent.includes('Incoming title'));
  assert.equal(h.workspace.active, ref.view);
  assert.equal(h.workspace.opens.length, 0, 'background rendering never changes focus');
});

test('Reading footer refreshes remote relation metadata without duplication', async t => {
  const h = createHarness(entries), c = await start(t, h), page = preview(h, 'Page.md');
  await h.workspace.emit('layout-change'); await settle();
  const updated = entries['Ref.md'].replaceAll('Reference title', 'Updated title');
  h.vault.data.set('Ref.md', updated);
  await h.app.metadataCache.emit('changed', h.vault.files.get('Ref.md'), updated, {}); await settle();
  assert.equal(page.sizer.querySelectorAll('[data-hybrid-backmatter]').length, 1);
  assert.ok(page.sizer.querySelector('[data-hybrid-backmatter]').textContent.includes('Updated title'));
  assert.ok(!page.sizer.querySelector('[data-hybrid-backmatter]').textContent.includes('Reference title'));
});

test('Reading footer removes owned DOM when excluded, malformed, source mode or leaf closed', async t => {
  const h = createHarness(entries), c = await start(t, h), page = preview(h, 'Page.md');
  const present = () => !!page.sizer.querySelector('[data-hybrid-backmatter]');
  await h.workspace.emit('layout-change'); await settle(); assert.ok(present());
  page.view.mode = 'source'; await h.workspace.emit('layout-change'); await settle(); assert.equal(present(), false);
  page.view.mode = 'preview'; await h.workspace.emit('layout-change'); await settle(); assert.ok(present());
  h.options.excludedFolders = ['/']; await c.refresh(); await settle(); assert.equal(present(), false);
  h.options.excludedFolders = []; await c.refresh(); await settle(); assert.ok(present());
  page.view.editor.value = '---\npublish: true\nauthors: [\n---\n[[REF]]';
  await h.workspace.emit('layout-change'); await settle(); assert.equal(present(), false);
  page.view.editor.value = entries['Page.md']; await h.workspace.emit('layout-change'); await settle(); assert.ok(present());
  h.workspace.views = []; await h.workspace.emit('layout-change'); await settle(); assert.equal(present(), false);
  assert.ok(page.content.textContent.includes('Native body remains'));
});

test('Reading footer is never injected into a nested native embed or empty relation note', async t => {
  const h = createHarness({ ...entries, 'Empty.md': note('EMPTY', 'Empty', 'No links.') }), c = await start(t, h);
  const empty = preview(h, 'Empty.md');
  const embedded = preview(h, 'Page.md');
  const embedOwner = document.createElement('div'); embedOwner.className = 'internal-embed';
  embedded.root.replaceWith(embedOwner); embedOwner.append(embedded.root);
  await h.workspace.emit('layout-change'); await settle();
  assert.equal(empty.sizer.querySelector('[data-hybrid-backmatter]'), null);
  assert.equal(embedded.sizer.querySelector('[data-hybrid-backmatter]'), null);
});

test('unload cancels pending Reading footer synchronization and makes prior navigation inert', async t => {
  const h = createHarness(entries), c = await start(t, h), page = preview(h, 'Page.md');
  await h.workspace.emit('layout-change'); await settle();
  const links = [...page.sizer.querySelectorAll('[data-hybrid-backmatter] a')];
  h.plugin.unload();
  assert.equal(page.sizer.querySelector('[data-hybrid-backmatter]'), null);
  for (const link of links) link.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  await settle(); assert.equal(h.workspace.opens.length, 0);
  await h.plugin.postprocessors[0](page.content, h.context('Page.md', 0, entries['Page.md'].split('\n').length - 1));
  await settle(); assert.equal(page.sizer.querySelector('[data-hybrid-backmatter]'), null);
});

test('Live Preview adds one EOF backmatter widget with shared relation semantics and no source mutation', async t => {
  const h = createHarness(entries), c = await start(t, h), view = h.open('Page.md');
  const state = await live(c, h, view);
  const widgets = footerWidgets(state);
  assert.equal(widgets.length, 1);
  assert.equal(widgets[0].from, state.doc.length);
  assert.equal(widgets[0].to, state.doc.length);
  assert.equal(widgets[0].decoration.spec.block, true);
  assert.equal(state.doc.toString(), entries['Page.md']);
  assert.deepEqual(widgets[0].widget.backmatter.groups.references.map(tree => tree.id), ['REF']);
  assert.deepEqual(widgets[0].widget.backmatter.groups.backlinks.map(tree => tree.id), ['INCOMING']);
  assert.deepEqual(widgets[0].widget.backmatter.groups.related.map(tree => tree.id), ['RELATED']);
  const element = widgets[0].widget.toDOM();
  assert.ok(element.querySelector('[data-hybrid-backmatter]'));
  assert.equal(element.querySelector('.hybrid-toc'), null);
  widgets[0].widget.destroy(); assert.equal(element.querySelector('[data-hybrid-backmatter]'), null);
  assert.equal(h.vault.processes.length, 0);
});

test('Reading keeps the existing footer after asynchronously appended native sections', async t => {
  const h = createHarness(entries), c = await start(t, h), page = preview(h, 'Page.md');
  await h.workspace.emit('layout-change'); await settle();
  const footer = page.sizer.querySelector('[data-hybrid-backmatter]');
  const tail = document.createElement('section'); tail.textContent = 'Later native section'; page.sizer.append(tail);
  await h.plugin.postprocessors[0](tail, h.context('Page.md', 0, entries['Page.md'].split('\n').length - 1)); await settle();
  assert.ok(page.sizer.lastElementChild.contains(footer));
  assert.ok(page.sizer.querySelectorAll('[data-hybrid-backmatter]').length === 1);
  assert.ok(tail.textContent.includes('Later native section'));
});

test('normal same-file opening resets the Live Preview footer from a subtree page to the root', async t => {
  const h = createHarness(entries), c = await start(t, h), view = h.open('Page.md');
  await live(c, h, view);
  assert.equal(footerWidgets(view.editor.cm.state).length, 1);
  await c.openTree(c.currentIndex().ids.get('section')[0], false);
  assert.equal(c.current().tree.id, 'SECTION');
  assert.equal(footerWidgets(view.editor.cm.state).length, 0, 'the section has no relations');
  await h.workspace.emit('file-open', view.file);
  await prepared(c, view);
  assert.equal(c.current().tree.id, 'PAGE');
  assert.equal(footerWidgets(view.editor.cm.state).length, 1, 'root footer must refresh without a text edit');
});

test('Live Preview footer is absent in Source mode, excluded notes and malformed drafts', async t => {
  const h = createHarness(entries), c = await start(t, h), view = h.open('Page.md');
  assert.equal(footerWidgets(view.editor.attach(h.plugin.extensions, false)).length, 0);
  assert.equal(footerWidgets(view.editor.attach(h.plugin.extensions, true, '---\nauthors: [\n---\n[[REF]]')).length, 0);
  h.options.excludedFolders = ['/'];
  assert.equal(footerWidgets(view.editor.attach(h.plugin.extensions)).length, 0);
});

test('Live Preview footer uses each editor overlay and preserves its widget across cursor moves', async t => {
  const h = createHarness(entries), c = await start(t, h), page = h.open('Page.md'), ref = h.open('Ref.md');
  const state = await live(c, h, page, true, entries['Page.md'].replace('[[RELATED]]', 'plain text'));
  const widget = footerWidgets(state)[0].widget;
  assert.equal(widget.backmatter.groups.related.length, 0, 'unsaved state, not disk or active Ref editor');
  assert.deepEqual(widget.backmatter.groups.backlinks.map(tree => tree.id), ['INCOMING']);
  const moved = state.update({ selection: { anchor: 0 } }).state;
  assert.ok(widget.eq(footerWidgets(moved)[0].widget), 'cursor movement does not collapse/recreate the footer');
  assert.equal(h.workspace.active, ref);
});

test('Live Preview footer updates referenced metadata and lazy content from vault changes', async t => {
  const h = createHarness(entries), c = await start(t, h), page = h.open('Page.md');
  await live(c, h, page);
  const oldWidget = footerWidgets(page.editor.cm.state)[0].widget;
  const updated = entries['Ref.md'].replaceAll('Reference title', 'Updated title');
  h.vault.data.set('Ref.md', updated); await h.app.metadataCache.emit('changed', h.vault.files.get('Ref.md'), updated, {});
  await prepared(c, page);
  const currentWidget = footerWidgets(page.editor.cm.state)[0].widget;
  assert.ok(!oldWidget.eq(currentWidget));
  const el = currentWidget.toDOM();
  assert.ok(el.textContent.includes('Updated title'));
  const details = el.querySelector('[data-hybrid-backmatter-group="references"] details');
  details.open = true; details.dispatchEvent(new window.Event('toggle')); await settle();
  assert.ok(details.textContent.includes('Reference body.'));
  currentWidget.destroy();
});

test('CM source-link capture does not reinterpret footer routes as the last source subtree', async t => {
  const h = createHarness(entries), c = await start(t, h), page = h.open('Page.md');
  const state = await live(c, h, page), widget = footerWidgets(state)[0].widget, dom = widget.toDOM();
  const native = { dom, state, posAtDOM: () => state.doc.length };
  let capture; const add = dom.addEventListener.bind(dom);
  dom.addEventListener = (type, fn, options) => { if (type === 'click' && options === true) capture = fn; add(type, fn, options); };
  const lifecycle = h.plugin.extensions[0][1].create(native);
  const link = dom.querySelector('[data-hybrid-backmatter-group="references"] .hybrid-slug');
  const event = new window.Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'target', { value: link }); Object.defineProperty(event, 'ctrlKey', { value: true });
  capture(event); assert.equal(h.workspace.opens.length, 0);
  link.dispatchEvent(event); await settle();
  assert.equal(h.workspace.opens.length, 1);
  assert.equal(h.workspace.opens[0][0], 'Ref.md'); assert.equal(h.workspace.opens[0][2], true);
  lifecycle.destroy(); widget.destroy();
});
