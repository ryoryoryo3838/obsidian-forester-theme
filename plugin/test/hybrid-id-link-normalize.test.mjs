import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridController } from './build/hybrid-controller.mjs';
import { createHarness } from './controller-obsidian-mock.mjs';

// v0.6: a link typed by tree ID becomes the native form once the caret leaves it.
const book = '---\nforester-id: book-id\ntitle: Book title\n---\n# Book\n\n## Part ^part-id\nBody\n';
async function typed(line, caret = line.length, extra = {}) {
  const h = createHarness({ 'Page.md': '# Page\n\n', 'Book.md': book, ...extra });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  const view = h.open('Page.md', `# Page\n\n${line}`);
  view.editor.setCursor({ line: 2, ch: caret });
  await h.workspace.emit('editor-change', view.editor, view);
  const value = view.editor.getValue().split('\n')[2];
  h.plugin.unload();
  return value;
}

test('a whole-note ID becomes [[file]] and a subtree ID [[file#^id]]', async () => {
  assert.equal(await typed('See [[book-id]] now'), 'See [[Book]] now');
  assert.equal(await typed('See [[part-id]] now'), 'See [[Book#^part-id]] now');
});

test('display text, embed flags and ! are kept', async () => {
  assert.equal(await typed('[[part-id|別名]] and ![[part-id|-h -t]] '), '[[Book#^part-id|別名]] and ![[Book#^part-id|-h -t]] ');
});

test('two ID links on one line are both rewritten without corrupting the line', async () => {
  assert.equal(await typed('[[book-id]] [[part-id]] [[Book]] end'), '[[Book]] [[Book#^part-id]] [[Book]] end');
});

test('a link the caret is still inside is left alone', async () => {
  const line = 'See [[part-id]] now';
  assert.equal(await typed(line, line.indexOf('part') + 2), line);
});

test('an ID that also names a file, and anything in code, stays as written', async () => {
  const clash = { 'Notes/book-id.md': '# Another note\n' };
  assert.equal(await typed('See [[book-id]] now', undefined, clash), 'See [[book-id]] now');
  assert.equal(await typed('Code `[[part-id]]` here'), 'Code `[[part-id]]` here');
});
