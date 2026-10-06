import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { createPlugin, ItemView, WorkspaceLeaf, notices, window } from './sidebar-obsidian-mock.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const entry = new URL('../src/hybrid-sidebar.ts', import.meta.url);
const artifact = new URL('./build/sidebar/hybrid-sidebar.mjs', import.meta.url);
let sidebar = {};
if (existsSync(entry)) {
  mkdirSync(new URL('./build/sidebar/', import.meta.url), { recursive: true });
  const mock = fileURLToPath(new URL('./sidebar-obsidian-mock.mjs', import.meta.url));
  await build({ absWorkingDir: root, entryPoints: [fileURLToPath(entry)], bundle: true,
    platform: 'node', format: 'esm', outfile: fileURLToPath(artifact),
    plugins: [{ name: 'public-obsidian-sidebar-boundary', setup(b) {
      b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true }));
    } }] });
  sidebar = await import(artifact.href);
}
const specs = [
  ['forester-toc', 'Forester TOC', 'list-tree'],
  ['forester-backlinks', 'Forester Backlinks', 'links'],
  ['forester-related', 'Forester Related', 'network'],
  ['forester-references', 'Forester References', 'book-open']
];
function hostHarness() {
  const listeners = new Set();
  return {
    state: null, entries: [], groups: { backlinks: [], related: [], references: [] },
    listeners, calls: { current: 0, outline: [], relations: [], opens: [], focuses: [], subscriptions: 0, releases: 0 },
    current() { this.calls.current++; return this.state; },
    outline(document, tree) { this.calls.outline.push([document, tree]); return this.entries; },
    relations(tree) { this.calls.relations.push(tree); return this.groups; },
    async openTree(tree, newLeaf) { this.calls.opens.push([tree, newLeaf]); },
    async focusOccurrence(entry) { this.calls.focuses.push(entry); },
    subscribe(update) {
      this.calls.subscriptions++; listeners.add(update);
      return () => { this.calls.releases++; listeners.delete(update); };
    },
    emit() { for (const update of [...listeners]) update(); }
  };
}
async function setup(t, host = hostHarness()) {
  assert.equal(typeof sidebar.registerHybridSidebar, 'function', 'the isolated sidebar module exports registerHybridSidebar');
  const h = createPlugin();
  sidebar.registerHybridSidebar(h.plugin, host);
  t.after(() => h.plugin.unload());
  return { ...h, host };
}
async function open(h, type) {
  const command = h.plugin.commands.get(`open-${type}`);
  assert.ok(command, `public command for ${type}`);
  await command.callback();
  return h.workspace.getLeavesOfType(type)[0].view;
}

const settle = () => new Promise(resolve => setTimeout(resolve, 80));
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const click = (el, modifiers = {}) => {
  assert.ok(el, 'navigation target exists');
  const event = new window.Event('click', { bubbles: true, cancelable: true });
  for (const [key, value] of Object.entries(modifiers)) Object.defineProperty(event, key, { value });
  el.dispatchEvent(event);
  return event;
};
const tree = (id, title, extra = {}) => ({
  key: `Note.md:${id ?? title}`, id, path: 'Note.md', level: 2, line: 2, endLine: 4,
  from: 10, to: 30, contentFrom: 20, children: [], metadataRanges: [], number: '1',
  meta: { title, authors: [], dates: [], citationAuthors: [], publish: false, publicTitle: false }, ...extra
});
const current = viewed => ({ document: {
  path: viewed.path, source: '# Page\n## Section', enabled: true, frontmatter: {}, root: tree('page', 'Viewed page'),
  trees: [viewed], protectedRanges: [], raw: [], diagnostics: []
}, tree: viewed });

// The native unavailable runtime alone is mocked; every assertion uses the real module.
test('native base constructor can query each sidebar identity before derived fields initialize', async t => {
  const h = await setup(t);
  for (const [type, title, icon] of specs) {
    const leaf = h.workspace.getRightLeaf(false);
    let view;
    assert.doesNotThrow(() => { view = h.plugin.views.get(type)(leaf); }, `${type} must not become a missing-plugin pane`);
    leaf.view = view;
    assert.deepEqual(view.constructorIdentity, {type, title, icon});
  }
});

test('four individual public ItemViews open only by command and reuse existing leaves per type', async t => {
  const h = await setup(t);
  assert.deepEqual([...h.plugin.views.keys()], specs.map(s => s[0]));
  assert.equal(h.workspace.leaves.length, 0, 'registration does not open tabs on startup');
  assert.equal(h.host.calls.current, 0, 'registration does not scan an unopened sidebar');
  assert.equal(h.host.calls.subscriptions, 0);
  for (const [type, title, icon] of specs) {
    const view = await open(h, type);
    assert.ok(view instanceof ItemView);
    assert.equal(view.getViewType(), type);
    assert.equal(view.getDisplayText(), title);
    assert.equal(view.getIcon(), icon);
  }
  assert.equal(h.workspace.leaves.length, 4, 'not four sections in one view');
  assert.ok(h.workspace.leaves.every(leaf => leaf.parent === h.workspace.rightGroup));
  assert.deepEqual(h.workspace.rightCalls, [false, false, false, false]);
  const original = [...h.workspace.leaves];
  for (const [type] of specs) await open(h, type);
  assert.deepEqual(h.workspace.leaves, original);
  assert.equal(h.workspace.leaves.length, 4);
  assert.deepEqual(h.workspace.rightCalls, [false, false, false, false]);
  assert.equal(h.workspace.reveals.length, 8);
  assert.deepEqual(notices, []);
});

