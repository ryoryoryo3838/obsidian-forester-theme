import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EditorView } from '@codemirror/view';
import { createHarness, document, TFile, notices, modals } from './controller-obsidian-mock.mjs';

// Instrument entry counts in the real core, not replacement parser/index behavior.
// Only Obsidian's unavailable runtime/IO uses the existing native boundary mock.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = fileURLToPath(new URL('./build/startup-controller/', import.meta.url));
const mock = fileURLToPath(new URL('./controller-obsidian-mock.mjs', import.meta.url));
mkdirSync(out, { recursive: true });
const instrumentation = {
  name: 'real-core-operation-counts',
  setup(b) {
    b.onLoad({ filter: /[/\\]hybrid-core\.ts$/ }, args => {
      let contents = readFileSync(args.path, 'utf8');
      for (const [name, statement] of [
        ['parseHybrid', 'globalThis.__startupControllerCounts?.parses.push(path);'],
        ['indexHybrid', 'if (globalThis.__startupControllerCounts) globalThis.__startupControllerCounts.indexes++;'],
      ]) {
        const signature = new RegExp(`export function ${name}\\([^\\n]+\\{`);
        assert.match(contents, signature, `instrument real ${name} entry`);
        contents = contents.replace(signature, signature => `${signature}\n${statement}`);
      }
      return { contents, loader: 'ts' };
    });
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true }));
  },
};
await build({ absWorkingDir: root, stdin: { contents: "export { HybridController } from './src/hybrid-controller.ts'; export { planHybridSave, resolveHybrid } from './src/hybrid-core.ts';", resolveDir: root, sourcefile: 'startup-controller-entry.ts' }, bundle: true, platform: 'node', format: 'esm', outfile: `${out}/hybrid-controller.mjs`, external: ['@codemirror/state', '@codemirror/view'], plugins: [instrumentation] });
const { HybridController, planHybridSave, resolveHybrid } = await import('./build/startup-controller/hybrid-controller.mjs');
const mainMock = fileURLToPath(new URL('./hybrid-main-obsidian.mjs', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['src/main.ts'], bundle: true, platform: 'node', format: 'esm', outfile: `${out}/hybrid-main.mjs`, external: ['@codemirror/state', '@codemirror/view'], plugins: [
  { name: 'native-main-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mainMock, external: true })); } }, instrumentation,
] });
const { default: LegacyPlugin } = await import('./build/startup-controller/hybrid-main.mjs');
const optin = (body, extra = '') => `---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;
const counts = () => globalThis.__startupControllerCounts = { parses: [], indexes: 0 };
async function start(entries, options) {
  const h = createHarness(entries, options);
  const c = new HybridController(h.plugin, h.getter);
  await c.initialize();
  return { h, c };
}
const spans = (state, kind) => {
  const out = [];
  for (const decorations of state.facet(EditorView.decorations)) if (typeof decorations.between === 'function') {
    decorations.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget?.span?.kind === kind) out.push(decoration.spec.widget.span);
    });
  }
  return out;
};
test('activation uses current header/settings without body parse or vault overlay', async () => {
  const { h, c } = await start({ 'Plain.md': '# Plain', 'Trees/Plain.md': '# Folder' });
  try {
    const observed = counts();
    const richBody = 'text `code` text $x$. '.repeat(6400);
    for (let n = 0; n < 20; n++) {
      assert.equal(c.isEnabled('Plain.md', richBody), true);
      assert.equal(c.isEnabled('Plain.md', optin(richBody)), true, 'explicit frontmatter still opts in with no folders');
      assert.equal(c.isEnabled('Plain.md', '---\nforester-mode: true\n---\n' + richBody), true);
      assert.equal(c.isEnabled('Plain.md', '---\nforester-mode: hybrid-v0\n---\n' + richBody), true, 'legacy mode is metadata, not scope');
    }
    h.options.folders.push('Trees');
    assert.equal(c.isEnabled('Trees/Plain.md'), true, 'in-place config edit is current');
    for (const mode of ['false', 'unknown', 'hybrid-v0']) assert.equal(c.isEnabled('Trees/Plain.md', `---\nforester-mode: ${mode}\n---\n${richBody}`), true);
    h.options.excludedFolders = ['Trees']; assert.equal(c.isEnabled('Trees/Plain.md', richBody), false);
    assert.equal(c.isEnabled('Missing.md'), false);
    assert.equal(observed.parses.length, 0, 'ownership checks must not call full parseHybrid');
    assert.equal(observed.indexes, 0);
  } finally { h.plugin.unload(); }
});

test('500/1000-note identical metadata storms are no-ops; changed batches parse only latest sources', async () => {
  for (const size of [500, 1000]) {
    const entries = Object.fromEntries(Array.from({ length: size }, (_, n) => [`Plain${n}.md`, '# Plain\n\n' + 'Ordinary prose. '.repeat(60)]));
    const { h, c } = await start(entries);
    try {
      let observed = counts();
      const revision = c.revision;
      h.vault.reads.length = 0;
      await Promise.all(Array.from({ length: 20 }, () => h.app.metadataCache.emit('changed', h.vault.files.get('Plain0.md'), entries['Plain0.md'], {})));
      assert.equal(observed.parses.length, 0, `${size}: equal-source notifications cannot reparse the vault`);
      assert.equal(observed.indexes, 0, `${size}: stable inputs cannot rebuild index`);
      assert.equal(c.revision, revision, `${size}: stable revision prevents Reading embed churn`);
      assert.equal(h.vault.reads.length, 0);

      observed = counts();
      const batches = [];
      for (let n = 0; n < 20; n++) {
        const path = `Plain${n % 3}.md`, source = entries[path] + `\nChange ${n}`;
        h.vault.data.set(path, source);
        batches.push(h.app.metadataCache.emit('changed', h.vault.files.get(path), source, {}));
      }
      await Promise.all(batches);
      assert.deepEqual(observed.parses.sort(), ['Plain0.md', 'Plain1.md', 'Plain2.md'], `${size}: reuse unaffected parse snapshots`);
      assert.equal(observed.indexes, 1, `${size}: one index for a same-turn burst`);
      assert.equal(c.revision, revision + 1);
      for (const n of [0, 1, 2]) assert.equal(c.index.documents.get(`Plain${n}.md`).source, h.vault.data.get(`Plain${n}.md`));

      observed = counts();
      await Promise.all(Array.from({ length: 20 }, () => h.vault.emit('modify', h.vault.files.get('Plain0.md'))));
      assert.equal(h.vault.reads.length, 1, `${size}: source-less events share one read`);
      assert.equal(observed.parses.length, 0, `${size}: read equality retains parsed document`);
      assert.equal(observed.indexes, 0);
      assert.equal(c.revision, revision + 1);
    } finally { h.plugin.unload(); }
  }
});

test('disabled Live Preview never parses/builds an overlay; enabled same-content selections reuse it', async () => {
  const { h, c } = await start({ 'Native/Plain.md': '# Plain', 'Draft/Draft.md': optin('# Disk') }, { folders: [], excludedFolders: ['Native'], publicFolders: [], reservedIds: [] });
  try {
    const view = h.open('Native/Plain.md');
    let observed = counts();
    const source = '# Unsaved ordinary\n\n' + 'text `code` text $x$. '.repeat(6400);
    let state = view.editor.attach(h.plugin.extensions, true, source);
    for (let n = 0; n < 20; n++) state = state.update({ selection: { anchor: n } }).state;
    assert.equal(observed.parses.length, 0, 'cheap disabled gate must precede full parse');
    assert.equal(observed.indexes, 0, 'ordinary selection cannot overlay the full vault');
    assert.equal(c.overlays.has('Native/Plain.md'), false);
    assert.equal(spans(state, 'citation').length, 0);

    observed = counts();
    const draft = h.open('Draft/Draft.md');
    const unsaved = optin('# Draft\n\n{ref:[[draft-id]]}\n\nEnd', 'forester-id: draft-id\ncitation-authors: [Floridi]\npublication-year: 2024\n');
    state = draft.editor.attach(h.plugin.extensions, true, unsaved);
    const overlay = c.overlays.get('Draft/Draft.md');
    assert.equal(spans(state, 'citation')[0].text, '(Floridi, 2024)');
    for (let n = 0; n < 20; n++) state = state.update({ selection: { anchor: n } }).state;
    assert.deepEqual(observed.parses, ['Draft/Draft.md']);
    assert.equal(observed.indexes, 1, 'selection-only updates reuse the current source overlay');
    assert.equal(c.overlays.get('Draft/Draft.md'), overlay);
    h.options.excludedFolders.push('Draft');
    state = state.update({ changes: { from: 0, to: state.doc.length, insert: unsaved.replace('hybrid-v1', 'false') } }).state;
    assert.equal(spans(state, 'citation').length, 0, 'unsaved opt-out clears decorations');
    assert.equal(c.overlays.has('Draft/Draft.md'), false, 'disabled overlay is not an authorization source');
  } finally { h.plugin.unload(); }
});

test('index updates invalidate enabled dependencies without touching ordinary Reading/editor views', async () => {
  const { h, c } = await start({
    'Native/Plain.md': '# Ordinary',
    'Page.md': optin('# Page\n\n{ref:[[book-id]]}\n\nEnd'),
    'Book.md': optin('# Book', 'forester-id: book-id\ncitation-authors: [Bates]\npublication-year: 2022\n'),
  }, { folders: [], excludedFolders: ['Native'], publicFolders: [], reservedIds: [] });
  try {
    const plain = h.open('Native/Plain.md'); plain.mode = 'preview'; plain.editor.attach(h.plugin.extensions);
    const page = h.open('Page.md'); page.mode = 'preview'; page.editor.attach(h.plugin.extensions);
    const changed = h.vault.data.get('Book.md').replace('Bates', 'White');
    h.vault.data.set('Book.md', changed);
    await h.app.metadataCache.emit('changed', h.vault.files.get('Book.md'), changed, {});
    assert.equal(plain.rerenders, 0, 'ordinary Reading is not a hybrid invalidation target');
    assert.equal(plain.editor.cm.dispatches.length, 0, 'ordinary CM does not receive hybrid refresh effects');
    assert.equal(page.rerenders, 1);
    assert.equal(spans(page.editor.cm.state, 'citation')[0].text, '(White, 2022)', 'enabled dependent remains current');
    assert.equal(page.editor.cm.dispatches.length, 1);
    const revision = c.revision;
    const observed = counts();
    await c.refresh(); await c.refresh();
    assert.equal(c.revision, revision);
    assert.equal(observed.parses.length, 0); assert.equal(observed.indexes, 0);
    assert.equal(page.rerenders, 1, 'stable explicit refresh does not disturb Reading signatures');
    assert.equal(page.editor.cm.dispatches.length, 1, 'stable view generation is a no-op');
    assert.equal(plain.rerenders, 0); assert.equal(plain.editor.cm.dispatches.length, 0);

    let iterations = 0;
    const iterate = c.readingEmbeds[Symbol.iterator].bind(c.readingEmbeds);
    c.readingEmbeds[Symbol.iterator] = () => { iterations++; return iterate(); };
    const el = document.createElement('section'); el.innerHTML = '<p>Ordinary</p>';
    const before = el.innerHTML;
    await h.plugin.postprocessors[0](el, { sourcePath: 'Native/Plain.md', getSectionInfo() { throw new Error('ordinary section info must not be requested'); } });
    assert.equal(iterations, 0, 'ordinary postprocessor exits before scanning hybrid renderer owners');
    assert.equal(el.innerHTML, before);
  } finally { h.plugin.unload(); }
});

test('cold startup and warm changed-source batches yield real UI timer tasks before completion', async () => {
  for (const size of [500, 1000]) {
    const entries = Object.fromEntries(Array.from({ length: size }, (_, n) => [`Plain${n}.md`, '# Plain\n\n' + 'Ordinary prose. '.repeat(60)]));
    const h = createHarness(entries), c = new HybridController(h.plugin, h.getter);
    let completed = false;
    const observed = counts();
    const heartbeat = new Promise(resolve => setTimeout(() => resolve({ completed, reads: h.vault.reads.length, parses: observed.parses.length }), 0));
    try {
      await c.initialize(); completed = true;
      const during = await heartbeat;
      assert.equal(during.completed, false, `${size}: UI timer must run while bootstrap is still in progress`);
      assert.ok(during.reads < size, `${size}: bounded read batches must yield even for immediate Promise IO`);
      assert.ok(during.parses < size);
      assert.equal(h.vault.reads.length, size);
      assert.equal(observed.parses.length, size);
      assert.equal(observed.indexes, 1);

      completed = false;
      const warm = counts();
      const warmHeartbeat = new Promise(resolve => setTimeout(() => resolve({ completed, parses: warm.parses.length }), 0));
      const updates = Object.entries(entries).map(([path, source]) => {
        const changed = source + '\nNew body'; h.vault.data.set(path, changed);
        return h.app.metadataCache.emit('changed', h.vault.files.get(path), changed, {});
      });
      await Promise.all(updates); completed = true;
      const inBatch = await warmHeartbeat;
      assert.equal(inBatch.completed, false, `${size}: cached-source parse batches cannot starve UI tasks`);
      assert.ok(inBatch.parses < size);
      assert.equal(warm.parses.length, size); assert.equal(warm.indexes, 1);
    } finally { h.plugin.unload(); }
  }
});

test('a single large explicit opt-in yields before its synchronous body parse', async () => {
  const source = optin('# Large\n\n' + 'text `code` text $x$. '.repeat(6400));
  const h = createHarness({ 'Large.md': source }), c = new HybridController(h.plugin, h.getter);
  const observed = counts();
  let completed = false;
  const heartbeat = new Promise(resolve => setTimeout(() => resolve({ completed, parses: observed.parses.length }), 0));
  try {
    await c.initialize(); completed = true;
    const during = await heartbeat;
    assert.equal(during.completed, false, 'UI task runs before large synchronous opt-in parsing');
    assert.equal(during.parses, 0);
    assert.equal(c.isEnabled('Large.md'), true); assert.equal(observed.parses.length, 1);
  } finally { h.plugin.unload(); }
});

test('a source-less notification during a pending read cannot reinstall its stale snapshot', async () => {
  const h = createHarness({ 'Page.md': optin('# Old', 'forester-id: old-id\npublish: true\n') });
  const c = new HybridController(h.plugin, h.getter), read = h.vault.read;
  let release, began;
  const gate = new Promise(resolve => release = resolve), reading = new Promise(resolve => began = resolve);
  let first = true;
  h.vault.read = async file => {
    const snapshot = await read(file);
    if (first) { first = false; began(); await gate; }
    return snapshot;
  };
  const observed = counts();
  try {
    const initializing = c.initialize();
    await reading;
    const latest = optin('# Private', 'forester-id: latest-id\npublish: false\n');
    h.vault.data.set('Page.md', latest);
    const updating = h.vault.emit('modify', h.vault.files.get('Page.md'));
    release();
    await Promise.all([initializing, updating]);
    assert.equal(c.index.documents.get('Page.md').source, latest, 'all refresh callers settle on latest source generation');
    assert.equal(c.index.ids.has('old-id'), false);
    assert.equal(c.index.ids.has('latest-id'), true);
    assert.equal(c.index.documents.get('Page.md').root.meta.publish, false, 'stale public metadata cannot survive read races');
    assert.equal(h.vault.reads.length, 2, 'invalidated pending read is retried');
    assert.equal(observed.indexes, 1, 'do not publish a partial/stale generation');
  } finally { release(); h.plugin.unload(); }
});

test('changes during a cooperative parse slice publish only the latest complete generation', async () => {
  const entries = Object.fromEntries(Array.from({ length: 100 }, (_, n) => [`Page${n}.md`, optin(`# Page ${n}\n\nOld`)]));
  const { h, c } = await start(entries);
  try {
    const page = h.open('Page0.md'); page.mode = 'preview'; page.editor.attach(h.plugin.extensions, false);
    const rendered = [];
    page.previewMode.rerender = () => rendered.push(c.index.documents.get('Page0.md').source);
    const intermediate = entries['Page0.md'] + '\nIntermediate';
    const latest = entries['Page0.md'] + '\nLatest private body';
    const parse = c.parse.bind(c);
    let once = true, pending;
    c.parse = (...args) => {
      const doc = parse(...args);
      if (once && args[0] === 'Page0.md' && args[1] === intermediate) {
        once = false;
        setTimeout(() => {
          h.vault.data.set('Page0.md', latest);
          pending = h.app.metadataCache.emit('changed', h.vault.files.get('Page0.md'), latest, {});
        }, 0);
      }
      return doc;
    };
    const observed = counts();
    const updates = Object.entries(entries).map(([path, source]) => {
      const next = source + '\nIntermediate'; h.vault.data.set(path, next);
      return h.app.metadataCache.emit('changed', h.vault.files.get(path), next, {});
    });
    await Promise.all(updates); await pending;
    assert.equal(c.index.documents.get('Page0.md').source, latest);
    assert.deepEqual(rendered, [latest], 'stale slices are never made visible to hybrid Reading');
    assert.equal(observed.indexes, 1, 'invalidated source snapshot cannot increment revision or index');
    assert.equal(page.editor.cm.dispatches.length, 1);
  } finally { h.plugin.unload(); }
});

