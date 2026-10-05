import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A missing new module must fail an assertion, not an import/syntax error.
// Isolated runs can select their own ignored build directory; package tests use build/.
const build = new URL(process.env.HYBRID_RELATIONS_BUILD_DIR ?? './build/', import.meta.url);
const relations = await import(new URL('hybrid-relations.mjs', build)).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const core = await import(new URL('hybrid-core.mjs', build));
const options = { folders: ['/'], publicFolders: [], reservedIds: [] };
const parse = (path, source) => core.parseHybrid(path, source, options);
const graphOf = documents => {
  const index = core.indexHybrid(documents);
  return relations.createTreeRelations(index, (target, fromPath) => core.resolveHybrid(index, target, fromPath));
};
const ids = trees => trees.map(tree => tree.id ?? tree.key);
const empty = () => ({ backlinks: [], related: [], references: [] });

test('exports a pure relation factory with empty results for unknown keys', () => {
  assert.equal(typeof relations.createTreeRelations, 'function');
  const graph = graphOf([]);
  assert.deepEqual(graph.forTree('unknown'), empty());
});

test('direct links feed inverse Backlinks, non-Reference Related, and reflexive References', () => {
  const a = parse('A.md', '---\nforester-id: a-id\n---\n[[b-id]] [[ref-id|explicit label]] [[b-id]]');
  const b = parse('B.md', '---\nforester-id: b-id\n---\n[[c-id]]');
  const c = parse('C.md', '---\nforester-id: c-id\n---\nNo outgoing links');
  const ref = parse('R.md', '---\nforester-id: ref-id\ntaxon: Reference\n---\nReference body');
  const graph = graphOf([ref, c, b, a]);
  assert.deepEqual(ids(graph.forTree(a.root.key).related), ['b-id']);
  assert.deepEqual(ids(graph.forTree(a.root.key).references), ['ref-id']);
  assert.deepEqual(ids(graph.forTree(b.root.key).backlinks), ['a-id']);
  assert.deepEqual(ids(graph.forTree(c.root.key).backlinks), ['b-id'], 'no backlink transitive closure');
  assert.deepEqual(ids(graph.forTree(ref.root.key).backlinks), ['a-id']);
});

test('References close over embeds without making transcludes into direct links', () => {
  const a = parse('A.md', '---\nforester-id: a-id\n---\n![[b-id|placement]] %%ht%%\n![[unused-ref]]\n![[a-id]]');
  const b = parse('B.md', '---\nforester-id: b-id\n---\n![[c-id]] [[ref-b]]');
  const c = parse('C.md', '---\nforester-id: c-id\n---\n![[a-id]] [[ref-c]] [[ref-b]]');
  const incoming = parse('D.md', '---\nforester-id: incoming-id\n---\n[[a-id]]');
  const rb = parse('RB.md', '---\nforester-id: ref-b\ntaxon: Reference\n---\nBody');
  const rc = parse('RC.md', '---\nforester-id: ref-c\ntaxon: Reference\n---\nBody');
  const unused = parse('Unused.md', '---\nforester-id: unused-ref\ntaxon: Reference\n---\nNever linked');
  const graph = graphOf([unused, rb, a, c, incoming, rc, b]);
  for (const document of [a, b, c]) {
    assert.deepEqual(ids(graph.forTree(document.root.key).references), ['ref-b', 'ref-c']);
    assert.deepEqual(graph.forTree(document.root.key).related, [], 'embeds and their outbound links are not Related');
  }
  assert.deepEqual(ids(graph.forTree(a.root.key).backlinks), ['incoming-id'], 'cycles/embeds do not become Backlinks');
  assert.deepEqual(graph.forTree(b.root.key).backlinks, []);
  assert.deepEqual(ids(graph.forTree(rb.root.key).backlinks), ['b-id', 'c-id'], 'only direct link owners backlink');
});

test('narrowest source tree owns links while structural sections aggregate References', () => {
  const a = parse('A.md', '---\nforester-id: a-id\n---\n# Root\n[[root-target]]\n## Child ^child-id\n[[child-target]] [[ref-1]]\n### Deep ^deep-id\n{ref:[[ref-2]]}\n## Sibling ^sibling-id\n[[sibling-target]] {ref:[[ref-3]]}\n# Root tail\n[[tail-target]]');
  const embedder = parse('E.md', '---\nforester-id: embedder-id\n---\n![[A#^child-id]]');
  const headingLink = parse('H.md', '---\nforester-id: heading-link-id\n---\n[[A#Child#Deep]]');
  const targets = ['root-target', 'child-target', 'sibling-target', 'tail-target'].map((id, i) =>
    parse(`T${i}.md`, `---\nforester-id: ${id}\n---\nBody`));
  const refs = ['ref-1', 'ref-2', 'ref-3'].map((id, i) =>
    parse(`R${i}.md`, `---\nforester-id: ${id}\n---\n#Ref\n\nBody`));
  const graph = graphOf([embedder, headingLink, ...refs, ...targets, a]);
  const [, child, deep, sibling] = a.trees;
  assert.deepEqual(ids(graph.forTree(a.root.key).related), ['root-target', 'tail-target']);
  assert.deepEqual(ids(graph.forTree(child.key).related), ['child-target']);
  assert.deepEqual(ids(graph.forTree(sibling.key).related), ['sibling-target']);
  assert.deepEqual(ids(graph.forTree(a.root.key).references), ['ref-1', 'ref-2', 'ref-3']);
  assert.deepEqual(ids(graph.forTree(child.key).references), ['ref-1', 'ref-2']);
  assert.deepEqual(ids(graph.forTree(deep.key).references), ['ref-2']);
  assert.deepEqual(ids(graph.forTree(embedder.root.key).references), ['ref-1', 'ref-2'], 'subtree embed must not include root/sibling facts');
  assert.deepEqual(ids(graph.forTree(refs[1].root.key).backlinks), ['deep-id']);
  assert.deepEqual(ids(graph.forTree(targets[1].root.key).backlinks), ['child-id']);
  assert.deepEqual(ids(graph.forTree(deep.key).backlinks), ['heading-link-id'], 'structural containment is not a backlink');
  assert.deepEqual(ids(graph.forTree(headingLink.root.key).related), ['deep-id']);
});