test('empty tabs explain no active, excluded and empty context through one coalesced host refresh', async t => {
  const h = await setup(t), views = [];
  for (const [type] of specs) views.push(await open(h, type));
  await settle();
  for (const view of views) {
    assert.equal(view.contentEl.getAttribute('data-forester-sidebar'), view.getViewType());
    assert.equal(view.contentEl.querySelector('h2').textContent, view.getDisplayText());
    assert.match(view.contentEl.querySelector('.hybrid-sidebar-empty').textContent, /No active Markdown/);
  }
  assert.equal(h.host.calls.subscriptions, 1, 'open views share one host subscription');
  const viewed = tree('viewed', 'Viewed section');
  h.host.state = current(viewed);
  h.host.state.document.enabled = false;
  h.host.emit();
  await settle();
  for (const view of views) assert.match(view.contentEl.textContent, /excluded|disabled/i);
  assert.equal(h.host.calls.outline.length, 0);
  assert.equal(h.host.calls.relations.length, 0);

  h.host.state.document.enabled = true;
  const reads = h.host.calls.current;
  for (let i = 0; i < 20; i++) h.host.emit();
  await settle();
  assert.equal(h.host.calls.current - reads, 1, 'a burst does not rescan each tab');
  assert.deepEqual(h.host.calls.outline, [[h.host.state.document, viewed]]);
  assert.deepEqual(h.host.calls.relations, [viewed], 'all three relation tabs share graph extraction');
  for (const view of views) {
    assert.match(view.contentEl.querySelector('.hybrid-sidebar-context').textContent, /Viewed section/);
    assert.match(view.contentEl.querySelector('.hybrid-sidebar-empty').textContent, /No /);
  }
  assert.deepEqual(h.workspace.eventSubscriptions, [], 'context has no editor selection listener');
  assert.deepEqual(h.host.calls.opens, []);
  assert.deepEqual(h.host.calls.focuses, []);
  assert.deepEqual(notices, []);
});

test('TOC headings focus exact repeated placements while the adjacent square opens the definition', async t => {
  const host = hostHarness(), definition = tree('embed-id', '<em>Repeated tree</em>');
  const first = { title: definition.meta.title, number: '1', target: 'embed-id', sourceKey: definition.key,
    occurrenceKey: 'Viewed.md:embed@15', tree: definition, children: [] };
  const second = { ...first, number: '2', occurrenceKey: 'Viewed.md:embed@40' };
  host.state = current(tree('page', 'Current page'));
  host.entries = [first, second];
  const h = await setup(t, host), toc = await open(h, 'forester-toc');
  for (const [type] of specs.slice(1)) await open(h, type);
  await settle();
  const rows = [...toc.contentEl.querySelectorAll('.hybrid-sidebar-toc-entry')];
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(row => row.dataset.occurrenceKey), [first.occurrenceKey, second.occurrenceKey]);
  assert.deepEqual(rows.map(row => row.querySelector('.hybrid-sidebar-number').textContent), ['1', '2']);
  assert.equal(toc.contentEl.querySelector('em'), null, 'titles are literal text, never HTML');
  assert.equal(toc.contentEl.querySelector('a[href]'), null, 'local placement is not a fabricated URI');
  for (const row of rows) assert.equal(row.querySelector('.hybrid-sidebar-heading').textContent, definition.meta.title);
  assert.equal(click(rows[0].querySelector('.hybrid-sidebar-heading')).defaultPrevented, true);
  click(rows[1].querySelector('.hybrid-sidebar-heading'), { ctrlKey: true });
  await settle();
  assert.deepEqual(host.calls.focuses, [first, second], 'pass the original entry including occurrence identity');
  assert.deepEqual(host.calls.opens, [], 'heading jump must not navigate or switch relation context');
  assert.equal(host.state.tree.id, 'page');
  host.emit();
  await settle();
  for (const leaf of h.workspace.leaves) assert.match(leaf.view.contentEl.querySelector('.hybrid-sidebar-context').textContent, /Current page/);
  const square = toc.contentEl.querySelector('.hybrid-sidebar-route');
  assert.equal(square.textContent, '■');
  click(square);
  click(square, { ctrlKey: true });
  click(square, { metaKey: true });
  await settle();
  assert.deepEqual(host.calls.opens, [[definition, false], [definition, true], [definition, true]]);
  assert.deepEqual(host.calls.focuses, [first, second]);
  assert.deepEqual(h.workspace.eventSubscriptions, []);
  assert.deepEqual(notices, []);
});

