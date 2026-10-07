import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { createHarness, MockEditor, TFile, notices } from './controller-obsidian-mock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const mock = fileURLToPath(new URL('./controller-obsidian-mock.mjs', import.meta.url));
await build({ absWorkingDir: root, entryPoints: ['src/main.ts'], outfile: 'test/build/hybrid-acceptance-main-v2.mjs', bundle: true, format: 'esm', platform: 'node', external: ['@codemirror/state', '@codemirror/view'], plugins: [{ name: 'native-obsidian-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true })); } }] });
const { default: ForesterPlugin } = await import('./build/hybrid-acceptance-main-v2.mjs');
const options = excludedFolders => ({ folders: [], excludedFolders, publicFolders: [], reservedIds: [] });
const body = '# Ordinary\n\n## Part\nBody\n\n## Other part\nMore';
const legacy = (text, mode) => `---\nforester-mode: ${mode}\n---\n${text}`;
async function start(entries, excludedFolders = []) {
  const h = createHarness(entries, options(excludedFolders));
  const plugin = new ForesterPlugin(h.app);
  plugin.loadData = async () => ({ hybrid: options(excludedFolders) });
  await plugin.onload();
  return { h, plugin, c: plugin.hybridController, close() { plugin.unload(); h.plugin.unload(); } };
}
function pauseRead(h, at = 1) {
  let release, began, count = 0;
  const started = new Promise(resolve => began = resolve), gate = new Promise(resolve => release = resolve);
  const read = h.vault.read;
  h.vault.read = async file => { const sampled = await read(file); if (++count === at) { began(); await gate; } return sampled; };
  return { started, release };
}
const command = (plugin, kind, view) => plugin.commands.get(`mint-${kind}-address`).editorCallback(view.editor, view);

// The old opt-in/legacy editor-only controls are intentionally replaced by the
// new contract. These cases still execute the registered main command and real
// controller/core/CAS, not a stand-in writer or source-string inspection.
for (const mode of ['false', 'true', 'hybrid-v0', 'hybrid-v1']) {
  test(`legacy forester-mode ${mode} does not disable the real subtree command`, async () => {
    const source = legacy(body, mode), s = await start({ 'Page.md': source }); const view = s.h.open('Page.md');
    await command(s.plugin, 'subtree', view);
    assert.match(s.h.vault.data.get('Page.md'), /## Other part \^[0-9A-F]{6}/);
    assert.match(s.h.vault.data.get('Page.md'), /## Part \^[0-9A-F]{6}/);
    assert.equal(view.editor.getValue(), s.h.vault.data.get('Page.md'));
    assert.ok(!view.editor.getValue().includes('forester-id:'), 'subtree-only normalization does not move the root route'); s.close();
  });
}
for (const kind of ['note', 'subtree']) {
  test(`excluded folders block ${kind} commands and every retained legacy write path`, async () => {
    const source = legacy(body, 'true'), s = await start({ 'Native/Page.md': source }, ['Native']); const view = s.h.open('Native/Page.md');
    await command(s.plugin, kind, view); await s.plugin.lintActiveNote('notes'); await s.plugin.retargetVault();
    assert.equal(s.h.vault.data.get('Native/Page.md'), source); assert.equal(view.editor.getValue(), source);
    assert.deepEqual(s.h.vault.processes, []); s.close();
  });
  test(`registered ${kind} command reports genuine native read errors without success`, async t => {
    const s = await start({ 'Page.md': body }); const view = s.h.open('Page.md');
    const failure = new Error('native address disk read failed'), errors = [];
    t.mock.method(console, 'error', (...args) => errors.push(args));
    s.h.vault.read = async () => { throw failure; };
    await assert.doesNotReject(() => command(s.plugin, kind, view));
    assert.equal(s.h.vault.data.get('Page.md'), body); assert.equal(view.editor.getValue(), body);
    assert.ok(notices.some(message => message.includes(failure.message)), 'native error provenance is visible');
    assert.ok(!notices.some(message => /address minted/.test(message))); s.close();
  });
}

for (const kind of ['note', 'subtree']) test(`registered ${kind} command reports an unreadable initial editor snapshot`, async t => {
  const s = await start({ 'Page.md': body }); const view = s.h.open('Page.md'), failure = new Error('initial editor unavailable');
  t.mock.method(console, 'error', () => {}); view.editor.getValue = () => { throw failure; };
  await assert.doesNotReject(() => command(s.plugin, kind, view));
  assert.ok(notices.some(message => message.includes(failure.message))); assert.equal(s.h.vault.data.get('Page.md'), body); s.close();
});

for (const readAt of [1, 2]) for (const change of ['other-view', 'rebound-file', 'renamed-file', 'replaced-editor', 'source-input', 'cursor-line', 'cursor-column', 'unavailable-source', 'unavailable-cursor', 'unavailable-editor', 'disk-source', 'exclude']) {
  test(`manual subtree CAS retires ${change} at native read ${readAt}`, { timeout: 3000 }, async t => {
    const s = await start({ 'Page.md': body, 'Other.md': body }); const view = s.h.open('Page.md'), editor = view.editor, file = view.file;
    const gate = pauseRead(s.h, readAt), errors = []; t.mock.method(console, 'error', (...args) => errors.push(args));
    const pending = command(s.plugin, 'subtree', view); await gate.started;
    if (change === 'other-view') s.h.open('Other.md');
    else if (change === 'rebound-file') view.file = s.h.vault.files.get('Other.md');
    else if (change === 'renamed-file') file.path = 'Renamed.md';
    else if (change === 'replaced-editor') view.editor = s.h.open('Other.md').editor;
    else if (change === 'source-input') editor.value += '\nFresh typing';
    else if (change === 'cursor-line') editor.setCursor({ line: 2, ch: 0 });
    else if (change === 'cursor-column') editor.setCursor({ line: 6, ch: 1 });
    else if (change === 'unavailable-source') editor.getValue = () => { throw new Error('source unavailable'); };
    else if (change === 'unavailable-cursor') editor.getCursor = () => { throw new Error('cursor unavailable'); };
    else if (change === 'unavailable-editor') Object.defineProperty(view, 'editor', { get() { throw new Error('editor unavailable'); } });
    else if (change === 'disk-source') s.h.vault.data.set('Page.md', body + '\nSync change');
    else s.plugin.settings.hybrid.excludedFolders = ['/'];
    gate.release(); await assert.doesNotReject(() => pending);
    assert.equal(editor.value, change === 'source-input' ? body + '\nFresh typing' : body);
    assert.equal(s.h.vault.data.get('Page.md'), change === 'disk-source' ? body + '\nSync change' : body);
    assert.equal(s.h.vault.data.get('Other.md'), body); s.close();
  });
}

for (const readAt of [1, 2]) for (const change of ['dirty-existing', 'new-markdown-buffer', 'new-non-markdown-buffer', 'unreadable-value', 'unreadable-editor']) {
  test(`manual CAS checks all matching buffers at native read ${readAt}: ${change}`, { timeout: 3000 }, async t => {
    const s = await start({ 'Page.md': body }); const inactive = s.h.open('Page.md'), view = s.h.open('Page.md');
    const gate = pauseRead(s.h, readAt); t.mock.method(console, 'error', () => {});
    const pending = command(s.plugin, 'subtree', view); await gate.started;
    if (change === 'dirty-existing') inactive.editor.value += '\nInactive typing';
    else if (change === 'new-markdown-buffer') s.h.open('Page.md', body + '\nNew matching buffer');
    else if (change === 'new-non-markdown-buffer') {
      const native = { file: view.file }; native.editor = new MockEditor(body + '\nCanvas typing', native, s.h.plugin); s.h.workspace.views.push(native);
    } else if (change === 'unreadable-value') inactive.editor.getValue = () => { throw new Error('inactive buffer unavailable'); };
    else Object.defineProperty(inactive, 'editor', { get() { throw new Error('inactive editor unavailable'); } });
    gate.release(); await assert.doesNotReject(() => pending);
    assert.equal(s.h.vault.data.get('Page.md'), body); assert.equal(view.editor.getValue(), body); s.close();
  });
}

for (const targetActive of [false, true]) {
  test(`dirty referenced target blocks the actual linter in either active-leaf order: ${targetActive}`, async () => {
    const source = '# Page\n\n[[Book#Part]]', target = '# Book\n\n## Part\nBody';
    const s = await start({ 'Page.md': source, 'Book.md': target });
    const dirty = s.h.open('Book.md', target + '\nUnsaved'), author = s.h.open('Page.md');
    if (targetActive) { s.h.workspace.active = dirty; s.h.workspace.active = author; }
    await s.plugin.lintActiveNote('notes');
    assert.equal(s.h.vault.data.get('Page.md'), source); assert.equal(s.h.vault.data.get('Book.md'), target);
    assert.equal(author.editor.getValue(), source); assert.equal(dirty.editor.getValue(), target + '\nUnsaved');
    assert.deepEqual(s.h.vault.processes, []); s.close();
  });
}

for (const failure of ['partial-rollback', 'safe-rollback', 'unload', 'switch', 'new-dirty-target']) {
  test(`ID-less input target uses the same transactional rollback: ${failure}`, async t => {
    const source = '# Page\n\n/transclude', target = '# Book\n\nBody'; const s = await start({ 'Page.md': source, 'Book.md': target, 'Other.md': '# Other' });
    const targetView = s.h.open('Book.md'), author = s.h.open('Page.md'); const tree = s.c.currentIndex().documents.get('Book.md').root;
    t.mock.method(console, 'error', () => {}); let targetWrites = 0;
    s.h.vault.beforeProcess = async file => {
      if (file.path === 'Book.md') { if (++targetWrites > 1 && failure === 'partial-rollback') throw new Error('rollback denied'); return; }
      if (file.path !== 'Page.md') return;
      if (failure === 'unload') s.plugin.unload();
      else if (failure === 'switch') s.h.open('Other.md');
      else if (failure === 'new-dirty-target') targetView.editor.value += '\nConcurrent target typing';
      else throw new Error('source write failed');
    };
    await s.c.insertTarget(author.editor, author.file, tree, true, { from: { line: 2, ch: 0 }, to: { line: 2, ch: 11 }, before: source });
    assert.equal(s.h.vault.data.get('Page.md'), source); assert.equal(author.editor.getValue(), source);
    if (failure === 'partial-rollback' || failure === 'new-dirty-target') {
      assert.notEqual(s.h.vault.data.get('Book.md'), target); assert.ok(notices.some(message => /partial rollback/.test(message)));
    } else { assert.equal(s.h.vault.data.get('Book.md'), target); assert.equal(targetView.editor.getValue(), target); }
    assert.ok(!notices.some(message => /address minted/.test(message))); s.close();
  });
}

test('real linter stabilizes only live references and preserves raw/code/math/quote regions', async () => {
  const guarded = '`[[Book#Part]]`\n\n$[[Book#Part]]$\n\n\\{ [[Book#Part]] }\n\n> [[Book#Part]]';
  const source = '# Page\n\n[[Book#Part|manual]]\n\n' + guarded;
  const s = await start({ 'Page.md': source, 'Book.md': '# Book\n\n## Part ^manual-id\nBody' }); const view = s.h.open('Page.md');
  await s.plugin.lintActiveNote('notes');
  assert.ok(s.h.vault.data.get('Page.md').includes('[[Book#^manual-id|manual]]')); assert.ok(s.h.vault.data.get('Page.md').endsWith(guarded));
  assert.equal(view.editor.getValue(), s.h.vault.data.get('Page.md')); s.close();
});

test('cursor changes before queued manual planning cancel the captured owner', async () => {
  const s = await start({ 'Page.md': body }); const view = s.h.open('Page.md');
  const pending = command(s.plugin, 'subtree', view); view.editor.setCursor({ line: 2, ch: 0 }); await pending;
  assert.equal(s.h.vault.data.get('Page.md'), body); assert.equal(view.editor.getValue(), body); s.close();
});

test('manual commands refuse unbound files and protected example headings have no eligible subtree', async () => {
  const source = '# Page\n\n```\n## Example\n```', s = await start({ 'Page.md': source }); const view = s.h.open('Page.md');
  await s.plugin.mintSubtreeAddress(view.editor, null); await command(s.plugin, 'subtree', view);
  assert.equal(s.h.vault.data.get('Page.md'), source); assert.deepEqual(s.h.vault.processes, []);
  assert.ok(notices.some(message => message.includes('no eligible subtree'))); s.close();
});

test('an inline [[ choice confirmed before autosave saves the typed text first and inserts the link', async () => {
  const saved = '# Page\n\nSee ', typed = saved + '[[par]]';
  const s = await start({ 'Page.md': saved, 'Book.md': '# Book\n\n## Part ^ABC123\nBody' });
  const author = s.h.open('Page.md');
  author.editor.value = typed;   // typed text Obsidian has not autosaved yet
  assert.equal(s.h.vault.data.get('Page.md'), saved);
  const tree = s.c.currentIndex().documents.get('Book.md').trees.find(t => t.id === 'ABC123');
  const at = typed.indexOf('[[');
  await s.c.insertTarget(author.editor, author.file, tree, false, { from: { line: 2, ch: at - saved.lastIndexOf('\n') - 1 }, to: { line: 2, ch: typed.length - typed.lastIndexOf('\n') - 1 }, before: typed });
  assert.ok(!notices.some(message => /保存を中止/.test(message)), notices.join('\n'));
  assert.equal(s.h.vault.data.get('Page.md'), saved + '[[ABC123|Part]]');
  assert.equal(author.editor.getValue(), saved + '[[ABC123|Part]]');
  assert.ok(s.h.vault.saves >= 1, 'the owning view was saved before the commit');
  s.close();
});