test('legacy startup hooks are available before the hybrid vault bootstrap finishes', async () => {
  const h = createHarness({ 'Plain.md': '# Ordinary' });
  const plugin = new LegacyPlugin(h.app);
  h.workspace.onLayoutReady = () => {};
  const originalDocument = globalThis.document, originalObserver = globalThis.MutationObserver;
  globalThis.document = { body: { addClass() {}, toggleClass() {}, removeClass() {}, style: { setProperty() {} } } };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  let release, began;
  const gate = new Promise(resolve => release = resolve), reading = new Promise(resolve => began = resolve);
  const read = h.vault.read;
  h.vault.read = async file => { began(); await gate; return read(file); };
  const loading = plugin.onload();
  try {
    await reading;
    assert.ok(plugin.commands.some(command => command.id === 'mint-note-address'), 'legacy command registration must not wait on full-vault IO');
    assert.ok(plugin.commands.some(command => command.id === 'retarget-heading-references'));
    assert.equal(plugin.postprocessors.length, 1, 'only the hybrid Reading hook is registered');
    assert.equal(plugin.observer, null, 'default-on Markdown never starts legacy global observation');
  } finally {
    release(); await loading;
    for (const cleanup of plugin.cleanups) cleanup(); plugin.onunload(); h.plugin.unload();
    globalThis.document = originalDocument; globalThis.MutationObserver = originalObserver;
  }
});

