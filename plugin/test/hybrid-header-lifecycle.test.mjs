import assert from 'node:assert/strict';
import test from 'node:test';
import { EditorView } from '@codemirror/view';
import { createHarness, document, window, renders, TFile } from './controller-obsidian-mock.mjs';
import { HybridController } from './build/hybrid-controller.mjs';

const optin = (body, extra = '') => `---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;
const source = optin('# Main\n#Claim\n\n## Part ^ABCD01\n#Lemma\n\nBody\n', 'forester-id: main-id\nauthors: ["[[person-id]]"]\n');
const entries = { 'Main.md': source, 'Person.md': optin('# Alice', 'forester-id: person-id\n') };
const click = el => { const event = new window.Event('click', { bubbles: true, cancelable: true }); el.dispatchEvent(event); return event; };
const section = () => { const el = document.createElement('section'); el.innerHTML = '<h1>Main</h1><h2>Part ^ABCD01</h2><p>Body</p>'; return el; };
const context = (h, text = source) => h.context('Main.md', text.split('\n').indexOf('# Main'), text.split('\n').length - 1, text);
async function setup(t, data = entries) { const h = createHarness(data); const c = new HybridController(h.plugin, h.getter); await c.initialize(); t.after(() => h.plugin.unload()); return { h, c, process: h.plugin.postprocessors[0] }; }
function assertInert(h, links) { const count = h.workspace.opens.length; for (const link of links) assert.equal(click(link).defaultPrevented, false, 'disposed header no longer owns the click'); assert.equal(h.workspace.opens.length, count, 'detached links cannot navigate'); }
function headerLinks(el) { return [...el.querySelectorAll('.hybrid-slug, .hybrid-metadata a')]; }
function assertSource(h, text = source) { assert.equal(h.vault.data.get('Main.md'), text); assert.deepEqual(h.vault.processes, []); }

// Real controller/MarkdownRenderChild lifecycle. Only the unavailable Obsidian boundary is mocked.
test('Reading section disposal, partial heading replacement and removal release header owners without plugin-scope growth', async t => {
  const { h, c, process } = await setup(t);
  const pluginCleanups = h.plugin.cleanups.length;
  for (let round = 0; round < 3; round++) {
    const el = section(), ctx = context(h);
    for (let pass = 0; pass < 3; pass++) await process(el, ctx);
    const links = headerLinks(el);
    assert.equal(links.length, 4);
    click(links.find(link => link.closest('.hybrid-metadata')));
    assert.equal(h.workspace.opens.at(-1)?.[0], 'Person.md');
    for (const child of ctx.children) child.unload();
    assertInert(h, links);
    assert.equal(ctx.children.length, 1, 'repeated passes reuse one section header owner');
    assert.equal(h.plugin.cleanups.length, pluginCleanups, 'section DOM is not retained by plugin registrations');
    assert.equal(c.readingChildren.size, 0);
    assert.equal(c.readingHeaders.has(el), false, 'disposed section leaves no owner entry');
    assert.equal(el.querySelector('[data-hybrid-heading]'), null);
    assert.equal(el.querySelector('h2').textContent.trim(), 'Part ^ABCD01');
    assertSource(h);
  }

  const el = section(), ctx = context(h);
  await process(el, ctx);
  const root = el.querySelector('h1'), rootLinks = headerLinks(el).filter(link => link.closest('h1') || link.closest('.hybrid-metadata') === root.nextElementSibling);
  root.replaceWith(document.createElement('h1'));
  el.querySelector('h1').textContent = 'Main';
  await process(el, ctx);
  assertInert(h, rootLinks);
  assert.equal(ctx.children.filter(child => child.loaded).length, 1);
  assert.equal(el.querySelectorAll('.hybrid-slug').length, 2);
  assert.equal(el.querySelectorAll('.hybrid-metadata').length, 2);
  const remaining = headerLinks(el);
  el.replaceChildren();
  await process(el, ctx);
  assertInert(h, remaining);
  assert.equal(ctx.children.filter(child => child.loaded).length, 0, 'an empty native rerender has no empty header owner');
  assert.equal(c.readingChildren.size, 0);
  assert.equal(c.readingHeaders.has(el), false);

  const active = section(), activeCtx = context(h);
  await process(active, activeCtx);
  const activeLinks = headerLinks(active);
  h.plugin.unload();
  assertInert(h, activeLinks);
  assert.ok(activeCtx.children.every(child => !child.loaded));
  assert.equal(c.readingChildren.size, 0);
  await process(active, activeCtx);
  assert.equal(activeCtx.children.length, 1, 'unloaded controller cannot allocate section owners');
  assertSource(h);
});

test('Reading raw-section headers share the renderer child and release detached listeners on disposal', async t => {
  const rawSource = source + '\n\\{\\title{Literal}}\n';
  const { h, c, process } = await setup(t, { ...entries, 'Main.md': rawSource });
  h.app.renderOverride = async (text, el) => { el.innerHTML = text.replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>'); };
  const pluginCleanups = h.plugin.cleanups.length;
  const el = section(), ctx = context(h, rawSource);
  for (let pass = 0; pass < 3; pass++) await process(el, ctx);
  assert.equal(renders.length, 1);
  assert.equal(ctx.children.length, 1);
  assert.equal(renders[0].component, ctx.children[0], 'headers must use this existing raw-section renderer owner');
  const links = headerLinks(el);
  assert.equal(links.length, 4);
  click(links.find(link => link.closest('.hybrid-metadata')));
  assert.equal(h.workspace.opens.at(-1)?.[0], 'Person.md');
  el.remove();
  ctx.children[0].unload();
  assertInert(h, links);
  assert.equal(h.plugin.cleanups.length, pluginCleanups);
  assert.equal(c.readingChildren.size, 0);
  assertSource(h, rawSource);
});

test('Reading partial native replacement releases old header anchors even when the heading element is reused', async t => {
  const { h, c, process } = await setup(t);
  const el = section(), ctx = context(h), pluginCleanups = h.plugin.cleanups.length;
  await process(el, ctx);
  const detached = el.querySelector('.hybrid-metadata a'), replacement = detached.cloneNode(true), owner = ctx.children[0];
  detached.replaceWith(replacement);
  await process(el, ctx);
  assertInert(h, [detached]);
  assert.equal(owner.loaded, false);
  assert.equal(ctx.children.filter(child => child.loaded).length, 1);
  assert.equal(el.querySelectorAll('.hybrid-metadata').length, 2);
  const links = headerLinks(el), root = el.querySelector('h1');
  root.textContent = 'Main';
  await process(el, ctx);
  assertInert(h, links);
  assert.equal(el.querySelector('h1'), root, 'native rendering may reuse a heading container');
  assert.equal(el.querySelectorAll('.hybrid-slug').length, 2);
  assert.equal(el.querySelectorAll('.hybrid-metadata').length, 2);
  assert.equal(ctx.children.filter(child => child.loaded).length, 1);
  click(el.querySelector('.hybrid-metadata a'));
  assert.equal(h.workspace.opens.at(-1)?.[0], 'Person.md');
  for (const child of ctx.children) child.unload();
  assert.equal(c.readingChildren.size, 0);
  assert.equal(c.readingHeaders.has(el), false);
  assert.equal(h.plugin.cleanups.length, pluginCleanups);
  assertSource(h);
});

test('Reading ordinary-to-raw section replacement unloads the previous header owner before rendering', async t => {
  const { h, c, process } = await setup(t);
  const el = section(), previousCtx = context(h);
  await process(el, previousCtx);
  const oldLinks = headerLinks(el), previousOwner = previousCtx.children[0];
  const rawSource = source + '\n\\{\\title{Literal}}\n';
  h.vault.data.set('Main.md', rawSource);
  await h.app.metadataCache.emit('changed', h.vault.files.get('Main.md'), rawSource, {});
  await c.refresh();
  h.app.renderOverride = async (text, body) => { body.innerHTML = text.replace(/^## (.*)$/gm, '<h2>$1</h2>').replace(/^# (.*)$/gm, '<h1>$1</h1>'); };
  const ctx = context(h, rawSource);
  await process(el, ctx);
  assertInert(h, oldLinks);
  assert.equal(previousOwner.loaded, false);
  assert.equal(c.readingHeaders.has(el), false);
  assert.equal(ctx.children.length, 1);
  assert.equal(c.readingChildren.size, 1);
  assert.equal(el.querySelectorAll('.hybrid-metadata').length, 2);
  assertSource(h, rawSource);
});

// Preservation checks for the additional ID/whole-section acceptance request.
// Do not weaken source guards without a captured native context.
for (const target of ['Book#^ABCD01', 'ABCD01']) test(`Reading ![[${target}]] renders the exact entire heading section including subheadings, excluding the next H2`, async t => {
  const page = optin(`# Page\n\n[[${target}]]\n\n![[${target}]]\n`);
  const book = optin('# Book\n\n## Whole ^ABCD01\n\nFirst\n\n### Child ^ABCD02\n\nSecond\n\n## Next\nExcluded');
  const { h, process } = await setup(t, { 'Page.md': page, 'Book.md': book });
  const el = document.createElement('section');
  el.innerHTML = `<p><a class="internal-link" data-href="${target}">Whole</a></p><div class="internal-embed" src="${target}">Native one-line excerpt</div>`;
  const ctx = h.context('Page.md', page.split('\n').indexOf(`[[${target}]]`), page.split('\n').length - 1);
  await process(el, ctx);
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  const wrapper = el.querySelector('.hybrid-embed');
  assert.ok(wrapper?.querySelector('header')?.textContent.includes('Whole'));
  const expected = book.slice(book.indexOf('\n', book.indexOf('## Whole')) + 1, book.indexOf('## Next'));
  assert.equal(renders.length, 1);
  assert.equal(renders[0].source, expected, 'not a native caret one-line excerpt');
  assert.equal(wrapper.querySelector('.hybrid-tree-body').textContent, expected);
  assert.ok(expected.includes('### Child ^ABCD02') && expected.includes('Second'));
  assert.ok(!wrapper.textContent.includes('Excluded'));
  if (target === 'ABCD01') {
    click(el.querySelector('p a'));
    assert.equal(h.workspace.opens.at(-1)?.[0], 'Book.md#^ABCD01');
  }
  assert.equal(h.vault.data.get('Page.md'), page);
  assert.equal(h.vault.data.get('Book.md'), book);
  assert.deepEqual(h.vault.processes, []);
});