test('shared parser guards exclude metadata and quoted/code/math/raw examples from facts', () => {
  const source = [
    '---',
    'forester-id: source-id',
    'authors: ["[[guard-id]]"]',
    'dates: ["[[guard-id]]"]',
    'contributors: ["[[guard-id]]"]',
    'title: "[[guard-id]]"',
    '---',
    '%% forester',
    'source: "[[guard-id]]"',
    'authors: ["[[guard-id]]"]',
    '%%',
    '[[visible-id]] {ref:[[real-ref]]}',
    '',
    '%% [[guard-id]] ![[guard-embed]] %%',
    '',
    '<!-- [[guard-id]] ![[guard-embed]] -->',
    '',
    '```forester',
    '[[guard-id]] ![[guard-embed]]',
    '```',
    '',
    '~~~md',
    '[[guard-id]] ![[guard-embed]]',
    '~~~',
    '',
    '    [[guard-id]] ![[guard-embed]]',
    '',
    '> [[guard-id]] ![[guard-embed]]',
    'lazy continuation [[guard-id]] ![[guard-embed]]',
    '',
    '`[[guard-id]] ![[guard-embed]]`',
    '',
    '`soft line\n[[guard-id]] ![[guard-embed]]`',
    '',
    '$[[guard-id]] ![[guard-embed]]$',
    '',
    '$$\n[[guard-id]] ![[guard-embed]]\n$$',
    '',
    String.raw`\( [[guard-id]] ![[guard-embed]] \)`,
    '',
    String.raw`\[ [[guard-id]] ![[guard-embed]] \]`,
    '',
    String.raw`\{ \p{[[guard-id]] ![[guard-embed]]} }`,
    '',
    '## Child ^child-id',
    '%% authors: ["[[guard-id]]"] %%',
    'Body',
  ].join('\n');
  const a = parse('A.md', source);
  const visible = parse('V.md', '---\nforester-id: visible-id\n---\nBody');
  const guarded = parse('G.md', '---\nforester-id: guard-id\ntaxon: Reference\n---\nBody');
  const real = parse('R.md', '---\nforester-id: real-ref\ntaxon: Reference\n---\nBody');
  const embedded = parse('E.md', '---\nforester-id: guard-embed\n---\n[[guard-id]]');
  assert.equal(a.diagnostics.some(diagnostic => diagnostic.severity === 'error'), false);
  const graph = graphOf([a, visible, guarded, real, embedded]);
  assert.deepEqual(ids(graph.forTree(a.root.key).related), ['visible-id']);
  assert.deepEqual(ids(graph.forTree(a.root.key).references), ['real-ref']);
  assert.deepEqual(ids(graph.forTree(guarded.root.key).backlinks), ['guard-embed']);
  assert.deepEqual(graph.forTree(a.trees[1].key), empty(), 'inherited attribution strings are not body link facts');
  assert.equal(a.source, source, 'relation extraction must not mutate source or masks');
});

test('malformed frontmatter cannot contribute code examples or transcluded References', () => {
  const body = '```md\n[[Target.md]] [[Reference.md]] ![[Bridge.md]]\n```\n';
  const target = parse('Target.md', '# Target\n');
  const reference = parse('Reference.md', '---\ntaxon: Reference\n---\nReference\n');
  const bridge = parse('Bridge.md', '[[Reference.md]]\n');
  for (const [kind, source, settings] of [
    ['invalid', '---\nauthors: [\n---\n', options],
    ['valid', '---\nauthors: [Writer]\n---\n', options],
    ['excluded', '---\nauthors: [\n---\n', { ...options, excludedFolders: ['Excluded'] }],
  ]) {
    const path = kind === 'excluded' ? 'Excluded/Source.md' : 'Source.md';
    const document = core.parseHybrid(path, source + body, settings);
    const embedder = parse('Embedder.md', `![[${path}]]\n`);
    assert.equal(document.enabled, kind !== 'excluded', 'activation is scope-only, not parse success');
    assert.equal(document.diagnostics.some(diagnostic => diagnostic.code === 'invalid-frontmatter'), kind !== 'valid');
    const graph = graphOf([embedder, bridge, reference, target, document]);
    assert.deepEqual(graph.forTree(document.root.key), empty(), kind);
    assert.deepEqual(graph.forTree(target.root.key).backlinks, [], kind);
    assert.deepEqual(graph.forTree(reference.root.key).backlinks, [bridge.root], kind);
    assert.deepEqual(graph.forTree(embedder.root.key).references, [], kind);
    assert.deepEqual(graph.forTree(embedder.root.key).related, [], 'embedding never implies a direct link');
  }
});

