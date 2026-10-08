import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorView } from '@codemirror/view';
import { createHarness, notices, modals, renders, document, resetObservations, TFile, MockEditor, window } from './controller-obsidian-mock.mjs';
const adapter = await import('./build/hybrid-controller.mjs').catch(() => ({}));
const optin = (body, extra = '') => `---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;
async function controller(h) { assert.equal(typeof adapter.HybridController, 'function', 'real integration class is available'); const c = new adapter.HybridController(h.plugin, h.getter); await c.initialize(); return c; }
const spans = (state, kind) => { const out = []; for (const ds of state.facet(EditorView.decorations)) if (typeof ds.between === 'function') ds.between(0, state.doc.length, (from, to, d) => { if (d.spec.widget?.span?.kind === kind) out.push({ from, to, span: d.spec.widget.span, widget: d.spec.widget }); }); return out; };

test('initialization installs native hooks and getter enables all Markdown except explicit path exclusions', async () => {
  const h = createHarness({ 'ordinary.md': '# Normal', 'enabled.md': optin('# Hybrid'), 'no.md': optin('# No').replace('hybrid-v1', 'false'), 'Trees/a.md': '# Selected' });
  const originalSave = h.app.commands.commands['editor:save-file'].callback;
  const c = await controller(h);
  assert.equal(h.plugin.extensions.length, 1);
  assert.equal(h.plugin.postprocessors.length, 1);
  assert.ok(h.plugin.commands.has('check-hybrid-trees'));
  assert.ok(h.plugin.commands.has('preview-public-projection'));
  assert.equal(c.isEnabled('ordinary.md'), true);
  assert.equal(c.isEnabled('enabled.md'), true);
  assert.equal(c.isEnabled('no.md'), true);
  h.options = { ...h.options, folders: ['Legacy'], excludedFolders: ['Trees'] };
  assert.equal(c.isEnabled('Trees/a.md'), false, 'getter sees changed settings');
  assert.equal(c.isEnabled('no.md'), true, 'legacy mode metadata does not change activation');
  assert.equal(c.isEnabled('missing.md'), false, 'unknown source fails closed');
  assert.equal(c.isEnabled('old.md', '---\nforester-mode: hybrid-v0\n---\n# Legacy'), true);
  for (const event of ['modify', 'create', 'rename', 'delete']) assert.ok(h.vault.events.has(event), event);
  assert.ok(h.app.metadataCache.events.has('changed'));
  assert.ok(h.workspace.events.has('editor-change'));
  assert.equal(h.app.commands.commands['editor:save-file'].callback, originalSave, 'does not collide with legacy save wrapper');
  h.plugin.unload();
  assert.equal((h.workspace.events.get('editor-change') ?? []).length, 0);
});

test('real CodeMirror decorates only Live Preview and resolves the unsaved document overlay', async () => {
  const disk = optin('# Work\n\nOld body', 'forester-id: old-id\n');
  const unsaved = optin('# Draft\n\n{ref:[[new-id]]}\n\nEnd', 'forester-id: new-id\ncitation-authors: [Floridi]\npublication-year: 2024\n');
  const h = createHarness({ 'Work/Work.md': disk, 'Native/Normal.md': '# Normal\n\n{ref:[[new-id]]}' }, { folders: [], excludedFolders: ['Native/Normal.md'], publicFolders: [], reservedIds: [] });
  await controller(h);
  const view = h.open('Work/Work.md');
  let state = view.editor.attach(h.plugin.extensions, true, unsaved);
  assert.equal(spans(state, 'citation').length, 1);
  assert.equal(spans(state, 'citation')[0].span.text, '(Floridi, 2024)', 'self ID from state.doc, not disk cache');
  assert.equal(state.doc.toString(), unsaved);
  state = view.editor.attach(h.plugin.extensions, false, unsaved);
  assert.equal(spans(state, 'citation').length, 0, 'Source mode untouched');
  state = h.open('Native/Normal.md').editor.attach(h.plugin.extensions, true);
  assert.equal(spans(state, 'citation').length, 0, 'ordinary Live Preview untouched');
  h.options.excludedFolders.push('Work');
  state = view.editor.attach(h.plugin.extensions, true, unsaved.replace('hybrid-v1', 'false'));
  assert.equal(spans(state, 'citation').length, 0, 'path exclusion overrides legacy mode metadata');
  h.plugin.unload();
});

test('remote source changes refresh the native StateField and collision warnings include disabled file names/aliases', async () => {
  const h = createHarness({
    'Page.md': optin('# Page\n\n{ref:[[book-id]]}\n\nEnd', 'forester-id: page-id\n'),
    'Book.md': optin('# Book\n\nBody', 'forester-id: book-id\ncitation-authors: [Bates]\npublication-year: 2022\n')
  });
  const c = await controller(h);
  const view = h.open('Page.md'); view.editor.attach(h.plugin.extensions);
  assert.equal(spans(view.editor.cm.state, 'citation')[0].span.text, '(Bates, 2022)');
  const changed = h.vault.data.get('Book.md').replace('Bates', 'White').replace('Body', 'New!');
  h.vault.data.set('Book.md', changed);
  await h.app.metadataCache.emit('changed', h.vault.files.get('Book.md'), changed, {});
  assert.equal(spans(view.editor.cm.state, 'citation')[0].span.text, '(White, 2022)', 'same-line title/body changes rerender dependencies');
  assert.ok(view.editor.cm.dispatches.length > 0);
  h.vault.files.set('book-id.md', new TFile('book-id.md')); h.vault.data.set('book-id.md', '# Native');
  await h.vault.emit('create', h.vault.files.get('book-id.md'));
  assert.ok(notices.some(n => n.includes('file-id-collision')));
  assert.ok(spans(view.editor.cm.state, 'citation')[0].span.error, 'ID/file ambiguity must not pick one');
  const count = notices.length; await c.refresh(); assert.equal(notices.length, count, 'deduped warning');
  const file = h.vault.files.get('book-id.md'); h.vault.files.delete(file.path); h.vault.data.delete(file.path); await h.vault.emit('delete', file);
  assert.equal(spans(view.editor.cm.state, 'citation')[0].span.text, '(White, 2022)');
  h.vault.files.set('Other.md', new TFile('Other.md')); h.vault.data.set('Other.md', '---\nforester-mode: false\naliases: [book-id]\n---\n# Ordinary');
  await h.vault.emit('create', h.vault.files.get('Other.md'));
  assert.ok(notices.some(n => n.includes('alias-id-collision')));
  const book = h.vault.files.get('Book.md'); h.vault.files.delete('Book.md'); h.vault.data.delete('Book.md'); book.path = 'Renamed.md'; h.vault.files.set(book.path, book); h.vault.data.set(book.path, changed);
  await h.vault.emit('rename', book, 'Book.md');
  assert.equal(c.isEnabled('Book.md'), false);
  assert.equal(c.isEnabled('Renamed.md'), true);
  h.plugin.unload();
});

test('refresh propagates CodeMirror effect errors instead of swallowing them', async () => {
  const h = createHarness({ 'Page.md': optin('# Page') }); const c = await controller(h); const view = h.open('Page.md');
  view.editor.cm.dispatch = () => { throw new Error('bad facet'); };
  await assert.rejects(c.refresh(), /bad facet/);
  h.plugin.unload();
});

test('Reading badges use section positions; citations skip code, quotes and native excerpts', async () => {
  const source = optin('# Root\n\n## Part ^first-id\n#Claim\n\nFirst\n\n## Part ^second-id\n#Claim\n\n{ref:[[book-id]]}\n');
  const h = createHarness({ 'Work.md': source, 'Book.md': optin('# Book', 'forester-id: book-id\ncitation-authors: [Bates]\npublication-year: 2022\n') });
  await controller(h); const process = h.plugin.postprocessors[0];
  const start = source.split('\n').indexOf('## Part ^second-id');
  const el = document.createElement('section'); el.innerHTML = '<h2>Part</h2><p>{ref:<a class="internal-link" data-href="book-id">book-id</a>}</p><pre><code>{ref:[[book-id]]}</code></pre><blockquote>{ref:[[book-id]]}</blockquote>';
  const ctx = h.context('Work.md', start, source.split('\n').length - 1);
  await process(el, ctx);
  assert.equal(el.querySelector('.hybrid-taxon-number')?.textContent.trim(), 'Claim 2');
  assert.equal(el.querySelector('.hybrid-citation')?.textContent, '(Bates, 2022)');
  assert.equal(el.querySelector('pre').textContent, '{ref:[[book-id]]}');
  assert.equal(el.querySelector('blockquote').textContent, '{ref:[[book-id]]}');
  await process(el, ctx); assert.equal(el.querySelectorAll('.hybrid-taxon-number').length, 1, 'idempotent native postprocessing');
  const excerpt = document.createElement('div'); excerpt.className = 'internal-embed'; excerpt.innerHTML = '<h2>Part</h2><p>{ref:[[book-id]]}</p>';
  await process(excerpt, h.context('Work.md', 0, 1, '## Part\n{ref:[[book-id]]}'));
  assert.equal(excerpt.querySelector('.hybrid-taxon-number'), null);
  assert.equal(excerpt.querySelector('.hybrid-citation'), null);
  const unrelated = document.createElement('div'); unrelated.innerHTML = '<h2>Part</h2>';
  await process(unrelated, h.context('Work.md', start, start, '## Wrong'));
  assert.equal(unrelated.querySelector('.hybrid-taxon-number'), null, 'mismatched source fails closed');
  h.plugin.unload();
});

test('Live Preview embeds render the complete private tree section with offset-only metadata removal and lifecycle cleanup', async () => {
  const target = optin('# Book\n\n## Selected ^section-id\n#Claim\n%% publish: false %%\n\nFirst paragraph\n\nSecond paragraph\n\n### Nested ^nested-id\n#Person\n%% authors: [Local] %%\n\nChild text\n\n## Sibling ^sibling-id\nNot in section\n', 'forester-id: book-id\n');
  const h = createHarness({ 'Page.md': optin('# Page\n\n![[section-id]] %%ht%%\n\nEnd'), 'Book.md': target });
  await controller(h); const view = h.open('Page.md'); const state = view.editor.attach(h.plugin.extensions);
  const embedded = spans(state, 'embed')[0]; assert.ok(embedded);
  const el = embedded.widget.toDOM({ dispatch() {}, focus() {} });
  await new Promise(setImmediate);
  assert.equal(renders.length, 1, 'one native section render, no repeated root reads');
  assert.equal(renders[0].sourcePath, 'Book.md');
  assert.ok(renders[0].source.includes('First paragraph\n\nSecond paragraph'));
  assert.ok(renders[0].source.includes('### Nested ^nested-id'));
  assert.ok(renders[0].source.includes('Child text'));
  assert.ok(!renders[0].source.includes('Not in section'));
  assert.ok(!renders[0].source.includes('publish: false'));
  assert.ok(!renders[0].source.includes('authors: [Local]'));
  assert.equal(el.getAttribute('data-toc'), 'false');
  assert.equal(el.querySelector('header'), null, 'h hides entire header');
  assert.equal(el.getAttribute('data-hybrid-source-path'), 'Book.md');
  assert.equal(el.getAttribute('data-hybrid-from'), String(target.indexOf('First paragraph')));
  assert.equal(renders[0].component.loaded, true);
  const owner = renders[0].component; embedded.widget.destroy(); assert.equal(owner.loaded, false);
  h.plugin.unload();
});

test('Reading tree embeds replace native one-block excerpts and belong to the renderer child lifecycle', async () => {
  const source = optin('# Page\n\n![[section-id]]\n');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\n## Whole ^section-id\n\nFirst\n\nSecond\n\n## Next\nExcluded', 'forester-id: book-id\n') });
  await controller(h); const el = document.createElement('section'); el.innerHTML = '<div class="internal-embed" src="section-id"><p>First</p></div>';
  const line = source.split('\n').indexOf('![[section-id]]'); const ctx = h.context('Page.md', line, line);
  await h.plugin.postprocessors[0](el, ctx); await new Promise(setImmediate);
  assert.ok(el.querySelector('.hybrid-embed header')?.textContent.includes('Whole'));
  assert.ok(renders[0]?.source.includes('First\n\nSecond'));
  assert.equal(ctx.children.length, 1);
  const component = renders[0].component; ctx.children[0].unload(); assert.equal(component.loaded, false);
  h.plugin.unload();
});

test('nested native renders bound cycles, restore protected examples, and label raw Forester without execution', async () => {
  const h = createHarness({
    'Page.md': optin('# Page\n\n![[a-id]]\n\nEnd'),
    'A.md': optin('# A\n\n{ref:[[ref-id]]}\n\n![[b-id]]\n\n```forester\n![[b-id]]\n```\n\n> ![[b-id]]\n\n\\{\\title{<img src=x onerror=attack()>}}\n', 'forester-id: a-id\n'),
    'B.md': optin('# B\n\n![[a-id]]\n', 'forester-id: b-id\n'),
    'Ref.md': optin('# Ref', 'forester-id: ref-id\ncitation-authors: [Bates]\npublication-year: 2022\n')
  });
  // A native renderer mock accepts only the safe placeholders; no core logic is mocked.
  h.app.renderOverride = async (source, el) => { el.innerHTML = source; };
  await controller(h); const view = h.open('Page.md'); const state = view.editor.attach(h.plugin.extensions);
  const widget = spans(state, 'embed')[0].widget; const el = widget.toDOM({ dispatch() {}, focus() {} }); await new Promise(setImmediate);
  assert.equal(renders.length, 2, 'A and B each rendered once; cycle A is not reread');
  assert.ok(el.querySelector('.hybrid-error')?.textContent.includes('cycle'));
  assert.equal(el.querySelector('.hybrid-citation')?.textContent, '(Bates, 2022)');
  assert.equal(el.querySelector('.hybrid-raw-label')?.textContent, 'Forester · 未評価');
  assert.ok(el.querySelector('.hybrid-raw code')?.textContent.includes('<img src=x onerror=attack()>'));
  assert.equal(el.querySelector('img'), null, 'raw never flows into native HTML interpretation');
  assert.ok(renders[0].source.includes('```forester\n![[b-id]]\n```'));
  assert.ok(renders[0].source.includes('> ![[b-id]]'));
  assert.ok(!renders[0].source.includes('onerror'));
  const components = renders.map(r => r.component); widget.destroy(); assert.ok(components.every(c => !c.loaded)); h.plugin.unload();
});

test('deep embed chains stop at the adapter depth cap', async () => {
  const entries = { 'Page.md': optin('# Page\n\n![[chain-0]]\n\nEnd') };
  for (let i = 0; i < 20; i++) entries[`Chain${i}.md`] = optin(`# Chain ${i}\n\n![[chain-${i + 1}]]\n`, `forester-id: chain-${i}\n`);
  const h = createHarness(entries); h.app.renderOverride = async (source, el) => { el.innerHTML = source; }; await controller(h);
  const view = h.open('Page.md'); const state = view.editor.attach(h.plugin.extensions); const widget = spans(state, 'embed')[0].widget;
  const el = widget.toDOM({ dispatch() {}, focus() {} }); await new Promise(setImmediate);
  assert.ok(el.querySelector('.hybrid-error')?.textContent.includes('limit'));
  assert.ok(renders.length <= 12, 'bounded native render calls'); widget.destroy(); h.plugin.unload();
});

