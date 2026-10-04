import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { createHarness, notices, renders, document, window, editorInfoField, editorLivePreviewField, MockEditor } from './controller-obsidian-mock.mjs';
import { HybridController } from './build/hybrid-controller.mjs';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';

const mainMock = fileURLToPath(new URL('./hybrid-main-obsidian.mjs', import.meta.url));
await build({ entryPoints: ['src/main.ts'], outfile: 'test/build/hybrid-second-review-main.mjs', bundle: true, platform: 'node', format: 'esm', external: ['@codemirror/state', '@codemirror/view'], plugins: [{ name: 'native-main-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mainMock, external: true })); } }] });
const { default: LegacyPlugin } = await import('./build/hybrid-second-review-main.mjs');


const optin = (body, extra = '') => `---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;
async function controller(h) { const c = new HybridController(h.plugin, h.getter); await c.initialize(); return c; }
async function drain() { for (let i = 0; i < 6; i++) await new Promise(setImmediate); }
async function save(t, h, view) { await h.workspace.emit('editor-change', view.editor, view); t.mock.timers.tick(2000); await drain(); }
const spans = (state, kind) => {
  const out = [];
  for (const ds of state.facet(EditorView.decorations)) if (typeof ds.between === 'function') ds.between(0, state.doc.length, (from, to, decoration) => {
    if (decoration.spec.widget?.span?.kind === kind) out.push({ from, to, widget: decoration.spec.widget });
  });
  return out;
};

// Exercise the actual adapter and Vault.process boundary, not a save-plan stand-in.
test('settled save writes referenced IDs before rewriting the source link', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n[[Book#Section|label]]');
  const book = optin('# Book\n\n## Section\nBody');
  const h = createHarness({ 'Page.md': source, 'Book.md': book });
  await controller(h);
  const target = h.open('Book.md'), view = h.open('Page.md');
  const snapshots = [];
  const process = h.vault.process;
  h.vault.process = async (file, fn) => { const result = await process(file, fn); snapshots.push(new Map(h.vault.data)); return result; };
  await save(t, h, view);
  assert.deepEqual(h.vault.processes, ['Book.md', 'Page.md'], 'source commits last');
  for (const snapshot of snapshots) {
    const id = /\[\[Book#\^([0-9A-F]{6})\|label\]\]/.exec(snapshot.get('Page.md'))?.[1];
    if (id) assert.ok(snapshot.get('Book.md').includes(`## Section ^${id}`), 'no rewritten link to an ID that is not on disk');
  }
  assert.equal(view.editor.getValue(), h.vault.data.get('Page.md'));
  assert.equal(target.editor.getValue(), h.vault.data.get('Book.md'));
  h.plugin.unload();
});

test('safe CAS rollback restores written targets after an active-note switch or unload', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const interrupted of ['switch', 'unload']) {
    const source = optin('# Page\n\n[[Book#Section|label]]'), book = optin('# Book\n\n## Section\nBody');
    const h = createHarness({ 'Page.md': source, 'Book.md': book, 'Other.md': '# Other' });
    await controller(h);
    const target = h.open('Book.md'), view = h.open('Page.md');
    h.vault.beforeProcess = async file => {
      if (file.path !== 'Page.md') return;
      assert.notEqual(h.vault.data.get('Book.md'), book, 'target was already committed');
      if (interrupted === 'switch') h.open('Other.md'); else h.plugin.unload();
    };
    await save(t, h, view);
    assert.equal(h.vault.data.get('Page.md'), source, `${interrupted}: no new source edit`);
    assert.equal(h.vault.data.get('Book.md'), book, `${interrupted}: rollback remains permitted`);
    assert.equal(view.editor.getValue(), source);
    assert.equal(target.editor.getValue(), book);
    assert.deepEqual(h.vault.processes, ['Book.md', 'Page.md', 'Book.md']);
    assert.ok(!notices.some(n => n.includes('partial rollback')), 'changing active state is not a rollback conflict');
    h.plugin.unload();
  }
});