test('semantic parse errors refuse incoming normal links and embeds as well as source reads', () => {
  const good = parse('Good.md', '[[GoodRef.md]]\n');
  const reference = parse('GoodRef.md', '---\ntaxon: Reference\n---\nReference\n');
  const source = parse('Source.md', '---\nid: legacy-warning\n---\n[[Bad.md]] ![[Bad.md]] [[Good.md]]\n');
  const embedder = parse('Embedder.md', '![[Bad.md]] ![[Good.md]]\n');
  assert.ok(source.diagnostics.some(diagnostic => diagnostic.severity === 'warning'));
  for (const [code, badSource] of [
    ['invalid-frontmatter', '---\nauthors: [\n---\n[[GoodRef.md]]\n'],
    ['invalid-frontmatter', '---\nauthors: *missing\n---\n[[GoodRef.md]]\n'],
    ['invalid-metadata', '---\ntaxon: Reference\nauthors: [42]\n---\n[[GoodRef.md]]\n'],
    ['invalid-id', '---\ntaxon: Reference\nforester-id: invalid_id\n---\n[[GoodRef.md]]\n'],
    ['unclosed-raw', '---\ntaxon: Reference\n---\n[[GoodRef.md]]\n\\{\\p{unfinished'],
    ['unclosed-math', '---\ntaxon: Reference\n---\n[[GoodRef.md]]\n$$unfinished'],
  ]) {
    const bad = parse('Bad.md', badSource);
    assert.equal(bad.enabled, true);
    assert.ok(bad.diagnostics.some(diagnostic => diagnostic.code === code && diagnostic.severity === 'error'));
    const index = core.indexHybrid([source, embedder, bad, good, reference]);
    assert.equal(core.resolveHybrid(index, 'Bad.md', source.path).status, 'resolved', 'scope/resolution alone is not semantic validity');
    Object.defineProperty(bad, 'source', { get() { throw new Error('must not scan a semantically invalid source'); } });
    const graph = relations.createTreeRelations(index, (target, path) => core.resolveHybrid(index, target, path));
    assert.deepEqual(graph.forTree(source.root.key), { backlinks: [], related: [good.root], references: [] }, code);
    assert.deepEqual(graph.forTree(bad.root.key), empty(), code);
    assert.deepEqual(graph.forTree(reference.root.key).backlinks, [good.root], code);
    assert.deepEqual(graph.forTree(embedder.root.key).references, [reference.root], code);
  }
});

for (const [kind, alias] of [
  ['code', '`literal`'],
  ['math', '$x$'],
  ['HTML comment', '<!-- literal -->'],
  ['raw Forester', String.raw`\{\p{literal}}`],
]) {
  test(`protected alias payload preserves outer direct links and embeds: ${kind}`, () => {
    const source = parse('Source.md', `## Child ^child-id\n[[Target.md|${alias}]] [[Reference.md|${alias}]] [[Target.md|${alias}]]\n`);
    const embedder = parse('Embedder.md', `![[Target.md|${alias}]]\n`);
    const target = parse('Target.md', '[[Reference.md]]\n');
    const reference = parse('Reference.md', '---\ntaxon: Reference\n---\nReference\n');
    assert.equal(source.diagnostics.some(diagnostic => diagnostic.severity === 'error'), false);
    const graph = graphOf([source, embedder, reference, target]);
    assert.deepEqual(graph.forTree(source.root.key).related, [], 'inclusive ancestor body is not a second owner');
    assert.deepEqual(graph.forTree(source.root.key).references, [reference.root]);
    assert.deepEqual(graph.forTree(source.trees[1].key).related, [target.root]);
    assert.deepEqual(graph.forTree(source.trees[1].key).references, [reference.root]);
    assert.deepEqual(graph.forTree(target.root.key).backlinks, [source.trees[1]], 'embeds do not become backlinks');
    assert.deepEqual(graph.forTree(reference.root.key).backlinks, [source.trees[1], target.root]);
    assert.deepEqual(graph.forTree(embedder.root.key), { backlinks: [], related: [], references: [reference.root] });
  });
}

test('masked alias examples and delimiters remain inert without losing the outer edge', () => {
  const target = parse('Target.md', '[[Reference.md]]\n');
  const reference = parse('Reference.md', '---\ntaxon: Reference\n---\nReference\n');
  const hidden = parse('Hidden.md', '---\ntaxon: Reference\n---\nHidden\n');
  for (const alias of [
    '`literal [[Hidden.md]] [[ unmatched`',
    '$literal [[Hidden.md]] [[ unmatched$',
    '<!-- literal ]] [[Hidden.md]] [[ unmatched -->',
    '%% literal ]] [[Hidden.md]] [[ unmatched %%',
    String.raw`\{\p{literal ]] [[Hidden.md]] [[ unmatched}}`,
    String.raw`\{\p{nested \em{]]} [[Hidden.md]] \verb|]] [[| \startverb ] ] \stopverb}}`,
    '`]]` then [[Hidden.md]] and ![[Hidden.md]]',
    String.raw`\{\p{]]}} then [[Hidden.md]] and ![[Hidden.md]]`,
  ]) {
    const source = parse('Source.md', `[[Target.md|${alias}]] ![[Target.md|${alias}]]\n`);
    assert.equal(source.diagnostics.some(diagnostic => diagnostic.severity === 'error'), false, alias);
    const index = core.indexHybrid([source, target, reference, hidden]);
    const resolutions = [];
    const graph = relations.createTreeRelations(index, (target, path) => {
      if (path === source.path) resolutions.push(target);
      return core.resolveHybrid(index, target, path);
    });
    assert.deepEqual(graph.forTree(source.root.key).related, [target.root], alias);
    assert.deepEqual(graph.forTree(source.root.key).references, [reference.root], alias);
    assert.deepEqual(graph.forTree(hidden.root.key).backlinks, [], alias);
    assert.deepEqual(resolutions, ['Target.md'], 'never resolve alias examples; normal/embed occurrences share a cache');
  }
});

test('protected targets and non-link examples cannot borrow permission from a visible alias', () => {
  const source = parse('Source.md', [
    '[[Target.md|visible]]',
    '[[`Target.md`|alias]]',
    '[[$Target.md$|alias]]',
    '[[<!-- Target.md -->|alias]]',
    '[[%% Target.md %%|alias]]',
    String.raw`[[\{\p{Target.md}}|alias]]`,
    '`[[Target.md|alias]]`',
    '$[[Target.md|alias]]$',
    '<!-- [[Target.md|alias]] -->',
    String.raw`\{\p{[[Target.md|alias]]}}`,
    '> [[Target.md|alias]]',
    '',
    '```md\n[[Target.md|alias]]\n```',
  ].join('\n\n'));
  const target = parse('Target.md', '# Target\n');
  const index = core.indexHybrid([source, target]);
  const resolutions = [];
  const graph = relations.createTreeRelations(index, (text, path) => {
    resolutions.push([text, path]);
    // Even a permissive adapter must not make a masked target a fact.
    return { status: 'resolved', tree: target.root, document: target };
  });
  assert.deepEqual(resolutions, [['Target.md', source.path]]);
  assert.deepEqual(graph.forTree(source.root.key).related, [target.root]);
  assert.deepEqual(graph.forTree(target.root.key).backlinks, [source.root]);
});