test('TOC hierarchy preserves collapses during updates and unfolds ancestors before local focus', async t => {
  const host = hostHarness();
  const leaf = { title: 'Leaf', number: '1.1.1', target: '', sourceKey: 'leaf-source', occurrenceKey: 'page/parent/child/leaf', children: [] };
  const child = { title: 'Child', number: '1.1', target: '', occurrenceKey: 'page/parent/child', children: [leaf] };
  const parent = { title: 'Parent', number: '1', target: '', occurrenceKey: 'page/parent', children: [child] };
  host.state = current(tree('page', 'Page'));
  host.entries = [parent];
  const h = await setup(t, host), toc = await open(h, 'forester-toc');
  await settle();
  const details = () => [...toc.contentEl.querySelectorAll('details')];
  assert.equal(details().length, 2, 'native details contain nested TOC entries');
  assert.ok(details().every(el => el.hasAttribute('open')));
  assert.equal(toc.contentEl.querySelectorAll('ul ul').length, 2);
  for (const el of details()) { el.removeAttribute('open'); el.dispatchEvent(new window.Event('toggle')); }
  host.emit();
  await settle();
  assert.ok(details().every(el => !el.hasAttribute('open')), 'refresh must not reset user collapses');
  const heading = toc.contentEl.querySelector('[data-occurrence-key="page/parent/child/leaf"] .hybrid-sidebar-heading');
  host.focusOccurrence = async entry => {
    assert.ok(details().every(el => el.hasAttribute('open')), 'unfold ancestors before delegating local-page jump');
    host.calls.focuses.push(entry);
  };
  click(heading);
  await settle();
  assert.deepEqual(host.calls.focuses, [leaf]);
  assert.deepEqual(host.calls.opens, []);
  assert.equal(host.state.tree.id, 'page');
  for (const el of details()) el.removeAttribute('open');
  host.state = current(tree('different', 'Different page'));
  host.emit();
  await settle();
  assert.ok(details().every(el => el.hasAttribute('open')), 'a different viewed tree has its own collapse state');
  assert.deepEqual(notices, []);
});

test('anonymous sections jump locally without a route and unresolved or duplicate placements stay inert', async t => {
  const host = hostHarness(), anonymous = tree(undefined, 'Anonymous section');
  const local = { title: 'Anonymous section', number: '1', target: '', sourceKey: anonymous.key, tree: anonymous, children: [] };
  const unresolved = { title: 'Unresolved embed', number: '2', target: 'missing-id', children: [] };
  const duplicate = { title: 'Repeated without placement identity', number: '3', target: 'dup-id', sourceKey: 'shared-source', children: [] };
  const collision = { title: 'Duplicate placement key', number: '5', target: 'collision-id', occurrenceKey: 'colliding-occurrence', children: [] };
  host.entries = [local, unresolved, duplicate, { ...duplicate, number: '4' }, collision, { ...collision, number: '6' }];
  host.state = current(tree('page', 'Page'));
  const h = await setup(t, host), toc = await open(h, 'forester-toc');
  await settle();
  const rows = [...toc.contentEl.querySelectorAll('.hybrid-sidebar-toc-entry')];
  assert.equal(rows.length, 6);
  assert.equal(rows[0].querySelector('.hybrid-sidebar-route'), null, 'anonymous trees do not gain fake public addresses');
  assert.equal(rows[0].querySelector('.hybrid-sidebar-heading').hasAttribute('disabled'), false);
  click(rows[0].querySelector('.hybrid-sidebar-heading'));
  for (const row of rows.slice(1)) {
    const heading = row.querySelector('.hybrid-sidebar-heading');
    assert.ok(heading.hasAttribute('disabled'), 'missing/ambiguous occurrence must not fall back to ID-only focus');
    assert.match(heading.getAttribute('title'), /unavailable|ambiguous/i);
    assert.match(row.querySelector('.hybrid-sidebar-unavailable').textContent, /unavailable|ambiguous/i);
    assert.equal(click(heading).defaultPrevented, false, 'disabled entry has no navigation handler');
  }
  await settle();
  assert.deepEqual(host.calls.focuses, [local]);
  assert.deepEqual(host.calls.opens, []);
  assert.equal(toc.contentEl.querySelector('a[href]'), null);
  assert.deepEqual(notices, []);
});