test('interrupting post-write IO does not start a new forward editor edit', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const interrupted of ['switch', 'unload']) {
    const source = optin('# Page\n\n[[Book#Section]]'), book = optin('# Book\n\n## Section\nBody');
    const h = createHarness({ 'Page.md': source, 'Book.md': book, 'Other.md': '# Other' });
    await controller(h);
    const target = h.open('Book.md'), view = h.open('Page.md');
    const process = h.vault.process;
    let first = true;
    h.vault.process = async (file, fn) => {
      const result = await process(file, fn);
      if (file.path === 'Book.md' && first) {
        first = false;
        if (interrupted === 'switch') h.open('Other.md'); else h.plugin.unload();
      }
      return result;
    };
    await save(t, h, view);
    assert.equal(target.editor.replacements.length, 0, 'unchanged editor needs no forward or rollback patch after interruption');
    assert.equal(h.vault.data.get('Book.md'), book, 'restore exact written disk snapshot despite already-original editor');
    assert.equal(h.vault.data.get('Page.md'), source);
    assert.ok(!notices.some(n => n.includes('partial rollback')));
    h.plugin.unload();
  }
});

test('legacy vault retargeting excludes opt-in sources using current raw text, not stale caches', async () => {
  const protectedBody = '# Hybrid\n\n[[Book#Part]]\n$[[Book#Part]]$\n\\{ [[Book#Part]] }';
  const hybrid = optin(protectedBody), ordinary = '# Plain\n\n[[Book#Part]]';
  const disabled = optin(ordinary).replace('hybrid-v1', 'false');
  const folder = protectedBody;
  const h = createHarness({ 'Hybrid.md': hybrid, 'Trees/Folder.md': folder, 'Plain.md': ordinary, 'Disabled.md': disabled, 'Book.md': '# Book\n\n## Part ^ABCD01\nBody' }, { folders: ['Trees'], publicFolders: [], reservedIds: [] });
  const c = await controller(h);
  const legacy = new LegacyPlugin(h.app);
  legacy.hybridController = c;
  h.app.metadataCache.getFirstLinkpathDest = path => h.vault.files.get(`${path}.md`) ?? null;
  legacy.sources = new Map(h.vault.data);
  legacy.sources.set('Hybrid.md', '# Old ordinary cache');
  legacy.sources.set('Disabled.md', optin(ordinary));
  const fixed = await legacy.retargetVault();
  assert.equal(h.vault.data.get('Hybrid.md'), hybrid, 'math/raw/live links in hybrid source are all owned by hybrid');
  assert.equal(h.vault.data.get('Trees/Folder.md'), folder, 'folder opt-in is excluded too');
  assert.equal(h.vault.data.get('Plain.md'), ordinary.replace('[[Book#Part]]', '[[ABCD01]]'));
  assert.equal(h.vault.data.get('Disabled.md'), disabled.replace('[[Book#Part]]', '[[ABCD01]]'), 'current explicit opt-out retains legacy behavior');
  assert.equal(fixed, 2);
  h.plugin.unload();
});

test('legacy referenced-heading minting never writes an opt-in target', async () => {
  const source = '# Page\n\n[[Hybrid#Part]] [[Plain#Part]]';
  const hybrid = optin('# Hybrid\n\n## Part\nBody'), plain = '# Plain\n\n## Part\nBody';
  const h = createHarness({ 'Page.md': source, 'Hybrid.md': hybrid, 'Plain.md': plain });
  const c = await controller(h), legacy = new LegacyPlugin(h.app);
  legacy.hybridController = c;
  legacy.sources = new Map(h.vault.data);
  legacy.sources.set('Hybrid.md', '# Stale\n\n## Part\nBody');
  h.app.metadataCache.getFirstLinkpathDest = path => h.vault.files.get(`${path}.md`) ?? null;
  h.app.metadataCache.getFileCache = file => ({ headings: [{ level: 1, heading: file.basename }] });
  const minted = await legacy.addressReferencedHeadings(h.vault.files.get('Page.md'), () => 'A0BC01');
  assert.equal(h.vault.data.get('Hybrid.md'), hybrid, 'legacy does not mint a heading even when its cache predates opt-in');
  assert.equal(h.vault.data.get('Plain.md'), plain.replace('## Part', '## Part ^A0BC01'));
  assert.equal(minted, 1);
  assert.deepEqual(h.vault.processes, ['Plain.md']);
  h.plugin.unload();
});