test('multiline or unclosed aliases never promote their payload to independent facts', () => {
  const target = parse('Target.md', '# Target\n');
  const hidden = parse('Hidden.md', '---\ntaxon: Reference\n---\nHidden\n');
  const after = parse('After.md', '# After\n');
  for (const newline of ['\n', '\r\n']) for (const body of [
    '[[Target.md|`literal\ncode` [[Hidden.md]]]] [[After.md]]',
    '[[Target.md|$literal\nmath$ [[Hidden.md]]]] [[After.md]]',
    '[[Target.md|<!-- literal\ncomment --> [[Hidden.md]]]] [[After.md]]',
    '[[Target.md|\\{\\p{literal ]]\nraw}} [[Hidden.md]]]] [[After.md]]',
    '[[Target.md|literal\n[[Hidden.md]]]] [[After.md]]',
    '[[Target.md|`literal\ncode` [[Hidden.md]]\n\n[[After.md]]',
    '[[Target.md|literal\n[[Hidden.md]]\n\n[[After.md]]',
    '[[Target.md|literal\n[[Hidden.md]]\n# New block\n[[After.md]]',
    '[[Target.md|literal\n[[Hidden.md]]\n***\n[[After.md]]',
    '[[Target.md|literal\n[[Hidden.md]]\n```md\n[[Hidden.md]]\n```\n[[After.md]]',
  ]) {
    const source = parse('Source.md', body.replaceAll('\n', newline));
    assert.equal(source.diagnostics.some(diagnostic => diagnostic.severity === 'error'), false, body);
    const index = core.indexHybrid([source, target, hidden, after]);
    const resolutions = [];
    const graph = relations.createTreeRelations(index, (text, path) => {
      resolutions.push(text);
      return core.resolveHybrid(index, text, path);
    });
    assert.deepEqual(graph.forTree(source.root.key).related, [after.root], body);
    assert.deepEqual(graph.forTree(source.root.key).references, [], body);
    assert.deepEqual(graph.forTree(target.root.key).backlinks, [], body);
    assert.deepEqual(graph.forTree(hidden.root.key).backlinks, [], body);
    assert.deepEqual(resolutions, ['After.md'], 'reject the malformed outer link but consume its inert alias');
  }
});

test('opaque masks cannot license partly protected wikilink delimiters or targets', () => {
  const target = parse('Target.md', '# Target\n');
  const hidden = parse('Hidden.md', '---\ntaxon: Reference\n---\nHidden\n');
  const after = parse('After.md', '# After\n');
  for (const [body, protectedText, offset, length, outerAllowed] of [
    ['[[Target.md|opaque ]] [[Hidden.md]]]] [[After.md]]', 'opaque ]] [[Hidden.md]]', 0, undefined, true],
    ['[[Target.md|opaque]] [[Hidden.md]]\n\n[[After.md]]', ']]', 0, 1, false],
    ['[[Target.md|opaque]] [[Hidden.md]]\n\n[[After.md]]', ']]', 1, 1, false],
    ['[[Target.md|opaque]] [[After.md]]', 'Target.md', 2, 1, false],
    ['![[Target.md|opaque]] [[After.md]]', '[[', 0, 1, false],
    ['![[Target.md|opaque]] [[After.md]]', '[[', 1, 1, false],
    ['[[Target.md|opaque]] [[After.md]]', '|', 0, 1, false],
  ]) {
    const source = parse('Source.md', body);
    const from = body.indexOf(protectedText) + offset;
    const mask = Object.freeze({ from, to: from + (length ?? protectedText.length) });
    source.protectedRanges = Object.freeze([mask]);
    const graph = graphOf([source, target, hidden, after]);
    assert.deepEqual(graph.forTree(source.root.key).related, outerAllowed ? [after.root, target.root] : [after.root], body);
    assert.deepEqual(graph.forTree(source.root.key).references, [], body);
    assert.deepEqual(graph.forTree(hidden.root.key).backlinks, [], 'unknown masks do not permit alias examples to escape');
    assert.deepEqual(source.protectedRanges, [mask], 'union/lexing must not mutate input masks');
  }
});

test('stale identity entries and same-key resolver snapshots stay fail closed with inert aliases', () => {
  const source = parse('Source.md', '[[stale-id|`literal`]] ![[stale-id|$x$]] [[missing-id|<!-- literal -->]] ![[missing-id]] [[ambiguous-id]] ![[ambiguous-id]] [[foreign-document]] ![[foreign-document]] [[Target.md|`literal`]] ![[Target.md|`literal`]]\n');
  const old = parse('Target.md', '---\nforester-id: stale-id\n---\n[[Reference.md]]\n');
  const current = parse('Target.md', '[[Reference.md]]\n');
  const reference = parse('Reference.md', '---\ntaxon: Reference\n---\nReference\n');
  const index = core.indexHybrid([source, current, reference]);
  index.ids.set('stale-id', [old.root]);
  assert.equal(core.resolveHybrid(index, 'stale-id', source.path).status, 'resolved', 'a stale ID map can return a same-path foreign tree');
  const calls = new Map();
  const graph = relations.createTreeRelations(index, (target, path) => {
    if (path === source.path) calls.set(target, (calls.get(target) ?? 0) + 1);
    if (target === 'ambiguous-id') return { status: 'ambiguous', message: 'not unique' };
    if (target === 'foreign-document') return { status: 'resolved', tree: current.root, document: old };
    return core.resolveHybrid(index, target, path);
  });
  assert.deepEqual(graph.forTree(source.root.key), { backlinks: [], related: [current.root], references: [reference.root] });
  assert.deepEqual(graph.forTree(current.root.key).backlinks, [source.root]);
  assert.deepEqual(graph.forTree(reference.root.key).backlinks, [current.root]);
  assert.deepEqual([...calls], [['stale-id', 1], ['missing-id', 1], ['ambiguous-id', 1], ['foreign-document', 1], ['Target.md', 1]]);
});

