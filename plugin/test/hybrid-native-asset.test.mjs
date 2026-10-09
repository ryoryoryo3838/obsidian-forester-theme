import assert from 'node:assert/strict';
import test from 'node:test';
import { posix } from 'node:path';
import { Decoration, EditorView, WidgetType } from '@codemirror/view';
import { createHarness, document, renders, window, modals } from './controller-obsidian-mock.mjs';
import { HybridController } from './build/hybrid-controller.mjs';

const drain = async () => { for (let n = 0; n < 6; n++) await new Promise(setImmediate); };
// Only the unavailable Obsidian public linkpath lookup is substituted; controller,
// parser, index, lifecycle and source-range matching are the actual implementation.
function assets(entries) {
  const h = createHarness(entries);
  h.linkpaths = [];
  h.app.metadataCache.getFirstLinkpathDest = (target, path) => {
    h.linkpaths.push({ target, path });
    const relative = posix.normalize(posix.join(posix.dirname(path), target));
    const exact = h.vault.files.get(relative) ?? h.vault.files.get(target);
    if (exact) return exact;
    return [...h.vault.files.values()].find(file => file.path.split('/').at(-1) === target) ?? null;
  };
  return h;
}

test('Reading leaves basename images and native dimensions/DOM owned by Obsidian', async () => {
  const source = '# Host\n\n![[image.png|300x200]]\n';
  const h = assets({ 'Notes/Host.md': source, 'Assets/image.png': 'synthetic attachment' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const section = document.createElement('section');
    section.innerHTML = '<span class="internal-embed image-embed" src="image.png" data-native-owner="keep"><img src="app://assets/image.png" width="300" height="200" data-native="keep"></span>';
    const native = section.firstElementChild, image = native.firstElementChild, before = native.outerHTML;
    const ctx = h.context('Notes/Host.md', 2, 2);
    await h.plugin.postprocessors[0](section, ctx); await drain();
    assert.equal(section.firstElementChild === native, true, 'original native wrapper retained');
    assert.equal(native.firstElementChild === image, true, 'original native image retained, not replaced by a hybrid error');
    assert.equal(native.outerHTML, before, 'src, dimensions, classes and native data attributes unchanged');
    assert.equal(ctx.children.length, 0, 'no hybrid owner for an attachment');
    assert.equal(renders.length, 0, 'native image must not be rendered twice');
    assert.ok(h.linkpaths.some(call => call.target === 'image.png' && call.path === 'Notes/Host.md'));
    assert.equal(h.vault.data.get('Notes/Host.md'), source);
  } finally { h.plugin.unload(); }
});

const embedWidgets = state => {
  const out = [];
  for (const set of state.facet(EditorView.decorations)) if (typeof set.between === 'function') {
    set.between(0, state.doc.length, (_from, _to, decoration) => {
      if (decoration.spec.widget?.span?.kind === 'embed') out.push(decoration.spec.widget);
    });
  }
  return out;
};

test('nested tree images reach MarkdownRenderer with their entire original syntax and dimensions', async () => {
  const literals = ['![[image.png|300x200]]', '![[Assets/image.png|300]]', '![[../Assets/image.png|120x80]]', '![[画像 名.png|90x60]]', '![[guide.pdf#page=2|400]]'];
  const protectedExample = '```md\n![[image.png|1x2]]\n```\n\n> ![[image.png|3x4]]';
  const body = '# Book\n\n## Images ^images-id\n\n' + literals.join('\n\n') + '\n\n' + protectedExample + '\n';
  const h = assets({ 'Host.md': '# Host\n\n![[images-id]]\n\nEnd', 'Notes/Book.md': body, 'Assets/image.png': 'fixture', 'Assets/画像 名.png': 'fixture', 'Assets/guide.pdf': 'fixture' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const state = h.open('Host.md').editor.attach(h.plugin.extensions), widget = embedWidgets(state)[0];
    assert.ok(widget, 'real tree still has its hybrid widget');
    const el = widget.toDOM({ dispatch() {}, focus() {} }); await drain();
    assert.equal(renders.length, 1, 'native renderer receives the whole tree once; attachments are not nested hybrid slots');
    for (const literal of literals) assert.ok(renders[0].source.includes(literal), `original attachment literal retained: ${literal}`);
    assert.ok(renders[0].source.includes(protectedExample), 'protected examples remain byte-for-byte');
    assert.equal(renders[0].sourcePath, 'Notes/Book.md', 'relative asset resolution uses the tree definition path');
    assert.equal(el.querySelector('.hybrid-error'), null);
    widget.destroy(); assert.equal(renders[0].component.loaded, false);
    assert.equal(h.vault.data.get('Notes/Book.md'), body);
  } finally { h.plugin.unload(); }
});

test('display-only attachment masks never enter the semantic/footer overlay index', async () => {
  const source = '# Host\n\n![[image.png|300]]\n\n[[tree-id]]\n\nEnd';
  const h = assets({ 'Host.md': source, 'Assets/image.png': 'fixture', 'Book.md': '---\nforester-id: tree-id\n---\n# Book' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const canonical = c.index.documents.get('Host.md');
    h.open('Host.md').editor.attach(h.plugin.extensions);
    const request = [...c.backmatterRequests.values()][0];
    assert.ok(request);
    assert.equal(request.index.documents.get('Host.md') === canonical, true, 'footer graph retains the canonical parser document, not a display-only masked clone');
    assert.equal(c.overlayDocuments.get('Host.md') === canonical, true, 'display masks cannot replace the shared semantic overlay cache');
  } finally { h.plugin.unload(); }
});

test('image-before-subtree uses one canonical numbering plan in CM, Reading and TOC', async () => {
  const source = '# Host\n\n![[photo.png|300x200]]\n\n## Child ^child-id\n\nBody';
  const h = assets({ 'Host.md': source, 'Attachments/photo.png': 'fixture' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const view = h.open('Host.md'), state = view.editor.attach(h.plugin.extensions), labels = [];
    for (const set of state.facet(EditorView.decorations)) if (typeof set.between === 'function') set.between(0, state.doc.length, (_from, _to, decoration) => {
      const widget = decoration.spec.widget;
      if (widget?.constructor.name === 'Label') labels.push(widget.toDOM().textContent.trim());
    });
    const section = document.createElement('section');
    section.innerHTML = '<span class="internal-embed image-embed" src="photo.png"><img width="300" height="200"></span><h2>Child ^child-id</h2>';
    await h.plugin.postprocessors[0](section, h.context('Host.md', 2, 6)); await drain();
    const reading = section.querySelector('[data-hybrid-badge]')?.textContent.trim();
    const context = c.current(), toc = c.outline(context.document, context.tree);
    assert.deepEqual(labels, ['2'], 'preserve the existing canonical numbering instead of renumbering only the editor');
    assert.equal(reading, '2');
    assert.equal(toc[0]?.number, '2');
    assert.equal(embedWidgets(state).length, 0, 'image still belongs to native decorations');
  } finally { h.plugin.unload(); }
});

class NativeAttachment extends WidgetType {
  toDOM() { const el = document.createElement('img'); el.setAttribute('width', '300'); el.setAttribute('height', '200'); el.setAttribute('src', 'app://image.png'); return el; }
}
test('Live Preview does not replace native attachment decorations with hybrid widgets', async () => {
  const literals = ['![[image.png|300x200]]', '![[../Assets/image.png|50]]', '![[画像 名.png|90x60]]', '![[guide.pdf#page=2|400]]'];
  const source = '# Host\n\n' + literals.join('\n\n') + '\n\n![[tree-id]]\n\n![[unknown-id]]\n\nEnd';
  const h = assets({ 'Notes/Host.md': source, 'Book.md': '# Book\n\n## Target ^tree-id\n\nBody', 'Assets/image.png': 'fixture', 'Assets/画像 名.png': 'fixture', 'Assets/guide.pdf': 'fixture' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const nativeWidget = new NativeAttachment();
    const nativeRanges = literals.map(literal => { const from = source.indexOf(literal); return Decoration.replace({ widget: nativeWidget, block: true }).range(from, from + literal.length); });
    const native = EditorView.decorations.of(Decoration.set(nativeRanges));
    const state = h.open('Notes/Host.md').editor.attach([native, ...h.plugin.extensions]);
    assert.deepEqual(embedWidgets(state).map(widget => widget.span.target), ['tree-id', 'unknown-id'], 'attachments stay native, real trees and missing IDs remain hybrid-owned');
    for (const literal of literals) {
      const from = source.indexOf(literal), owners = [];
      for (const set of state.facet(EditorView.decorations)) if (typeof set.between === 'function') set.between(from, from + literal.length, (at, to, decoration) => {
        if (at === from && to === from + literal.length) owners.push(decoration.spec.widget);
      });
      assert.equal(owners.length, 1, 'only the native replacement occupies an image/PDF range');
      assert.equal(owners[0] === nativeWidget, true);
    }
    assert.equal(state.doc.toString(), source, 'dimensions and original native source untouched');
    assert.equal(renders.length, 0);
  } finally { h.plugin.unload(); }
});

test('native attachment links are not intercepted even when their basename collides with a tree ID', async () => {
  const source = '# Host\n\n[[diagram]] [[image.png]]\n\n![[diagram]]\n\nEnd';
  const h = assets({ 'Host.md': source, 'Book.md': '---\nforester-id: diagram\n---\n# Book\n\nTREE-ONLY', 'Assets/diagram': 'synthetic extensionless attachment', 'Assets/image.png': 'fixture' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const section = document.createElement('section');
    section.innerHTML = '<p><a class="internal-link" data-href="diagram">diagram</a><a class="internal-link" data-href="image.png">image.png</a></p><span class="internal-embed" src="diagram" data-native-owner="keep">native attachment</span>';
    const native = section.querySelector('.internal-embed'), before = native.outerHTML;
    await h.plugin.postprocessors[0](section, h.context('Host.md', 2, 4)); await drain();
    for (const anchor of section.querySelectorAll('a')) {
      assert.equal(anchor.hasAttribute('data-hybrid-link'), false, 'attachment links keep native click ownership');
      const event = new window.Event('click', { bubbles: true, cancelable: true }); anchor.dispatchEvent(event);
      assert.equal(event.defaultPrevented, false);
    }
    assert.equal(native.outerHTML, before, 'native attachment wins over a bare colliding tree identity');
    const view = h.open('Host.md'), state = view.editor.attach(h.plugin.extensions);
    assert.equal(embedWidgets(state).length, 0, 'colliding attachment stays native in Live Preview too');
    const dom = document.createElement('div'); dom.innerHTML = '<a class="internal-link" data-href="diagram">diagram</a>';
    const lifecycle = h.plugin.extensions[0][1].create({ dom, state, posAtDOM: () => source.indexOf('diagram') });
    const event = new window.Event('click', { bubbles: true, cancelable: true }); dom.firstElementChild.dispatchEvent(event);
    assert.equal(event.defaultPrevented, false, 'scoped CM listener does not hijack an attachment link');
    assert.equal(h.workspace.opens.length, 0);
    lifecycle.destroy();
  } finally { h.plugin.unload(); }
});

for (const target of ['Assets/image.png', '../Assets/image.png', '画像 名.png', 'Assets/画像 名.png', 'guide.pdf#page=2']) {
  test(`Reading keeps native attachment DOM for ${target}`, async () => {
    const source = `# Host\n\n![[${target}|300x200]]\n`;
    const h = assets({ 'Notes/Host.md': source, 'Assets/image.png': 'fixture', 'Assets/画像 名.png': 'fixture', 'Assets/guide.pdf': 'fixture' });
    const c = new HybridController(h.plugin, h.getter); await c.initialize();
    try {
      const section = document.createElement('section'), native = document.createElement('span');
      native.className = 'internal-embed'; native.setAttribute('src', target); native.setAttribute('data-native-owner', 'keep');
      const image = document.createElement('img'); image.setAttribute('src', 'app://attachment'); image.setAttribute('width', '300'); image.setAttribute('height', '200'); native.append(image); section.append(native);
      const before = native.outerHTML, ctx = h.context('Notes/Host.md', 2, 2);
      await h.plugin.postprocessors[0](section, ctx); await drain();
      assert.equal(native.firstElementChild === image, true); assert.equal(native.outerHTML, before);
      assert.equal(ctx.children.length, 0); assert.equal(renders.length, 0);
    } finally { h.plugin.unload(); }
  });
}

test('missing attachments and ambiguous real tree identities still render explicit hybrid errors', async () => {
  const source = '# Host\n\n![[missing.png|300x200]]\n\n![[duplicate-id]]\n\nEnd';
  const h = assets({ 'Host.md': source, 'One.md': '---\nforester-id: duplicate-id\n---\n# One', 'Two.md': '---\nforester-id: duplicate-id\n---\n# Two' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const state = h.open('Host.md').editor.attach(h.plugin.extensions), widgets = embedWidgets(state);
    assert.equal(widgets.length, 2, 'only known actual attachments are passed through');
    const errors = widgets.map(widget => { const el = widget.toDOM({ dispatch() {}, focus() {} }); assert.equal(el.classList.contains('hybrid-error'), true); return el.textContent; });
    assert.match(errors[0], /not found/i); assert.match(errors[1], /multiple matches/i);
    const section = document.createElement('section'); section.innerHTML = '<span class="internal-embed" src="missing.png"></span><span class="internal-embed" src="duplicate-id"></span>';
    await h.plugin.postprocessors[0](section, h.context('Host.md', 2, 4)); await drain();
    assert.equal(section.querySelectorAll('.hybrid-error').length, 2);
    assert.equal(renders.length, 0, 'failed tree identities never reach native MarkdownRenderer');
    for (const widget of widgets) widget.destroy();
  } finally { h.plugin.unload(); }
});

test('local native asset display does not protect assets from the public privacy validator', async () => {
  const source = '---\nforester-id: public-id\npublish: true\n---\n# Public\n\n![[image.png|300x200]]\n\nEnd';
  const h = assets({ 'Public.md': source, 'Assets/image.png': 'synthetic attachment' });
  const c = new HybridController(h.plugin, h.getter); await c.initialize();
  try {
    const indexed = c.index.documents.get('Public.md'), before = structuredClone(indexed.protectedRanges);
    const state = h.open('Public.md').editor.attach(h.plugin.extensions);
    assert.equal(embedWidgets(state).length, 0);
    assert.deepEqual(indexed.protectedRanges, before, 'display-only protection never mutates the indexed document');
    await h.plugin.commands.get('preview-public-projection').callback();
    assert.match(modals.at(-1).contentEl.textContent, /unvetted-asset/);
    assert.match(modals.at(-1).contentEl.textContent, /0 public trees/);
    assert.equal(h.vault.processes.length, 0);
  } finally { h.plugin.unload(); }
});