test('settled typing mints IDs and fixes heading refs through disk/editor CAS with minimal undoable edits', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n[[Book#Section|explicit label]]\n\n' + 'Unchanged text '.repeat(40) + '\nTail selected');
  const book = optin('# Book\n\n## Section\n\nFirst\n\nSecond');
  const h = createHarness({ 'Page.md': source, 'Book.md': book }); await controller(h);
  const targetView = h.open('Book.md'); const view = h.open('Page.md');
  view.editor.setSelections([{ anchor: view.editor.offsetToPos(source.indexOf('Tail')), head: view.editor.offsetToPos(source.length) }]);
  await h.workspace.emit('editor-change', view.editor, view);
  t.mock.timers.tick(1499); await new Promise(setImmediate); assert.equal(h.vault.processes.length, 0, 'no writes while typing');
  t.mock.timers.tick(501); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  const after = h.vault.data.get('Page.md'); const target = h.vault.data.get('Book.md');
  assert.match(after, /forester-id: (?:"?[0-9A-F]{6}"?)/);
  const id = /## Section \^([0-9A-F]{6})/.exec(target)?.[1]; assert.ok(id);
  assert.ok(after.includes(`[[Book#^${id}|explicit label]]`));
  assert.equal(view.editor.getValue(), after); assert.equal(targetView.editor.getValue(), target);
  assert.ok(view.editor.replacements.length >= 2, 'disjoint minimal changes, not a whole-document replace');
  assert.ok(view.editor.replacements.every(r => r.end - r.start < 80));
  const selected = view.editor.listSelections()[0]; assert.equal(after.slice(view.editor.posToOffset(selected.anchor), view.editor.posToOffset(selected.head)), 'Tail selected');
  assert.ok(view.editor.undoStack.length > 0);
  const count = h.vault.processes.length; t.mock.timers.tick(3000); for (let i = 0; i < 2; i++) await new Promise(setImmediate); assert.equal(h.vault.processes.length, count, 'own writes do not reenter');
  h.plugin.unload();
});

test('I/O failures and partial rollback are surfaced without a success notice', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n[[Book#Section]]'); const book = optin('# Book\n\n## Section\nBody');
  const h = createHarness({ 'Page.md': source, 'Book.md': book }); await controller(h); const view = h.open('Page.md');
  let targetAttempts = 0;
  h.vault.beforeProcess = async file => { if (file.path === 'Page.md') throw new Error('EIO source failed'); if (++targetAttempts > 1) throw new Error('EIO rollback denied'); };
  await h.workspace.emit('editor-change', view.editor, view); t.mock.timers.tick(2000); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.ok(notices.some(n => n.includes('EIO source failed')), 'report the original native I/O exception');
  assert.ok(notices.some(n => n.includes('partial rollback') && n.includes('Book.md')));
  assert.ok(!notices.some(n => /saved|success|保存完了/.test(n)));
  assert.equal(h.vault.data.get('Page.md'), source);
  assert.notEqual(h.vault.data.get('Book.md'), book, 'honestly report incomplete rollback');
  h.plugin.unload();
});

test('tree check reports local IDs, metadata, bibliography and protected reference errors without changing files', async () => {
  const h = createHarness({
    'Page.md': optin('# Page\n\n## Bad ^bad_id\n%% publication-year: [bad] %%\n\n{ref:[[unknown]]}\n\n[[Book#Duplicate]]\n\n```\n[[not-real]]\n```'),
    'Book.md': optin('# Book\n\n## Duplicate\nOne\n\n## Duplicate\nTwo')
  });
  await controller(h); h.open('Page.md');
  const before = new Map(h.vault.data);
  await h.plugin.commands.get('check-hybrid-trees').callback();
  assert.equal(modals.length, 1, 'explicit local report modal');
  const report = modals[0].contentEl.textContent;
  assert.ok(report.includes('invalid-id')); assert.ok(report.includes('invalid-metadata'));
  assert.ok(report.includes('missing-reference')); assert.ok(report.includes('ambiguous-reference'));
  assert.ok(!report.includes('not-real'), 'code examples are not active references');
  assert.deepEqual(h.vault.data, before); assert.equal(h.vault.processes.length, 0); h.plugin.unload();
});

test('public preview uses the real privacy projection but shows only counts/diagnostics with no automatic write or publish', async () => {
  const h = createHarness({
    'Public.md': optin('# Public\n\nVisible', 'forester-id: pub-id\npublish: true\n'),
    'Private.md': optin('# Secret title\n\nSecret body', 'forester-id: private-id\npublish: false\n')
  });
  await controller(h); await h.plugin.commands.get('preview-public-projection').callback();
  assert.equal(modals.length, 1);
  const report = modals[0].contentEl.textContent;
  assert.match(report, /1 public trees/); assert.match(report, /0 diagnostics/);
  assert.ok(!report.includes('Secret title')); assert.ok(!report.includes('Secret body'));
  assert.equal(modals[0].contentEl.querySelector('a, button, textarea'), null, 'no implicit copy/export action');
  assert.equal(h.vault.processes.length, 0);
  const source = h.vault.data.get('Public.md') + '\n![[private-id]]\n'; h.vault.data.set('Public.md', source); await h.app.metadataCache.emit('changed', h.vault.files.get('Public.md'), source, {});
  await h.plugin.commands.get('preview-public-projection').callback();
  assert.ok(modals[1].contentEl.textContent.includes('private-embed'));
  assert.match(modals[1].contentEl.textContent, /0 public trees/);
  h.plugin.unload();
});

test('Reading raw regions and forester fences are labelled/highlighted with safe text only', async () => {
  const source = optin('# Page\n\n\\{\\title{<img src=x onerror=attack()>}}\n');
  const h = createHarness({ 'Page.md': source }); h.app.renderOverride = async (s, el) => { el.innerHTML = s; }; await controller(h);
  const el = document.createElement('section'); el.innerHTML = '<p>{\\title{<img src="x">}}</p>';
  const line = source.split('\n').findIndex(s => s.startsWith('\\{'));
  const ctx = h.context('Page.md', line, line);
  await h.plugin.postprocessors[0](el, ctx); await new Promise(setImmediate);
  assert.equal(el.querySelector('.hybrid-raw-label')?.textContent, 'Forester · 未評価');
  assert.equal(el.querySelector('img'), null);
  assert.ok(el.querySelector('code')?.textContent.includes('<img src=x onerror=attack()>'));
  assert.equal(renders.length, 1);
  const code = document.createElement('div'); const handler = h.plugin.codeblocks.get('forester'); assert.equal(typeof handler, 'function');
  await handler('\\title{<script>attack()</script>} % comment', code, h.context('Page.md', line, line));
  assert.equal(code.querySelector('script'), null); assert.equal(code.querySelector('code').textContent, '\\title{<script>attack()</script>} % comment');
  assert.ok(code.querySelector('.hybrid-token-command'));
  assert.equal(code.querySelector('.hybrid-raw-label')?.textContent, 'Forester · 未評価');
  ctx.children.forEach(c => c.unload()); h.plugin.unload();
});

test('a dirty non-leaf native editor blocks every planned disk edit before preflight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n[[Book#Section]]'); const book = optin('# Book\n\n## Section\nBody');
  const h = createHarness({ 'Page.md': source, 'Book.md': book }); await controller(h);
  const canvasInfo = { file: h.vault.files.get('Book.md') }; canvasInfo.editor = new MockEditor(book + '\nUnsaved Canvas body', canvasInfo, h.plugin);
  canvasInfo.editor.attach(h.plugin.extensions, false, canvasInfo.editor.getValue(), 'Book.md');
  const view = h.open('Page.md'); await h.workspace.emit('editor-change', view.editor, view); t.mock.timers.tick(2000); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.equal(h.vault.processes.length, 0, 'not even the source note is edited');
  assert.equal(h.vault.data.get('Page.md'), source); assert.equal(h.vault.data.get('Book.md'), book);
  assert.ok(notices.some(n => n.includes('保存を中止')));
  h.plugin.unload();
});