test('wikilink lexing respects source escapes and treats labels as inert payloads', () => {
  const source = [
    '---', 'forester-id: source-id', '---',
    // The shared parser also recognizes \[ as display math. Close that
    // conservative guard so an escaped opener cannot protect later controls.
    String.raw`\[[escaped-id]] \] \![[escaped-embed]] \\\[[escaped-id]] \]`,
    String.raw`\\[[visible-id]]`,
    '[[labelled-id|manual [[label-canary]] and [[second-canary]]]]',
    String.raw`[[close-id|escaped \]] [[label-canary]] and more]]`,
    '[[labelled-id|]]',
    '{ref:[[real-ref|Author, 2022]]}',
    String.raw`[[Target#Title\|Pipe|shown]]`,
    '[[missing [[label-canary]]',
    '[[unterminated',
    '[[after-id]]',
  ].join('\n');
  const a = parse('A.md', source);
  const normalIds = ['escaped-id', 'visible-id', 'labelled-id', 'close-id', 'label-canary', 'second-canary', 'after-id'];
  const documents = normalIds.map((id, i) => parse(`T${i}.md`, `---\nforester-id: ${id}\n---\nBody`));
  const ref = parse('R.md', '---\nforester-id: real-ref\ntaxon: Reference\n---\nBody');
  const rogue = parse('RR.md', '---\nforester-id: embedded-ref\ntaxon: Reference\n---\nBody');
  const embedded = parse('E.md', '---\nforester-id: escaped-embed\n---\n[[embedded-ref]]');
  const index = core.indexHybrid([a, ref, rogue, embedded, ...documents]);
  const targets = [];
  const graph = relations.createTreeRelations(index, (target, fromPath) => {
    targets.push(target);
    return core.resolveHybrid(index, target, fromPath);
  });
  assert.deepEqual(ids(graph.forTree(a.root.key).related), ['visible-id', 'labelled-id', 'close-id', 'after-id']);
  assert.deepEqual(ids(graph.forTree(a.root.key).references), ['real-ref']);
  assert.deepEqual(graph.forTree(documents[0].root.key).backlinks, []);
  assert.deepEqual(graph.forTree(documents[4].root.key).backlinks, []);
  assert.deepEqual(graph.forTree(documents[5].root.key).backlinks, []);
  assert.ok(targets.includes(String.raw`Target#Title\|Pipe`), 'preserve the raw target for the shared resolver; do not guess by unescaping');
  assert.equal(targets.some(target => target.includes('canary')), false, 'never parse nested label examples as independent links');
});

test('ambiguous identities and disabled or foreign documents never create guessed edges', () => {
  const source = parse('S.md', '---\nforester-id: source-id\n---\n[[duplicate]] ![[duplicate]] [[A#^duplicate]] [[H#Repeat]] ![[H#Repeat]] [[missing-id]] [[ordinary-id]] ![[ordinary-id]] [[Excluded/Ordinary.md]] ![[Excluded/Ordinary.md]] [[A.md]] [[spoofed]]');
  const a = parse('A.md', '---\nforester-id: DUPLICATE\ntaxon: Reference\n---\nBody');
  const b = parse('B.md', '## Duplicate ^duplicate\nBody');
  const h = parse('H.md', '## Repeat ^h1\nBody\n## Repeat ^h2\nBody');
  const ordinary = core.parseHybrid('Excluded/Ordinary.md', '---\nforester-mode: false\nforester-id: ordinary-id\n---\n[[DUPLICATE]]', { ...options, excludedFolders: ['Excluded'] });
  const foreign = parse('Foreign.md', '---\nforester-id: foreign-id\n---\nBody');
  const index = core.indexHybrid([source, a, b, h, ordinary]);
  assert.ok(index.diagnostics.some(diagnostic => diagnostic.code === 'duplicate-id'));
  assert.equal(ordinary.enabled, false);
  Object.defineProperty(ordinary, 'source', { get() { throw new Error('must not scan disabled Markdown'); } });
  const graph = relations.createTreeRelations(index, (target, fromPath) => {
    // An adapter must not be able to import facts from a foreign graph snapshot.
    if (target === 'spoofed') return { status: 'resolved', tree: h.trees[1], document: foreign };
    return core.resolveHybrid(index, target, fromPath);
  });
  assert.deepEqual(graph.forTree(source.root.key).related, []);
  assert.deepEqual(graph.forTree(source.root.key).references, [a.root], 'explicit file identity is not a guessed duplicate-ID match');
  assert.deepEqual(graph.forTree(a.root.key).backlinks, [source.root]);
  assert.deepEqual(graph.forTree(b.trees[1].key).backlinks, []);
  assert.deepEqual(graph.forTree(h.trees[1].key).backlinks, []);
  assert.deepEqual(graph.forTree(h.trees[2].key).backlinks, []);
  assert.deepEqual(graph.forTree(ordinary.root.key), empty());
  assert.deepEqual(graph.forTree(foreign.root.key), empty());
});