for (const collision of ['different file name', 'different file alias']) test(`Reading bare ID links/embeds fail closed on a ${collision} collision`, async t => {
  const page = optin('# Page\n\n[[ABCD01]]\n\n![[ABCD01]]\n');
  const book = optin('# Book\n\n## Whole ^ABCD01\n\nBody\n\n## Next\nExcluded');
  const conflicting = collision === 'different file name' ? { 'ABCD01.md': '# Ordinary collision' } : { 'Other.md': '---\naliases: [ABCD01]\n---\n# Ordinary alias collision' };
  const { h, process } = await setup(t, { 'Page.md': page, 'Book.md': book, ...conflicting });
  const el = document.createElement('section');
  el.innerHTML = '<p><a class="internal-link" data-href="ABCD01">Whole</a></p><div class="internal-embed" src="ABCD01">Native excerpt</div>';
  await process(el, h.context('Page.md', page.split('\n').indexOf('[[ABCD01]]'), page.split('\n').length - 1));
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  click(el.querySelector('p a'));
  assert.equal(h.workspace.opens.length, 0, 'ambiguity must not pick a file or tree arbitrarily');
  assert.ok(el.querySelector('.hybrid-embed')?.classList.contains('hybrid-error'));
  assert.equal(renders.length, 0, 'ambiguous embeds never render an arbitrary body');
  assert.equal(h.vault.data.get('Page.md'), page);
  assert.equal(h.vault.data.get('Book.md'), book);
  assert.deepEqual(h.vault.processes, []);
});

