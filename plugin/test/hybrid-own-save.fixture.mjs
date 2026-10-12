import assert from 'node:assert/strict';
import { HybridController } from './build/hybrid-controller.mjs';
import { createHarness, notices, window } from './controller-obsidian-mock.mjs';

// Synthetic in-memory vault; mock only public native editor/lifecycle/I/O.
export const sourcePath = '合成情報メディア.md';
export const targetPath = '合成本文.md';
export const target = '---\nforester-id: "6B4C0F"\ntitle: 合成博物館\n---\n# 合成博物館\n\nSynthetic body\n';
export const saved = '# 合成draft\n\n';

export async function selectionFixture({ query = '博物', mode = 'ordinary' } = {}) {
  const before = `${saved}![[${query}]]\n`;
  const expected = `${saved}![[6B4C0F]]\n`;
  const h = createHarness({ [sourcePath]: saved, [targetPath]: target });
  const c = new HybridController(h.plugin, h.getter);
  await c.initialize();
  const view = h.open(sourcePath, before);
  view.editor.attach(h.plugin.extensions);
  const caret = before.indexOf('![[') + 3 + query.length;
  view.editor.setCursor(view.editor.offsetToPos(caret));
  await h.workspace.emit('editor-change', view.editor, view);
  const suggest = h.plugin.suggesters[1];
  const trigger = suggest.onTrigger(view.editor.getCursor(), view.editor, view.file);
  assert.ok(trigger, 'actual registered wikilink EditorSuggest triggers');
  suggest.context = { ...trigger, file: view.file, editor: view.editor };
  const row = suggest.getSuggestions(suggest.context).find(r => r.tree?.id === '6B4C0F');
  assert.ok(row, 'already-addressed root is returned through real search/index/resolver');
  const trace = [];
  const snapshot = stage => trace.push({
    stage, versions: Object.fromEntries(c.sourceVersions),
    editorEqualsBefore: view.editor.getValue() === before,
    sourceDiskEqualsBefore: h.vault.data.get(sourcePath) === before,
    selection: view.editor.listSelections(),
  });
  const nativeRead = h.vault.read;
  const nativeProcess = h.vault.process;
  h.vault.process = async (file, transform) => nativeProcess(file, bytes => {
    const after = transform(bytes);
    snapshot(`cas:${file.path}:${bytes === before && after === expected ? 'forward' : bytes === expected && after === before ? 'rollback' : 'no-op-or-other'}`);
    return after;
  });
  const nativeEmit = h.vault.emit.bind(h.vault);
  const nativeSave = view.save.bind(view);
  let saving = false, delayedModify;
  const notifications = [];

  // Controlled native event ordering, not a claim about the incident's runtime.
  // save() settles the bytes; its own modify notification arrives at preflight.
  if (mode === 'late-own-source-modify' || mode === 'late-own-source-modify-unawaited' || mode === 'late-own-source-metadata') {
    h.vault.emit = async (name, ...args) => {
      if (saving && name === 'modify' && args[0] === view.file) {
        delayedModify = args[0]; snapshot('own-save-modify-queued'); return;
      }
      return nativeEmit(name, ...args);
    };
  }
  view.save = async () => {
    snapshot('flush-start'); saving = true;
    try { await nativeSave(); } finally { saving = false; }
    snapshot('flush-resolved');
  };
  h.vault.read = async file => {
    const bytes = await nativeRead(file);
    snapshot(`read:${file.path}`);
    if (file.path === sourcePath && delayedModify) {
      const ownFile = delayedModify; delayedModify = undefined;
      if (mode === 'late-own-source-metadata') await h.app.metadataCache.emit('changed', ownFile, bytes);
      else if (mode === 'late-own-source-modify-unawaited') notifications.push(nativeEmit('modify', ownFile));
      else await nativeEmit('modify', ownFile);
      snapshot('own-save-notification-delivered');
    }
    return bytes;
  };
  // Native TextFileView may synchronise its clean editor from a vault modify.
  // Use real CodeMirror transactions/selection mapping at this native boundary;
  // the controller/parser/resolver/save implementation remains untouched.
  if (mode === 'native-source-reload' || mode === 'native-source-reload-keep-selection' || mode === 'native-source-reload-user-cursor') {
    view.editor.cm.state = view.editor.cm.state.update({ selection: { anchor: caret } }).state;
    h.vault.on('modify', async file => {
      if (file !== view.file) return;
      const bytes = h.vault.data.get(sourcePath), old = view.editor.getValue();
      if (bytes === old) return;
      let from = 0, suffix = 0;
      while (from < old.length && from < bytes.length && old[from] === bytes[from]) from++;
      while (suffix < old.length - from && suffix < bytes.length - from && old[old.length - 1 - suffix] === bytes[bytes.length - 1 - suffix]) suffix++;
      const previousSelection = view.editor.listSelections();
      let state = view.editor.cm.state.update({ changes: {
        from, to: old.length - suffix, insert: bytes.slice(from, bytes.length - suffix),
      } }).state;
      if (mode === 'native-source-reload-keep-selection') {
        state = state.update({ selection: { anchor: caret } }).state;
      }
      view.editor.cm.state = state;
      view.editor.value = state.doc.toString();
      view.editor.setSelections(mode === 'native-source-reload-keep-selection' ? previousSelection : state.selection.ranges.map(range => ({
        anchor: view.editor.offsetToPos(range.anchor), head: view.editor.offsetToPos(range.head),
      })));
      await h.workspace.emit('editor-change', view.editor, view);
      if (mode === 'native-source-reload-user-cursor' && bytes === expected) {
        view.editor.cm.state = view.editor.cm.state.update({ selection: { anchor: 0 } }).state;
        view.editor.setCursor({ line: 0, ch: 0 });
      }
      snapshot('native-source-reload');
    });
  }
  if (mode === 'cursor-move') {
    let once = true;
    const read = h.vault.read;
    h.vault.read = async file => {
      const bytes = await read(file);
      if (once && file.path === targetPath) { once = false; view.editor.setCursor({ line: 0, ch: 0 }); snapshot('user-cursor-moved'); }
      return bytes;
    };
  }
  if (mode === 'dirty-source-pane') {
    const dirty = h.open(sourcePath, before + 'Unsaved other-pane edit');
    dirty.editor.attach(h.plugin.extensions);
    h.workspace.active = view;
  }
  return {
    h, c, view, before, expected, trace,
    async choose() {
      snapshot('choose:Enter');
      const enter = new window.Event('keydown', { bubbles: true, cancelable: true });
      Object.defineProperties(enter, { key: { value: 'Enter' }, code: { value: 'Enter' } });
      suggest.selectSuggestion(row, enter);
      await c.saveTail;
      await Promise.all(notifications);
      snapshot('settled');
      return {
        mode, query, notice: [...notices], processes: [...h.vault.processes],
        inserted: view.editor.getValue() === expected,
        literalUnchanged: view.editor.getValue() === before,
        diskEqualsBefore: h.vault.data.get(sourcePath) === before,
        diskEqualsExpected: h.vault.data.get(sourcePath) === expected,
        targetUnchanged: h.vault.data.get(targetPath) === target,
        replacements: view.editor.replacements.length,
        trace,
      };
    },
    close() { h.plugin.unload(); },
  };
}