test('one snapshot scan and per-tree query caches bound repeated relation work', () => {
  const a = parse('A.md', '---\nforester-id: a-id\n---\n' + '[[b-id]] ![[b-id]] [[missing-id]] ![[missing-id]]\n'.repeat(64));
  const b = parse('B.md', '---\nforester-id: b-id\n---\n[[ref-id]] ![[a-id]]');
  const ref = parse('R.md', '---\nforester-id: ref-id\ntaxon: Reference\n---\nBody');
  const documents = [a, b, ref];
  const index = core.indexHybrid(documents);
  let sourceReads = 0, taxonReads = 0;
  for (const document of documents) {
    const source = document.source;
    Object.defineProperty(document, 'source', { get() { sourceReads++; return source; } });
    const taxon = document.root.meta.taxon;
    Object.defineProperty(document.root.meta, 'taxon', { get() { taxonReads++; return taxon; } });
  }
  const resolutions = new Map();
  const graph = relations.createTreeRelations(index, (target, fromPath) => {
    const key = `${fromPath}\0${target}`;
    resolutions.set(key, (resolutions.get(key) ?? 0) + 1);
    return core.resolveHybrid(index, target, fromPath);
  });
  assert.equal(sourceReads, documents.length, 'read each enabled source once, never reparse through the factory');
  assert.equal(resolutions.size, 4);
  assert.ok([...resolutions.values()].every(count => count === 1), 'memoize resolved and missing targets per source path');
  for (const document of documents) graph.forTree(document.root.key);
  const warmTaxonReads = taxonReads;
  for (let i = 0; i < 1000; i++) {
    assert.deepEqual(ids(graph.forTree(a.root.key).references), ['ref-id']);
    assert.deepEqual(ids(graph.forTree(a.root.key).related), ['b-id']);
  }
  assert.equal(taxonReads, warmTaxonReads, 'repeat tab queries must not traverse the closure or refilter graph nodes');
  assert.equal(sourceReads, documents.length, 'forTree must never reread Markdown');
  assert.ok([...resolutions.values()].every(count => count === 1), 'forTree must never re-resolve targets');
  const returned = graph.forTree(a.root.key);
  returned.related.length = 0;
  returned.references.push(a.root);
  returned.backlinks.push(ref.root);
  assert.deepEqual(ids(graph.forTree(a.root.key).related), ['b-id'], 'caller array edits cannot poison cached results');
  assert.deepEqual(ids(graph.forTree(a.root.key).references), ['ref-id']);
  assert.deepEqual(graph.forTree(a.root.key).backlinks, [], 'transclusion cycles still are not backlinks');
});

test('deduplicated results have deterministic literal-path and numeric-source order', () => {
  const source = parse('S.md', '---\nforester-id: source-id\n---\n[[B#Second]] [[B.md]] [[B#First]] [[first-id]] [[B#^first-id]]');
  const b = parse('B.md', '# B\n## First ^first-id\n' + 'padding '.repeat(20) + '\n## Second ^second-id\nBody');
  const graph = graphOf([source, b]);
  assert.deepEqual(ids(graph.forTree(source.root.key).related), [b.root.key, 'first-id', 'second-id']);
  const reversed = graphOf([b, source]);
  assert.deepEqual(reversed.forTree(source.root.key), graph.forTree(source.root.key));
  assert.deepEqual(graph.forTree(b.trees[1].key).backlinks, [source.root]);
});

// Focused synthetic regressions for the lexer/closure established by the TDD
// slices above. These must also hold when parser/save implementations evolve.
test('saved semantic-title aliases cannot generate extra graph edges', () => {
  for (const title of [
    '[[canary-id]] and ![[canary-id]]',
    '`code` $$ %% \\{ raw } and \\(math\\)',
    'A | B &amp; &#91;&#91;canary-id&#93;&#93; <tag> \\',
    '日本語 🌳 [[canary-id]]\n## Not a tree',
  ]) {
    const a = parse('Source.md', '---\nforester-id: source-id\n---\n[[target-id]]');
    const target = parse('Target.md', `---\nforester-id: target-id\ntitle: ${JSON.stringify(title)}\n---\nBody`);
    const canary = parse('Canary.md', '---\nforester-id: canary-id\ntaxon: Reference\n---\nBody');
    const index = core.indexHybrid([a, target, canary]);
    const saved = core.planHybridSave(index, a.path, () => { throw new Error('fixture identities are already assigned'); });
    assert.equal(saved.diagnostics.some(diagnostic => diagnostic.severity === 'error'), false);
    assert.equal(saved.edits.length, 1);
    const reparsed = parse(a.path, saved.edits[0].after);
    assert.equal(reparsed.trees.length, 1, 'title alias may not create headings');
    assert.equal(reparsed.diagnostics.some(diagnostic => diagnostic.severity === 'error'), false);
    const graph = graphOf([reparsed, target, canary]);
    assert.deepEqual(graph.forTree(reparsed.root.key).related, [target.root]);
    assert.deepEqual(graph.forTree(reparsed.root.key).references, []);
    assert.deepEqual(graph.forTree(canary.root.key).backlinks, []);
  }
});

test('normal links never participate in the References transclusion closure', () => {
  const a = parse('A.md', '---\nforester-id: a-id\n---\n[[b-id]]');
  const b = parse('B.md', '---\nforester-id: b-id\n---\n[[ref-id]]');
  const ref = parse('R.md', '---\nforester-id: ref-id\ntaxon: Reference\n---\nBody');
  const graph = graphOf([a, b, ref]);
  assert.deepEqual(graph.forTree(a.root.key).references, []);
  assert.deepEqual(graph.forTree(b.root.key).references, [ref.root]);
  assert.deepEqual(graph.forTree(ref.root.key).backlinks, [b.root]);
});

test('native direct queries retain explicit self-links without looping', () => {
  const normal = parse('N.md', '---\nforester-id: normal-id\n---\n[[normal-id]] ![[normal-id]]');
  const ref = parse('R.md', '---\nforester-id: ref-id\ntaxon: Reference\n---\n[[ref-id]] ![[ref-id]]');
  const graph = graphOf([normal, ref]);
  assert.deepEqual(graph.forTree(normal.root.key), { backlinks: [normal.root], related: [normal.root], references: [] });
  assert.deepEqual(graph.forTree(ref.root.key), { backlinks: [ref.root], related: [], references: [ref.root] });
});