test('Reading a root file and its own matching ID are one identity, not an ambiguous collision', async t => {
  const page = optin('# Page\n\n[[self]]\n\n![[self]]\n');
  const self = optin('# Self\n\nTop\n\n## Child ^ABCD02\n\nNested', 'forester-id: self\n');
  const { h, process } = await setup(t, { 'Page.md': page, 'self.md': self });
  const el = document.createElement('section');
  el.innerHTML = '<p><a class="internal-link" data-href="self">Self</a></p><div class="internal-embed" src="self">Native excerpt</div>';
  await process(el, h.context('Page.md', page.split('\n').indexOf('[[self]]'), page.split('\n').length - 1));
  for (let i = 0; i < 4; i++) await new Promise(setImmediate);
  click(el.querySelector('p a'));
  assert.equal(h.workspace.opens.at(-1)?.[0], 'self.md');
  assert.ok(el.querySelector('.hybrid-embed .hybrid-tree-body')?.textContent.includes('Nested'));
  assert.equal(el.querySelector('.hybrid-embed.hybrid-error'), null);
  assert.equal(h.vault.data.get('Page.md'), page);
  assert.equal(h.vault.data.get('self.md'), self);
  assert.deepEqual(h.vault.processes, []);
});

function metadataWidget(state) {
  const widgets = [];
  for (const decorations of state.facet(EditorView.decorations)) if (typeof decorations.between === 'function') decorations.between(0, state.doc.length, (_from, _to, decoration) => {
    if (decoration.spec.widget?.kind === 'metadata') widgets.push(decoration.spec.widget);
  });
  return widgets.find(widget => widget.tree.meta.title === 'Main');
}

