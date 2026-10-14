import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { EditorView } from '@codemirror/view';
import { createHarness, document, renders } from './controller-obsidian-mock.mjs';
import { HybridController } from './build/hybrid-controller.mjs';
import { projectPublicForest } from './build/hybrid-public-forest.mjs';
import { parseHybrid } from './build/hybrid-core.mjs';

const sha = value => createHash('sha256').update(value).digest('hex');
const drain = async () => { for (let n = 0; n < 6; n++) await new Promise(setImmediate); };
const widgets = state => {
  const result = [];
  for (const set of state.facet(EditorView.decorations)) if (typeof set.between === 'function') {
    set.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget?.span?.kind === 'embed') result.push(decoration.spec.widget);
    });
  }
  return result;
};
const identities = d => d.trees.map(t => [t.id, t.from, t.contentFrom, t.to, t.meta.publish]);

// Actual controller/editor/renderer; only Obsidian's unavailable native API is mocked.
// This is a local boundary regression, not an installed/native Obsidian acceptance.
test('public-only privacy keeps local private embeds and native p-marked images intact', async () => {
  const source = '---\nforester-id: PUBLICA\ntitle: Public A\npublish: true\n---\n![[photo.jpg|600x400]] %%p%%\n\n![[CANARYPRIVATEID]]\n\nEnd.';
  const hidden = '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY\n\n![[photo.jpg|120x80]] %%p%%\n';
  const h = createHarness({ 'Public.md': source, 'Secret.md': hidden, 'Assets/photo.jpg': 'CANARYFILEBYTES' });
  h.app.metadataCache.getFirstLinkpathDest = (target, path) => {
    const relative = posix.normalize(posix.join(posix.dirname(path), target));
    return h.vault.files.get(relative) ?? h.vault.files.get(target) ??
      [...h.vault.files.values()].find(file => file.path.split('/').at(-1) === target) ?? null;
  };
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const canonical = c.index.documents.get('Public.md');
    const before = identities(canonical), protection = structuredClone(canonical.protectedRanges);
    const state = h.open('Public.md').editor.attach(h.plugin.extensions);
    assert.deepEqual(widgets(state).map(w => w.span.target), ['CANARYPRIVATEID'], 'native image is not converted to a hybrid error/widget');
    const el = widgets(state)[0].toDOM({ dispatch() {}, focus() {} }); await drain();
    assert.equal(el.querySelector('.hybrid-error'), null);
    assert.ok(renders.some(r => r.source.includes('CANARYBODY')), 'local embed continues to expand private body');
    assert.ok(renders.some(r => r.source.includes('![[photo.jpg|120x80]]')), 'private target retains native image syntax/dimensions for its local renderer');
    assert.equal(state.doc.toString(), source);

    const section = document.createElement('section');
    section.innerHTML = '<span class="internal-embed image-embed" src="photo.jpg" data-native-owner="keep"><img src="app://assets/photo.jpg" width="600" height="400"></span>';
    const native = section.firstElementChild, image = native.firstElementChild, nativeBytes = native.outerHTML;
    const line = source.slice(0, source.indexOf('![[photo.jpg')).split('\n').length - 1;
    const ctx = h.context('Public.md', line, line);
    await h.plugin.postprocessors[0](section, ctx); await drain();
    assert.equal(section.firstElementChild === native, true);
    assert.equal(native.firstElementChild === image, true);
    assert.equal(native.outerHTML, nativeBytes);
    assert.equal(ctx.children.length, 0, 'no hybrid owner attached to the native image');

    const result = projectPublicForest(c.index);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(result.forest.trees[0].content, [{ kind: 'unavailable' }, { kind: 'markdown', text: 'End.' }]);
    assert.ok(!JSON.stringify(result).includes('CANARY'));
    assert.equal(sha(h.vault.data.get('Public.md')), sha(source));
    assert.equal(sha(h.vault.data.get('Secret.md')), sha(hidden));
    assert.deepEqual(identities(canonical), before);
    assert.deepEqual(canonical.protectedRanges, protection, 'publication never mutates semantic/native protection masks');
    assert.deepEqual(identities(parseHybrid(canonical.path, canonical.source, c.options())), before);
    assert.equal(h.vault.processes.length, 0, 'no local source writes');
    for (const widget of widgets(state)) widget.destroy();
  } finally { h.plugin.unload(); }
});