test('relation tabs render resolved title, ID, taxon and metadata and navigate exact source trees', async t => {
  const host = hostHarness();
  const backlink = tree('back-id', '<img src=x onerror=evil()> Backlink');
  backlink.meta.taxon = 'Claim'; backlink.meta.authors = ['[[Ada]]']; backlink.meta.dates = ['2026-10-05'];
  const related = tree('related-id', 'Related section', { path: 'Other.md' });
  related.meta.taxon = 'Lemma';
  const reference = tree('ref-id', 'Reference title', { path: 'Library/Reference.md' });
  reference.meta.taxon = 'Reference'; reference.meta.citationAuthors = ['Bibliographic author']; reference.meta.publicationYear = '2022';
  reference.meta.authors = ['Note author']; reference.meta.dates = ['2026-10-05'];
  host.groups = { backlinks: [backlink], related: [related], references: [reference] };
  host.state = current(tree('page', 'Viewed tree'));
  const h = await setup(t, host), views = [];
  for (const [type] of specs.slice(1)) views.push(await open(h, type));
  await settle();
  const targets = [backlink, related, reference];
  views.forEach((view, index) => {
    const row = view.contentEl.querySelector('.hybrid-sidebar-relation-entry');
    assert.ok(row);
    assert.equal(row.getAttribute('data-tree-key'), targets[index].key);
    assert.equal(row.getAttribute('data-tree-id'), targets[index].id);
    assert.equal(row.querySelector('.hybrid-sidebar-heading').textContent, targets[index].meta.title);
    assert.equal(row.querySelector('.hybrid-sidebar-id').textContent, targets[index].id);
    assert.equal(row.querySelector('.hybrid-sidebar-taxon').textContent, targets[index].meta.taxon);
    assert.equal(view.contentEl.querySelector('.hybrid-sidebar-empty'), null);
  });
  assert.equal(views[0].contentEl.querySelector('img'), null);
  assert.match(views[0].contentEl.querySelector('.hybrid-sidebar-metadata').textContent, /Authors: \[\[Ada\]\].*Dates: 2026-10-05/);
  const bibliography = views[2].contentEl.querySelector('.hybrid-sidebar-bibliography').textContent;
  assert.match(bibliography, /Bibliographic author/);
  assert.match(bibliography, /2022/);
  assert.doesNotMatch(bibliography, /Note author|2026-10-05/, 'citation metadata is not note authorship/date');
  assert.doesNotMatch(views[2].contentEl.textContent, /BibTeX|APA|CSL/, 'not a claim of full bibliography rendering');
  click(views[0].contentEl.querySelector('.hybrid-sidebar-heading'));
  click(views[1].contentEl.querySelector('.hybrid-sidebar-heading'), { ctrlKey: true });
  click(views[2].contentEl.querySelector('.hybrid-sidebar-heading'), { metaKey: true });
  await settle();
  assert.deepEqual(host.calls.opens, [[backlink, false], [related, true], [reference, true]]);
  assert.deepEqual(host.calls.focuses, []);
  assert.deepEqual(host.calls.relations, [host.state.tree]);
  assert.equal(host.calls.outline.length, 0, 'unopened TOC does not compute its outline');
  assert.deepEqual(notices, []);
});

test('relation source availability is explicit without inventing addresses or citation fields', async t => {
  const host = hostHarness(), fileRoot = tree(undefined, 'File-backed anonymous root', { level: 1 });
  const unavailable = tree('unavailable-id', 'Unavailable source', { path: '' });
  host.groups.references = [fileRoot, unavailable];
  host.state = current(tree('page', 'Page'));
  const h = await setup(t, host), view = await open(h, 'forester-references');
  await settle();
  const rows = [...view.contentEl.querySelectorAll('.hybrid-sidebar-relation-entry')];
  assert.equal(rows[0].querySelector('.hybrid-sidebar-id'), null);
  assert.equal(rows[0].getAttribute('data-tree-id'), null);
  click(rows[0].querySelector('.hybrid-sidebar-heading'));
  const heading = rows[1].querySelector('.hybrid-sidebar-heading');
  assert.ok(heading.hasAttribute('disabled'));
  assert.match(rows[1].querySelector('.hybrid-sidebar-unavailable').textContent, /source.*unavailable/i);
  assert.equal(click(heading).defaultPrevented, false);
  for (const row of rows) assert.match(row.querySelector('.hybrid-sidebar-bibliography').textContent, /metadata not set/i);
  await settle();
  assert.deepEqual(host.calls.opens, [[fileRoot, false]], 'anonymous file root uses its actual source tree');
  assert.equal(view.contentEl.querySelector('a[href]'), null);
  assert.deepEqual(notices, []);
});

