import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridController } from './build/hybrid-controller.mjs';
import { createHarness, notices } from './controller-obsidian-mock.mjs';

const page = '---\nforester-id: page-id\n---\n# Page\n\n## A ^a-id\na1\n\n### B ^b-id\nb body\n\n## C ^c-id\nc body\n';

test('v0.6: "return to parent" moves the caret\'s section to its own note and continues the parent', async () => {
  const h = createHarness({ 'Notes/Page.md': page, 'Other.md': '# Other\n[[Page#^b-id]] and [[b-id]]\n', 'B.md': '# Taken name\n' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  const view = h.open('Notes/Page.md');
  view.editor.setCursor(view.editor.offsetToPos(page.indexOf('b body')));
  await h.plugin.commands.get('lift-section-to-note').editorCallback(view.editor, view);
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  // B.md exists, so the new note takes the next free name; it lands beside its source.
  assert.equal(h.vault.data.get('Notes/B 2.md'), '---\nforester-id: "b-id"\n---\n# B\nb body\n\n');
  assert.equal(view.editor.getValue(), '---\nforester-id: page-id\n---\n# Page\n\n## A ^a-id\na1\n\n![[B 2]]\n\n## C ^c-id\nc body\n');
  assert.deepEqual(view.editor.getCursor(), view.editor.offsetToPos(view.editor.getValue().indexOf('![[B 2]]\n') + '![[B 2]]\n'.length));
  assert.equal(h.vault.data.get('Other.md'), '# Other\n[[B 2]] and [[b-id]]\n');
  assert.ok(notices.some(message => message.includes('moved "B"')));
  h.plugin.unload();
});

test('v0.6: "return to parent" outside any subsection only explains itself', async () => {
  const h = createHarness({ 'Page.md': page });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  const view = h.open('Page.md');
  view.editor.setCursor({ line: 3, ch: 2 });
  await h.plugin.commands.get('lift-section-to-note').editorCallback(view.editor, view);
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  assert.equal(view.editor.getValue(), page);
  assert.ok(notices.some(message => message.includes('inside a subsection')));
  h.plugin.unload();
});
