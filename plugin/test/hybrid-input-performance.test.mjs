import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHarness, TFile } from './controller-obsidian-mock.mjs';

// Real registered input + controller + core. Only Obsidian's unavailable
// runtime and public file formatter are simulated, never the tree resolver.
const root = fileURLToPath(new URL('../', import.meta.url));
const out = new URL('./build/input-performance/', import.meta.url);
const mock = fileURLToPath(new URL('./controller-obsidian-mock.mjs', import.meta.url));
mkdirSync(out, { recursive: true });
await build({ absWorkingDir: root, stdin: { contents: "export { HybridController } from './src/hybrid-controller.ts'; export { registerHybridInput } from './src/hybrid-input.ts'; export { parseHybrid, indexHybrid, resolveHybrid } from './src/hybrid-core.ts';", resolveDir: root, sourcefile: 'input-performance-entry.ts' }, bundle: true, platform: 'node', format: 'esm', outfile: fileURLToPath(new URL('controller.mjs', out)), external: ['@codemirror/state', '@codemirror/view'], logLevel: 'silent', plugins: [{ name: 'measure-real-input-controller', setup(b) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true }));
  b.onLoad({ filter: /hybrid-(core|controller|input)\.ts$/ }, args => {
    let contents = readFileSync(args.path, 'utf8');
    const add = (signature, statement) => { assert.match(contents, signature); contents = contents.replace(signature, match => `${match}\n${statement}`); };
    if (args.path.endsWith('hybrid-core.ts')) {
      add(/export function resolveHybrid\([^\n]+\{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.resolves++;');
      add(/export function parseHybrid\([^\n]+\{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.parses++;');
      add(/export function indexHybrid\([^\n]+\{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.indexBuilds++;');
      const begin = contents.indexOf('export function resolveHybrid('), end = contents.indexOf('/** Portable secure randomness', begin);
      let resolver = contents.slice(begin, end);
      assert.match(resolver, /for \(const document of index.documents.values\(\)\) \{/);
      resolver = resolver.replace(/for \(const document of index.documents.values\(\)\) \{/, match => `${match}\nif (globalThis.__inputPerformance) globalThis.__inputPerformance.resolverDocumentVisits++;`);
      contents = contents.slice(0, begin) + resolver + contents.slice(end);
    } else if (args.path.endsWith('hybrid-controller.ts')) {
      add(/currentIndex\(\): HybridIndex \{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.currentIndexCalls++;');
    } else {
      add(/private async buildSearch\([^\n]+\{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.catalogBuilds++;');
      // Count real cheap tree visits as well as resolver calls; slicing after
      // an eager all-tree pass does not satisfy the empty-query work bound.
      add(/for \(const tree of document.trees\) \{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.treeVisits++;');
      add(/if \(document.enabled\) for \(const tree of document.trees\) \{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.treeNormalizations++;');
      add(/for \(const \{ facts \} of this.catalog.values\(\)\) for \(const fact of facts\) \{/, 'if (globalThis.__inputPerformance) globalThis.__inputPerformance.treeVisits++;');
    }
    return { contents, loader: 'ts' };
  });
} }] });
const { HybridController, registerHybridInput, parseHybrid, indexHybrid, resolveHybrid } = await import(new URL('controller.mjs', out).href);
const newCounts = () => ({ resolves: 0, parses: 0, indexBuilds: 0, resolverDocumentVisits: 0, currentIndexCalls: 0, treeVisits: 0, treeNormalizations: 0, linktextCalls: 0, nativeFileVisits: 0, nativeFormatterMs: 0, generationCalls: 0, vaultEnumerations: 0, catalogBuilds: 0 });

function catalogFixture(assets = 0, entries = { 'Source.md': '[[', 'Target.md': '---\nforester-id: Target-ID\npublish: false\n---\n# Initial title' }) {
  globalThis.__inputPerformance = undefined;
  const h = createHarness(entries, { folders: ['/'], excludedFolders: [], publicFolders: [], reservedIds: [] });
  let index = indexHybrid(Object.entries(entries).map(([path, source]) => parseHybrid(path, source, h.options)));
  for (let n = 0; n < assets; n++) h.vault.files.set(`Assets/File-${n}.png`, new TFile(`Assets/File-${n}.png`));
  const listeners = new Set();
  let enumerations = 0, normalized = 0;
  h.vault.getFiles = () => { enumerations++; return [...h.vault.files.values()]; };
  for (const file of h.vault.files.values()) {
    let basename = file.basename;
    Object.defineProperty(file, 'basename', { configurable: true, get() { normalized++; return basename; }, set(value) { basename = value; } });
  }
  h.app.metadataCache.fileToLinktext = file => file.path;
  const view = h.open('Source.md');
  const host = { index: () => index, searchIndex: () => index, subscribeSearch(update) { listeners.add(update); return () => listeners.delete(update); }, resolve: (target, path, snapshot) => resolveHybrid(snapshot ?? index, target, path), insertTarget: async (...args) => calls.push(args) };
  const calls = [];
  const input = registerHybridInput(h.plugin, host), links = h.plugin.suggesters[1], support = links.support;
  return { h, input, links, support, view, calls, listeners, get index() { return index; }, get normalized() { return normalized; }, get enumerations() { return enumerations; },
    publish(documents) { index = indexHybrid(documents); for (const update of listeners) update(); },
    rows(query = '') { view.editor.value = `[[${query}`; view.editor.setCursor(view.editor.offsetToPos(view.editor.value.length)); const trigger = links.onTrigger(view.editor.getCursor(), view.editor, view.file); assert.ok(trigger); links.context = { ...trigger, editor: view.editor, file: view.file }; return links.getSuggestions(links.context); },
  };
}

async function fixture(size = 3662, assets = 276, ambiguous = false) {
  const entries = { 'Source.md': '---\nforester-id: source-id\n---\n# Source\n\n[[' };
  for (let n = 1; n < size; n++) entries[`Notes/Note-${n}.md`] = `---\nforester-id: root-${n}\n---\n# Root ${n}\n\n` + Array.from({ length: 10 }, (_, j) => `## Child ${n} ${j} ^${ambiguous ? 'duplicate' : `child-${n}-${j}`}\nBody\n`).join('\n');
  const h = createHarness(entries, { folders: ['/'], excludedFolders: [], publicFolders: [], reservedIds: [] });
  for (let n = 0; n < assets; n++) {
    const extension = n < 87 ? 'png' : n < 151 ? 'pdf' : 'svg';
    const file = new TFile(`Assets/Asset-${n}.${extension}`);
    file.name = file.path.split('/').at(-1); file.basename = file.name.slice(0, -(extension.length + 1));
    h.vault.files.set(file.path, file);
  }
  h.vault.getFiles = () => { if (globalThis.__inputPerformance) globalThis.__inputPerformance.vaultEnumerations++; return [...h.vault.files.values()]; };
  h.app.metadataCache.fileToLinktext = (file, sourcePath) => {
    assert.equal(sourcePath, 'Source.md');
    const counts = globalThis.__inputPerformance, start = performance.now();
    if (counts) counts.linktextCalls++;
    // Explicitly simulated native uniqueness scan, not an Obsidian timing claim.
    let same = 0;
    for (const other of h.vault.files.values()) { if (counts) counts.nativeFileVisits++; if (other.name === file.name) same++; }
    if (counts) counts.nativeFormatterMs += performance.now() - start;
    return same === 1 ? file.name : file.path;
  };
  const c = new HybridController(h.plugin, h.getter);
  await c.initialize();
  const view = h.open('Source.md');
  c.currentIndex(); // Warm the real controller's cached overlay, not a fake index.
  h.vault.reads.length = 0;
  return { h, c, view, links: h.plugin.suggesters[1], rows(query = '') {
    view.editor.value = `---\nforester-id: source-id\n---\n# Source\n\n[[${query}`;
    view.editor.setCursor(view.editor.offsetToPos(view.editor.value.length));
    const counts = globalThis.__inputPerformance = newCounts(), start = performance.now();
    const trigger = this.links.onTrigger(view.editor.getCursor(), view.editor, view.file);
    assert.ok(trigger, 'actual registered [[ onTrigger accepts editable source');
    this.links.context = { ...trigger, editor: view.editor, file: view.file };
    counts.generationCalls++;
    const rows = this.links.getSuggestions(this.links.context);
    const metric = { ...counts, rows: rows.length, treeRows: rows.filter(row => row.kind === 'tree').length, fileRows: rows.filter(row => row.kind === 'file').length, elapsedMs: performance.now() - start, markdownFiles: size, assets, indexedTrees: [...c.currentIndex().documents.values()].reduce((n, doc) => n + doc.trees.length, 0), vaultReads: h.vault.reads.length };
    return { rows, metric };
  } };
}

if (process.env.HYBRID_INPUT_PERF_CHILD === '1') {
  const f = await fixture(Number(process.env.HYBRID_INPUT_PERF_SIZE ?? 3662));
  try {
    console.log(JSON.stringify({ phase: 'ready', markdownFiles: f.h.vault.getMarkdownFiles().length, nativeFiles: f.h.vault.files.size }));
    const { metric } = f.rows();
    console.log(JSON.stringify({ phase: 'complete', metric }));
  } finally { f.h.plugin.unload(); }
} else {
  test('native catalog bootstrap normalizes at most 128 files before yielding and readiness includes the last file', async () => {
    const f = catalogFixture(600);
    try {
      assert.ok(f.normalized > 0 && f.normalized <= 128, `registration normalized ${f.normalized} files synchronously`);
      assert.equal(f.enumerations, 1, 'snapshot once outside query callbacks');
      f.rows('File-599');
      assert.equal(f.enumerations, 1, 'pending query does not enumerate or restart bootstrap');
      await f.input.prepareSearch();
      assert.equal(f.rows('File-599')[0]?.file.path, 'Assets/File-599.png');
      assert.equal(f.normalized, 602);
    } finally { f.h.plugin.unload(); }
  });
  test('canonical publication cancels an obsolete build before the scheduled replacement starts', async () => {
    const f = catalogFixture();
    await f.input.prepareSearch();
    const original = f.support.catalog, pending = [];
    const set = globalThis.setTimeout, clear = globalThis.clearTimeout;
    globalThis.setTimeout = callback => { const timer = { callback, cancelled: false }; pending.push(timer); return timer; };
    globalThis.clearTimeout = timer => { timer.cancelled = true; };
    try {
      const source = f.index.documents.get('Source.md');
      const old = parseHybrid('Target.md', '# Obsolete\n' + Array.from({ length: 126 }, (_, n) => `\n## Heading ${n} ^old-${n}\n`).join(''), f.h.options);
      f.publish([source, old]);
      const obsolete = f.input.prepareSearch();
      assert.ok(pending.some(timer => !timer.cancelled), 'old build is actually waiting at a cooperative yield');
      const latest = parseHybrid('Target.md', '# Latest', f.h.options);
      f.publish([source, latest]);
      // Run only the old build's yield, not the queued replacement publication.
      pending.find(timer => !timer.cancelled).callback();
      await obsolete;
      assert.ok(f.support.catalog === original, 'obsolete canonical facts cannot publish during the notification gap');
      globalThis.setTimeout = set; globalThis.clearTimeout = clear;
      await f.input.prepareSearch();
      assert.equal(f.rows('Latest')[0]?.tree.meta.title, 'Latest');
      assert.deepEqual(f.rows('Obsolete'), []);
    } finally { globalThis.setTimeout = set; globalThis.clearTimeout = clear; f.h.plugin.unload(); }
  });
  test('native create/delete/rename/replacement events cannot be rolled back by delayed inventory objects', async () => {
    const f = catalogFixture(600);
    try {
      const deleted = f.h.vault.files.get('Assets/File-599.png');
      f.h.vault.files.delete(deleted.path); await f.h.vault.emit('delete', deleted);
      const renamed = f.h.vault.files.get('Assets/File-598.png'), oldPath = renamed.path;
      f.h.vault.files.delete(oldPath); renamed.path = 'Moved/Latest name.svg'; renamed.extension = 'svg'; renamed.basename = 'Latest name';
      f.h.vault.files.set(renamed.path, renamed); await f.h.vault.emit('rename', renamed, oldPath);
      const replacement = new TFile('Assets/File-597.png'); replacement.basename = 'replacement';
      f.h.vault.files.set(replacement.path, replacement); await f.h.vault.emit('create', replacement);
      const created = new TFile('New/Created.pdf'); f.h.vault.files.set(created.path, created); await f.h.vault.emit('create', created);
      await f.input.prepareSearch();
      assert.deepEqual(f.rows('File-599'), []); assert.deepEqual(f.rows('File-598'), []);
      assert.equal(f.rows('Latest name svg')[0]?.file, renamed);
      assert.equal(f.rows('replacement')[0]?.file, replacement);
      assert.equal(f.rows('Created pdf')[0]?.file, created);
      const row = f.rows('Created pdf')[0], before = f.view.editor.value;
      f.h.vault.files.delete(created.path); await f.h.vault.emit('delete', created);
      f.links.selectSuggestion(row);
      assert.equal(f.view.editor.value, before, 'deleted native candidate is not inserted');
      assert.deepEqual(f.rows('Created pdf'), []);
      assert.equal(f.enumerations, 1); assert.equal(f.h.vault.reads.length, 0);
    } finally { f.h.plugin.unload(); }
  });
  test('queries reuse prepared facts and differential publications retain unchanged document fact identities', async () => {
    const f = catalogFixture(4);
    try {
      await f.input.prepareSearch();
      const sourceFacts = f.support.catalog.get('Source.md'), targetFacts = f.support.catalog.get('Target.md'), normalized = f.normalized;
      const counts = globalThis.__inputPerformance = newCounts();
      for (const query of ['', 'target-id', 'Initial', 'Assets', 'no-match']) f.rows(query);
      await f.input.prepareSearch();
      assert.equal(counts.catalogBuilds, 0); assert.equal(counts.treeNormalizations, 0);
      assert.equal(f.normalized, normalized); assert.equal(f.enumerations, 1);
      f.publish([...f.index.documents.values()]); await f.input.prepareSearch();
      assert.ok(f.support.catalog.get('Source.md') === sourceFacts);
      assert.ok(f.support.catalog.get('Target.md') === targetFacts);
      assert.equal(counts.treeNormalizations, 0, 'new index wrapper with unchanged documents does not normalize trees');
      const changed = parseHybrid('Target.md', targetFacts.document.source.replace('Initial title', 'Fresh remote title'), f.h.options);
      const stale = f.rows('Initial')[0];
      f.publish([sourceFacts.document, changed]); await f.input.prepareSearch();
      assert.ok(f.support.catalog.get('Source.md') === sourceFacts);
      assert.ok(f.support.catalog.get('Target.md') !== targetFacts);
      assert.equal(counts.treeNormalizations, 1, 'only the changed document is normalized');
      const before = f.view.editor.value; f.links.selectSuggestion(stale); assert.equal(f.calls.length, 0); assert.equal(f.view.editor.value, before, 'unchanged input still refuses a stale target-source choice');
      assert.deepEqual(f.rows('Initial'), []); assert.equal(f.rows('Fresh remote')[0]?.tree.id, 'Target-ID');
    } finally { globalThis.__inputPerformance = undefined; f.h.plugin.unload(); }
  });
  test('scope and source changes exclude pending tree facts and stale selection while local private candidates remain usable', async () => {
    const f = catalogFixture(0, { 'Source.md': '[[', 'Private/Target.md': '---\nforester-id: Private-ID\npublish: false\n---\n# Private title' });
    try {
      await f.input.prepareSearch();
      const privateRow = f.rows('Private-ID')[0]; assert.ok(privateRow, 'local publish:false trees are not hidden by public projection rules');
      const source = f.index.documents.get('Source.md'), target = f.index.documents.get('Private/Target.md');
      f.publish([source, parseHybrid(target.path, target.source, { ...f.h.options, excludedFolders: ['Private'] })]);
      assert.deepEqual(f.rows('Private-ID'), [], 'unprepared old facts are filtered by current scope before resolution');
      f.links.selectSuggestion(privateRow); assert.equal(f.calls.length, 0);
      await f.input.prepareSearch(); assert.deepEqual(f.rows('Private-ID'), []);
      f.publish([source, target]); await f.input.prepareSearch();
      const valid = f.rows('Private-ID')[0]; f.links.selectSuggestion(valid);
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0][2].id, 'Private-ID');
      f.publish([parseHybrid('Source.md', '[[', { ...f.h.options, excludedFolders: ['/'] }), target]);
      assert.equal(f.links.onTrigger(f.view.editor.getCursor(), f.view.editor, f.view.file), null, 'excluded source never starts completion');
    } finally { f.h.plugin.unload(); }
  });
  test('tree document create/rename/delete publications remove old identities without vault enumeration', async () => {
    const f = catalogFixture();
    try {
      await f.input.prepareSearch();
      const source = f.index.documents.get('Source.md'), target = f.index.documents.get('Target.md');
      const added = parseHybrid('Added/New.md', '---\nforester-id: New-ID\n---\n# New title', f.h.options);
      f.publish([source, target, added]); await f.input.prepareSearch(); assert.equal(f.rows('New-ID')[0]?.tree.path, added.path);
      const renamed = parseHybrid('Moved/New.md', added.source, f.h.options);
      f.publish([source, target, renamed]); assert.deepEqual(f.rows('Added/New.md'), []);
      await f.input.prepareSearch(); assert.equal(f.rows('New-ID')[0]?.tree.path, renamed.path);
      f.publish([source, target]); assert.deepEqual(f.rows('New-ID'), []);
      await f.input.prepareSearch(); assert.ok(!f.support.catalog.has(renamed.path));
      assert.equal(f.enumerations, 1); assert.equal(f.h.vault.reads.length, 0);
    } finally { f.h.plugin.unload(); }
  });
  test('unload while native and tree bootstrap are yielding settles readiness without late facts, rows or insertion', async () => {
    const f = catalogFixture(600, { 'Source.md': '[[', 'Target.md': '# Target\n' + Array.from({ length: 300 }, (_, n) => `\n## Child ${n} ^child-${n}\n`).join('') });
    const pending = f.input.prepareSearch(), normalized = f.normalized;
    assert.ok(normalized <= 128); assert.equal(f.support.catalog.size, 0, 'tree preparation is genuinely pending');
    f.h.plugin.unload(); await pending; await f.input.prepareSearch();
    assert.equal(f.normalized, normalized, 'native bootstrap stops at unload');
    assert.equal(f.support.catalog.size, 0); assert.equal(f.support.nativeCatalog.size, 0); assert.equal(f.listeners.size, 0);
    assert.equal(f.links.onTrigger(f.view.editor.getCursor(), f.view.editor, f.view.file), null);
    assert.deepEqual(f.links.getSuggestions({ editor: f.view.editor, file: f.view.file, start: { line: 0, ch: 0 }, end: { line: 0, ch: 2 }, query: '' }), []);
    assert.equal(f.calls.length, 0);
  });
  test('controller remote title refresh publishes searchable facts through its canonical subscription', async () => {
    const f = await fixture(8, 0);
    try {
      const support = f.links.support, sourceFacts = support.catalog.get('Source.md');
      const file = f.h.vault.files.get('Notes/Note-7.md');
      f.h.vault.data.set(file.path, f.h.vault.data.get(file.path).replace('Root 7', 'Remote updated title'));
      await f.h.vault.emit('modify', file);
      // The publication timer is queued by the real controller; waiting for one
      // timer turn exercises that notification, not a sleep or direct rebuild.
      await new Promise(resolve => setTimeout(resolve, 0)); await support.preparation;
      assert.equal(f.rows('Remote updated title').rows[0]?.tree.id, 'root-7');
      assert.ok(f.rows('Notes/Note-7.md Root 7').rows.every(row => row.tree.meta.title !== 'Root 7'), 'ID/path matches retain only the refreshed title, never cached old metadata');
      assert.ok(support.catalog.get('Source.md') === sourceFacts, 'remote change reuses the unchanged source facts');
    } finally { globalThis.__inputPerformance = undefined; f.h.plugin.unload(); }
  });
  test('registered empty wikilink bounds rows and expensive work on a 3662-note synthetic vault', () => {
    const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url)], { cwd: root, encoding: 'utf8', timeout: 40000, maxBuffer: 1024 * 1024, env: { ...process.env, HYBRID_INPUT_PERF_CHILD: '1' } });
    console.log(result.stdout);
    assert.equal(result.error?.code, undefined, 'candidate generation must complete within the child-process safety timeout');
    assert.equal(result.status, 0, result.stderr);
    const complete = result.stdout.trim().split('\n').map(line => JSON.parse(line)).find(row => row.phase === 'complete');
    assert.ok(complete, 'finished actual generation metrics, not fabricated timeout results');
    const m = complete.metric;
    assert.equal(m.catalogBuilds, 0, 'interactive completion never rebuilds the search catalog');
    assert.equal(m.vaultEnumerations, 0, 'prepared completion never enumerates native vault files');
    assert.ok(m.rows <= 100, `${m.rows} rows exceed the native UI budget`);
    assert.ok(m.resolves <= 100, `${m.resolves} real resolver calls exceed the candidate-work budget`);
    assert.ok(m.treeVisits <= 101, `${m.treeVisits} tree visits show an eager empty-query scan`);
    assert.ok(m.linktextCalls <= 100, 'native formatting is bounded before generating choices');
    assert.ok(m.treeRows >= 40 && m.fileRows >= 40, 'trees cannot starve native attachments or vice versa');
    assert.equal(m.vaultReads, 0, 'input completion does not read Markdown or binaries');
  });
  test('bounded completion still finds the last tree ID and last native attachment', async () => {
    const f = await fixture();
    try {
      for (const [query, identity] of [['CHILD-3661-9', 'child-3661-9'], ['Notes/Note-3661.md Child 3661 9', 'child-3661-9']]) {
        const { rows, metric } = f.rows(query);
        assert.equal(rows.length, 1); assert.equal(rows[0].tree.id, identity); assert.equal(metric.resolves, 1);
      }
      const { rows, metric } = f.rows('Assets Asset-275 svg');
      assert.equal(rows.length, 1); assert.equal(rows[0].file.path, 'Assets/Asset-275.svg'); assert.equal(metric.linktextCalls, 1);
      f.links.selectSuggestion(rows[0]);
      assert.ok(f.view.editor.value.endsWith('[[Asset-275.svg]]'), 'safe native literal selection remains usable');
      assert.equal(f.h.vault.processes.length, 0, 'native assets never mint or write through the controller');
    } finally { f.h.plugin.unload(); }
  });
}