test('closing and plugin disposal release subscriptions, queued refreshes and detached DOM listeners', async t => {
  const host = hostHarness(), target = tree('target', 'Target');
  host.state = current(tree('page', 'Page'));
  host.entries = [{ title: 'Target', number: '1', target: 'target', sourceKey: target.key, tree: target, children: [] }];
  host.groups.related = [target];
  const h = await setup(t, host), toc = await open(h, 'forester-toc'), related = await open(h, 'forester-related');
  await toc.onOpen(); // Native repeated lifecycle entry must not duplicate a subscription.
  await settle();
  assert.equal(host.listeners.size, 1);
  const staleUpdate = [...host.listeners][0];
  const oldButtons = [...toc.contentEl.querySelectorAll('button'), ...related.contentEl.querySelectorAll('button')];
  host.emit();
  await settle();
  for (const button of oldButtons) assert.equal(click(button).defaultPrevented, false, 'rerender releases detached listeners');
  const closedButtons = [...related.contentEl.querySelectorAll('button')];
  await related.onClose();
  await related.onClose();
  for (const button of closedButtons) assert.equal(click(button).defaultPrevented, false);
  assert.equal(host.listeners.size, 1, 'the remaining TOC still receives updates');
  assert.equal(host.calls.releases, 0);
  host.emit(); // A queued refresh must be cancelled by the last close.
  await toc.onClose();
  assert.equal(host.listeners.size, 0);
  assert.equal(host.calls.releases, 1);
  const reads = host.calls.current;
  staleUpdate(); host.emit();
  await settle();
  assert.equal(host.calls.current, reads, 'closed views cannot be resurrected by stale callbacks');
  await toc.onOpen();
  await settle();
  assert.equal(host.calls.subscriptions, 2, 'reopening creates exactly one new subscription');
  const finalButtons = [...toc.contentEl.querySelectorAll('button')];
  host.emit();
  const finalReads = host.calls.current;
  // Public Plugin.register cleanup may precede native leaf closing during unload.
  for (const cleanup of h.plugin.cleanups.splice(0).reverse()) cleanup();
  for (const button of finalButtons) assert.equal(click(button).defaultPrevented, false, 'plugin unload releases view listeners even before onClose');
  assert.equal(toc.contentEl.childElementCount, 0);
  assert.equal(host.listeners.size, 0);
  assert.equal(host.calls.releases, 2);
  await toc.onOpen(); // Late native lifecycle work after plugin unload is inert.
  await settle();
  assert.equal(host.listeners.size, 0);
  assert.equal(host.calls.current, finalReads);
  assert.deepEqual(host.calls.opens, []);
  assert.deepEqual(host.calls.focuses, []);
  assert.deepEqual(notices, []);
});

test('host refresh failures become visible errors and Notices, then a later update can recover', async t => {
  const scheduled = new Map(); let nextTimer = 0;
  t.mock.method(globalThis, 'setTimeout', fn => { scheduled.set(++nextTimer, fn); return nextTimer; });
  t.mock.method(globalThis, 'clearTimeout', id => scheduled.delete(id));
  const refresh = () => { const callbacks = [...scheduled.values()]; scheduled.clear(); for (const callback of callbacks) callback(); };
  const host = hostHarness(), readCurrent = host.current, readOutline = host.outline, readRelations = host.relations;
  host.state = current(tree('page', 'Page'));
  host.current = () => { throw new Error('Host current unavailable'); };
  const h = await setup(t, host), toc = await open(h, 'forester-toc');
  assert.doesNotThrow(refresh, 'a timer callback cannot leak host exceptions');
  assert.match(toc.contentEl.querySelector('.hybrid-sidebar-error').textContent, /Host current unavailable/);
  assert.match(notices[0], /Forester.*Host current unavailable/);
  host.current = readCurrent;
  host.outline = () => { throw new Error('Outline unavailable'); };
  host.emit(); assert.doesNotThrow(refresh);
  assert.match(toc.contentEl.querySelector('.hybrid-sidebar-error').textContent, /Outline unavailable/);
  host.outline = readOutline;
  host.relations = () => { throw new Error('Relations unavailable'); };
  const backlinks = await open(h, 'forester-backlinks');
  assert.doesNotThrow(refresh);
  assert.match(backlinks.contentEl.querySelector('.hybrid-sidebar-error').textContent, /Relations unavailable/);
  assert.equal(notices.length, 3, 'one Notice per failed shared refresh, not one per tab');
  host.relations = readRelations;
  host.emit(); assert.doesNotThrow(refresh);
  for (const view of [toc, backlinks]) {
    assert.equal(view.contentEl.querySelector('.hybrid-sidebar-error'), null);
    assert.match(view.contentEl.querySelector('.hybrid-sidebar-context').textContent, /Page/);
  }
  assert.equal(notices.length, 3);
});

test('actual heading and route clicks report host navigation rejections without unhandled promises', async t => {
  const host = hostHarness(), target = tree('target', 'Target');
  host.state = current(tree('page', 'Page'));
  host.entries = [{ title: 'Target', number: '1', target: 'target', sourceKey: target.key, tree: target, children: [] }];
  host.groups.related = [target];
  // Observe a real rejected Promise while preventing a harness-level unhandled rejection in RED.
  const rejection = message => { const promise = Promise.reject(new Error(message)); promise.catch(() => {}); return promise; };
  host.focusOccurrence = () => rejection('Local jump failed');
  host.openTree = () => rejection('Source navigation failed');
  const h = await setup(t, host), toc = await open(h, 'forester-toc'), related = await open(h, 'forester-related');
  await settle();
  click(toc.contentEl.querySelector('.hybrid-sidebar-heading'));
  click(toc.contentEl.querySelector('.hybrid-sidebar-route'), { metaKey: true });
  click(related.contentEl.querySelector('.hybrid-sidebar-heading'));
  await settle();
  assert.equal(notices.length, 3, 'every rejected navigation is reported');
  assert.match(notices[0], /Local jump failed/);
  assert.match(notices[1], /Source navigation failed/);
  assert.match(notices[2], /Source navigation failed/);
  assert.equal(host.state.tree.id, 'page');
});