test('anonymous nested sections keep unique owners and still aggregate References', () => {
  const a = parse('A.md', '# Root\n## Anonymous\n[[ref-id]]\n### Deep anonymous\n[[ref-id]]');
  const embedder = parse('E.md', '![[A#Anonymous]]');
  const ref = parse('R.md', '---\nforester-id: ref-id\ntaxon: Reference\n---\nBody');
  const graph = graphOf([a, embedder, ref]);
  for (const tree of a.trees) assert.deepEqual(graph.forTree(tree.key).references, [ref.root]);
  assert.deepEqual(graph.forTree(embedder.root.key).references, [ref.root]);
  assert.deepEqual(graph.forTree(ref.root.key).backlinks, a.trees.slice(1));
  assert.deepEqual(graph.forTree(a.trees[1].key).backlinks, [], 'anonymous containment/embedding is transclusion only');
});

test('relative-target resolution caches are isolated by their defining source path', () => {
  const a = parse('one/Source.md', '[[./Target.md]] [[./Target.md|label]]');
  const b = parse('two/Source.md', '[[./Target.md]] [[./Target.md|]]');
  const at = parse('one/Target.md', '---\nforester-id: one-target\n---\nBody');
  const bt = parse('two/Target.md', '---\nforester-id: two-target\n---\nBody');
  const graph = graphOf([bt, a, at, b]);
  assert.deepEqual(graph.forTree(a.root.key).related, [at.root]);
  assert.deepEqual(graph.forTree(b.root.key).related, [bt.root]);
  assert.deepEqual(graph.forTree(at.root.key).backlinks, [a.root]);
  assert.deepEqual(graph.forTree(bt.root.key).backlinks, [b.root]);
});

test('file/alias identity collisions remain ambiguous even when one document is excluded', () => {
  const a = parse('Source.md', '[[same]] [[topic]] ![[same]] ![[topic]]');
  const target = parse('Target.md', '---\nforester-id: same\n---\n## Topic ^topic\nBody');
  const ordinary = core.parseHybrid('Excluded/same.md', '---\nforester-mode: false\naliases: [topic]\n---\nBody', { ...options, excludedFolders: ['Excluded'] });
  const index = core.indexHybrid([a, target, ordinary]);
  assert.equal(core.resolveHybrid(index, 'same', a.path).status, 'ambiguous');
  assert.equal(core.resolveHybrid(index, 'topic', a.path).status, 'ambiguous');
  const graph = relations.createTreeRelations(index, (target, path) => core.resolveHybrid(index, target, path));
  assert.deepEqual(graph.forTree(a.root.key), empty());
  assert.deepEqual(graph.forTree(target.root.key).backlinks, []);
  assert.deepEqual(graph.forTree(target.trees[1].key).backlinks, []);
});

test('metadata ranges independently guard relations without changing parser-owned ranges', () => {
  const a = parse('A.md', '---\nforester-id: a-id\nauthors: ["[[ref-id]]"]\n---\n## Child ^child-id\n%% authors: ["[[ref-id]]"] %%\nBody');
  const ref = parse('R.md', '---\nforester-id: ref-id\ntaxon: Reference\n---\nBody');
  // The contract exposes metadata masks separately: a caller need not duplicate
  // them in protectedRanges. Keep their actual parser-produced source offsets.
  a.protectedRanges = [];
  for (const tree of a.trees) {
    for (const range of tree.metadataRanges) Object.freeze(range);
    Object.freeze(tree.metadataRanges);
  }
  const before = JSON.stringify(a);
  const graph = graphOf([a, ref]);
  assert.deepEqual(graph.forTree(a.root.key).references, []);
  assert.deepEqual(graph.forTree(ref.root.key).backlinks, []);
  assert.equal(JSON.stringify(a), before);
  assert.deepEqual(Object.keys(graph), ['forTree']);
  assert.deepEqual(Object.keys(graph.forTree(a.root.key)).sort(), ['backlinks', 'references', 'related']);
});

test('Reference classification uses the parser taxon, not guessed bibliography/metadata', () => {
  const a = parse('A.md', '[[canonical]] [[lowercase]] [[custom]]');
  const canonical = parse('Canonical.md', '---\nforester-id: canonical\n---\n#rEf\n\nBody');
  const lowercase = parse('Lowercase.md', '---\nforester-id: lowercase\ntaxon: reference\ncitation-authors: [Author]\npublication-year: 2022\n---\nBody');
  const custom = parse('Custom.md', '---\nforester-id: custom\ntaxon: Bibliography\n---\nBody');
  const graph = graphOf([a, canonical, lowercase, custom]);
  assert.deepEqual(graph.forTree(a.root.key).references, [canonical.root]);
  assert.deepEqual(graph.forTree(a.root.key).related, [custom.root, lowercase.root]);
});