test('legacy note-address command skips current opt-in Markdown but still mints disabled notes', async () => {
  const hybrid = optin('# Hybrid'), disabled = optin('# Disabled').replace('hybrid-v1', 'false');
  const h = createHarness({ 'Hybrid.md': hybrid, 'Disabled.md': disabled });
  const c = await controller(h), legacy = new LegacyPlugin(h.app);
  legacy.hybridController = c;
  legacy.sources = new Map(h.vault.data);
  h.app.metadataCache.getFileCache = () => ({ frontmatter: {} });
  const frontmatterWrites = [];
  h.app.fileManager = { processFrontMatter: async (file, mutate) => { const frontmatter = {}; mutate(frontmatter); frontmatterWrites.push({ path: file.path, frontmatter }); } };
  await legacy.mintNoteAddress(h.vault.files.get('Hybrid.md'));
  assert.equal(frontmatterWrites.length, 0, 'no legacy id frontmatter write to opt-in note');
  await legacy.mintNoteAddress(h.vault.files.get('Disabled.md'));
  assert.equal(frontmatterWrites.length, 1);
  assert.equal(frontmatterWrites[0].path, 'Disabled.md');
  assert.ok(frontmatterWrites[0].frontmatter.id);
  h.plugin.unload();
});

test('legacy subtree-address command preserves opt-in editor text, including unsaved opt-in', async () => {
  const hybrid = optin('# Hybrid\n\n## Part\nBody'), disk = '# Draft\n\n## Part\nBody';
  const h = createHarness({ 'Hybrid.md': hybrid, 'Draft.md': disk, 'Disabled.md': hybrid.replace('hybrid-v1', 'false') });
  const c = await controller(h), legacy = new LegacyPlugin(h.app);
  legacy.hybridController = c; legacy.sources = new Map(h.vault.data);
  h.app.metadataCache.getFileCache = () => ({ frontmatter: {} });
  const setup = (path, text) => {
    const view = h.open(path, text), editor = view.editor;
    editor.getLine = line => editor.getValue().split('\n')[line];
    editor.setLine = (line, replacement) => editor.replaceRange(replacement, { line, ch: 0 }, { line, ch: editor.getLine(line).length });
    return view;
  };
  for (const [path, text] of [['Hybrid.md', hybrid], ['Draft.md', optin(disk)]]) {
    const view = setup(path, text);
    // Wait for the command's saved-source ownership read; keep the original mutation assertions.
    await legacy.mintSubtreeAddress(view.editor, view.file);
    assert.equal(view.editor.getValue(), text, `${path}: extension ownership is based on current editor source`);
  }
  const disabled = h.vault.data.get('Disabled.md'), view = setup('Disabled.md', disabled);
  // The same async ownership check must finish before checking ordinary-note minting.
  await legacy.mintSubtreeAddress(view.editor, view.file);
  assert.notEqual(view.editor.getValue(), disabled, 'explicitly disabled note retains ordinary minting');
  h.plugin.unload();
});

test('legacy linter excludes an unsaved opt-in source before frontmatter or body writes', async () => {
  const disk = '# Draft\n\n<!-- id -->\n\n## Part\nBody', unsaved = optin(disk);
  const h = createHarness({ 'Draft.md': disk });
  const c = await controller(h), legacy = new LegacyPlugin(h.app);
  legacy.hybridController = c; legacy.sources = new Map(h.vault.data);
  const view = h.open('Draft.md', unsaved);
  h.app.metadataCache.getFileCache = () => ({ frontmatter: {} });
  const writes = [];
  h.app.fileManager = { processFrontMatter: async (file, fn) => { writes.push(file.path); fn({}); } };
  await legacy.lintActiveNote('notes');
  assert.equal(writes.length, 0, 'editor opt-in cannot wait for a metadata-cache event');
  assert.equal(h.vault.processes.length, 0);
  assert.equal(h.vault.data.get('Draft.md'), disk);
  assert.equal(view.editor.getValue(), unsaved);
  await legacy.mintNoteAddress(view.file);
  assert.equal(writes.length, 0, 'explicit note command uses the same ownership gate');
  h.plugin.unload();
});