test('unload cancels pending refresh/report work and releases editor parse/overlay caches', async () => {
  const { h, c } = await start({ 'Page.md': optin('# Page'), 'Other.md': '# Ordinary' });
  const view = h.open('Page.md'); view.editor.attach(h.plugin.extensions, true, optin('# Unsaved'));
  let release, began;
  const gate = new Promise(resolve => release = resolve), reading = new Promise(resolve => began = resolve);
  const read = h.vault.read;
  h.vault.read = async file => { began(); await gate; return read(file); };
  const observed = counts();
  try {
    const updating = h.vault.emit('modify', h.vault.files.get('Page.md'));
    await reading;
    const report = h.plugin.commands.get('preview-public-projection').callback();
    h.plugin.unload(); release();
    await Promise.all([updating, report]);
    assert.equal(modals.length, 0, 'a pending command cannot reopen UI after unload');
    assert.equal(observed.parses.length, 0); assert.equal(observed.indexes, 0);
    assert.equal(view.editor.cm.dispatches.length, 0);
    assert.equal(c.parsed.size, 0); assert.equal(c.overlays.size, 0); assert.equal(c.overlayDocuments.size, 0);
    assert.equal(c.sources.size, 0);
    const reads = h.vault.reads.length;
    await c.refresh();
    view.editor.attach(h.plugin.extensions, true, optin('# After unload'));
    assert.equal(c.observedEditors.size, 0, 'old editor fields cannot repopulate unloaded controller state');
    assert.equal(h.vault.reads.length, reads);
    assert.equal(c.refreshTask, undefined);
  } finally { release(); h.plugin.unload(); }
});