test('rendered subtree descendants keep source-positioned badges and partial Reading passes do not renumber existing headings', async () => {
  const book = optin('# Book\n\n## Whole ^section-id\n#Claim\n\n### Child ^child-id\n#Lemma\n\nText\n\n## Second ^second-id\n#Claim\n\nEnd');
  const h = createHarness({ 'Page.md': optin('# Page\n\n![[section-id]]\n\nEnd'), 'Book.md': book });
  h.app.renderOverride = async (s, el) => { el.innerHTML = s.replace(/^### (.+)$/gm, '<h3>$1</h3>'); }; await controller(h);
  const view = h.open('Page.md'); const state = view.editor.attach(h.plugin.extensions); const widget = spans(state, 'embed')[0].widget;
  const embedded = widget.toDOM({ dispatch() {}, focus() {} }); await new Promise(setImmediate);
  assert.equal(embedded.querySelector('.hybrid-tree-body .hybrid-taxon-number')?.textContent.trim(), 'Lemma 1.1');
  assert.equal(embedded.querySelector('.hybrid-tree-body h3')?.getAttribute('data-hybrid-from'), String(book.indexOf('### Child')));
  const el = document.createElement('section'); el.innerHTML = '<h2>Whole</h2><h3>Child</h3><h2>Second</h2>';
  const ctx = h.context('Book.md', book.split('\n').indexOf('## Whole ^section-id'), book.split('\n').length - 1);
  await h.plugin.postprocessors[0](el, ctx); el.querySelectorAll('.hybrid-taxon-number')[2].remove(); await h.plugin.postprocessors[0](el, ctx);
  assert.deepEqual([...el.querySelectorAll('.hybrid-taxon-number')].map(e => e.textContent.trim()), ['Claim 1', 'Lemma 1.1', 'Claim 2']);
  widget.destroy(); h.plugin.unload();
});

test('user typing during an in-flight preflight is preserved and receives a fresh settled run', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n## Section\nOriginal'); const h = createHarness({ 'Page.md': source }); await controller(h); const view = h.open('Page.md');
  const read = h.vault.read; let release; let hold = true; const gate = new Promise(resolve => { release = resolve; });
  h.vault.read = async file => { if (hold) await gate; return read(file); };
  await h.workspace.emit('editor-change', view.editor, view); t.mock.timers.tick(2000); await new Promise(setImmediate);
  const fresh = source + '\nFresh typing'; view.editor.value = fresh; h.vault.data.set('Page.md', fresh);
  await h.workspace.emit('editor-change', view.editor, view); hold = false; release(); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.equal(h.vault.processes.length, 0, 'old preflight did not overwrite fresh typing');
  t.mock.timers.tick(2000); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.match(h.vault.data.get('Page.md'), /## Section \^[0-9A-F]{6}/, 'fresh typing receives its own settled save');
  assert.ok(view.editor.getValue().endsWith('Fresh typing')); h.plugin.unload();
});

test('disabled Markdown targets keep native embed scope instead of rendering their frontmatter as a hybrid tree', async () => {
  const plain = '---\nforester-mode: false\n---\n# Plain\n\n## Section\nNative body';
  const h = createHarness({ 'Page.md': optin('# Page\n\n![[Plain#Section]]\n\nEnd'), 'Native/Plain.md': plain }, { folders: [], excludedFolders: ['Native'], publicFolders: [], reservedIds: [] }); await controller(h);
  const view = h.open('Page.md'); const state = view.editor.attach(h.plugin.extensions); const widget = spans(state, 'embed')[0].widget;
  const el = widget.toDOM({ dispatch() {}, focus() {} }); await new Promise(setImmediate);
  assert.equal(renders[0]?.source, '![[Plain#Section]]', 'delegate ordinary target to the native Markdown renderer');
  assert.equal(renders[0]?.sourcePath, 'Page.md'); assert.equal(el.querySelector('header'), null);
  const section = document.createElement('section'); section.innerHTML = '<div class="internal-embed" src="Plain#Section">Native body</div>';
  const source = h.vault.data.get('Page.md'), line = source.split('\n').indexOf('![[Plain#Section]]'); const ctx = h.context('Page.md', line, line);
  await h.plugin.postprocessors[0](section, ctx); assert.equal(section.querySelector('.hybrid-embed'), null); assert.equal(ctx.children.length, 0);
  widget.destroy(); h.plugin.unload();
});

test('bare root/subtree ID links navigate safely in Reading and a scoped native Live Preview view', async () => {
  const source = optin('# Page\n\n[[book-id]] [[section-id|label]] [[Plain]] [[Book.md]]\n');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\n## Part ^section-id\nBody', 'forester-id: book-id\n'), 'Plain.md': '# Native' }); await controller(h);
  const line = source.split('\n').findIndex(s => s.startsWith('[[book-id]]'));
  const el = document.createElement('section'); el.innerHTML = '<p><a class="internal-link" data-href="book-id">book-id</a> <a class="internal-link" data-href="section-id">label</a> <a class="internal-link" data-href="Plain">Plain</a> <a class="internal-link" data-href="Book.md">Book.md</a></p>';
  await h.plugin.postprocessors[0](el, h.context('Page.md', line, line));
  const click = a => a.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  click(el.querySelector('[data-href="book-id"]')); assert.equal(h.workspace.opens.at(-1)?.[0], 'Book.md');
  click(el.querySelector('[data-href="section-id"]')); assert.equal(h.workspace.opens.at(-1)?.[0], 'Book.md#^section-id');
  assert.equal(el.querySelector('[data-href="section-id"]').textContent, 'label');
  const count = h.workspace.opens.length; click(el.querySelector('[data-href="Plain"]')); click(el.querySelector('[data-href="Book.md"]')); assert.equal(h.workspace.opens.length, count, 'native file links stay native');
  const view = h.open('Page.md'); const state = view.editor.attach(h.plugin.extensions);
  const dom = document.createElement('div'); dom.innerHTML = '<a class="internal-link" data-href="section-id">label</a>';
  // Instantiate the real registered ViewPlugin around the unavoidable Obsidian DOM shell.
  const lifecycle = h.plugin.extensions[0][1].create({ dom, state, posAtDOM: () => source.indexOf('section-id') });
  click(dom.querySelector('a')); assert.equal(h.workspace.opens.length, count + 1);
  assert.equal(h.workspace.opens.at(-1)[0], 'Book.md#^section-id');
  lifecycle.destroy(); click(dom.querySelector('a')); assert.equal(h.workspace.opens.length, count + 1, 'unload removes the scoped listener');
  h.vault.files.set('book-id.md', new TFile('book-id.md')); h.vault.data.set('book-id.md', '# Conflicting native file'); await h.vault.emit('create', h.vault.files.get('book-id.md'));
  click(el.querySelector('[data-href="book-id"]')); assert.equal(h.workspace.opens.length, count + 1, 'old DOM cannot navigate using a stale unambiguous index');
  assert.ok(notices.some(n => n.includes('multiple matches'))); h.plugin.unload();
});

test('settled saves fail closed for dirty snapshots, switched active editors, opt-outs and unload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const scenario of ['dirty-source', 'dirty-target', 'switched-editor', 'opt-out', 'unload']) {
    const source = optin('# Page\n\n[[Book#Section]]'), book = optin('# Book\n\n## Section\nBody');
    const h = createHarness({ 'Page.md': source, 'Book.md': book }); const c = await controller(h);
    if (scenario === 'dirty-target') h.open('Book.md', book + '\nUnsaved');
    const view = h.open('Page.md', scenario === 'dirty-source' ? source + '\nUnsaved' : source);
    await h.workspace.emit('editor-change', view.editor, view);
    if (scenario === 'switched-editor') h.open('Page.md');
    if (scenario === 'opt-out') { h.options.excludedFolders = ['/']; await c.refresh(); }
    if (scenario === 'unload') h.plugin.unload();
    t.mock.timers.tick(2100); for (let i = 0; i < 3; i++) await new Promise(setImmediate);
    assert.equal(h.vault.processes.length, 0, scenario); assert.equal(h.vault.data.get('Book.md'), book, scenario); h.plugin.unload();
  }
});