test('Reading repeated target embeds consume independent DOM occurrences and keep local ht flags', async () => {
  const source = optin('# Page\n\n![[book-id]] %%ht%%\n\n![[book-id]]\n');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\nComplete body', 'forester-id: book-id\n') });
  await controller(h);
  const el = document.createElement('section');
  el.innerHTML = '<div class="internal-embed" src="book-id">Native first</div><div class="internal-embed" src="book-id">Native second</div>';
  const ctx = h.context('Page.md', source.split('\n').indexOf('![[book-id]] %%ht%%'), source.split('\n').length - 1);
  await h.plugin.postprocessors[0](el, ctx); await drain();
  const wrappers = [...el.querySelectorAll('.hybrid-embed')];
  assert.equal(wrappers.length, 2, 'each source occurrence consumes one unique native element');
  assert.equal(wrappers[0].getAttribute('data-toc'), 'false');
  assert.equal(wrappers[0].querySelector('header'), null, 'h belongs only to the first occurrence');
  assert.equal(wrappers[1].getAttribute('data-toc'), 'true');
  assert.ok(wrappers[1].querySelector('header')?.textContent.includes('Book'));
  assert.equal(renders.length, 2);
  assert.ok(renders.every(r => r.component.loaded && el.contains(r.el)), 'no live renderer is already detached');
  h.plugin.unload();
  assert.ok(renders.every(r => !r.component.loaded));
});

test('Reading embed rerenders are idempotent and unload removed renderer owners before replacement', async () => {
  const source = optin('# Page\n\n![[book-id]] %%ht%%\n\n![[book-id]]\n');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\nBody', 'forester-id: book-id\n') });
  const c = await controller(h), process = h.plugin.postprocessors[0];
  const el = document.createElement('section');
  el.innerHTML = '<div class="internal-embed" src="book-id"></div><div class="internal-embed" src="book-id"></div>';
  const ctx = h.context('Page.md', source.split('\n').indexOf('![[book-id]] %%ht%%'), source.split('\n').length - 1);
  for (let i = 0; i < 3; i++) { await process(el, ctx); await drain(); }
  assert.equal(renders.length, 2, 'same occurrences reuse their renderer children');
  assert.equal(ctx.children.filter(child => child.loaded).length, 2);
  const first = el.querySelector('.hybrid-managed-embed'), second = el.querySelectorAll('.hybrid-managed-embed')[1];
  const firstOwner = renders[0].component;
  first.replaceChildren(document.createTextNode('Native rerender'));
  h.app.renderOverride = async (source, body) => { assert.equal(firstOwner.loaded, false, 'old detached owner is unloaded before the new native render'); body.textContent = source; };
  await process(el, ctx); await drain();
  assert.equal(renders.length, 3);
  assert.equal(renders[1].component.loaded, true, 'independent sibling is not destroyed');
  first.remove();
  await process(el, ctx); await drain();
  assert.equal(renders[2].component.loaded, false, 'removed native occurrence loses its renderer owner');
  assert.equal(second.querySelector('.hybrid-embed').getAttribute('data-toc'), 'true', 'partial pass does not transfer first occurrence flags to the second');
  assert.ok(renders.filter(r => r.component.loaded).every(r => el.contains(r.el)));
  const oldOwners = renders.map(r => r.component);
  const changedBook = h.vault.data.get('Book.md') + '\nUpdated dependency.';
  h.vault.data.set('Book.md', changedBook);
  await h.app.metadataCache.emit('changed', h.vault.files.get('Book.md'), changedBook, {});
  await c.refresh();
  await process(el, ctx); await drain();
  assert.ok(oldOwners.every(component => !component.loaded), 'dependency generation change tears down old renderer owners');
  h.plugin.unload();
  assert.ok(ctx.children.every(child => !child.loaded));
  assert.ok(renders.every(r => !r.component.loaded));
});

