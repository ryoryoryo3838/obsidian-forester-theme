import test from 'node:test';
import assert from 'node:assert/strict';
import { HybridController } from './build/hybrid-controller.mjs';
import { createHarness } from './controller-obsidian-mock.mjs';

const book = '---\nforester-id: book-id\ntitle: Book\n---\n# Book\n\n## Part ^part-id\nBody\n';
async function paste(url, { site = 'https://miya-lis.net/', before = 'See ', after = '', prevented = false } = {}) {
  const h = createHarness({ 'Page.md': '# Page\n\n', 'Book.md': book });
  const c = new HybridController(h.plugin, h.getter, () => true, () => site); await c.initialize();
  const view = h.open('Page.md', `# Page\n\n${before}${after}`);
  view.editor.setCursor({ line: 2, ch: before.length });
  const event = { defaultPrevented: prevented, clipboardData: { getData: () => url }, preventDefault() { this.defaultPrevented = true; } };
  await h.workspace.emit('editor-paste', event, view.editor, view);
  const line = view.editor.getValue().split('\n')[2];
  h.plugin.unload();
  return { line, claimed: event.defaultPrevented && !prevented };
}

test('v0.6: a pasted URL of the published site becomes a native tree link', async () => {
  assert.deepEqual(await paste('https://miya-lis.net/part-id/'), { line: 'See [[Book#^part-id]]', claimed: true });
  assert.deepEqual(await paste('http://miya-lis.net/book-id'), { line: 'See [[Book]]', claimed: true });
});

test('v0.6: other URLs, unknown IDs, code, an empty setting or a claimed paste are left to Obsidian', async () => {
  for (const [url, options] of [
    ['https://example.net/part-id/', {}],
    ['https://miya-lis.net/missing/', {}],
    ['https://miya-lis.net/part-id/', { before: '`see ', after: '`' }],
    ['https://miya-lis.net/part-id/', { site: '' }],
    ['https://miya-lis.net/part-id/', { prevented: true }],
  ]) assert.equal((await paste(url, options)).claimed, false, `${url} ${JSON.stringify(options)}`);
});