test('open commands report unavailable sidebars, view creation and reveal failures as Notices', async t => {
  const h = await setup(t), command = h.plugin.commands.get('open-forester-toc');
  h.workspace.noRightLeaf = true;
  await assert.doesNotReject(() => command.callback());
  assert.match(notices.at(-1) ?? '', /sidebar.*unavailable/i);
  h.workspace.noRightLeaf = false;
  h.workspace.failSetState = true;
  await assert.doesNotReject(() => command.callback());
  assert.match(notices.at(-1), /Cannot create sidebar/);
  h.workspace.failSetState = false;
  h.workspace.failReveal = true;
  await assert.doesNotReject(() => command.callback());
  assert.match(notices.at(-1), /Cannot reveal sidebar/);
  h.workspace.failReveal = false;
  await command.callback();
  assert.equal(h.workspace.getLeavesOfType('forester-toc').length, 1);
  assert.equal(notices.length, 3, 'successful retry is not reported as a failure');
});

test('subscription failures are visible and cleanup failures cannot retain host or DOM listeners', async t => {
  const host = hostHarness(), subscribe = host.subscribe;
  host.subscribe = () => { throw new Error('Subscription unavailable'); };
  const h = await setup(t, host), toc = await open(h, 'forester-toc');
  assert.ok(toc.contentEl.querySelector('.hybrid-sidebar-error'), 'failed subscription must remain visible in the tab');
  assert.match(toc.contentEl.querySelector('.hybrid-sidebar-error').textContent, /Subscription unavailable/);
  assert.equal(notices.length, 1);
  assert.equal(host.listeners.size, 0);
  await toc.onClose();
  host.subscribe = function(update) {
    const release = subscribe.call(this, update);
    return () => { release(); throw new Error('Subscription release failed'); };
  };
  await toc.onOpen();
  await settle();
  assert.equal(host.listeners.size, 1);
  assert.equal(toc.contentEl.querySelector('.hybrid-sidebar-error'), null);
  await assert.doesNotReject(() => toc.onClose());
  assert.equal(host.listeners.size, 0);
  assert.equal(toc.contentEl.childElementCount, 0);
  assert.match(notices.at(-1), /Subscription release failed/);
  await toc.onClose();
  assert.equal(notices.length, 2, 'a throwing cleanup is removed before it can be retried');
});

test('simultaneous open commands reuse one in-flight leaf per type without combining distinct tabs', async t => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const setViewState = WorkspaceLeaf.prototype.setViewState;
  t.mock.method(WorkspaceLeaf.prototype, 'setViewState', async function(state) { await gate; return setViewState.call(this, state); });
  const h = await setup(t), toc = h.plugin.commands.get('open-forester-toc'), related = h.plugin.commands.get('open-forester-related');
  const first = toc.callback(), second = toc.callback(), other = related.callback();
  release();
  await Promise.all([first, second, other]);
  assert.equal(h.workspace.getLeavesOfType('forester-toc').length, 1, 'in-flight view creation cannot produce duplicate tabs');
  assert.equal(h.workspace.getLeavesOfType('forester-related').length, 1);
  assert.deepEqual(h.workspace.rightCalls, [false, false]);
  await toc.callback();
  assert.equal(h.workspace.getLeavesOfType('forester-toc').length, 1, 'the command is reusable after its promise settles');
  assert.deepEqual(notices, []);
});

test('in-flight sidebar open never reveals a detached leaf after plugin unload', { timeout: 5_000 }, async t => {
  const gate = deferred(), opened = deferred();
  t.after(() => gate.resolve());
  const setViewState = WorkspaceLeaf.prototype.setViewState;
  t.mock.method(WorkspaceLeaf.prototype, 'setViewState', async function(state) {
    await setViewState.call(this, state);
    opened.resolve(this);
    await gate.promise;
  });
  const h = await setup(t), command = h.plugin.commands.get('open-forester-toc');
  const pending = command.callback(), leaf = await opened.promise;
  assert.equal(h.workspace.getLeavesOfType('forester-toc')[0], leaf, 'real public view creation ran before the gate');
  assert.equal(h.host.listeners.size, 1);
  await h.plugin.unload();
  assert.equal(h.workspace.leaves.includes(leaf), false, 'native unload detached the exact in-flight leaf');
  assert.equal(h.host.listeners.size, 0);
  gate.resolve();
  await pending;
  assert.equal(h.workspace.reveals.length, 0, 'the awaited open must not reveal a detached leaf after disposal');
  await settle();
  assert.equal(h.workspace.leaves.includes(leaf), false);
  assert.equal(leaf.view.containerEl.isConnected, false);
  assert.deepEqual(h.host.calls.focuses, []);
  assert.deepEqual(h.host.calls.opens, []);
  assert.deepEqual(notices, []);
});