test('real CodeMirror Compartment mode reconfiguration removes hybrid decorations without a document or cursor edit', async () => {
  const source = optin('# Page\n\n{ref:[[book-id]]}\n\n![[book-id]]\n\nEnd');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\nBody', 'forester-id: book-id\ncitation-authors: [Bates]\npublication-year: 2022\n') });
  await controller(h);
  const view = h.open('Page.md'), mode = new Compartment();
  let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [editorInfoField.init(() => ({ file: view.file, editor: view.editor })), mode.of(editorLivePreviewField.init(() => true)), h.plugin.extensions] });
  assert.equal(spans(state, 'citation').length, 1);
  assert.equal(spans(state, 'embed').length, 1);
  const selection = state.selection;
  // The Obsidian fields are unavoidable boundary mocks; Compartment/transactions/decorations are real CM.
  let tr = state.update({ effects: mode.reconfigure([]) });
  assert.equal(tr.docChanged, false); assert.equal(tr.reconfigured, true);
  state = tr.state;
  state = state.update({ effects: mode.reconfigure(editorLivePreviewField.init(() => false)) }).state;
  assert.equal(state.field(editorLivePreviewField), false);
  assert.equal(state.selection.eq(selection), true);
  assert.equal(state.doc.toString(), source);
  assert.equal(spans(state, 'citation').length, 0, 'Source mode must not retain a stale citation widget');
  assert.equal(spans(state, 'embed').length, 0, 'Source mode exposes native source, not stale embed replacements');
  assert.ok(state.facet(EditorView.decorations).every(ds => typeof ds.between !== 'function' || ds.size === 0));
  state = state.update({ effects: mode.reconfigure([]) }).state;
  state = state.update({ effects: mode.reconfigure(editorLivePreviewField.init(() => true)) }).state;
  assert.equal(spans(state, 'citation').length, 1, 'Live Preview can return with identical text and cursor');
  h.plugin.unload();
});