test('all plan snapshots are read before edit; a raced target rolls back source without clobbering remote changes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n[[Book#Section|label]]'), book = optin('# Book\n\n## Section\nBody');
  const h = createHarness({ 'Page.md': source, 'Book.md': book }); await controller(h); const view = h.open('Page.md');
  const reads = []; const read = h.vault.read, process = h.vault.process;
  h.vault.read = async file => { reads.push(`read:${file.path}`); return read(file); };
  h.vault.process = async (file, fn) => { reads.push(`write:${file.path}`); return process(file, fn); };
  h.vault.beforeProcess = async file => { if (file.path === 'Book.md') h.vault.data.set('Book.md', book + '\nRemote edit'); };
  await h.workspace.emit('editor-change', view.editor, view); t.mock.timers.tick(2000); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.deepEqual(reads.slice(0, reads.findIndex(e => e.startsWith('write:'))), ['read:Page.md', 'read:Book.md', 'read:Book.md'], 'all snapshots preflight before the target is resampled at the forward mutation boundary');
  assert.equal(h.vault.data.get('Page.md'), source); assert.equal(view.editor.getValue(), source);
  assert.equal(h.vault.data.get('Book.md'), book + '\nRemote edit'); assert.ok(notices.some(n => n.includes('保存を中止'))); h.plugin.unload();
});