test('disposed sidebar registration rejects held open commands before any workspace mutation', async t => {
  const h = await setup(t), commands = [...h.plugin.commands.values()];
  await h.plugin.unload();
  for (const command of commands) await assert.doesNotReject(() => command.callback());
  assert.equal(h.workspace.rightCalls.length, 0, 'held callbacks cannot create a new leaf after disposal');
  assert.equal(h.workspace.leaves.length, 0);
  assert.equal(h.workspace.reveals.length, 0);
  assert.equal(h.host.calls.subscriptions, 0);
  assert.equal(h.host.calls.current, 0);
  assert.deepEqual(notices, []);
});

for (const phase of ['before view creation', 'after view creation']) {
  test(`in-flight sidebar cleanup removes only its created leaf when disposed ${phase}`, { timeout: 5_000 }, async t => {
    const h = await setup(t), completed = (await open(h, 'forester-related')).leaf;
    const unrelated = h.workspace.getRightLeaf(false);
    await unrelated.setViewState({ type: 'markdown', active: false });
    t.after(() => unrelated.detach());
    const gate = deferred(), entered = deferred();
    t.after(() => gate.resolve());
    const setViewState = WorkspaceLeaf.prototype.setViewState;
    t.mock.method(WorkspaceLeaf.prototype, 'setViewState', async function(state) {
      if (state.type !== 'forester-toc') return setViewState.call(this, state);
      if (phase === 'after view creation') await setViewState.call(this, state);
      entered.resolve(this);
      await gate.promise;
      if (phase === 'before view creation') await setViewState.call(this, state);
    });
    const command = h.plugin.commands.get('open-forester-toc'), reveals = h.workspace.reveals.length;
    const pending = command.callback(), created = await entered.promise;
    assert.equal(h.workspace.leaves.includes(created), true);
    // Exercise Plugin.register disposal before the native onClose/detach phase.
    for (const cleanup of h.plugin.cleanups.splice(0).reverse()) cleanup();
    assert.equal(h.workspace.leaves.includes(created), false, 'registration disposal immediately removes its in-flight leaf');
    assert.equal(h.workspace.leaves.includes(completed), true, 'completed opens belong to normal native leaf teardown');
    assert.equal(h.workspace.leaves.includes(unrelated), true, 'never detach a different native leaf');
    assert.equal(unrelated.view.containerEl.isConnected, true);
    assert.equal(h.host.listeners.size, 0);
    gate.resolve();
    await pending;
    assert.equal(h.workspace.leaves.includes(created), false);
    assert.equal(created.view.containerEl.isConnected, false, 'late setViewState completion cannot leave a revived view behind');
    assert.equal(h.workspace.reveals.length, reveals, 'no late reveal or focus after registration disposal');
    await created.view.onOpen();
    await settle();
    assert.equal(h.host.listeners.size, 0);
    assert.equal(h.host.calls.subscriptions, 1);
    assert.deepEqual(h.host.calls.focuses, []);
    assert.deepEqual(h.host.calls.opens, []);
    await h.plugin.unload();
    assert.equal(h.workspace.leaves.includes(unrelated), true, 'plugin unload is not workspace-wide teardown');
    assert.deepEqual(notices, []);
  });
}

test('sidebar disposal leaves a pending leaf repurposed as native Markdown untouched', { timeout: 5_000 }, async t => {
  const h = await setup(t), gate = deferred(), opened = deferred();
  t.after(() => gate.resolve());
  const setViewState = WorkspaceLeaf.prototype.setViewState;
  t.mock.method(WorkspaceLeaf.prototype, 'setViewState', async function(state) {
    await setViewState.call(this, state);
    opened.resolve(this);
    await gate.promise;
  });
  const pending = h.plugin.commands.get('open-forester-toc').callback(), leaf = await opened.promise;
  // Use the real public state-change implementation, not a type-string stub.
  await setViewState.call(leaf, { type: 'markdown', active: false });
  const nativeView = leaf.view;
  t.after(() => leaf.detach());
  await h.plugin.unload();
  assert.equal(h.workspace.leaves.includes(leaf), true, 'the tracked handle no longer belongs to this registration');
  assert.equal(nativeView.containerEl.isConnected, true);
  gate.resolve();
  await pending;
  assert.equal(h.workspace.leaves.includes(leaf), true, 'post-await cleanup must recheck the leaf type too');
  assert.equal(leaf.view, nativeView);
  assert.equal(nativeView.containerEl.isConnected, true);
  assert.equal(h.workspace.reveals.length, 0);
  assert.equal(h.host.listeners.size, 0);
  assert.deepEqual(notices, []);
});