test('Live Preview capture ignores links inside a native disabled embed and other read-only rendered contexts', async () => {
  const source = optin('# Page\n\n[[book-id]]\n\n![[Plain]]\n\nEnd');
  const plain = '---\nforester-mode: false\n---\n# Plain\n\n[[book-id]]';
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\nBody', 'forester-id: book-id\n'), 'Plain.md': plain });
  const c = await controller(h), view = h.open('Page.md'), state = view.editor.attach(h.plugin.extensions);
  assert.equal(c.isEnabled('Plain.md'), false);
  const dom = document.createElement('div');
  dom.innerHTML = '<div class="cm-line"><a class="internal-link" data-href="book-id">Live source</a></div><div class="internal-embed" src="Plain"><div class="markdown-embed-content"><a class="internal-link" data-href="book-id">Disabled native content</a></div></div><div class="markdown-rendered"><a class="internal-link" data-href="book-id">Read only</a></div>';
  const native = { dom, state, posAtDOM: () => source.indexOf('book-id') };
  const lifecycle = h.plugin.extensions[0][1].create(native);
  for (const link of dom.querySelectorAll('.internal-embed a, .markdown-rendered a')) {
    const event = new window.Event('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'a different rendered document cannot inherit the Page occurrence permission');
    assert.equal(h.workspace.opens.length, 0);
  }
  const event = new window.Event('click', { bubbles: true, cancelable: true });
  dom.querySelector('.cm-line a').dispatchEvent(event);
  assert.equal(event.defaultPrevented, true, 'data-href bare ID helper remains active for its own source occurrence');
  assert.equal(h.workspace.opens.at(-1)?.[0], 'Book.md');
  assert.equal(h.workspace.opens.at(-1)?.[1], 'Page.md');
  lifecycle.destroy(); h.plugin.unload();
});

test('Live Preview anchor authorization uses the clicked source occurrence, never any matching ID elsewhere', async () => {
  const source = optin('# Page\n\n[[book-id|Live]]\n\n$[[book-id]]$\n\n[[other-id]]\n\nEnd');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book', 'forester-id: book-id\n'), 'Other.md': optin('# Other', 'forester-id: other-id\n') });
  await controller(h); const view = h.open('Page.md'), state = view.editor.attach(h.plugin.extensions);
  const dom = document.createElement('div');
  dom.innerHTML = '<a class="internal-link" data-href="book-id">Live</a>';
  let position = source.lastIndexOf('book-id');
  const native = { dom, state, posAtDOM: () => { if (position === null) throw new Error('not in the CM source DOM'); return position; } };
  const lifecycle = h.plugin.extensions[0][1].create(native), link = dom.querySelector('a');
  for (const at of [source.lastIndexOf('book-id'), source.indexOf('other-id'), null]) {
    position = at;
    const event = new window.Event('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'protected, mismatched and unbound anchors remain native');
    assert.equal(h.workspace.opens.length, 0);
  }
  position = source.indexOf('book-id');
  const event = new window.Event('click', { bubbles: true, cancelable: true });
  link.dispatchEvent(event);
  assert.equal(event.defaultPrevented, true);
  assert.equal(h.workspace.opens.at(-1)?.[0], 'Book.md');
  lifecycle.destroy(); h.plugin.unload();
});

test('rollback after unload retains non-leaf editor concurrency checks from the save preflight', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n[[Book#Section]]'), book = optin('# Book\n\n## Section\nBody');
  const h = createHarness({ 'Page.md': source, 'Book.md': book });
  await controller(h);
  const canvas = { file: h.vault.files.get('Book.md') };
  canvas.editor = new MockEditor(book, canvas, h.plugin);
  canvas.editor.attach(h.plugin.extensions, false, book, 'Book.md');
  const view = h.open('Page.md');
  let writtenTarget, dirtyTarget;
  h.vault.beforeProcess = async file => {
    if (file.path !== 'Page.md') return;
    writtenTarget = h.vault.data.get('Book.md');
    canvas.editor.replaceRange('\nFresh Canvas typing', canvas.editor.offsetToPos(canvas.editor.getValue().length));
    dirtyTarget = canvas.editor.getValue();
    h.plugin.unload();
  };
  await save(t, h, view);
  assert.equal(h.vault.data.get('Page.md'), source, 'no source rewrite after unload');
  assert.equal(h.vault.data.get('Book.md'), writtenTarget, 'cleanup cannot ignore a dirty non-leaf editor when unregistering views');
  assert.equal(canvas.editor.getValue(), dirtyTarget, 'concurrent user typing is never patched over');
  assert.ok(notices.some(n => n.includes('partial rollback') && n.includes('Book.md')), 'this is a genuine concurrent-editor rollback conflict');
});

test('mixed Reading sections reuse ID-link children and release detached links on a partial native rerender', async () => {
  const source = optin('# Page\n\n[[book-id]]\n\n![[book-id]]\n');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\nBody', 'forester-id: book-id\n') });
  await controller(h);
  const el = document.createElement('section');
  el.innerHTML = '<p><a class="internal-link" data-href="book-id">Book</a></p><div class="internal-embed" src="book-id"></div>';
  const ctx = h.context('Page.md', source.split('\n').indexOf('[[book-id]]'), source.split('\n').length - 1), process = h.plugin.postprocessors[0];
  for (let i = 0; i < 3; i++) { await process(el, ctx); await drain(); }
  assert.equal(ctx.children.filter(child => child.loaded).length, 2, 'one ID-link owner plus one independent embed owner, not an empty new owner on every pass');
  assert.equal(renders.length, 1);
  const detached = el.querySelector('a'), replacement = detached.cloneNode(true);
  replacement.removeAttribute('data-hybrid-link');
  detached.replaceWith(replacement);
  await process(el, ctx); await drain();
  assert.equal(ctx.children.filter(child => child.loaded).length, 2);
  detached.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(h.workspace.opens.length, 0, 'partial native replacement removes the old ID listener');
  replacement.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(h.workspace.opens.length, 1);
  h.plugin.unload();
  const count = ctx.children.length;
  await process(el, ctx); await drain();
  assert.equal(ctx.children.length, count, 'stale postprocessor callbacks cannot allocate new children after unload');
  assert.ok(ctx.children.every(child => !child.loaded));
});

test('rollback after unload never restores over a concurrently modified disk snapshot', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const source = optin('# Page\n\n[[Book#Section|label]]'), book = optin('# Book\n\n## Section\nBody');
  const h = createHarness({ 'Page.md': source, 'Book.md': book });
  await controller(h); const target = h.open('Book.md'), view = h.open('Page.md');
  let remote;
  h.vault.beforeProcess = async file => {
    if (file.path !== 'Page.md') return;
    remote = h.vault.data.get('Book.md') + '\nRemote sync edit';
    h.vault.data.set('Book.md', remote);
    h.plugin.unload();
  };
  await save(t, h, view);
  assert.equal(h.vault.data.get('Page.md'), source);
  assert.equal(h.vault.data.get('Book.md'), remote);
  assert.ok(!target.editor.getValue().includes('Remote sync edit'), 'conflicted disk restore never patches an unrelated editor snapshot');
  assert.ok(notices.some(n => n.includes('partial rollback') && n.includes('Book.md')));
});

test('controller-owned Live Preview embeds keep their bound target path while nested disabled embeds stay native', async () => {
  const source = optin('# Page\n\n[[other-id]]\n\n![[book-id]]\n\nEnd');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book\n\n[[other-id|Other]]\n\n![[Plain]]', 'forester-id: book-id\n'), 'Other.md': optin('# Other', 'forester-id: other-id\n'), 'Plain.md': '# Plain\n\n[[other-id]]' });
  h.app.renderOverride = async (text, el) => {
    el.innerHTML = text === '![[Plain]]' ? '<div class="internal-embed" src="Plain"><a class="internal-link" data-href="other-id">Native disabled</a></div>' : text.replace('[[other-id|Other]]', '<a class="internal-link" data-href="other-id">Owned Other</a>');
  };
  await controller(h); const view = h.open('Page.md'), state = view.editor.attach(h.plugin.extensions);
  const widget = spans(state, 'embed')[0].widget, embedded = widget.toDOM({ dispatch() {}, focus() {} });
  await drain();
  const dom = document.createElement('div'); dom.append(embedded);
  const lifecycle = h.plugin.extensions[0][1].create({ dom, state, posAtDOM: () => source.indexOf('other-id') });
  const plain = embedded.querySelector('.internal-embed a'), owned = embedded.querySelector('[data-hybrid-link]');
  assert.ok(plain); assert.ok(owned);
  const nativeEvent = new window.Event('click', { bubbles: true, cancelable: true }); plain.dispatchEvent(nativeEvent);
  assert.equal(nativeEvent.defaultPrevented, false); assert.equal(h.workspace.opens.length, 0);
  owned.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(h.workspace.opens.at(-1)?.[0], 'Other.md');
  assert.equal(h.workspace.opens.at(-1)?.[1], 'Book.md', 'owned navigation uses the embed target source path, not the host Page');
  widget.destroy();
  owned.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true }));
  assert.equal(h.workspace.opens.length, 1, 'destroyed renderer listeners cannot reopen stale targets');
  lifecycle.destroy(); h.plugin.unload();
});

test('real CodeMirror host-field reconfiguration clears decorations for a non-Markdown host', async () => {
  const source = optin('# Page\n\n{ref:[[book-id]]}\n\nEnd');
  const h = createHarness({ 'Page.md': source, 'Book.md': optin('# Book', 'forester-id: book-id\ncitation-authors: [Bates]\npublication-year: 2022\n') });
  await controller(h); const view = h.open('Page.md'), host = new Compartment();
  let state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [host.of(editorInfoField.init(() => ({ file: view.file, editor: view.editor }))), editorLivePreviewField.init(() => true), h.plugin.extensions] });
  assert.equal(spans(state, 'citation').length, 1);
  state = state.update({ effects: host.reconfigure([]) }).state;
  state = state.update({ effects: host.reconfigure(editorInfoField.init(() => ({ file: null, editor: view.editor }))) }).state;
  assert.equal(state.doc.toString(), source);
  assert.equal(state.selection.main.anchor, source.length);
  assert.equal(spans(state, 'citation').length, 0, 'applicability change is independent of document edits');
  h.plugin.unload();
});