test('1000 synthetic notes stay bounded through cycles and 10000 cached tab queries', context => {
  const script = `
    import { performance } from 'node:perf_hooks';
    import { parseHybrid, indexHybrid, resolveHybrid } from ${JSON.stringify(new URL('hybrid-core.mjs', build).href)};
    import { createTreeRelations } from ${JSON.stringify(new URL('hybrid-relations.mjs', build).href)};
    const options = { folders: ['/'], excludedFolders: ['Excluded'], publicFolders: [], reservedIds: [] };
    const count = 998, documents = [], started = performance.now();
    let bytes = 0, sourceReads = 0, disabledReads = 0, resolverCalls = 0;
    for (let i = 0; i < count; i++) {
      let source = '---\\nforester-id: n-' + i + '\\n---\\n![[n-' + ((i + 1) % count) + ']] ![[n-' + ((i + 1) % count) + ']] [[n-' + ((i + 1) % count) + ']]\\n' +
        '\\n\u0060[[ref-id]]\u0060\\n%% [[ref-id]] %%\\n## Section ^s-' + i + '\\n{ref:[[ref-id]]}\\n';
      if (i % 2) source = source.replace(/\\n/g, '\\r\\n');
      bytes += source.length;
      documents.push(parseHybrid('synthetic/N' + String(i).padStart(4, '0') + '.md', source, options));
    }
    documents.push(parseHybrid('synthetic/Reference.md', '---\\nforester-id: ref-id\\ntaxon: Reference\\n---\\n[[ref-id]]', options));
    documents.push(parseHybrid('Excluded/Blocked.md', '---\\nforester-mode: false\\n---\\n[[ref-id]]', options));
    const index = indexHybrid(documents), indexed = performance.now();
    for (const document of documents) {
      const source = document.source;
      Object.defineProperty(document, 'source', { get() {
        if (!document.enabled) { disabledReads++; throw new Error('disabled source scanned'); }
        sourceReads++; return source;
      } });
    }
    const buildStarted = performance.now();
    const graph = createTreeRelations(index, (target, path) => { resolverCalls++; return resolveHybrid(index, target, path); });
    const built = performance.now(), first = graph.forTree(documents[0].root.key), cold = performance.now();
    if (first.references.length !== 1 || first.references[0].id !== 'ref-id' ||
      first.related.length !== 1 || first.related[0].id !== 'n-1' ||
      first.backlinks.length !== 1 || first.backlinks[0].id !== 'n-' + (count - 1)) throw new Error('incorrect cyclic graph facts');
    const callsAfterBuild = resolverCalls, readsAfterBuild = sourceReads, warmQueries = 10000;
    for (let i = 0; i < warmQueries; i++) graph.forTree(documents[0].root.key);
    const warm = performance.now();
    const referenceBacklinks = graph.forTree(documents[count].root.key).backlinks.length;
    if (resolverCalls !== callsAfterBuild || sourceReads !== readsAfterBuild) throw new Error('cached tab queries rescanned the graph');
    console.log(JSON.stringify({
      notes: documents.length, enabledTrees: documents.filter(d => d.enabled).reduce((sum, d) => sum + d.trees.length, 0),
      bytes, sourceReads, disabledReads, resolverCalls, referenceBacklinks, warmQueries,
      parseIndexMs: indexed - started, buildMs: built - buildStarted, coldQueryMs: cold - built, warmQueryMs: warm - cold,
      heapUsedMiB: process.memoryUsage().heapUsed / (1024 * 1024)
    }));
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  });
  assert.equal(child.error, undefined, `bounded synthetic probe failed: ${child.error}`);
  assert.equal(child.signal, null, `bounded synthetic probe was terminated: ${child.signal}`);
  assert.equal(child.status, 0, child.stderr);
  const metrics = JSON.parse(child.stdout.trim());
  assert.equal(metrics.notes, 1000);
  assert.equal(metrics.enabledTrees, 1997);
  assert.equal(metrics.sourceReads, 999);
  assert.equal(metrics.disabledReads, 0);
  assert.equal(metrics.resolverCalls, 1997);
  assert.equal(metrics.referenceBacklinks, 999, 'masked root examples cannot create backlinks');
  assert.equal(metrics.warmQueries, 10000);
  context.diagnostic(JSON.stringify({ syntheticProbe: metrics }));
});

test('long escapes, nested labels and unmatched openers scan in a bounded child', context => {
  const script = `
    import { performance } from 'node:perf_hooks';
    import { parseHybrid, indexHybrid, resolveHybrid } from ${JSON.stringify(new URL('hybrid-core.mjs', build).href)};
    import { createTreeRelations } from ${JSON.stringify(new URL('hybrid-relations.mjs', build).href)};
    const options = { folders: ['/'], publicFolders: [], reservedIds: [] }, start = performance.now();
    const slash = String.fromCharCode(92), tick = String.fromCharCode(96);
    const source = '---\\nforester-id: source-id\\n---\\n' + slash.repeat(40000) + '[[visible-id]]\\n\\n' +
      '[['.repeat(20000) + '\\n[[visible-id]]\\n\\n[[visible-id|' + '[[ghost-id]]'.repeat(10000) + ']]\\n\\n' +
      (tick + '[[ghost-id]]' + tick + ' [[visible-id]] ').repeat(10000);
    const a = parseHybrid('A.md', source, options);
    const visible = parseHybrid('V.md', '---\\nforester-id: visible-id\\n---\\nBody', options);
    const ghost = parseHybrid('G.md', '---\\nforester-id: ghost-id\\n---\\nBody', options);
    const index = indexHybrid([a, visible, ghost]), parsed = performance.now();
    let resolverCalls = 0;
    const graph = createTreeRelations(index, (target, path) => { resolverCalls++; return resolveHybrid(index, target, path); });
    const built = performance.now(), result = graph.forTree(a.root.key);
    if (result.related.length !== 1 || result.related[0] !== visible.root || result.references.length ||
      graph.forTree(ghost.root.key).backlinks.length) throw new Error('literal examples escaped into graph facts');
    console.log(JSON.stringify({ sourceLength: source.length, protectedRanges: a.protectedRanges.length,
      resolverCalls, parseIndexMs: parsed - start, buildMs: built - parsed }));
  `;
  const child = spawnSync(process.execPath, ['--max-old-space-size=128', '--input-type=module', '--eval', script], {
    encoding: 'utf8', timeout: 15000, maxBuffer: 65536,
  });
  assert.equal(child.error, undefined, `bounded lexer probe failed: ${child.error}`);
  assert.equal(child.signal, null, `bounded lexer probe was terminated: ${child.signal}`);
  assert.equal(child.status, 0, child.stderr);
  const metrics = JSON.parse(child.stdout.trim());
  assert.equal(metrics.resolverCalls, 1, 'only one exact active target should reach the resolver');
  assert.ok(metrics.sourceLength > 400000);
  assert.equal(metrics.protectedRanges, 10001);
  context.diagnostic(JSON.stringify({ lexerProbe: metrics }));
});