test('hundreds of startup diagnostics keep full local evidence without hundreds of Notice instances', async () => {
  const entries = Object.fromEntries(Array.from({ length: 500 }, (_, n) => [`Bad${n}.md`, '---\nbroken: [unterminated\n---\n# Ordinary']));
  const { h, c } = await start(entries);
  try {
    assert.equal(c.index.diagnostics.filter(d => d.code === 'invalid-frontmatter').length, 500);
    assert.ok(notices.length <= 4, `startup must bound notification DOM work, got ${notices.length}`);
    assert.ok(notices.some(message => /497.*additional diagnostics/.test(message)), 'bounded summary retains omitted diagnostic count');
    const before = notices.length;
    await c.refresh(); assert.equal(notices.length, before, 'unchanged warnings are deduplicated');
    assert.equal(h.vault.processes.length, 0);
  } finally { h.plugin.unload(); }
});

test('in-place folder/public/reservation config edits invalidate same-source documents and clear disabled decorations', async () => {
  const entries = {
    'Trees/Page.md': '---\nforester-id: page-id\n---\n# Root\n\n## Child ^child-id\n#Claim\n\nBody',
    'Outside.md': optin('# Outside\n\n## Child\nBody'),
    'Trees/Malformed.md': '---\nbroken: [unterminated\n---\n# Private invalid body',
  };
  const { h, c } = await start(entries, { folders: ['Trees'], excludedFolders: [], publicFolders: [], reservedIds: [] });
  try {
    const page = h.open('Trees/Page.md'); page.mode = 'preview'; page.editor.attach(h.plugin.extensions);
    assert.equal(c.index.documents.get('Trees/Malformed.md').enabled, true, 'syntax errors retain path activation but publication still fails closed');
    const old = c.index.documents.get('Trees/Page.md');
    assert.equal(old.root.meta.publish, false);
    const observed = counts();
    h.options.publicFolders.push('Trees');
    await c.refresh();
    assert.notEqual(c.index.documents.get('Trees/Page.md'), old);
    assert.equal(c.index.documents.get('Trees/Page.md').root.meta.publish, true);
    assert.deepEqual(observed.parses.sort(), Object.keys(entries).sort(), 'all config-sensitive documents use the new generation');
    assert.equal(observed.indexes, 1);
    await h.plugin.commands.get('preview-public-projection').callback();
    assert.match(modals.at(-1).contentEl.textContent, /0 public trees.*invalid-source/, 'malformed disabled input still fails the entire public projection closed');
    assert.ok(!modals.at(-1).contentEl.textContent.includes('Private invalid body'));
    const malformed = h.vault.files.get('Trees/Malformed.md');
    h.vault.files.delete(malformed.path); h.vault.data.delete(malformed.path);
    await h.vault.emit('delete', malformed);
    await h.plugin.commands.get('preview-public-projection').callback();
    assert.match(modals.at(-1).contentEl.textContent, /2 public trees/, 'root and child reflect new folder publication defaults');

    h.options.publicFolders.length = 0;
    await c.refresh();
    await h.plugin.commands.get('preview-public-projection').callback();
    assert.match(modals.at(-1).contentEl.textContent, /0 public trees/, 'public/private metadata cannot be cached across options edits');
    h.options.reservedIds.push('AAAAAA');
    await c.refresh();
    const candidates = ['AAAAAA', 'BBBBBB'];
    const plan = planHybridSave(c.index, 'Outside.md', () => candidates.shift());
    assert.match(plan.edits[0].after, /## Child \^BBBBBB/, 'reservation cache follows current options without source changes');
    h.options.excludedFolders.push('Trees');
    await c.refresh();
    assert.equal(c.index.documents.get('Trees/Page.md').enabled, false);
    assert.equal(page.editor.cm.state.facet(EditorView.decorations).every(d => d.size === 0), true, 'config-only disable clears existing CodeMirror decorations');
    assert.equal(c.overlays.has('Trees/Page.md'), false);
    assert.equal(c.isEnabled('Outside.md'), true, 'explicit exceptional opt-in survives empty folders');
    assert.equal(h.vault.processes.length, 0, 'refresh/config/public reports are read-only');
  } finally { h.plugin.unload(); }
});

test('disabled aliases/root IDs and rename/delete membership invalidate resolution without stale cache entries', async () => {
  const { h, c } = await start({ 'Page.md': optin('# Page', 'forester-id: page-id\n'), 'Plain.md': '# Ordinary' });
  try {
    const source = '---\nforester-mode: false\naliases: [page-id]\n---\n# Ordinary';
    h.vault.data.set('Plain.md', source);
    await h.app.metadataCache.emit('changed', h.vault.files.get('Plain.md'), source, {});
    assert.equal(resolveHybrid(c.index, 'page-id', 'Plain.md').status, 'ambiguous');
    assert.ok(c.index.diagnostics.some(d => d.code === 'alias-id-collision'));
    const changed = h.vault.data.get('Page.md').replace('page-id', 'new-id');
    h.vault.data.set('Page.md', changed);
    await h.app.metadataCache.emit('changed', h.vault.files.get('Page.md'), changed, {});
    assert.equal(c.index.ids.has('page-id'), false); assert.equal(c.index.ids.has('new-id'), true);
    const renamed = h.vault.files.get('Page.md');
    h.vault.files.delete('Page.md'); h.vault.data.delete('Page.md');
    renamed.path = 'Renamed.md'; h.vault.files.set(renamed.path, renamed); h.vault.data.set(renamed.path, changed);
    await h.vault.emit('rename', renamed, 'Page.md');
    assert.equal(c.index.documents.has('Page.md'), false); assert.equal(c.parsed.has('Page.md'), false);
    assert.equal(resolveHybrid(c.index, 'new-id', 'Plain.md').document.path, 'Renamed.md');
    h.vault.files.delete('Renamed.md'); h.vault.data.delete('Renamed.md');
    await h.vault.emit('delete', renamed);
    assert.equal(c.index.ids.has('new-id'), false); assert.equal(c.parsed.has('Renamed.md'), false);
    assert.equal(c.sources.has('Renamed.md'), false); assert.equal(c.sourceVersions.has('Renamed.md'), false);
    assert.equal(c.index.documents.has('Plain.md'), true, 'disabled files remain collision/public inputs');
  } finally { h.plugin.unload(); }
});

test('refresh failures reject all coalesced callers, clear the queue and allow a current retry', async () => {
  const { h, c } = await start({ 'Page.md': optin('# Before', 'publish: true\n') });
  const read = h.vault.read;
  try {
    const latest = optin('# After private', 'publish: false\n'); h.vault.data.set('Page.md', latest);
    h.vault.read = async () => { throw new Error('synthetic native EIO'); };
    const first = h.vault.emit('modify', h.vault.files.get('Page.md')), second = c.refresh();
    const results = await Promise.allSettled([first, second]);
    assert.ok(results.every(r => r.status === 'rejected' && /synthetic native EIO/.test(String(r.reason))));
    assert.equal(c.refreshTask, undefined); assert.equal(c.refreshRequested, false);
    h.vault.read = read;
    await c.refresh();
    assert.equal(c.index.documents.get('Page.md').source, latest);
    assert.equal(c.index.documents.get('Page.md').root.meta.publish, false);
    const view = h.open('Page.md');
    const dispatch = view.editor.cm.dispatch;
    view.editor.cm.dispatch = () => { throw new Error('synthetic native facet'); };
    await assert.rejects(c.refresh(), /synthetic native facet/);
    assert.equal(c.refreshTask, undefined); assert.equal(c.refreshRequested, false);
    view.editor.cm.dispatch = dispatch; await c.refresh();
    assert.equal(view.editor.cm.dispatches.length, 1, 'failed native notification is retried once');
  } finally { h.vault.read = read; h.plugin.unload(); }
});

test('legacy treeFor keeps its cached ordinary tree without full parser work and still respects current ownership', async () => {
  const source = '# Plain\n\n## Part\n\n' + 'text `code` text $x$. '.repeat(6400);
  const { h, c } = await start({ 'Plain.md': source });
  const plugin = new LegacyPlugin(h.app);
  plugin.hybridController = c; plugin.sources.set('Plain.md', source);
  h.app.metadataCache.getFileCache = () => ({ frontmatter: {}, headings: [{ heading: 'Plain', level: 1, position: { start: { line: 0 } } }] });
  try {
    const file = h.vault.files.get('Plain.md'), tree = plugin.treeFor(file);
    assert.equal(tree, null, 'hybrid or excluded Markdown never falls through to legacy formatting');
    const observed = counts();
    for (let n = 0; n < 20; n++) assert.equal(plugin.treeFor(file), tree);
    assert.equal(observed.parses.length, 0); assert.equal(observed.indexes, 0);
    h.options.folders.push('/');
    assert.equal(plugin.treeFor(file), null, 'cached legacy tree cannot override new folder ownership');
    plugin.sources.set('Plain.md', '---\nforester-mode: false\n---\n' + source);
    assert.equal(plugin.treeFor(file), null, 'legacy metadata cannot restore formatting');
  } finally { h.plugin.unload(); }
});

test('delete/rename races retire a failed stale read without stranding the latest membership refresh', async () => {
  for (const event of ['rename', 'delete']) {
    const source = optin('# Page', 'forester-id: page-id\n');
    const { h, c } = await start({ 'Page.md': source, 'Other.md': '# Ordinary' });
    let release, began;
    const gate = new Promise(resolve => release = resolve), reading = new Promise(resolve => began = resolve);
    const read = h.vault.read;
    let first = true;
    h.vault.read = async file => {
      if (first) { first = false; const snapshotFile = new TFile(file.path); began(); await gate; return read(snapshotFile); }
      return read(file);
    };
    try {
      const file = h.vault.files.get('Page.md'), updating = h.vault.emit('modify', file);
      await reading;
      h.vault.files.delete('Page.md'); h.vault.data.delete('Page.md');
      if (event === 'rename') { file.path = 'Renamed.md'; h.vault.files.set(file.path, file); h.vault.data.set(file.path, source); }
      const changing = event === 'rename' ? h.vault.emit('rename', file, 'Page.md') : h.vault.emit('delete', file);
      release();
      const results = await Promise.allSettled([updating, changing]);
      assert.ok(results.every(r => r.status === 'fulfilled'), `${event}: superseded Missing-file IO is not a current failure`);
      assert.equal(c.index.documents.has('Page.md'), false);
      assert.equal(c.index.documents.has('Renamed.md'), event === 'rename');
      assert.equal(c.index.ids.has('page-id'), event === 'rename');
      assert.equal(c.refreshTask, undefined);
    } finally { release(); h.plugin.unload(); }
  }
});

test('Reading owners survive no-op refresh and are replaced/cleaned on a real dependency change', async () => {
  const source = optin('# Page\n\n![[book-id]]\n');
  const { h, c } = await start({ 'Page.md': source, 'Book.md': optin('# Book\n\nOriginal body', 'forester-id: book-id\n') });
  const el = document.createElement('section'); el.innerHTML = '<div class="internal-embed" src="book-id">Native excerpt</div>';
  const line = source.split('\n').indexOf('![[book-id]]'), ctx = h.context('Page.md', line, line);
  try {
    await h.plugin.postprocessors[0](el, ctx); await new Promise(setImmediate);
    const first = ctx.children[0], wrapper = el.querySelector('.hybrid-embed');
    assert.equal(first.loaded, true);
    await c.refresh(); await h.plugin.postprocessors[0](el, ctx); await new Promise(setImmediate);
    assert.equal(first.loaded, true); assert.equal(el.querySelector('.hybrid-embed'), wrapper);
    assert.equal(ctx.children.length, 1, 'stable source/index keeps renderer child identity');
    const changed = h.vault.data.get('Book.md').replace('Original body', 'Updated! body'); h.vault.data.set('Book.md', changed);
    await h.app.metadataCache.emit('changed', h.vault.files.get('Book.md'), changed, {});
    await h.plugin.postprocessors[0](el, ctx); await new Promise(setImmediate);
    assert.equal(first.loaded, false, 'actual dependency generation unloads the old owner');
    assert.notEqual(el.querySelector('.hybrid-embed'), wrapper);
    assert.ok(el.textContent.includes('Updated! body'));
    assert.equal(ctx.children.length, 2); assert.equal(ctx.children[1].loaded, true);
    h.plugin.unload(); assert.ok(ctx.children.every(child => !child.loaded));
  } finally { h.plugin.unload(); }
});

test('invalid native snapshots reject instead of spinning the refresh queue indefinitely', async () => {
  for (const fault of ['lookup', 'read-result']) {
    const { h, c } = await start({ 'Page.md': optin('# Page') });
    const lookup = h.vault.getAbstractFileByPath, files = h.vault.getMarkdownFiles, read = h.vault.read;
    let visits = 0;
    // Stop an unfixed retry loop synchronously so this regression cannot hang CI.
    h.vault.getMarkdownFiles = () => { if (++visits > 8) throw new Error('test retry budget exceeded'); return files(); };
    if (fault === 'lookup') h.vault.getAbstractFileByPath = () => null;
    else h.vault.read = async () => undefined;
    try {
      await assert.rejects(h.vault.emit('modify', h.vault.files.get('Page.md')), fault === 'lookup' ? /Unstable file snapshot/ : /Invalid Markdown source/);
      assert.ok(visits <= 3, `${fault}: no unbounded retry without a newer native snapshot`);
      assert.equal(c.refreshTask, undefined); assert.equal(c.refreshRequested, false);
      h.vault.getAbstractFileByPath = lookup; h.vault.getMarkdownFiles = files; h.vault.read = read;
      await c.refresh(); assert.equal(c.isEnabled('Page.md'), true, 'a later current retry recovers');
    } finally { h.vault.getAbstractFileByPath = lookup; h.vault.getMarkdownFiles = files; h.vault.read = read; h.plugin.unload(); }
  }
});
