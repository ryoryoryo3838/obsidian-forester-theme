import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The unavailable Obsidian runtime is the only mocked boundary. The actual
// input adapter and parser/index/resolver are bundled in an isolated directory.
const root = fileURLToPath(new URL('../', import.meta.url));
const buildDir = new URL('./build/v2-input-module/', import.meta.url);
mkdirSync(buildDir, { recursive: true });
const mockUrl = new URL('obsidian-mock.mjs', buildDir);
writeFileSync(mockUrl, `
import { parseHTML } from 'linkedom';
export const { document, window } = parseHTML('<html><body></body></html>');
export const notices = [];
export const modals = [];
export class Notice { constructor(message) { notices.push(String(message)); } }
export class EditorSuggest {
  constructor(app) { this.app = app; this.context = null; this.limit = 100; this.closed = false; }
  setInstructions(instructions) { this.instructions = instructions; }
  open() { this.closed = false; }
  close() { this.closed = true; this.context = null; }
}
export class SuggestModal {
  constructor(app) { this.app = app; this.inputEl = document.createElement('input'); this.limit = 100; this.closed = true; }
  setPlaceholder(text) { this.inputEl.placeholder = text; }
  setInstructions(instructions) { this.instructions = instructions; }
  open() { this.closed = false; modals.push(this); this.onOpen?.(); }
  close() { this.closed = true; this.onClose?.(); }
  // Native selection closes the modal before invoking the chosen callback.
  selectSuggestion(item, event) { this.close(); return this.onChooseSuggestion(item, event); }
}
`);
const mock = await import(mockUrl.href);
await build({ absWorkingDir: root, entryPoints: ['src/hybrid-core.ts'], bundle: true, platform: 'node', format: 'esm', outfile: fileURLToPath(new URL('core.mjs', buildDir)), logLevel: 'silent' });
const core = await import(new URL('core.mjs', buildDir).href);
let input = {};
if (existsSync(new URL('../src/hybrid-input.ts', import.meta.url))) {
  await build({ absWorkingDir: root, entryPoints: ['src/hybrid-input.ts'], bundle: true, platform: 'node', format: 'esm', outfile: fileURLToPath(new URL('input.mjs', buildDir)), logLevel: 'silent', plugins: [{ name: 'native-input-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: fileURLToPath(mockUrl), external: true })); } }] });
  input = await import(new URL('input.mjs', buildDir).href);
}
const options = { folders: ['/'], excludedFolders: ['Disabled'], publicFolders: [], reservedIds: [] };
const optin = (body, extra = '') => `---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;
const makeIndex = entries => core.indexHybrid(Object.entries(entries).map(([path, source]) => core.parseHybrid(path, source, options)));
const samePos = (a, b) => a.line === b.line && a.ch === b.ch;
class Editor {
  constructor(value) { this.value = value; this.selections = [{ anchor: this.offsetToPos(value.length), head: this.offsetToPos(value.length) }]; this.replacements = []; }
  getValue() { return this.value; }
  getLine(line) { return this.value.split('\n')[line]; }
  listSelections() { return structuredClone(this.selections); }
  getCursor(side = 'head') {
    const { anchor, head } = this.selections[0];
    if (side === 'head' || side === 'anchor') return { ...this.selections[0][side] };
    const ordered = this.posToOffset(anchor) <= this.posToOffset(head) ? [anchor, head] : [head, anchor];
    return { ...ordered[side === 'from' ? 0 : 1] };
  }
  posToOffset(pos) { return this.value.split('\n').slice(0, pos.line).reduce((n, line) => n + line.length + 1, 0) + pos.ch; }
  offsetToPos(offset) { const lines = this.value.slice(0, offset).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; }
  getRange(from, to) { return this.value.slice(this.posToOffset(from), this.posToOffset(to)); }
  setCursor(pos) { this.setSelection(pos, pos); }
  setSelection(anchor, head = anchor) { this.selections = [{ anchor: { ...anchor }, head: { ...head } }]; }
  replaceRange(text, from, to = from) { const start = this.posToOffset(from), end = this.posToOffset(to); this.replacements.push({ text, from: { ...from }, to: { ...to } }); this.value = this.value.slice(0, start) + text + this.value.slice(end); }
  focus() { this.focused = true; }
}
function harness(entries = { 'Source.md': optin('Text ') }, activePath = 'Source.md') {
  mock.notices.length = 0; mock.modals.length = 0;
  let index = makeIndex(entries);
  const files = new Map(Object.keys(entries).map(path => [path, { path, extension: 'md', basename: path.split('/').pop().replace(/\.md$/, '') }]));
  const events = new Map(), cleanups = [];
  const workspace = {
    activeEditor: null,
    on(name, callback) { const ref = { name, callback }; const list = events.get(name) ?? []; list.push(ref); events.set(name, list); return ref; },
    offref(ref) { events.set(ref.name, (events.get(ref.name) ?? []).filter(r => r !== ref)); },
    emit(name, ...args) { for (const ref of [...(events.get(name) ?? [])]) ref.callback(...args); },
    getActiveFile() { return this.activeEditor?.file ?? null; },
  };
  const app = { workspace, vault: {
    getAbstractFileByPath: path => files.get(path) ?? null,
    getFileByPath: path => files.get(path) ?? null,
    read() { throw new Error('Input must not read the vault'); },
    cachedRead() { throw new Error('Input must not read the vault'); },
    getMarkdownFiles() { throw new Error('Input must not enumerate the vault'); },
  } };
  const plugin = { app, commands: new Map(), suggests: [], register(fn) { cleanups.push(fn); }, registerEvent(ref) { cleanups.push(() => workspace.offref(ref)); }, registerEditorSuggest(suggest) { this.suggests.push(suggest); }, addCommand(command) { this.commands.set(command.id, command); }, unload() { for (const fn of cleanups.splice(0).reverse()) fn(); } };
  const calls = [], resolutions = [];
  const host = {
    index() { return index; },
    resolve(target, path) { resolutions.push({ target, path }); return core.resolveHybrid(index, target, path); },
    async insertTarget(...args) { calls.push(args); },
  };
  const h = { plugin, host, calls, resolutions, files, workspace,
    index() { return index; },
    reindex(next) { index = makeIndex(next); for (const path of Object.keys(next)) if (!files.has(path)) files.set(path, { path, extension: 'md' }); },
    open(path, source = entries[path]) { const info = { file: files.get(path), editor: new Editor(source) }; workspace.activeEditor = info; return info; },
    register() { assert.equal(typeof input.registerHybridInput, 'function', 'actual input registration is exported'); input.registerHybridInput(plugin, host); return plugin.suggests[0]; },
    trigger() { const { file, editor } = workspace.activeEditor; const suggest = plugin.suggests[0]; const trigger = suggest.onTrigger(editor.getCursor(), editor, file); if (!trigger) return null; suggest.context = { ...trigger, file, editor }; return suggest.context; },
    async slash(command) { const context = h.trigger(); assert.ok(context, 'slash triggers in current editor'); const rows = await plugin.suggests[0].getSuggestions(context); const row = rows.find(r => r.command === command); assert.ok(row, `/${command} suggestion is available`); return plugin.suggests[0].selectSuggestion(row, {}); },
  };
  h.open(activePath);
  return h;
}
const settle = async () => { for (let i = 0; i < 3; i++) await new Promise(setImmediate); };

// This explicit availability assertion is the first RED; a missing module is
// not confused with a bundler/import error.
test('tree search matches preserved ID spelling, semantic title and source file/path across enabled trees', () => {
  assert.equal(typeof input.filterHybridTrees, 'function', 'pure indexed tree search is exported');
  const index = makeIndex({
    'Books/Alpha.md': optin('# Native root\n\n## Native child ^AbC-123\n%% title: Semantic child %%\nBody', 'forester-id: ROOT-id\ntitle: Root semantic\n'),
    'Other/Beta.md': optin('# Beta\n\n## Another ^other-id'),
    'Disabled/Hidden.md': '---\nforester-mode: false\nforester-id: hidden-id\n---\n# Secret semantic',
  });
  const search = query => input.filterHybridTrees(index, query);
  assert.equal(search('abc-123')[0].id, 'AbC-123');
  assert.equal(search('semantic child')[0].id, 'AbC-123');
  assert.equal(search('books/alpha.md child')[0].id, 'AbC-123');
  assert.equal(search('alpha.md').length, 2);
  assert.equal(search('ROOT-ID')[0].meta.title, 'Root semantic');
  assert.equal(search('hidden-id').length, 0);
  assert.equal(search('Native child').length, 0, 'search uses semantic title, not overridden source heading');
  assert.equal(search(' \t ').length, 4, 'roots without IDs remain candidates');
  assert.equal(index.documents.get('Books/Alpha.md').trees[1].id, 'AbC-123', 'filter does not normalize identity spelling');
});

test('native slash suggestions create a blank H2 with the cursor ready for its title', async () => {
  const before = optin('/su\nBody');
  const h = harness({ 'Source.md': before });
  const suggest = h.register();
  assert.ok(suggest instanceof mock.EditorSuggest, 'uses the public native EditorSuggest');
  const editor = h.workspace.activeEditor.editor;
  editor.setCursor(editor.offsetToPos(before.indexOf('/su') + 3));
  const context = h.trigger();
  assert.equal(context.query, 'su');
  const rows = await suggest.getSuggestions(context);
  assert.deepEqual(rows.map(row => row.command), ['subtree']);
  suggest.selectSuggestion(rows[0], {});
  assert.equal(editor.getValue(), before.replace('/su', '## '));
  assert.deepEqual(editor.getCursor(), editor.offsetToPos(before.indexOf('/su') + 3));
  assert.equal(h.calls.length, 0, 'minting is left to the host settled-save integration');
  assert.equal(h.plugin.commands.get('insert-subtree').hotkeys, undefined, 'no hotkey defaults');
  editor.setCursor(editor.offsetToPos(editor.value.length));
  h.plugin.commands.get('insert-subtree').editorCallback(editor, h.workspace.activeEditor);
  assert.ok(editor.getValue().endsWith('Body\n\n## '), 'palette insertion starts an actual H2, not inline hashes');
});

test('slash and palette activation use the current editor protected ranges and fail closed outside editable hybrid prose', () => {
  const protectedBodies = [
    '`code /su`', '``code /su``', '```md\n/su\n```', '~~~\n/su\n~~~',
    '    /su', '\t/su', '> quote /su', '> quote\nlazy /su',
    '$math /su$', '$$\n/su\n$$', '\\(math /su\\)', '\\[\n/su\n\\]',
    '\\{\\title{outer {nested /su}}}', '<!-- /su -->', '%% /su %%',
  ];
  for (const body of protectedBodies) {
    const initial = optin('Editable');
    const h = harness({ 'Source.md': initial }); h.register();
    const editor = h.workspace.activeEditor.editor;
    const source = optin(body); editor.value = source;
    editor.setCursor(editor.offsetToPos(source.indexOf('/su') + 3));
    assert.equal(h.trigger(), null, `protected current draft: ${body}`);
    h.plugin.commands.get('insert-subtree').editorCallback(editor, h.workspace.activeEditor);
    assert.equal(editor.value, source, 'palette command also respects protected ranges');
  }
  for (const body of ['https://example.org/su', 'path/to/su', 'either/su', '\\/su', '/sunrise', '/unknown', '//su']) {
    const h = harness({ 'Source.md': optin(body) }); h.register();
    assert.equal(h.trigger(), null, `not a known whitespace/start-line command: ${body}`);
  }
  const h = harness({ 'Source.md': optin('Editable', 'description: /su\n') }); h.register();
  const editor = h.workspace.activeEditor.editor;
  editor.setCursor(editor.offsetToPos(editor.value.indexOf('/su') + 3));
  assert.equal(h.trigger(), null, 'frontmatter is protected');
  editor.value = optin('/su').replace('hybrid-v1', 'false'); editor.setCursor(editor.offsetToPos(editor.value.length));
  assert.ok(h.trigger(), 'v2 path scope does not let legacy forester-mode disable Markdown');
  editor.value = optin('/su'); editor.setCursor(editor.offsetToPos(editor.value.length));
  editor.selections.push(structuredClone(editor.selections[0]));
  assert.equal(h.trigger(), null, 'multiple carets are not rewritten');
  const disabled = harness({ 'Disabled/Source.md': '/su' }, 'Disabled/Source.md'); disabled.register();
  assert.equal(disabled.trigger(), null, 'disabled indexed source is not activated');
  const ordinary = harness(); ordinary.register();
  ordinary.workspace.activeEditor.editor.getValue = () => { throw new Error('Normal input should short circuit before a document scan'); };
  assert.equal(ordinary.trigger(), null, 'normal typing does not scan the document');
});

test('slash tree pickers pass link/embed intent, exact target spelling and explicit replacement snapshots to the host', async () => {
  for (const [command, embed] of [['link', false], ['transclude', true]]) {
    const before = optin(`Intro /${command} tail`);
    const h = harness({ 'Source.md': before, 'Books/Alpha.md': optin('# Source heading\n\n## Child ^AbC-123\n%% title: Semantic child %%\nBody', 'forester-id: ROOT-id\ntitle: "<img src=x onerror=alert(1)> & title"\n') });
    const suggest = h.register();
    const editor = h.workspace.activeEditor.editor;
    editor.setCursor(editor.offsetToPos(before.indexOf(`/${command}`) + command.length + 1));
    const slashEl = mock.document.createElement('div');
    const context = h.trigger(); assert.ok(context, `/${command} is recognized`);
    const slashRows = await suggest.getSuggestions(context); suggest.renderSuggestion(slashRows[0], slashEl);
    assert.ok(slashEl.textContent.includes(command));
    await h.slash(command);
    const modal = mock.modals.at(-1);
    assert.ok(modal instanceof mock.SuggestModal, 'uses the public native SuggestModal');
    assert.equal(editor.getValue(), before, 'opening picker does not erase the slash');
    const results = await modal.getSuggestions('alpha.md Semantic child');
    assert.equal(results.length, 1);
    assert.equal(results[0].tree.id, 'AbC-123');
    const rootRow = (await modal.getSuggestions('root-id'))[0];
    const el = mock.document.createElement('div'); modal.renderSuggestion(rootRow, el);
    assert.ok(el.textContent.includes('ROOT-id'));
    assert.ok(el.textContent.includes('<img src=x onerror=alert(1)> & title'));
    assert.ok(el.textContent.includes('Books/Alpha.md'));
    assert.equal(el.querySelector('img'), null, 'titles are rendered as text, not HTML');
    await modal.selectSuggestion(results[0], {}); await settle();
    assert.equal(h.calls.length, 1);
    const [calledEditor, calledFile, tree, calledEmbed, replacement] = h.calls[0];
    assert.equal(calledEditor, editor);
    assert.equal(calledFile, h.workspace.activeEditor.file);
    assert.equal(tree.id, 'AbC-123', 'identity spelling is not normalized');
    assert.equal(calledEmbed, embed);
    assert.deepEqual(replacement, { from: editor.offsetToPos(before.indexOf(`/${command}`)), to: editor.offsetToPos(before.indexOf(`/${command}`) + command.length + 1), before });
    assert.equal(editor.getValue(), before, 'only the host performs link/embed insertion and minting');
    assert.equal(suggest.context, null, 'slash popover is closed when picker opens');
  }
});

test('palette picker replaces the original selection and registers only distinct commands without default hotkeys', async () => {
  const before = optin('Select this text');
  const h = harness({ 'Source.md': before, 'Target.md': optin('# Root without identity') });
  const mint = { id: 'mint-subtree-address', editorCallback() {} }; h.plugin.commands.set(mint.id, mint);
  h.register();
  assert.deepEqual([...h.plugin.commands.keys()].filter(id => id !== mint.id).sort(), ['insert-subtree', 'insert-tree-embed', 'insert-tree-link']);
  assert.equal(h.plugin.commands.get(mint.id), mint, 'existing mint command is untouched');
  for (const id of ['insert-subtree', 'insert-tree-embed', 'insert-tree-link']) assert.equal(h.plugin.commands.get(id).hotkeys, undefined);
  const editor = h.workspace.activeEditor.editor;
  const from = editor.offsetToPos(before.indexOf('this')), to = editor.offsetToPos(before.length);
  editor.setSelection(to, from);
  h.plugin.commands.get('insert-tree-link').editorCallback(editor, h.workspace.activeEditor);
  const modal = mock.modals.at(-1);
  const rows = await modal.getSuggestions('Target');
  assert.equal(rows.length, 1, 'a root without ID is selectable; host must mint/revalidate');
  await modal.selectSuggestion(rows[0], {}); await settle();
  assert.equal(h.calls[0][2].id, undefined);
  assert.deepEqual(h.calls[0][4], { from, to, before });
});

test('picker selection aborts on changed source, selection, source file or editor binding, including change-then-revert events', async () => {
  const before = optin('Text /link');
  const entries = { 'Source.md': before, 'Other.md': optin('Other'), 'Target.md': optin('# Target', 'forester-id: AbC-123\n') };
  const mutations = [
    ['full draft snapshot', h => { h.workspace.activeEditor.editor.value = before.replace('Text', 'Else'); }],
    ['indexed source changed while draft stayed the same', h => { h.reindex({ ...entries, 'Source.md': before.replace('Text', 'Else') }); }],
    ['selection moved', h => { h.workspace.activeEditor.editor.setCursor({ line: 3, ch: 0 }); }],
    ['multiple selections', h => { const e = h.workspace.activeEditor.editor; e.selections.push(structuredClone(e.selections[0])); }],
    ['different editor for same file', h => { h.open('Source.md', before); }],
    ['same editor rebound to another file', h => { h.workspace.activeEditor.file = h.files.get('Other.md'); }],
    ['renamed file', h => { h.workspace.activeEditor.file.path = 'Renamed.md'; }],
    ['deleted file', h => { h.files.delete('Source.md'); }],
    ['scope changed while open', h => { h.index().documents.get('Source.md').enabled = false; }],
    ['edit then undo to same bytes', h => { const info = h.workspace.activeEditor; info.editor.value += 'x'; h.workspace.emit('editor-change', info.editor, info); info.editor.value = before; h.workspace.emit('editor-change', info.editor, info); }],
    ['different Markdown editor then return', h => { const info = h.workspace.activeEditor; h.open('Other.md', entries['Other.md']); h.workspace.emit('active-leaf-change', {}); h.workspace.activeEditor = info; h.workspace.emit('active-leaf-change', {}); }],
  ];
  for (const [label, mutate] of mutations) {
    const h = harness(entries); h.register();
    await h.slash('link'); const modal = mock.modals.at(-1);
    const row = (await modal.getSuggestions('AbC-123'))[0]; assert.ok(row);
    mutate(h);
    await modal.selectSuggestion(row, {}); await settle();
    assert.equal(h.calls.length, 0, `stale ${label} never reaches host insertion`);
  }
});

test('cancelled modal, repeated choice and plugin unload cannot issue stale insertions; sidebar focus preserves the same Markdown editor', async () => {
  const entries = { 'Source.md': optin('/link'), 'Target.md': optin('# Target', 'forester-id: AbC-123\n') };
  const cancelled = harness(entries); cancelled.register(); await cancelled.slash('link');
  const cancelledModal = mock.modals.at(-1), cancelledRow = (await cancelledModal.getSuggestions('abc-123'))[0];
  cancelledModal.close(); await cancelledModal.onChooseSuggestion(cancelledRow, {}); await settle();
  assert.equal(cancelled.calls.length, 0, 'Escape/cancel leaves the slash and source unchanged');
  assert.equal(cancelled.workspace.activeEditor.editor.value, entries['Source.md']);
  const same = harness(entries); same.register(); await same.slash('link');
  const sameModal = mock.modals.at(-1), sameRow = (await sameModal.getSuggestions('abc-123'))[0];
  same.workspace.activeEditor = { ...same.workspace.activeEditor };
  same.workspace.emit('active-leaf-change', { view: { type: 'hybrid-sidebar' } });
  same.workspace.emit('file-open', same.workspace.activeEditor.file);
  await sameModal.selectSuggestion(sameRow, {}); await sameModal.onChooseSuggestion(sameRow, {}); await settle();
  assert.equal(same.calls.length, 1, 'native choose-after-close works once despite sidebar/picker focus');
  const unloaded = harness(entries); const suggest = unloaded.register(); await unloaded.slash('link');
  const unloadModal = mock.modals.at(-1), unloadRow = (await unloadModal.getSuggestions('abc-123'))[0];
  unloaded.plugin.unload();
  assert.equal(unloadModal.closed, true, 'unload closes native picker');
  assert.equal(suggest.context, null);
  await unloadModal.onChooseSuggestion(unloadRow, {}); await settle();
  assert.equal(unloaded.calls.length, 0, 'unloaded plugin never invokes host');
});

test('stale slash suggestion cannot rewrite text after editing or changing the active file', async () => {
  for (const kind of ['draft', 'selection', 'file', 'closed']) {
    const h = harness({ 'Source.md': optin('/su'), 'Other.md': optin('Other') }); const suggest = h.register();
    const context = h.trigger(), row = (await suggest.getSuggestions(context))[0];
    const editor = context.editor, original = editor.value;
    if (kind === 'draft') editor.value = original + 'x';
    if (kind === 'selection') editor.setCursor({ line: 3, ch: 0 });
    if (kind === 'file') h.open('Other.md', optin('Other'));
    if (kind === 'closed') suggest.close();
    const current = editor.value;
    suggest.selectSuggestion(row, {});
    assert.equal(editor.value, current, `stale ${kind} slash selection does not replace its old range`);
    assert.equal(editor.replacements.length, 0);
  }
});

test('picker refreshes the current index and hides duplicate IDs, file/alias collisions and ambiguous no-ID headings through the host resolver', async () => {
  const entries = {
    'Source.md': optin('/link'),
    'Target.md': optin('# Target\n\n## Original ^AbC-123\n%% title: Semantic child %%\nBody\n\n## No ID heading\n%% title: Semantic no ID %%\nBody', 'forester-id: root-id\n'),
    'One.md': optin('# One', 'forester-id: duplicate\n'),
    'Two.md': optin('# Two', 'forester-id: DUPLICATE\n'),
    'Collision.md': optin('# Colliding', 'forester-id: file-id\n'),
    'Disabled/file-id.md': '# Native excluded file still collides with a bare ID',
    'AliasTarget.md': optin('# AliasTarget', 'forester-id: alias-id\n'),
    'Disabled/Alias.md': '---\naliases: [alias-id]\n---\n# Native',
    'Headings.md': optin('# Headings\n\n## Repeated\nOne\n\n## Repeated\nTwo'),
  };
  const h = harness(entries); h.register(); await h.slash('link'); const modal = mock.modals.at(-1);
  assert.equal((await modal.getSuggestions('duplicate')).length, 0, 'case-insensitive duplicate IDs are not selectable');
  assert.equal((await modal.getSuggestions('file-id')).length, 0, 'even disabled filename collisions stop bare ID insertion');
  assert.equal((await modal.getSuggestions('alias-id')).length, 0, 'even disabled alias collisions stop bare ID insertion');
  assert.equal((await modal.getSuggestions('Repeated')).length, 0, 'ambiguous heading cannot be minted by selecting a guessed match');
  const noId = await modal.getSuggestions('Semantic no ID');
  assert.equal(noId.length, 1, 'no-ID subtree uses its actual source heading for host resolution');
  const preserved = await modal.getSuggestions('abc-123');
  assert.equal(preserved[0].tree.id, 'AbC-123');
  assert.ok(h.resolutions.some(r => r.target === 'AbC-123' && r.path === 'Source.md'));
  assert.ok(h.resolutions.every(r => r.path === 'Source.md'), 'resolution always uses the active source path');
  const next = { ...entries, 'Added/New.md': optin('# Added semantics', 'forester-id: Added-ID\n') };
  h.reindex(next);
  const added = await modal.getSuggestions('new.md semantics');
  assert.equal(added.length, 1, 'newly indexed trees appear on the next query without vault reads');
  assert.equal(added[0].tree.id, 'Added-ID');
  h.host.resolve = () => ({ status: 'resolved', tree: h.index().documents.get('Source.md').root, document: h.index().documents.get('Source.md') });
  assert.equal((await modal.getSuggestions('Added-ID')).length, 0, 'a resolved but different tree is not an insertion target');
});

test('chosen tree is revalidated against fresh target snapshots and current collision resolution before insertion', async () => {
  const entries = { 'Source.md': optin('/link'), 'Target.md': optin('# Target\nBody', 'forester-id: AbC-123\n') };
  for (const kind of ['changed-target', 'deleted-target', 'excluded-target', 'new-collision', 'resolver-missing']) {
    const h = harness(entries); h.register(); await h.slash('link'); const modal = mock.modals.at(-1);
    const row = (await modal.getSuggestions('abc-123'))[0]; assert.ok(row);
    if (kind === 'changed-target') h.reindex({ ...entries, 'Target.md': entries['Target.md'].replace('Body', 'Else') });
    if (kind === 'deleted-target') h.reindex({ 'Source.md': entries['Source.md'] });
    if (kind === 'excluded-target') h.index().documents.get('Target.md').enabled = false;
    if (kind === 'new-collision') h.reindex({ ...entries, 'Other.md': optin('# Other', 'forester-id: abc-123\n') });
    if (kind === 'resolver-missing') h.host.resolve = () => ({ status: 'missing', message: 'No longer available' });
    await modal.selectSuggestion(row, {}); await settle();
    assert.equal(h.calls.length, 0, `${kind} is not passed to the host`);
  }
});

test('slash assistance refuses tokens with a non-whitespace suffix and sources containing unsupported bare CR line endings', () => {
  for (const body of ['/subtreex', '/subtree/path', '/su?', 'https://example.org /su/path']) {
    const h = harness({ 'Source.md': optin(body) }); h.register();
    const editor = h.workspace.activeEditor.editor;
    const token = body.includes('/subtree') ? '/subtree' : '/su';
    editor.setCursor(editor.offsetToPos(editor.value.indexOf(token) + token.length));
    assert.equal(h.trigger(), null, 'caret inside another token is not a slash command');
  }
  const h = harness({ 'Source.md': '```\rcode\r /su' }); h.register();
  assert.equal(h.trigger(), null, 'shared parser does not support structural bare CR; input fails closed');
});

test('subtree insertion preserves CRLF and isolates inline prose from the blank new heading', async () => {
  const before = optin('Before /su After\nNext').replaceAll('\n', '\r\n');
  const h = harness({ 'Source.md': before }); h.register(); const editor = h.workspace.activeEditor.editor;
  editor.setCursor(editor.offsetToPos(before.indexOf('/su') + 3));
  await h.slash('subtree');
  assert.equal(editor.value, before.replace('/su', '\r\n\r\n## \r\n\r\n'));
  assert.equal(editor.getLine(editor.getCursor().line).replace(/\r$/, ''), '## ');
  assert.equal(editor.getCursor().ch, 3);
});

test('invalid YAML diagnostics refuse every slash and palette input command even when the document remains enabled', async () => {
  const yamlFailures = ['invalid: [', 'invalid: *missing', '- not a mapping'];
  for (const yaml of yamlFailures) {
    for (const indexedDraft of [false, true]) {
      for (const [command, token] of [['subtree', '/su'], ['link', '/link'], ['transclude', '/transclude']]) {
        const before = `---\n${yaml}\n---\n\`\`\`md\n${token}\n\`\`\``;
        const h = harness({ 'Source.md': indexedDraft ? before : optin('Valid indexed prose') });
        const suggest = h.register(), editor = h.workspace.activeEditor.editor, file = h.workspace.activeEditor.file;
        editor.value = before;
        editor.setCursor(editor.offsetToPos(before.indexOf(token) + token.length));
        const draft = core.parseHybrid(file.path, before, options);
        assert.equal(draft.enabled, true, 'activation is not evidence of parse success');
        assert.ok(draft.diagnostics.some(d => d.code === 'invalid-frontmatter' && d.severity === 'error'));
        assert.equal(h.trigger(), null, `${yaml}: /${command} cannot trigger inside an unmasked code block`);
        const end = editor.getCursor(), start = editor.offsetToPos(before.indexOf(token));
        assert.deepEqual(await suggest.getSuggestions({ file, editor, start, end, query: token.slice(1) }), [], 'native context refresh also refuses the parse error');
        for (const id of ['insert-subtree', 'insert-tree-link', 'insert-tree-embed']) {
          h.plugin.commands.get(id).editorCallback(editor, h.workspace.activeEditor);
          assert.equal(editor.value, before, `${id} preserves malformed source exactly`);
          assert.equal(editor.replacements.length, 0);
          assert.equal(mock.modals.length, 0, `${id} cannot open a picker on incomplete structural masks`);
          assert.equal(h.calls.length, 0);
        }
        h.plugin.unload();
      }
    }
  }
});

const unclosedInputRegions = [
  ['HTML comment', '<!-- unfinished'],
  ['Obsidian comment', '%% unfinished'],
  ['raw Forester', '\\{\\p{unfinished'],
  ['frontmatter', '---\ntitle: unfinished'],
  ['LaTeX display math', '\\[unfinished'],
];
for (const [name, body] of unclosedInputRegions) {
  test(`EOF input refuses every command inside unclosed ${name}`, async () => {
    for (const eol of ['', '\n', '\r\n']) {
      for (const id of ['insert-subtree', 'insert-tree-link', 'insert-tree-embed']) {
        const before = body + eol;
        const h = harness({ 'Source.md': 'Valid indexed prose' }); h.register();
        const editor = h.workspace.activeEditor.editor;
        editor.value = before; editor.setCursor(editor.offsetToPos(before.length));
        h.plugin.commands.get(id).editorCallback(editor, h.workspace.activeEditor);
        assert.equal(editor.value, before, `${id} must not insert at the unclosed ${name} EOF`);
        assert.equal(editor.replacements.length, 0);
        assert.equal(mock.modals.length, 0, `${id} cannot open a picker inside an unclosed region`);
        assert.equal(h.calls.length, 0);
        assert.notEqual(editor.focused, true, 'a refused command does not steal editor focus');
        h.plugin.unload();
      }
    }
    for (const token of ['/su', '/link', '/transclude']) {
      const before = `${body} ${token}`;
      const h = harness({ 'Source.md': before }); const suggest = h.register();
      const editor = h.workspace.activeEditor.editor, file = h.workspace.activeEditor.file;
      assert.equal(h.trigger(), null, `${token} stays inside the unclosed ${name}`);
      assert.deepEqual(await suggest.getSuggestions({ file, editor, start: editor.offsetToPos(before.indexOf(token)), end: editor.getCursor(), query: token.slice(1) }), []);
      assert.equal(editor.value, before);
      h.plugin.unload();
    }
  });
}

const closedInputRegions = [
  ['inline code', '`literal`'],
  ['double-backtick inline code', '``literal``'],
  ['dollar inline math', '$x$'],
  ['LaTeX inline math', '\\(x\\)'],
  ['LaTeX display math', '\\[x\\]'],
  ['HTML comment', '<!-- literal -->'],
  ['Obsidian comment', '%% literal %%'],
  ['raw Forester', '\\{\\p{literal}}'],
];
for (const [name, body] of closedInputRegions) {
  test(`EOF input remains available immediately outside closed ${name}`, async () => {
    for (const [id, embed] of [['insert-subtree', null], ['insert-tree-link', false], ['insert-tree-embed', true]]) {
      const h = harness({ 'Source.md': body, 'Target.md': optin('# Target', 'forester-id: target-id\n') }); h.register();
      const editor = h.workspace.activeEditor.editor;
      h.plugin.commands.get(id).editorCallback(editor, h.workspace.activeEditor);
      if (embed === null) {
        assert.equal(editor.value, `${body}\n\n## `, 'the end of a closed inline span is not protected');
        assert.equal(editor.replacements.length, 1);
      } else {
        const modal = mock.modals.at(-1); assert.ok(modal, `${id} opens outside the closed ${name}`);
        const row = (await modal.getSuggestions('target-id'))[0]; assert.ok(row);
        await modal.selectSuggestion(row, {}); await settle();
        assert.equal(h.calls.length, 1);
        assert.equal(h.calls[0][3], embed);
        assert.equal(editor.value, body, 'the host owns link/embed writes');
      }
      h.plugin.unload();
    }
    for (const command of ['subtree', 'link', 'transclude']) {
      const h = harness({ 'Source.md': `${body} /${command}` }); h.register();
      const context = h.trigger(); assert.ok(context, `/${command} follows outside the closed ${name}`);
      const rows = await h.plugin.suggests[0].getSuggestions(context);
      assert.deepEqual(rows.map(row => row.command), [command]);
      h.plugin.unload();
    }
  });
}

test('host insertion rejection is reported without an unhandled promise or an input-owned source write', async () => {
  const entries = { 'Source.md': optin('/link'), 'Target.md': optin('# Target', 'forester-id: AbC-123\n') };
  const h = harness(entries); h.register(); await h.slash('link'); const modal = mock.modals.at(-1);
  const row = (await modal.getSuggestions('abc-123'))[0]; let attempts = 0;
  h.host.insertTarget = async () => { attempts++; throw new Error('Synthetic host write rejection'); };
  await assert.doesNotReject(() => modal.onChooseSuggestion(row, {}));
  assert.equal(attempts, 1);
  assert.equal(h.workspace.activeEditor.editor.value, entries['Source.md']);
  assert.ok(mock.notices.some(message => message.includes('Synthetic host write rejection')));
});
