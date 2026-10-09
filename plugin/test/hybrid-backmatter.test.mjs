import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { parseHTML } from 'linkedom';

// Standalone build; never overwrite the controller/core test artifacts.
const entry = new URL('../src/hybrid-backmatter.ts', import.meta.url);
const artifact = new URL('./build/backmatter-renderer/hybrid-backmatter.mjs', import.meta.url);
let renderer = {};
if (existsSync(entry)) {
  mkdirSync(new URL('./build/backmatter-renderer/', import.meta.url), { recursive: true });
  await build({ entryPoints: [fileURLToPath(entry)], bundle: true, platform: 'node',
    format: 'esm', outfile: fileURLToPath(artifact), logLevel: 'warning' });
  renderer = await import(artifact.href);
}
const tree = (id, title, extra = {}) => ({
  key: `Definitions.md:${id ?? title}`, id, path: 'Definitions.md', level: 2,
  line: 2, endLine: 5, from: 10, to: 50, contentFrom: 20,
  children: [], metadataRanges: [], number: '9.7',
  meta: { title, taxon: 'Claim', authors: [], dates: [], citationAuthors: [],
    publish: false, publicTitle: false }, ...extra,
});
function setup(groups = {}, overrides = {}) {
  assert.equal(typeof renderer.renderBackmatter, 'function', 'export the reusable DOM renderBackmatter API');
  const { document, window } = parseHTML('<html><body><article><p id="native">Native note</p></article></body></html>');
  const container = document.querySelector('article');
  const calls = { bodies: [], opens: [], relations: [], releases: [], errors: [] };
  const host = {
    resolve: () => ({ status: 'missing', message: 'not found' }),
    open: (target, path) => calls.relations.push([target, path]),
    openTree: (value, newLeaf) => calls.opens.push([value, newLeaf]),
    renderBody: (el, value) => { calls.bodies.push(value); el.textContent = 'Full target body'; return () => calls.releases.push(value); },
    reportError: error => calls.errors.push(error),
    ...overrides,
  };
  const cleanup = renderer.renderBackmatter(container,
    { references: [], backlinks: [], related: [], ...groups }, host);
  return { container, document, window, calls, host, cleanup };
}
const click = (h, el, modifiers = {}) => {
  const event = new h.window.Event('click', { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(modifiers)) Object.defineProperty(event, key, { value });
  el.dispatchEvent(event); return event;
};
const toggle = (h, el, open) => {
  el.open = open;
  el.dispatchEvent(new h.window.Event('toggle'));
};

test('ordered nonempty groups append a footer after caller-owned note content', () => {
  const h = setup({ related: [tree('related', 'Related')], references: [tree('ref', 'Reference')], backlinks: [tree('back', 'Backlink')] });
  const footer = h.container.querySelector('footer.hybrid-backmatter[data-hybrid-backmatter]');
  assert.ok(footer);
  assert.equal(h.container.lastElementChild === footer, true);
  assert.deepEqual([...footer.querySelectorAll('section > h2')].map(el => el.textContent), ['References', 'Backlinks', 'Related']);
  assert.equal(h.document.querySelector('#native').textContent, 'Native note');
  h.cleanup(); h.cleanup();
  assert.equal(h.container.querySelector('footer'), null);
  assert.equal(h.document.querySelector('#native').textContent, 'Native note');
  const empty = setup();
  assert.equal(empty.container.querySelector('footer'), null);
  empty.cleanup();
  const partial = setup({ backlinks: [tree('back', 'Backlink')] });
  assert.deepEqual([...partial.container.querySelectorAll('section > h2')].map(el => el.textContent), ['Backlinks']);
  partial.cleanup();
});

test('each result is closed, safely titled, unnumbered and exposes native metadata', () => {
  const value = tree('ABCD01', '<img src=x onerror=alert(1)>', {
    meta: { title: '<img src=x onerror=alert(1)>', taxon: 'Claim', authors: ['Alice'], dates: ['2026-10-04'] },
  });
  const h = setup({ references: [value] });
  const details = h.container.querySelector('details.hybrid-backmatter-item');
  assert.ok(details);
  assert.equal(details.hasAttribute('open'), false);
  assert.equal(details.getAttribute('data-taxon'), 'Claim', 'footer exposes the semantic taxon for native appearance rules');
  const summary = details.querySelector('summary');
  assert.ok(summary);
  assert.equal(summary.querySelector('.hybrid-backmatter-title').textContent, value.meta.title);
  assert.equal(summary.querySelector('.hybrid-taxon-number').textContent.trim(), 'Claim');
  assert.equal(summary.textContent.includes('9.7'), false, 'no document-context numbering');
  assert.equal(summary.querySelector('img'), null);
  assert.match(details.querySelector('.hybrid-metadata').textContent, /October 4, 2026.*Alice/);
  assert.equal(summary.contains(details.querySelector('.hybrid-metadata')), true, 'metadata stays in the visible header while the body is collapsed');
  assert.deepEqual(h.calls.bodies, [], 'closed results never activate a Markdown component');
  h.cleanup();
});

test('slug anchors open the definition with Ctrl/Cmd new-leaf navigation and become inert on cleanup', () => {
  for (const level of [1, 2]) {
    const value = tree('ABCDEF', 'Definition', { level });
    const h = setup({ references: [value] });
    const slug = h.container.querySelector('summary a.hybrid-slug');
    assert.ok(slug, 'navigation is a native focusable anchor');
    assert.equal(slug.textContent, '[ABCDEF]');
    assert.equal(slug.getAttribute('href'), level === 1 ? 'Definitions.md' : 'Definitions.md#^ABCDEF');
    assert.equal(click(h, slug).defaultPrevented, true);
    click(h, slug, { ctrlKey: true });
    click(h, slug, { metaKey: true });
    assert.deepEqual(h.calls.opens, [[value, false], [value, true], [value, true]]);
    assert.equal(h.container.querySelector('details').hasAttribute('open'), false, 'slug is independent of disclosure');
    h.cleanup(); click(h, slug);
    assert.equal(h.calls.opens.length, 3);
  }
  const noId = setup({ related: [tree(undefined, 'Anonymous')] });
  assert.equal(noId.container.querySelector('.hybrid-slug'), null);
  noId.cleanup();
});

test('full bodies are rendered once on expansion, disposed once and never activated after unload', () => {
  const values = [tree('A1', 'First'), tree('B2', 'Second')];
  const h = setup({ references: values });
  const [first, second] = h.container.querySelectorAll('details');
  assert.deepEqual(h.calls.bodies, []);
  toggle(h, first, true);
  assert.deepEqual(h.calls.bodies, [values[0]]);
  assert.equal(first.querySelector('.hybrid-backmatter-body').textContent, 'Full target body');
  toggle(h, first, false); toggle(h, first, true);
  assert.deepEqual(h.calls.bodies, [values[0]], 'reopening reuses the same renderer component');
  assert.deepEqual(h.calls.releases, []);
  h.cleanup(); h.cleanup();
  assert.deepEqual(h.calls.releases, [values[0]]);
  toggle(h, second, true); toggle(h, first, true);
  assert.deepEqual(h.calls.bodies, [values[0]], 'retained/queued toggle callbacks cannot run after disposal');
  assert.equal(h.document.querySelector('#native').textContent, 'Native note');
});

test('host failures stay visible and bounded, including async navigation and failing disposers', async () => {
  const h = setup({ references: [tree('ERROR', 'Failure')], related: [tree('OK', 'Cleanup target')] });
  const [first, second] = h.container.querySelectorAll('details');
  const failure = new Error('<script>renderer failed</script>');
  h.host.renderBody = () => { throw failure; };
  assert.doesNotThrow(() => toggle(h, first, true));
  assert.match(first.querySelector('[role="alert"]').textContent, /render/i);
  assert.equal(first.querySelector('script'), null);
  assert.deepEqual(h.calls.errors, [failure]);
  toggle(h, first, false); toggle(h, first, true);
  assert.equal(h.calls.errors.length, 1, 'failed renders are not repeatedly activated');
  const slug = first.querySelector('a');
  h.host.openTree = () => Promise.reject(failure);
  click(h, slug); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.errors.length, 2, 'navigation rejection is handled, never unhandled');
  h.host.openTree = () => { throw failure; };
  assert.doesNotThrow(() => click(h, slug));
  assert.equal(h.calls.errors.length, 3);
  h.host.renderBody = () => () => { throw failure; };
  toggle(h, second, true);
  assert.doesNotThrow(h.cleanup, 'a failing component disposer must not prevent footer/listener removal');
  assert.equal(h.container.querySelector('footer'), null);
  assert.equal(click(h, slug).defaultPrevented, false, 'removed listener must not consume native events');
});

