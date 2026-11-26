import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridController } from './build/hybrid-controller.mjs';
import { createHarness, document } from './controller-obsidian-mock.mjs';
import { parseEmbedLine } from './build/hybrid-display.mjs';

const book = '---\nforester-id: book-id\ntitle: Book\n---\n# Book\n\n## Part ^part-id\n%% dates: ["2026-11-26"] %%\nBody text\n';
async function start(page = '# Page\n\n') {
  const h = createHarness({ 'Page.md': page, 'Book.md': book });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  return { h, c };
}

test('v0.6: an embed line reads | flags, keeps aliases as defaults, and refuses conflicts', () => {
  assert.deepEqual(parseEmbedLine('![[Book#^part-id|-h -e +m]]'),
    { target: 'Book#^part-id', heading: false, toc: true, numbered: true, expanded: false, metadata: true });
  assert.deepEqual(parseEmbedLine('![[Book|別名]]'), { target: 'Book', heading: true, toc: true });
  assert.match(parseEmbedLine('![[Book|-h -heading]]').error, /more than once/);
  assert.match(parseEmbedLine('![[Book|-h]] %%t%%').error, /not both/);
});

test('v0.6: | suggests the flags not yet written, filters by the typed word, and skips images', async () => {
  const { h } = await start();
  const suggest = h.plugin.suggesters.at(-1);
  const at = async line => {
    const view = h.open('Page.md', `# Page\n\n${line}`);
    view.editor.setCursor({ line: 2, ch: line.length });
    const trigger = suggest.onTrigger(view.editor.getCursor(), view.editor, view.file);
    if (!trigger) return { view, choices: null };
    suggest.context = { ...trigger, editor: view.editor, file: view.file };
    return { view, choices: suggest.getSuggestions(suggest.context).map(choice => choice.token) };
  };
  assert.deepEqual((await at('![[Book|')).choices, ['-h', '-t', '-n', '-e', '+m']);
  assert.deepEqual((await at('![[Book|-h ')).choices, ['-t', '-n', '-e', '+m']);
  assert.deepEqual((await at('![[Book|-h -e')).choices, ['-e'], 'the word being typed is not yet written');
  assert.deepEqual((await at('![[Book|-exp')).choices, ['-e']);
  assert.equal((await at('![[photo.png|')).choices, null);
  const { view } = await at('![[Book|');
  suggest.selectSuggestion({ token: '-h', name: 'heading', note: '' });
  assert.equal(view.editor.getValue(), '# Page\n\n![[Book|-h ');
  h.plugin.unload();
});

test('v0.6: rendered embeds follow -n, -e and +m like Forester', async () => {
  const { h, c } = await start();
  const render = flags => {
    const el = document.createElement('div');
    c.renderEmbed(el, 'Book#^part-id', { target: 'Book#^part-id', heading: true, toc: true, ...flags }, 'Page.md');
    return el;
  };
  const plain = render({});
  assert.ok(plain.querySelector('.hybrid-taxon-number'), 'numbered by default');
  assert.equal(plain.querySelector('.hybrid-metadata'), null, 'metadata hidden by default, as in Forester');
  assert.equal(render({ numbered: false }).querySelector('.hybrid-taxon-number'), null);
  assert.ok(render({ metadata: true }).querySelector('.hybrid-metadata'));
  const collapsed = render({ expanded: false });
  const body = collapsed.querySelector('.hybrid-tree-body'), toggle = collapsed.querySelector('.hybrid-embed-toggle');
  assert.equal(body.hidden, true);
  toggle.dispatchEvent(new collapsed.ownerDocument.defaultView.Event('click'));
  assert.equal(body.hidden, false);
  assert.equal(toggle.getAttribute('aria-expanded'), 'true');
  h.plugin.unload();
});