test('settled planning never writes disabled referenced notes and native file links remain untouched', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n## Own\n[[Plain#Section|native label]]\n\n[[Plain]]'), plain = '# Plain\n\n## Section\nBody';
  const h = createHarness({ 'Page.md': source, 'Native/Plain.md': plain }, { folders: [], excludedFolders: ['Native'], publicFolders: [], reservedIds: [] }); await controller(h); const view = h.open('Page.md');
  await h.workspace.emit('editor-change', view.editor, view); t.mock.timers.tick(2000); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.deepEqual(h.vault.processes, ['Page.md']); assert.equal(h.vault.data.get('Native/Plain.md'), plain);
  assert.ok(h.vault.data.get('Page.md').includes('[[Plain#Section|native label]]\n\n[[Plain]]'));
  const el = document.createElement('section'); el.innerHTML = '<p><a class="internal-link" data-href="Plain">Plain</a></p>';
  const after = h.vault.data.get('Page.md'), line = after.split('\n').indexOf('[[Plain]]'); await h.plugin.postprocessors[0](el, h.context('Page.md', line, line));
  assert.equal(el.innerHTML, '<p><a class="internal-link" data-href="Plain">Plain</a></p>'); h.plugin.unload();
});

test('Live Preview source link clicks preserve editing and follow ID only with the native modifier', async () => {
  const source = optin('# Page\n\n[[section-id]]\n\nEnd'); const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\n## Part ^section-id\nBody') }); await controller(h);
  const view = h.open('Page.md'); const state = view.editor.attach(h.plugin.extensions);
  const dom = document.createElement('div'); dom.innerHTML = '<span class="cm-hmd-internal-link"><span class="cm-underline">section-id</span></span>';
  const native = { dom, state, posAtDOM: () => source.indexOf('section-id') };
  const lifecycle = h.plugin.extensions[0][1].create(native); const span = dom.querySelector('.cm-underline');
  span.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); assert.equal(h.workspace.opens.length, 0);
  const modified = new window.Event('click', { bubbles: true, cancelable: true }); Object.defineProperty(modified, 'ctrlKey', { value: true }); span.dispatchEvent(modified);
  assert.equal(h.workspace.opens.at(-1)?.[0], 'Book.md#^section-id');
  native.state = view.editor.attach(h.plugin.extensions, false); const sourceModeClick = new window.Event('click', { bubbles: true, cancelable: true }); Object.defineProperty(sourceModeClick, 'ctrlKey', { value: true }); span.dispatchEvent(sourceModeClick);
  assert.equal(h.workspace.opens.length, 1, 'Source mode remains native'); lifecycle.destroy(); h.plugin.unload();
});

