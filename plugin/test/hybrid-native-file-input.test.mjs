import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Only the unavailable native runtime is mocked. No shared mock/build is overwritten.
const root = fileURLToPath(new URL('../', import.meta.url));
const buildDir = new URL('./build/v2-native-file-input/', import.meta.url);
mkdirSync(buildDir, { recursive: true });
const mockUrl = new URL('obsidian-mock.mjs', buildDir);
writeFileSync(mockUrl, `
import { parseHTML } from 'linkedom';
export const { document } = parseHTML('<html><body></body></html>');
export class Notice {}
export class EditorSuggest {
  constructor(app) { this.app = app; this.context = null; }
  close() { this.context = null; }
}
export class SuggestModal { constructor(app) { this.app = app; } }
`);
const mock = await import(mockUrl.href);
await build({ absWorkingDir: root, entryPoints: ['src/hybrid-core.ts'], bundle: true, platform: 'node', format: 'esm', outfile: fileURLToPath(new URL('core.mjs', buildDir)), logLevel: 'silent' });
await build({ absWorkingDir: root, entryPoints: ['src/hybrid-input.ts'], bundle: true, platform: 'node', format: 'esm', outfile: fileURLToPath(new URL('input.mjs', buildDir)), logLevel: 'silent', plugins: [{ name: 'native-file-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: fileURLToPath(mockUrl), external: true })); } }] });
const core = await import(new URL('core.mjs', buildDir).href);
const input = await import(new URL('input.mjs', buildDir).href);
const options = { folders: ['/'], excludedFolders: ['Disabled'], publicFolders: [], reservedIds: [] };
const makeIndex = entries => core.indexHybrid(Object.entries(entries).map(([path, source]) => core.parseHybrid(path, source, options)));
class Editor {
  constructor(value) { this.value = value; this.selections = []; this.replacements = []; this.setCursor(this.offsetToPos(value.length)); }
  getValue() { return this.value; }
  getLine(line) { return this.value.split('\n')[line]; }
  listSelections() { return structuredClone(this.selections); }
  getCursor(side = 'head') { return { ...this.selections[0][side === 'anchor' || side === 'from' ? 'anchor' : 'head'] }; }
  posToOffset(pos) { return this.value.split('\n').slice(0, pos.line).reduce((n, line) => n + line.length + 1, 0) + pos.ch; }
  offsetToPos(offset) { const lines = this.value.slice(0, offset).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; }
  getRange(from, to) { return this.value.slice(this.posToOffset(from), this.posToOffset(to)); }
  setCursor(pos) { this.selections = [{ anchor: { ...pos }, head: { ...pos } }]; }
  replaceRange(text, from, to = from) { const start = this.posToOffset(from), end = this.posToOffset(to); this.replacements.push({ text, from, to }); this.value = this.value.slice(0, start) + text + this.value.slice(end); }
  focus() { this.focused = true; }
}
function harness(body = 'See ![[', extra = {}, attachments = ['Attachments/photo.png'], activePath = 'Source.md') {
  const entries = { [activePath]: body, 'Target.md': '---\nforester-id: Tree-ID\npublish: false\n---\n# Semantic tree\n\n## Child ^Child-ID\nBody', ...extra };
  let index = makeIndex(entries);
  const paths = [...Object.keys(entries), ...attachments];
  const files = new Map(paths.map(path => { const name = path.split('/').at(-1), extension = name.split('.').at(-1); return [path, { path, name, basename: name.slice(0, -(extension.length + 1)), extension }]; }));
  const events = new Map(), cleanups = [], calls = [], linktextCalls = [];
  const workspace = { activeEditor: { file: files.get(activePath), editor: new Editor(body) },
    on(name, callback) { const ref = { name, callback }; events.set(name, [...(events.get(name) ?? []), ref]); return ref; },
    offref(ref) { events.set(ref.name, (events.get(ref.name) ?? []).filter(r => r !== ref)); },
    emit(name, ...args) { for (const ref of events.get(name) ?? []) ref.callback(...args); },
  };
  const app = { workspace, vault: {
    getAbstractFileByPath: path => files.get(path) ?? null,
    getFiles: () => [...files.values()],
    read() { throw new Error('Attachments must never be read'); },
    cachedRead() { throw new Error('Attachments must never be read'); },
    modify() { throw new Error('Attachments must never be written'); },
  }, metadataCache: { fileToLinktext(file, sourcePath) {
    linktextCalls.push({ file, sourcePath });
    if (h.linktextOverride !== undefined) return h.linktextOverride;
    const unique = [...files.values()].filter(other => other.name === file.name).length === 1;
    return unique ? (file.extension === 'md' ? file.basename : file.name) : file.path;
  } } };
  const host = { index: () => index, resolve: (target, path) => core.resolveHybrid(index, target, path), insertTarget: async (...args) => { calls.push(args); }, linkSuggest: () => h.enabled };
  const plugin = { app, suggests: [], commands: new Map(), register(fn) { cleanups.push(fn); }, registerEvent(ref) { cleanups.push(() => workspace.offref(ref)); }, registerEditorSuggest(suggest) { this.suggests.push(suggest); }, addCommand(command) { this.commands.set(command.id, command); }, unload() { for (const fn of cleanups.splice(0).reverse()) fn(); } };
  const h = { plugin, host, files, calls, linktextCalls, workspace, entries, enabled: true,
    index: () => index, reindex(next) { index = makeIndex(next); },
    trigger() { const { editor, file } = workspace.activeEditor; const trigger = h.links.onTrigger(editor.getCursor(), editor, file); if (!trigger) return null; h.links.context = { ...trigger, editor, file }; return h.links.context; },
    rows() { const context = h.trigger(); assert.ok(context, 'wikilink triggers'); return h.links.getSuggestions(context); },
  };
  input.registerHybridInput(plugin, host); h.links = plugin.suggests[1];
  return h;
}
test('native file selection refuses stale source, selection, binding, target and completion snapshots', () => {
  for (const [name, mutate] of [
    ['cursor', h => h.workspace.activeEditor.editor.setCursor({ line: 0, ch: 0 })],
    ['draft', h => { h.workspace.activeEditor.editor.value += 'x'; }],
    ['indexed source', h => h.reindex({ ...h.entries, 'Source.md': 'Changed' })],
    ['source excluded', h => { h.index().documents.get('Source.md').enabled = false; }],
    ['source deleted', h => h.files.delete('Source.md')],
    ['source binding', h => { h.workspace.activeEditor.file = h.files.get('Target.md'); }],
    ['target deleted', h => h.files.delete('Attachments/photo.png')],
    ['target replaced', h => h.files.set('Attachments/photo.png', { ...h.files.get('Attachments/photo.png') })],
    ['target renamed', h => { h.files.get('Attachments/photo.png').path = 'Elsewhere.png'; }],
    ['new basename collision', h => h.files.set('Other/photo.png', { path: 'Other/photo.png', name: 'photo.png', basename: 'photo', extension: 'png' })],
    ['completion cancelled', h => h.links.close()],
    ['plugin unloaded', h => h.plugin.unload()],
    ['edit then undo', h => { const { editor } = h.workspace.activeEditor, before = editor.value; editor.value += 'x'; h.workspace.emit('editor-change', editor); editor.value = before; h.workspace.emit('editor-change', editor); }],
  ]) {
    const h = harness('See [[photo'), row = fileRows(h.rows())[0], editor = h.workspace.activeEditor.editor;
    assert.ok(row); mutate(h);
    const current = editor.value;
    h.links.selectSuggestion(row);
    assert.equal(editor.value, current, name);
    assert.equal(editor.replacements.length, 0, name);
    assert.equal(h.calls.length, 0, name);
  }
});

test('native file suggestions respect protected syntax, excluded sources, settings and hand off alias/heading/block syntax', () => {
  for (const body of ['`[[photo`', '```md\n[[photo\n```', '    [[photo', '> [[photo', '$[[photo$', '<!-- [[photo -->', '%% [[photo %%', '\\{\\p{[[photo}}', '---\ninvalid: [\n---\n[[photo', 'See [[photo|alias', 'See [[photo#heading', 'See [[photo^block']) {
    const h = harness(body), { editor, file } = h.workspace.activeEditor;
    const token = body.includes('|alias') || body.includes('#heading') || body.includes('^block') ? body.slice(body.indexOf('[[')) : '[[photo';
    editor.setCursor(editor.offsetToPos(body.indexOf(token) + token.length));
    assert.equal(h.links.onTrigger(editor.getCursor(), editor, file), null, body);
    assert.equal(editor.replacements.length, 0);
    assert.equal(h.calls.length, 0);
  }
  const excluded = harness('See [[photo', {}, undefined, 'Disabled/Source.md');
  assert.equal(excluded.trigger(), null);
  const off = harness('See [[photo'); off.enabled = false;
  assert.equal(off.trigger(), null);
});

test('native filename rendering is text only and attachment query search covers extension, spaces and path words', () => {
  const paths = ['Attachments/my image.png', 'Diagrams/map.svg', 'Media/movie.webm', 'Attachments/<img src=x onerror=alert(1)>.png'];
  for (const [query, expected] of [['PNG my image', paths[0]], ['diagrams SVG', paths[1]], ['webm', paths[2]], ['<img', paths[3]]]) {
    const h = harness(`[[${query}`, {}, paths), rows = fileRows(h.rows());
    assert.equal(rows.length, 1, query);
    assert.equal(rows[0].file.path, expected);
    const el = mock.document.createElement('div');
    h.links.renderSuggestion(rows[0], el);
    assert.equal(el.textContent, expected);
    assert.equal(el.children.length, 0, 'filename markup is never interpreted');
  }
});

test('private local tree insertion preserves the host path, identity spelling and explicit source CAS snapshot', () => {
  const h = harness('![[Semantic'), row = h.rows().find(row => row.tree?.id === 'Tree-ID');
  assert.ok(row);
  const before = h.workspace.activeEditor.editor.value;
  h.links.selectSuggestion(row);
  assert.equal(h.calls.length, 1);
  const [editor, file, tree, embed, replacement] = h.calls[0];
  assert.equal(editor, h.workspace.activeEditor.editor);
  assert.equal(file, h.workspace.activeEditor.file);
  assert.equal(tree.id, 'Tree-ID');
  assert.equal(embed, true);
  assert.deepEqual(replacement, { from: { line: 0, ch: 0 }, to: { line: 0, ch: before.length }, before });
  assert.equal(editor.value, before, 'tree minting/CAS remains controller owned');
});

const fileRows = rows => rows.filter(row => row.file);

test('a stale native context cannot capture a new cursor for an old wikilink range', () => {
  const h = harness('Intro [[photo]] tail'), editor = h.workspace.activeEditor.editor;
  editor.setCursor(editor.offsetToPos('Intro [[photo'.length));
  h.rows();
  const context = h.links.context;
  editor.setCursor(editor.offsetToPos(editor.value.length));
  assert.deepEqual(h.links.getSuggestions(context), [], 'cursor and replacement must refer to the same trigger');
});

test('turning off tree link suggestions invalidates an open attachment popover', () => {
  const h = harness('See [[photo');
  const rows = h.rows(), context = h.links.context, row = fileRows(rows)[0];
  assert.ok(row);
  h.enabled = false;
  assert.deepEqual(h.links.getSuggestions(context), [], 'off leaves native Obsidian completion in control');
  h.links.selectSuggestion(row);
  assert.equal(context.editor.value, 'See [[photo');
  assert.equal(context.editor.replacements.length, 0, 'captured choices cannot outlive the setting');
});

test('empty wikilinks offer native attachments alongside semantic tree choices without duplicate root files', () => {
  const h = harness('See ![[', { 'Disabled/Ordinary.md': '# Excluded but native' }, ['Attachments/photo.png', 'Diagrams/map.svg', 'Docs/paper.pdf', 'Media/audio.mp3', 'New.md']);
  const rows = h.rows();
  assert.deepEqual(fileRows(rows).map(row => row.file.path).sort(), ['Attachments/photo.png', 'Diagrams/map.svg', 'Docs/paper.pdf', 'Media/audio.mp3', 'New.md', 'Disabled/Ordinary.md'].sort(), 'native vault files must not disappear behind the preferred tree suggester');
  assert.ok(rows.some(row => row.tree?.id === 'Tree-ID'), 'private local tree remains selectable');
  assert.equal(rows.filter(row => row.tree?.path === 'Target.md' && row.tree.id === 'Tree-ID').length, 1);
  assert.ok(!fileRows(rows).some(row => row.file.path === 'Target.md'), 'enabled roots are represented by their semantic choice');
  assert.equal(h.calls.length, 0);
});

test('native file selection inserts literal links and embeds using native shortest, unique and relative linktexts', () => {
  for (const [path, linktext, attachments] of [
    ['Attachments/photo.png', 'photo.png', ['Attachments/photo.png']],
    ['Attachments/my image.jpg', 'my image.jpg', ['Attachments/my image.jpg']],
    ['One/photo.png', 'One/photo.png', ['One/photo.png', 'Two/photo.png']],
    ['Attachments/map.svg', '../Attachments/map.svg', ['Attachments/map.svg']],
    ['Docs/paper.pdf', 'paper.pdf', ['Docs/paper.pdf']],
  ]) {
    for (const embed of [false, true]) for (const paired of [false, true]) {
      const typed = `${embed ? '!' : ''}[[${path.split('/').at(-1).split('.')[0]}`;
      const before = `Intro ${typed}${paired ? ']]' : ''} tail`;
      const h = harness(before, {}, attachments), editor = h.workspace.activeEditor.editor;
      if (path.endsWith('map.svg')) h.linktextOverride = linktext;
      const start = before.indexOf(typed), caret = start + typed.length;
      editor.setCursor(editor.offsetToPos(caret));
      const rows = h.rows(), row = fileRows(rows).find(row => row.file.path === path);
      assert.ok(row, 'query finds the requested attachment');
      h.links.selectSuggestion(row);
      const literal = `${embed ? '!' : ''}[[${linktext}]]`;
      assert.equal(editor.value, `Intro ${literal} tail`, 'one standard Obsidian link, no minted ID or alias');
      assert.deepEqual(editor.getCursor(), editor.offsetToPos(start + literal.length), 'cursor follows the inserted closing brackets');
      assert.equal(editor.replacements.length, 1);
      assert.equal(h.links.context, null);
      assert.equal(h.calls.length, 0, 'asset insertion cannot invoke minting/controller I/O');
      assert.ok(h.linktextCalls.every(call => call.sourcePath === 'Source.md'), 'native path formatting receives source context');
    }
  }
});