test('sidebar cleanup remains effective while a public revealLeaf promise is in flight', { timeout: 5_000 }, async t => {
  const h = await setup(t), gate = deferred(), revealed = deferred();
  t.after(() => gate.resolve());
  const revealLeaf = h.workspace.revealLeaf;
  t.mock.method(h.workspace, 'revealLeaf', async function(leaf) {
    await revealLeaf.call(this, leaf);
    revealed.resolve(leaf);
    await gate.promise;
  });
  const pending = h.plugin.commands.get('open-forester-toc').callback(), leaf = await revealed.promise;
  assert.equal(h.workspace.reveals.length, 1, 'the reveal call started while the registration was alive');
  for (const cleanup of h.plugin.cleanups.splice(0).reverse()) cleanup();
  assert.equal(h.workspace.leaves.includes(leaf), false);
  assert.equal(leaf.view.containerEl.isConnected, false);
  gate.resolve();
  await pending;
  assert.equal(h.workspace.reveals.length, 1, 'promise completion issues no further reveals');
  assert.equal(h.workspace.leaves.includes(leaf), false);
  assert.equal(h.host.listeners.size, 0);
  assert.deepEqual(h.host.calls.focuses, []);
  assert.deepEqual(h.host.calls.opens, []);
  assert.deepEqual(notices, []);
});

async function chromiumExecutable() {
  if (process.env.HYBRID_CHROMIUM) return process.env.HYBRID_CHROMIUM;
  const cache = join(homedir(), '.cache/ms-playwright');
  const entries = await readdir(cache).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  const candidates = entries.filter(name => name.startsWith('chromium_headless_shell-'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  for (const candidate of candidates) {
    const executable = join(cache, candidate, 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (await access(executable).then(() => true, () => false)) return executable;
  }
  assert.fail('Set HYBRID_CHROMIUM to an installed Chromium executable');
}

test('actual appended sidebar CSS keeps taxon/number neutral and navigation controls native-sized in light/dark themes', { timeout: 30_000 }, async t => {
  const host = hostHarness(), definition = tree('claim-id', 'Claim title');
  definition.meta.taxon = 'Claim';
  host.entries = [{ title: 'Claim title', number: '1', target: 'claim-id', occurrenceKey: 'page/claim', tree: definition,
    children: [{ title: 'Unresolved child', number: '1.1', target: 'missing', children: [] }] }];
  host.groups.related = [definition];
  host.state = current(tree('page', 'Page'));
  const h = await setup(t, host), toc = await open(h, 'forester-toc'), related = await open(h, 'forester-related');
  await settle();
  assert.equal(toc.contentEl.querySelector('.hybrid-sidebar-taxon')?.textContent, 'Claim');
  const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
  const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true });
  try {
    for (const mode of ['light', 'dark']) {
      const page = await browser.newPage({ colorScheme: mode });
      try {
        const ink = mode === 'light' ? '#222222' : '#dedede';
        await page.setContent(`<html><body class="theme-${mode}" style="--text-normal:${ink};--text-accent:#dc167a;--text-muted:#888888;--text-faint:#999999;--interactive-accent:#dc167a;color:var(--text-normal)">
          <p id="ink">Body ink</p>${toc.contentEl.outerHTML}${related.contentEl.outerHTML}</body></html>`);
        await page.addStyleTag({ content: '.hybrid-sidebar-row { color:var(--text-accent) } button { background:#ddd; box-shadow:1px 1px 2px black; color:var(--text-accent); padding:8px }' });
        await page.addStyleTag({ content: css });
        const styles = await page.evaluate(() => {
          const color = el => getComputedStyle(el).color;
          const button = document.querySelector('.hybrid-sidebar-heading');
          const style = getComputedStyle(button);
          return { ink: color(document.querySelector('#ink')),
            labels: [...document.querySelectorAll('.hybrid-sidebar-number,.hybrid-sidebar-taxon')].map(color),
            heading: color(button), shadow: style.boxShadow, background: style.backgroundColor, padding: style.padding,
            indent: getComputedStyle(document.querySelector('.hybrid-sidebar-toc .hybrid-sidebar-toc')).paddingInlineStart };
        });
        assert.ok(styles.labels.length >= 3);
        for (const color of styles.labels) assert.equal(color, styles.ink);
        assert.equal(styles.heading, styles.ink);
        assert.equal(styles.shadow, 'none');
        assert.equal(styles.background, 'rgba(0, 0, 0, 0)');
        assert.equal(styles.padding, '0px');
        assert.ok(parseFloat(styles.indent) > 0, 'nested hierarchy is indented');
        await page.locator('.hybrid-sidebar-heading').first().focus();
        assert.notEqual(await page.locator('.hybrid-sidebar-heading').first().evaluate(el => getComputedStyle(el).outlineStyle), 'none');
        await page.locator('summary').focus();
        await page.locator('summary').press('Enter');
        assert.equal(await page.locator('details').evaluate(el => el.open), false, 'the native disclosure still collapses');
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
});