test('plugin unload tears down Reading renderer owners and scoped ID listeners', async () => {
  const source = optin('# Page\n\n[[book-id]]\n\n![[section-id]]\n');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\n## Part ^section-id\nBody', 'forester-id: book-id\n') }); await controller(h);
  const el = document.createElement('section'); el.innerHTML = '<p><a class="internal-link" data-href="book-id">Book</a></p><div class="internal-embed" src="section-id">One block</div>';
  const ctx = h.context('Page.md', source.split('\n').indexOf('[[book-id]]'), source.split('\n').length - 1);
  await h.plugin.postprocessors[0](el, ctx); await new Promise(setImmediate);
  assert.ok(ctx.children.every(c => c.loaded)); assert.ok(renders[0].component.loaded);
  h.plugin.unload(); assert.ok(ctx.children.every(c => !c.loaded)); assert.equal(renders[0].component.loaded, false);
  el.querySelector('[data-href="book-id"]').dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(h.workspace.opens.length, 0); assert.equal(el.querySelector('[data-hybrid-link]'), null);
});

test('bare IDs inside a Reading tree embed resolve in the target path with renderer-owned click cleanup', async () => {
  const page = optin('# Page\n\n![[section-id]]\n');
  const h = createHarness({ 'Page.md': page, 'Book.md': optin('# Book\n\n## Section ^section-id\n\n[[other-id|Other]]\n'), 'Other.md': optin('# Other\nBody', 'forester-id: other-id\n') });
  h.app.renderOverride = async (s, el) => { el.innerHTML = s.replace(/\[\[other-id\|Other\]\]/g, '<a class="internal-link" data-href="other-id">Other</a>'); }; await controller(h);
  const el = document.createElement('section'); el.innerHTML = '<div class="internal-embed" src="section-id">One block</div>';
  const line = page.split('\n').indexOf('![[section-id]]'), ctx = h.context('Page.md', line, line);
  await h.plugin.postprocessors[0](el, ctx); await new Promise(setImmediate);
  const anchor = el.querySelector('[data-href="other-id"]'); anchor.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(h.workspace.opens.at(-1)?.[0], 'Other.md'); assert.equal(h.workspace.opens.at(-1)?.[1], 'Book.md');
  ctx.children[0].unload(); anchor.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); assert.equal(h.workspace.opens.length, 1); h.plugin.unload();
});

