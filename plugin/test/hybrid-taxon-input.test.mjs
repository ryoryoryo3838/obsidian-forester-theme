import test from 'node:test';
import assert from 'node:assert/strict';
import { EditorView } from '@codemirror/view';
import { HybridController } from './build/hybrid-controller.mjs';
import { createHarness } from './controller-obsidian-mock.mjs';

const vault = {
  'A.md': '# A\n\n## *Claim.* one\n\n## *Claim.* two\n\n## *Definition.* three\n',
  'Page.md': '# Page\n\n',
};
async function start(extra = {}) {
  const h = createHarness({ ...vault, ...extra });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  return { h, c };
}
async function typed(text, ch = text.length) {
  const { h } = await start();
  const view = h.open('Page.md', `# Page\n\n${text}`);
  view.editor.setCursor({ line: 2, ch });
  await h.workspace.emit('editor-change', view.editor, view);
  const line = view.editor.getValue().split('\n')[2];
  h.plugin.unload();
  return line;
}

test('v0.6: `.Person.` at the start of a heading becomes the taxon *Person.*', async () => {
  assert.equal(await typed('## .Person.'), '## *Person.* ');
  assert.equal(await typed('## .Person. 題', '## .Person.'.length), '## *Person.* 題');
  assert.equal(await typed('### ．定義。'), '### *定義.* ');
});

test('v0.6: a heading such as `.NET` without a closing period, or code, is left alone', async () => {
  assert.equal(await typed('## .NET の話', '## .NET'.length), '## .NET の話');
  const { h } = await start();
  const fenced = '# Page\n\n```\n## .Person.\n```\n';
  const view = h.open('Page.md', fenced);
  view.editor.setCursor({ line: 3, ch: '## .Person.'.length });
  await h.workspace.emit('editor-change', view.editor, view);
  assert.equal(view.editor.getValue(), fenced);
  h.plugin.unload();
});

test('v0.6: `.` suggests the taxa in use, most used first, and a new name', async () => {
  const { h } = await start();
  const view = h.open('Page.md', '# Page\n\n## .');
  view.editor.setCursor({ line: 2, ch: 4 });
  const suggest = h.plugin.suggesters.at(-2); // the embed-flag suggester is registered last
  const trigger = suggest.onTrigger(view.editor.getCursor(), view.editor, view.file);
  assert.ok(trigger);
  suggest.context = { ...trigger, editor: view.editor, file: view.file };
  assert.deepEqual(suggest.getSuggestions(suggest.context).map(c => c.taxon), ['Claim', 'Definition']);
  assert.deepEqual(suggest.getSuggestions({ ...suggest.context, query: 'Lem' }).map(c => [c.taxon, c.fresh]), [['Lem', true]]);
  suggest.selectSuggestion(suggest.getSuggestions(suggest.context)[0]);
  assert.equal(view.editor.getValue(), '# Page\n\n## *Claim.* ');
  h.plugin.unload();
});

test('v0.6: off the caret line, the italic taxon source is hidden behind the label', async () => {
  const { h } = await start();
  const source = '# Page\n\n## *Claim.* 定義の節\nBody\n';
  const view = h.open('Page.md', source);
  view.editor.setCursor({ line: 3, ch: 0 });
  view.editor.attach(h.plugin.extensions);
  const hidden = [];
  for (const set of view.editor.cm.state.facet(EditorView.decorations)) if (typeof set.between === 'function')
    set.between(0, source.length, (from, to, d) => { if (d.spec && !d.spec.widget && to > from && !d.spec.class) hidden.push(source.slice(from, to)); });
  assert.ok(hidden.includes('*Claim.* '), JSON.stringify(hidden));
  h.plugin.unload();
});