// Real CM StateField transactions and WidgetType equality, through the actual adapter/index.
// HeaderPart's combined-header variant uses the same production class (not a fake widget).
for (const transition of ['person title edit', 'missing to resolved', 'ambiguous to resolved']) {
  for (const kind of ['metadata', 'header']) test(`CodeMirror ${kind} invalidates relation labels after ${transition} without editing source`, async t => {
    const initial = { ...entries };
    if (transition === 'missing to resolved') delete initial['Person.md'];
    if (transition === 'ambiguous to resolved') initial['Other.md'] = optin('# Bob', 'forester-id: person-id\n');
    const { h, c } = await setup(t, initial);
    const view = h.open('Main.md'), before = view.editor.attach(h.plugin.extensions);
    const oldMetadata = metadataWidget(before);
    assert.ok(oldMetadata);
    const old = kind === 'metadata' ? oldMetadata : new oldMetadata.constructor(oldMetadata.tree, 'header', 'Claim', oldMetadata.host);
    const oldDOM = old.toDOM();
    t.after(() => old.destroy());
    const oldLabel = transition === 'person title edit' ? 'Alice' : 'person-id';
    assert.equal(oldDOM.querySelector('.hybrid-metadata a').textContent, oldLabel);
    const dispatches = view.editor.cm.dispatches.length;
    if (transition === 'ambiguous to resolved') {
      const file = h.vault.files.get('Other.md');
      h.vault.files.delete(file.path); h.vault.data.delete(file.path);
      await h.vault.emit('delete', file);
    } else {
      const text = optin(`# ${transition === 'person title edit' ? 'Alicia' : 'Alice'}`, 'forester-id: person-id\n');
      h.vault.data.set('Person.md', text);
      if (transition === 'missing to resolved') {
        const file = new TFile('Person.md'); h.vault.files.set(file.path, file);
        await h.vault.emit('create', file);
      } else await h.app.metadataCache.emit('changed', h.vault.files.get('Person.md'), text, {});
    }
    await c.refresh();
    const after = view.editor.cm.state, nextMetadata = metadataWidget(after);
    assert.ok(view.editor.cm.dispatches.length > dispatches, 'controller dispatches the real hybridRefresh effect');
    assert.equal(after.doc.toString(), source);
    assert.equal(view.editor.getValue(), source);
    assert.ok(after.selection.eq(before.selection));
    assert.deepEqual(nextMetadata.tree.meta, oldMetadata.tree.meta, 'local metadata is unchanged; only relation resolution changed');
    const next = kind === 'metadata' ? nextMetadata : new nextMetadata.constructor(nextMetadata.tree, 'header', 'Claim', nextMetadata.host);
    const nextDOM = next.toDOM();
    t.after(() => next.destroy());
    assert.equal(nextDOM.querySelector('.hybrid-metadata a').textContent, transition === 'person title edit' ? 'Alicia' : 'Alice');
    assert.equal(old.eq(next), false, 'CodeMirror must not reuse DOM with the stale relation label');
    old.destroy(); assertInert(h, headerLinks(oldDOM));
    click(nextDOM.querySelector('.hybrid-metadata a'));
    assert.equal(h.workspace.opens.at(-1)?.[0], 'Person.md');
    next.destroy(); assertInert(h, headerLinks(nextDOM));
    assertSource(h);
  });
}