test('a protected source occurrence cannot inherit navigation permission from the same live ID elsewhere', async () => {
  const source = optin('# Page\n\n[[section-id]]\n\n$[[section-id]]$\n\nEnd');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\n## Part ^section-id\nBody') }); await controller(h);
  const view = h.open('Page.md'), state = view.editor.attach(h.plugin.extensions);
  const dom = document.createElement('div'); dom.innerHTML = '<span class="cm-hmd-internal-link">section-id</span>';
  const native = { dom, state, posAtDOM: () => source.lastIndexOf('section-id') };
  const lifecycle = h.plugin.extensions[0][1].create(native), event = new window.Event('click', { bubbles: true, cancelable: true }); Object.defineProperty(event, 'ctrlKey', { value: true });
  dom.querySelector('span').dispatchEvent(event); assert.equal(h.workspace.opens.length, 0, 'source offsets must authorize the clicked occurrence'); lifecycle.destroy(); h.plugin.unload();
});

test('CodeMirror/editor failures inside commit are reported rather than swallowed by rollback handling', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = createHarness({ 'Page.md': optin('# Page\n\n## Section\nBody') }); await controller(h); const view = h.open('Page.md');
  view.editor.replaceRange = () => { throw new Error('CodeMirror facet failed'); };
  await h.workspace.emit('editor-change', view.editor, view); t.mock.timers.tick(2000); for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.ok(notices.some(n => n.includes('CodeMirror facet failed')), 'show the original editor error');
  assert.ok(!notices.some(n => n.includes('partial rollback')), 'an unchanged editor does not block safe disk rollback');
  assert.equal(h.vault.data.get('Page.md'), view.editor.getValue()); h.plugin.unload();
});