test('late navigation rejection and renderer-triggered cleanup cannot resurrect disposed work', async () => {
  const h = setup({ backlinks: [tree('LATE', 'Late callback')] });
  let reject;
  h.host.openTree = () => new Promise((_, fail) => { reject = fail; });
  click(h, h.container.querySelector('a'));
  let released = 0;
  h.host.renderBody = () => { h.cleanup(); return () => { released++; }; };
  toggle(h, h.container.querySelector('details'), true);
  assert.equal(released, 1, 'cleanup returned after synchronous unload is released immediately');
  reject(new Error('late navigation')); await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(h.calls.errors, [], 'stale async callbacks must not notify an unloaded host');
  assert.equal(h.container.querySelector('footer'), null);
});

test('metadata links are safe literal text with lifetime-bound host callbacks even if resolution fails', () => {
  const failure = new Error('metadata lookup failed');
  const value = tree('META', 'Metadata', { meta: {
    title: 'Metadata', authors: ['[[Alice|<img src=x onerror=alert(1)>]]'], dates: [],
  } });
  let h;
  assert.doesNotThrow(() => { h = setup({ references: [value] }, { resolve: () => { throw failure; } }); });
  const link = h.container.querySelector('.hybrid-metadata a');
  assert.equal(link.textContent, '<img src=x onerror=alert(1)>');
  assert.equal(h.container.querySelector('img'), null);
  assert.deepEqual(h.calls.errors, [failure]);
  click(h, link);
  assert.deepEqual(h.calls.relations, [['Alice', value.path]]);
  h.cleanup();
  assert.equal(click(h, link).defaultPrevented, false);
  assert.equal(h.calls.relations.length, 1);
});