test('recursive display resolution retains the current unsaved document overlay even when the source path changes', async () => {
  const disk = optin('# Page\n\nOld body');
  const unsaved = optin('# Page\n\n![[book-id]]\n\n## Unsaved child ^child-id\nBody');
  const h = createHarness({ 'Page.md': disk, 'Book.md': optin('# Book\n\n![[Page#Unsaved child]]\n', 'forester-id: book-id\n') }); const c = await controller(h);
  const view = h.open('Page.md', unsaved), state = view.editor.attach(h.plugin.extensions, true, unsaved);
  const context = c.current();
  const entries = c.outline(context.document, context.tree);
  assert.equal(entries[0]?.title, 'Book'); assert.equal(entries[0]?.children?.[0]?.title, 'Unsaved child', 'sidebar recursive resolver calls use the same unsaved overlay index');
  assert.equal(state.doc.toString(), unsaved); assert.equal(h.vault.data.get('Page.md'), disk); h.plugin.unload();
});

test('Reading heading badges agree with Live Preview occurrence numbering when an embed precedes a subtree', async () => {
  const source = optin('# Page\n\n![[book-id]]\n\n## Own ^own-id\n#Claim\n\nBody');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\nBody', 'forester-id: book-id\n') }); await controller(h);
  const view = h.open('Page.md'), state = view.editor.attach(h.plugin.extensions); let label;
  for (const ds of state.facet(EditorView.decorations)) if (typeof ds.between === 'function') ds.between(0, state.doc.length, (_from, _to, d) => { if (typeof d.spec.widget?.label === 'string') label = d.spec.widget.label; });
  assert.equal(label, 'Claim 2');
  const el = document.createElement('section'); el.innerHTML = '<h2>Own</h2><p>Body</p>'; const line = source.split('\n').indexOf('## Own ^own-id');
  await h.plugin.postprocessors[0](el, h.context('Page.md', line, source.split('\n').length - 1)); assert.equal(el.querySelector('.hybrid-taxon-number')?.textContent.trim(), label); h.plugin.unload();
});
