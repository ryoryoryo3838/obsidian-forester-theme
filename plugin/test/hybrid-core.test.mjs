import test from 'node:test';
import assert from 'node:assert/strict';

// The first RED is an availability assertion, not a missing-import crash.
const core = await import('./build/hybrid-core.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND') return {};
  throw error;
});
const options = (overrides = {}) => ({ folders: [], publicFolders: [], reservedIds: [], ...overrides });
const parse = (source, path = 'hybrid/Note.md', overrides = { folders: ['hybrid'] }) =>
  core.parseHybrid(path, source, options(overrides));

test('ordinary Markdown is active and private by default without source changes', () => {
  assert.equal(typeof core.parseHybrid, 'function');
  const source = '# Title\n## Child ^abc\n#Ref\n';
  const doc = core.parseHybrid('Note.md', source, options());
  assert.equal(doc.enabled, true);
  assert.equal(core.hybridModeEnabled(doc.path, source, options()), true);
  assert.equal(doc.source, source);
  assert.equal(doc.root.id, undefined);
  assert.equal(doc.trees.length, 2);
  assert.equal(doc.trees[1].id, 'abc');
  assert.ok(doc.trees.every(tree => tree.meta.publish === false));
});

test('path exclusions alone control activation with normalized descendant boundaries and case-sensitive folders', () => {
  const opt = options({folders: ['Legacy'], excludedFolders: ['/Ignored/../Private//', './Drafts/'], publicFolders: ['/']});
  for (const [path, enabled] of [
    ['Elsewhere.md', true], ['hybridish/Note.md', true], ['Private/Note.md', false],
    ['Other/../Private/Note.md', false], ['Private/Nested/Note.md', false],
    ['Privateish/Note.md', true], ['private/Note.md', true], ['Drafts/Note.md', false],
    ['Note.MD', true], ['Note.txt', false], ['Legacy/Note.tree', false],
  ]) {
    const doc = core.parseHybrid(path, '## Child\n', opt);
    assert.equal(doc.enabled, enabled, path);
    assert.equal(core.hybridModeEnabled(path, doc.source, opt), enabled, path);
    if (!enabled) {
      assert.equal(doc.trees.length, 1);
      assert.equal(doc.root.meta.publish, false, 'public-folder settings cannot override exclusions');
    }
  }
  assert.equal(parse('## Child', 'Elsewhere.md', {excludedFolders: ['/']}).enabled, false);
  assert.equal(parse('## Child', 'Elsewhere.md', {excludedFolders: ['', './', 'Empty/../']}).enabled, true);
  for (const mode of ['hybrid-v1', 'hybrid-v0', 'true', 'false', '"false"', 'unknown']) {
    const source = `---\nforester-mode: ${mode}\n---\n## Child\n`;
    const doc = parse(source, 'Elsewhere.md', {});
    assert.equal(doc.enabled, true, mode);
    assert.equal(core.hybridModeEnabled(doc.path, source, options()), true, mode);
    assert.equal(doc.source, source);
    assert.ok(Object.hasOwn(doc.frontmatter, 'forester-mode'));
    assert.ok(!doc.diagnostics.some(diagnostic => diagnostic.code === 'invalid-mode'));
    assert.equal(parse(source, 'Excluded/Note.md', {excludedFolders: ['Excluded'], publicFolders: ['/']}).enabled, false);
  }
});

test('syntax diagnostics do not change path activation and still refuse saves and public metadata', () => {
  for (const source of ['---\npublish: true\nauthors: [\n---\n## Child\n', '---\npublish: true\n', '---\nforester-mode: *missing\n---\n']) {
    for (const excluded of [false, true]) {
      const opt = options({excludedFolders: excluded ? ['/'] : [], publicFolders: ['/']});
      const doc = core.parseHybrid('Note.md', source, opt);
      assert.equal(doc.enabled, !excluded);
      assert.equal(core.hybridModeEnabled(doc.path, source, opt), !excluded);
      assert.equal(doc.root.meta.publish, false);
      assert.equal(doc.root.meta.publicTitle, false);
      assert.equal(doc.source, source);
      assert.ok(doc.diagnostics.some(d => d.code === 'invalid-frontmatter' && d.severity === 'error'));
      const plan = core.planHybridSave(core.indexHybrid([doc]), doc.path, () => { throw new Error('syntax preflight must refuse before drawing'); });
      assert.deepEqual(plan.edits, []);
      assert.ok(plan.diagnostics.some(d => d.code === 'invalid-frontmatter'));
    }
  }
});



test('root uses forester-id only and title priority is frontmatter, H1, then filename', () => {
  const fm = parse('---\nforester-id: my-ROOT\ntitle: YAML title\nid: legacy\n---\n# H1 title\n');
  assert.equal(fm.root.id, 'my-ROOT');
  assert.equal(fm.root.meta.title, 'YAML title');
  assert.equal(fm.root.contentFrom, fm.source.length);
  assert.ok(fm.diagnostics.some(d => d.code === 'legacy-id'));
  const h1 = parse('---\nid: legacy\n---\n# Heading title\nBody');
  assert.equal(h1.root.id, undefined);
  assert.equal(h1.root.meta.title, 'Heading title');
  assert.equal(parse('Body', 'hybrid/日本語.md').root.meta.title, '日本語');
  const bad = parse('---\nforester-id: "bad id"\n---\n');
  assert.equal(bad.root.id, undefined);
  assert.ok(bad.diagnostics.some(d => d.code === 'invalid-id' && d.severity === 'error'));
});

test('H2-H6 form flattened nested trees with exact JS offsets and exclusive line ranges', () => {
  const source = '# Root\r\n😀 intro\r\n## A ^custom-ID\r\nA body\r\n#### Deep ^deep\r\nDeep body\r\n## B\r\nB body\r\n# New root section\r\nTail';
  const doc = parse(source);
  assert.deepEqual(doc.trees.map(t => t.meta.title), ['Root', 'A', 'Deep', 'B']);
  const [root, a, deep, b] = doc.trees;
  assert.equal(a.id, 'custom-ID');
  assert.equal(deep.id, 'deep');
  assert.equal(a.from, source.indexOf('## A'));
  assert.equal(a.contentFrom, source.indexOf('A body'));
  assert.equal(a.to, source.indexOf('## B'));
  assert.equal(deep.to, a.to);
  assert.equal(b.to, source.indexOf('# New root section'));
  assert.deepEqual([a.line, a.endLine, deep.line, deep.endLine, b.line, b.endLine], [2, 6, 4, 6, 6, 8]);
  assert.equal(root.to, source.length);
  assert.equal(root.endLine, 10);
  assert.equal(deep.parentKey, a.key);
  assert.deepEqual(root.children.map(t => t.key), [a.key, b.key]);
  assert.deepEqual(a.children.map(t => t.key), [deep.key]);
  assert.deepEqual(doc.trees.map(t => t.number), ['', '1', '1.1', '2']);
});

test('metadata comments add inherited authors/dates while citation fields stay independent', () => {
  const source = '---\nforester-id: ROOT\nauthors: [Alice]\ndates: [2026-10-04]\ncitation-authors: [Cite]\npublication-year: 2020\ncontributors: [Keep]\n---\n# Root\n%% forester\nauthors: [Bob]\ndates: [2025]\n%%\n## Parent\n%% authors: [Carol], dates: [2024], taxon: Lemma %%\nP\n### Child\n%% forester\nauthors: Dana\ncitation-authors: [Other]\npublication-year: "2022"\ncontributors: [Untouched]\n%%\nC';
  const doc = parse(source);
  const [root, parent, child] = doc.trees;
  assert.deepEqual(root.meta.authors, ['Alice', 'Bob']);
  assert.deepEqual(parent.meta.authors, ['Alice', 'Bob', 'Carol']);
  assert.deepEqual(child.meta.authors, ['Alice', 'Bob', 'Carol', 'Dana']);
  assert.deepEqual(child.meta.dates, ['2026-10-04', '2025', '2024']);
  assert.deepEqual(root.meta.citationAuthors, ['Cite']);
  assert.equal(root.meta.publicationYear, '2020');
  assert.deepEqual(parent.meta.citationAuthors, []);
  assert.equal(parent.meta.publicationYear, undefined);
  assert.deepEqual(child.meta.citationAuthors, ['Other']);
  assert.equal(child.meta.publicationYear, '2022');
  assert.equal(parent.meta.taxon, 'Lemma');
  assert.equal(source.slice(parent.contentFrom, parent.contentFrom + 1), 'P');
  assert.equal(source.slice(child.contentFrom, child.contentFrom + 1), 'C');
  assert.ok(child.metadataRanges.some(r => source.slice(r.from, r.to).includes('contributors: [Untouched]')));
  assert.deepEqual(doc.frontmatter.contributors, ['Keep']);
  assert.equal(doc.source, source);
});

test('publication permissions fail closed and only publish inherits, not public-title', () => {
  const doc = parse('---\npublish: false\npublic-title: true\n---\n# R\n## Public exception\n%% publish: true %%\n### Inherit\nBody\n## Bad bool\n%% publish: "false", public-title: "true" %%\n', 'hybrid/P.md', { folders: ['hybrid'], publicFolders: ['hybrid'] });
  assert.equal(doc.root.meta.publish, false);
  assert.equal(doc.root.meta.publicTitle, true);
  assert.equal(doc.trees[1].meta.publish, true);
  assert.equal(doc.trees[2].meta.publish, true);
  assert.equal(doc.trees[1].meta.publicTitle, false);
  assert.equal(doc.trees[2].meta.publicTitle, false);
  assert.equal(doc.trees[3].meta.publish, false);
  assert.equal(doc.trees[3].meta.publicTitle, false);
  assert.ok(doc.diagnostics.filter(d => d.code === 'invalid-metadata').length >= 2);
  assert.equal(parse('Body', 'hybrid/Good.md', { folders: ['hybrid'], publicFolders: ['hybrid'] }).root.meta.publish, true);
  for (const source of ['---\npublish: true\nauthors: [\n---\nBody', '---\npublish: "false"\n---\nBody', '---\npublish: true\n---\n# R\n%% forester\nauthors: [\n%%\nBody']) {
    const malformed = parse(source, 'hybrid/M.md', { folders: ['hybrid'], publicFolders: ['hybrid'] });
    assert.equal(malformed.root.meta.publish, false);
    assert.ok(malformed.diagnostics.some(d => d.severity === 'error'));
  }
});

test('dedicated single tags define arbitrary taxa while heading sugar consumes only known aliases', () => {
  const source = '# R\n## One ^one\n#rEf\n\nBody\n## Two\n\n#My/Custom-Taxon\n\nText\n## Person #PERSON ^person\nBody\n## Ordinary #reading\nBody\n## Multiple\n#Ref #Person\nBody\n## Code\n`#Ref`\nBody\n## Escaped\n\\#Ref\nBody\n';
  const doc = parse(source);
  const [, one, two, person, ordinary, multiple, code, escaped] = doc.trees;
  assert.equal(one.meta.taxon, 'Reference');
  assert.equal(two.meta.taxon, 'My/Custom-Taxon');
  assert.equal(person.meta.taxon, 'Person');
  assert.equal(person.meta.title, 'Person');
  assert.equal(person.id, 'person');
  assert.equal(ordinary.meta.title, 'Ordinary #reading');
  assert.equal(ordinary.meta.taxon, undefined);
  assert.equal(multiple.meta.taxon, undefined);
  assert.ok(doc.diagnostics.some(d => d.code === 'ambiguous-taxon'));
  assert.equal(code.meta.taxon, undefined);
  assert.equal(escaped.meta.taxon, undefined);
  assert.equal(source.slice(one.contentFrom, one.contentFrom + 4), 'Body');
  assert.equal(source.slice(two.contentFrom, two.contentFrom + 4), 'Text');
  assert.equal(source.slice(one.metadataRanges[0].from, one.metadataRanges[0].to), '#rEf\n');
});

test('nonsemantic Markdown regions protect fake headings, metadata and links', () => {
  const source = '---\nforester-mode: hybrid-v1\nexample: |\n  ## fake-fm\n---\n```md\n# Fake root\n## Fenced ^fenced\n[[Target#H]]\n```\n~~~\n## Tilde\n~~~\n    ## Indent\n> [!info]\n> ## Quote\n> [[Target#H]]\n$$\n## Display math\n[[Target#H]]\n$$\n%% ordinary comment\n## Comment\n[[Target#H]]\n%%\n<!--\n## HTML comment\n-->\n# Real root\n## Real `#Ref` $x$ ^real\n`[[Target#H]]` $[[Target#H]]$ \\( [[Target#H]] \\)\nText';
  const doc = parse(source);
  assert.equal(doc.root.meta.title, 'Real root');
  assert.deepEqual(doc.trees.slice(1).map(t => t.id), ['real']);
  assert.equal(doc.trees[1].meta.taxon, undefined);
  const covers = text => {
    const from = source.indexOf(text);
    return doc.protectedRanges.some(r => r.from <= from && r.to >= from + text.length);
  };
  for (const text of ['## fake-fm', '## Fenced', '## Tilde', '## Indent', '> ## Quote', '## Display math', '## Comment', '## HTML comment', '`#Ref`', '`[[Target#H]]`', '$[[Target#H]]$', '\\( [[Target#H]] \\)']) assert.ok(covers(text), text);
});

test('raw Forester balances nested braces, escapes, percent comments and verbatim without evaluation', () => {
  const raw = String.raw`\{ \title{A {B}} escaped \} \{ ignored
% a comment with } and {
\startverb
} { [[Target#H]]
\stopverb
\verb|} {|
\p{inside}
## Not Markdown
}`;
  const source = '# R\nBefore **Markdown**\n' + raw + '\nAfter Markdown\n## Real ^real\n`\\{ not raw }` $\\{ not raw }$\n';
  const doc = parse(source);
  assert.equal(doc.raw.length, 1);
  const region = doc.raw[0];
  assert.equal(region.from, source.indexOf(raw));
  assert.equal(region.to, region.from + raw.length);
  assert.equal(region.codeFrom, region.from + 2);
  assert.equal(region.codeTo, region.to - 1);
  assert.equal(region.code, source.slice(region.codeFrom, region.codeTo));
  assert.equal(region.error, undefined);
  assert.deepEqual(doc.trees.slice(1).map(t => t.id), ['real']);
  assert.ok(doc.protectedRanges.some(r => r.from === region.from && r.to === region.to));
  assert.equal(doc.source, source);
});

test('unclosed raw regions diagnose and conservatively protect the remaining source', () => {
  for (const body of [String.raw`\{ \p{unclosed}`, String.raw`\{ \startverb }`, String.raw`\{ \verb|}`]) {
    const source = '# R\n' + body + '\n## Never interpreted ^hidden\n[[Target#H]]';
    const doc = parse(source);
    assert.equal(doc.raw.length, 1);
    assert.equal(doc.raw[0].to, source.length);
    assert.ok(doc.raw[0].error);
    assert.ok(doc.diagnostics.some(d => d.code === 'unclosed-raw' && d.severity === 'error'));
    assert.equal(doc.trees.length, 1);
  }
  const escapedMarker = parse(String.raw`# R
\\{ literal }
## Visible ^ok`);
  assert.equal(escapedMarker.raw.length, 0);
  assert.equal(escapedMarker.trees[1].id, 'ok');
});

test('identity index retains case-insensitive global duplicate roots/subtrees without picking one', () => {
  assert.equal(typeof core.indexHybrid, 'function');
  const a = parse('---\nforester-id: Alpha\n---\n## First ^beta\n## Duplicate ^ALPHA\n', 'hybrid/A.md');
  const b = parse('---\nforester-id: BETA\n---\n## Other ^z\n', 'hybrid/B.md');
  const ordinary = parse('---\nforester-id: alpha\n---\n## Ignored ^beta\n', 'ordinary/O.md', {excludedFolders: ['ordinary']});
  assert.equal(ordinary.enabled, false);
  const index = core.indexHybrid([a, b, ordinary]);
  assert.equal(index.documents.size, 3);
  assert.equal(index.ids.get('alpha').length, 2);
  assert.equal(index.ids.get('beta').length, 2);
  assert.equal(index.ids.get('z').length, 1);
  assert.equal(index.ids.size, 3);
  assert.ok(index.diagnostics.some(d => d.code === 'duplicate-id' && d.severity === 'error'));
  assert.equal(a.root.id, 'Alpha');
});

test('bare identity/file/alias collisions include disabled documents and remain ambiguous', () => {
  assert.equal(typeof core.resolveHybrid, 'function');
  const identity = parse('---\nforester-id: same\n---\n## Heading ^topic\n', 'hybrid/Identity.md');
  const file = parse('---\naliases: [topic, Nick]\n---\nOrdinary', 'ordinary/same.md', {excludedFolders: ['ordinary']});
  assert.equal(file.enabled, false);
  const index = core.indexHybrid([identity, file]);
  assert.ok(index.diagnostics.some(d => d.code === 'file-id-collision' && d.severity === 'warning'));
  assert.ok(index.diagnostics.some(d => d.code === 'alias-id-collision' && d.severity === 'warning'));
  assert.equal(core.resolveHybrid(index, 'same', identity.path).status, 'ambiguous');
  assert.equal(core.resolveHybrid(index, 'topic', identity.path).status, 'ambiguous');
  assert.equal(core.resolveHybrid(index, 'missing', identity.path).status, 'missing');
  const resolved = core.resolveHybrid(index, 'Nick', identity.path);
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.document.path, file.path);
  assert.equal(resolved.tree, file.root);
});

test('explicit paths, block IDs and nested same-note headings preserve ambiguity', () => {
  const a = parse('---\nforester-id: SAME\n---\n# Root\n## Parent ^p\n### Child ^child\n## Other\n### Child ^other-child\n## Duplicated\n## Duplicated\n', 'hybrid/Same.md');
  const b = parse('## Parent ^foreign\n', 'else/Same.md', { folders: ['else'] });
  const c = parse('## Else ^p\n', 'hybrid/C.md');
  const index = core.indexHybrid([a, b, c]);
  assert.equal(core.resolveHybrid(index, 'Same', a.path).status, 'ambiguous');
  const explicit = core.resolveHybrid(index, 'hybrid/Same.md#Parent#Child', b.path);
  assert.equal(explicit.status, 'resolved');
  assert.equal(explicit.tree.id, 'child');
  assert.equal(core.resolveHybrid(index, '#Parent#Child', a.path).tree.id, 'child');
  assert.equal(core.resolveHybrid(index, '#Child', a.path).status, 'ambiguous');
  assert.equal(core.resolveHybrid(index, '#Duplicated', a.path).status, 'ambiguous');
  assert.equal(core.resolveHybrid(index, 'hybrid/Same#^child', b.path).tree.id, 'child');
  assert.equal(core.resolveHybrid(index, 'hybrid/Same.md#^foreign', b.path).status, 'missing');
  assert.equal(core.resolveHybrid(index, '#^p', a.path).status, 'ambiguous');
  assert.equal(core.resolveHybrid(index, './Same.md#Other#Child', a.path).tree.id, 'other-child');
  assert.equal(core.resolveHybrid(index, '../hybrid/Same.md#^child', b.path).tree.id, 'child');
  assert.equal(core.resolveHybrid(index, 'else/Same.md#Parent', a.path).tree.id, 'foreign');
  assert.equal(core.resolveHybrid(index, 'hybrid/Same.md', a.path).tree, a.root);
  assert.equal(core.resolveHybrid(index, '#Missing', a.path).status, 'missing');
});

test('random IDs use uppercase six hex in range and skip decimal, taken and reserved IDs', () => {
  assert.equal(typeof core.drawHybridId, 'function');
  const min = 0x111111, max = 0xFFFFFF, size = max - min + 1;
  const candidates = [0x111111, 0x261111, 0xA12345, 0xB12345, 0xC12345];
  let calls = 0;
  const random = () => (candidates[calls++] - min + 0.25) / size;
  assert.equal(core.drawHybridId(['a12345'], ['b12345'], random), 'C12345');
  assert.equal(calls, 5);
  assert.equal(core.drawHybridId([], [], () => (0x11111A - min + 0.25) / size), '11111A');
  assert.equal(core.drawHybridId([], [], () => (max - min + 0.25) / size), 'FFFFFF');
  const id = core.drawHybridId([]);
  assert.match(id, /^[0-9A-F]{6}$/);
  assert.ok(parseInt(id, 16) >= min && parseInt(id, 16) <= max);
  assert.doesNotMatch(id, /^\d{6}$/);
});

test('ID drawing rejects invalid RNG outputs and terminates exhausted deterministic attempts', () => {
  for (const value of [NaN, Infinity, -0.1, 1, 2]) assert.throws(() => core.drawHybridId([], [], () => value), /random|RNG/i);
  let calls = 0;
  const loop = () => { if (++calls > 4096) throw new Error('test sentinel: unbounded'); return 0; };
  assert.throws(() => core.drawHybridId([], [], loop), /Unable|attempt|exhaust/i);
  assert.ok(calls <= 4096);
  assert.throws(() => core.drawHybridId(['FFFFFF'], [], () => 1 - Number.EPSILON), /Unable|attempt|exhaust/i);
});

test('settled-save mints every unaddressed H2-H6 only in the saved document without requiring a private root ID', () => {
  const source = '---\nforester-mode: false\nunknown-property: keep\n---\n# Root\n## A\n### B ^Custom-ID\n#### C\n##### D\n###### E\n## F ##  \n';
  const saved = parse(source, 'Notes/Saved.md', {});
  const untouched = parse('# Other\n## Unsettled\n', 'Notes/Other.md', {});
  const excluded = parse('---\nforester-mode: true\npublish: true\n---\n## Excluded\n', 'Excluded/Note.md', {excludedFolders: ['Excluded'], publicFolders: ['/']});
  const ids = ['A12345', 'B12345', 'C12345', 'D12345', 'E12345'];
  let calls = 0;
  const plan = core.planHybridSave(core.indexHybrid([saved, untouched, excluded]), saved.path, () => ids[calls++]);
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(calls, 5);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].path, saved.path);
  assert.equal(plan.edits[0].before, source);
  assert.equal(plan.edits[0].after, source.replace('## A\n', '## A ^A12345\n').replace('#### C\n', '#### C ^B12345\n')
    .replace('##### D\n', '##### D ^C12345\n').replace('###### E\n', '###### E ^D12345\n').replace('## F ##  \n', '## F ^E12345 ##  \n'));
  assert.equal(saved.source, source);
  assert.equal(untouched.source, '# Other\n## Unsettled\n');
  const fixed = parse(plan.edits[0].after, saved.path, {});
  assert.equal(fixed.root.id, undefined, 'automatic subtree IDs do not require a root route');
  assert.equal(fixed.frontmatter['forester-mode'], false);
  assert.deepEqual(fixed.trees.slice(1).map(tree => tree.id), ['A12345', 'Custom-ID', 'B12345', 'C12345', 'D12345', 'E12345']);
  assert.deepEqual(fixed.trees.map(tree => [tree.meta.title, tree.level, tree.meta.publish]), saved.trees.map(tree => [tree.meta.title, tree.level, tree.meta.publish]));
  const updated = core.indexHybrid([fixed, untouched, excluded]);
  assert.deepEqual(updated.diagnostics, []);
  assert.deepEqual(core.planHybridSave(updated, saved.path, () => { throw new Error('idempotence'); }), {edits: [], diagnostics: []});
  assert.deepEqual(core.planHybridSave(updated, excluded.path, () => { throw new Error('excluded path'); }), {edits: [], diagnostics: []});
});

test('save planning mints a required public root and preserves existing YAML, CRLF and snapshots', () => {
  assert.equal(typeof core.planHybridSave, 'function');
  const source = '---\r\n# keep comment\r\nforester-mode: hybrid-v1\r\naliases: [Keep]\r\n---\r\n# Note\r\nBody\r\n';
  const doc = parse(source, 'hybrid/S.md', {publicFolders: ['hybrid']});
  const plan = core.planHybridSave(core.indexHybrid([doc]), doc.path, () => 'A12345');
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].path, doc.path);
  assert.equal(plan.edits[0].before, source);
  assert.equal(plan.edits[0].after, source.replace('---\r\n# keep', '---\r\nforester-id: A12345\r\n# keep'));
  assert.equal(doc.source, source);
  assert.equal(doc.root.id, undefined);
  const fixed = parse(plan.edits[0].after, doc.path, {publicFolders: ['hybrid']});
  assert.equal(fixed.root.id, 'A12345');
  assert.deepEqual(core.planHybridSave(core.indexHybrid([fixed]), doc.path, () => { throw new Error('must not mint again'); }).edits, []);
  const plain = parse('Body', 'plain/N.md', {excludedFolders: ['plain']});
  assert.deepEqual(core.planHybridSave(core.indexHybrid([plain]), plain.path, () => { throw new Error('disabled'); }).edits, []);
  const idle = parse('# Private\nBody\n');
  const idlePlan = core.planHybridSave(core.indexHybrid([idle]), idle.path, () => { throw new Error('unneeded root'); });
  assert.deepEqual(idlePlan, {edits: [], diagnostics: []});
  const bare = parse('# Bare\n', 'hybrid/Bare.md', {publicFolders: ['hybrid']});
  const minted = core.planHybridSave(core.indexHybrid([bare]), bare.path, () => 'B12345');
  assert.equal(minted.edits[0].after, '---\nforester-id: B12345\n---\n# Bare\n');
});

test('save refuses malformed or duplicate identities instead of silently replacing them', () => {
  for (const source of ['---\nforester-id: "bad id"\n---\n', '---\nforester-id: 12\n---\n', '---\nforester-id: SAME\n---\n## Duplicate ^same\n', '---\nforester-id: broken\nother: [\n---\n']) {
    const doc = parse(source);
    const plan = core.planHybridSave(core.indexHybrid([doc]), doc.path, () => { throw new Error('must not draw'); });
    assert.deepEqual(plan.edits, []);
    assert.ok(plan.diagnostics.some(d => d.severity === 'error'));
  }
  const a = parse('---\nforester-id: A\n---\n', 'hybrid/A.md');
  const b = parse('---\nforester-id: a\n---\n', 'hybrid/B.md');
  const plan = core.planHybridSave(core.indexHybrid([a, b]), a.path, () => 'AB1234');
  assert.deepEqual(plan.edits, []);
  assert.ok(plan.diagnostics.some(d => d.code === 'duplicate-id'));
});

test('save fixes uniquely referenced headings, reuses minted IDs and preserves original spelling, labels and embeds', () => {
  const source = '[[tArGeT#Parent#Child|label]] ![[tArGeT#Parent#Child|custom !]] [[Target]] [[#Local]]\n## Local\nBody\n';
  const target = '# T\n## Parent\nParent body\n### Child\nChild body\n';
  const a = parse(source, 'hybrid/Source.md');
  const b = parse(target, 'hybrid/Target.md');
  const ids = ['A12345', 'B12345', 'C12345', 'D12345'];
  let draws = 0;
  const plan = core.planHybridSave(core.indexHybrid([a, b]), a.path, () => ids[draws++]);
  assert.equal(draws, 4);
  assert.equal(plan.edits.length, 2);
  const byPath = new Map(plan.edits.map(edit => [edit.path, edit]));
  assert.equal(byPath.get(a.path).before, source);
  assert.equal(byPath.get(b.path).before, target);
  assert.equal(byPath.get(a.path).after, '---\nforester-id: A12345\n---\n[[tArGeT#^C12345|label]] ![[tArGeT#^C12345|custom !]] [[Target|T]] [[#^D12345|Local]]\n## Local ^D12345\nBody\n');
  assert.equal(byPath.get(b.path).after, '---\nforester-id: B12345\n---\n# T\n## Parent\nParent body\n### Child ^C12345\nChild body\n');
  assert.equal(a.source, source);
  assert.equal(b.source, target);
  assert.equal(a.trees[1].id, undefined);
  const reparsed = [...byPath.values()].map(edit => parse(edit.after, edit.path));
  const index = core.indexHybrid(reparsed);
  assert.equal(core.resolveHybrid(index, 'tArGeT#^C12345', a.path).tree.meta.title, 'Child');
  assert.deepEqual(core.planHybridSave(index, a.path, () => { throw new Error('idempotence'); }).edits, []);
});

test('save reports ambiguous/missing heading links and leaves code, math, raw, comments and disabled targets unchanged', () => {
  const guarded = ['`[[Target#H]]`', '$[[Target#H]]$', '\\( [[Target#H]] \\)', '%% [[Target#H]] %%', '<!-- [[Target#H]] -->', '\\{ \\p{[[Target#H]]} }', '```\n[[Target#H]]\n```', '    [[Target#H]]', '> [[Target#H]]', '\\[[Target#H]]'].join('\n');
  const source = '---\nforester-id: SOURCE\n---\n[[Target#Dupe|x]] ![[NoSuch#H]] [[plain/Ordinary#H]] [[Target]]\n' + guarded;
  const a = parse(source, 'hybrid/Source.md');
  const b = parse('# T\n## H\n## Dupe\n## Dupe\n', 'hybrid/Target.md');
  const disabled = parse('## H\n', 'plain/Ordinary.md', {excludedFolders: ['plain']});
  assert.equal(disabled.enabled, false);
  const plan = core.planHybridSave(core.indexHybrid([a, b, disabled]), a.path, () => { throw new Error('no valid heading refs'); });
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].after, source.replace('[[Target]]', '[[Target|T]]'));
  assert.ok(plan.diagnostics.some(d => d.code === 'ambiguous-reference'));
  assert.ok(plan.diagnostics.some(d => d.code === 'missing-reference'));
  assert.equal(disabled.source, '## H\n');
});

test('any dangerous identity in a referenced target aborts every edit before drawing IDs', () => {
  const a = parse('[[Target#H]]\n## Automatic must not be minted\n', 'hybrid/Source.md');
  for (const target of ['---\nforester-id: DUPE\n---\n## H\n', '---\nforester-id: "bad id"\n---\n## H\n', '---\nforester-id: TARGET\n---\n## H ^X\n## Other ^x\n']) {
    const b = parse(target, 'hybrid/Target.md');
    const collision = parse('---\nforester-id: dupe\n---\n', 'hybrid/Other.md');
    const plan = core.planHybridSave(core.indexHybrid([a, b, collision]), a.path, () => { throw new Error('preflight must precede any draw'); });
    assert.deepEqual(plan.edits, []);
    assert.ok(plan.diagnostics.some(d => d.path === b.path && d.severity === 'error'));
  }
});

test('save retains manual heading IDs but still mints their missing target root and preserves CRLF closing hashes', () => {
  const a = parse('---\r\nforester-id: SOURCE\r\n---\r\n[[Target#Manual|M]] [[Target#New]]\r\n', 'hybrid/Source.md');
  const b = parse('# T\r\n## Manual ^manual-id\r\nBody\r\n## New ##  \r\nText\r\n', 'hybrid/Target.md');
  let calls = 0;
  const plan = core.planHybridSave(core.indexHybrid([a, b]), a.path, () => ['A12345', 'B12345'][calls++]);
  assert.equal(calls, 2);
  const targetEdit = plan.edits.find(e => e.path === b.path);
  const sourceEdit = plan.edits.find(e => e.path === a.path);
  assert.equal(targetEdit.after, '---\r\nforester-id: A12345\r\n---\r\n# T\r\n## Manual ^manual-id\r\nBody\r\n## New ^B12345 ##  \r\nText\r\n');
  assert.ok(sourceEdit.after.includes('[[Target#^manual-id|M]] [[Target#^B12345|New]]'));
  assert.equal(parse(targetEdit.after, b.path).trees[2].meta.title, 'New');
});

test('an existing subtree ID still causes its missing target root to be minted', () => {
  const a = parse('---\nforester-id: SOURCE\n---\n[[Target#Manual]]\n', 'hybrid/Source.md');
  const b = parse('## Manual ^manual-id\nBody\n', 'hybrid/Target.md');
  let calls = 0;
  const plan = core.planHybridSave(core.indexHybrid([a, b]), a.path, () => { calls++; return 'A12345'; });
  assert.equal(calls, 1);
  assert.equal(plan.edits.length, 2);
  assert.equal(plan.edits.find(e => e.path === b.path).after, '---\nforester-id: A12345\n---\n## Manual ^manual-id\nBody\n');
});

test('save allocation skips case-insensitive occupied/reserved names and reuses no generated identity', () => {
  const a = parse('[[Target#H]]', 'hybrid/Source.md', { folders: ['hybrid'], publicFolders: ['hybrid'], reservedIds: ['A12345'] });
  const b = parse('## H\nBody', 'hybrid/Target.md');
  const c = parse('---\nforester-id: b12345\n---\n', 'hybrid/Other.md');
  const name = parse('Ordinary', 'ordinary/C12345.md');
  const alias = parse('---\naliases: [D12345]\n---\n', 'ordinary/Alias.md');
  const ids = ['A12345', 'B12345', 'C12345', 'D12345', 'E12345', 'E12345', 'F12345', 'AB1234'];
  let calls = 0;
  const plan = core.planHybridSave(core.indexHybrid([a, b, c, name, alias]), a.path, () => ids[calls++]);
  assert.equal(calls, 8);
  const updated = plan.edits.map(e => parse(e.after, e.path));
  assert.equal(updated.find(d => d.path === a.path).root.id, 'E12345');
  assert.equal(updated.find(d => d.path === b.path).root.id, 'F12345');
  assert.equal(updated.find(d => d.path === b.path).trees[1].id, 'AB1234');
  for (const invalid of ['custom-id', '123456', '0ABCDE', 'abcdef', 'ABCDEF\nforester-mode: false']) {
    const bad = core.planHybridSave(core.indexHybrid([a]), a.path, () => invalid);
    assert.deepEqual(bad.edits, []);
    assert.ok(bad.diagnostics.some(d => d.code === 'id-allocation-failed' && d.severity === 'error'));
  }
  let repeated = 0;
  const exhausted = core.planHybridSave(core.indexHybrid([a]), a.path, () => { if (++repeated > 4096) throw new Error('unbounded'); return 'A12345'; });
  assert.deepEqual(exhausted.edits, []);
  assert.ok(repeated <= 4096);
  assert.ok(exhausted.diagnostics.some(d => d.code === 'id-allocation-failed'));
});

test('malformed or multiple unescaped native heading IDs are errors and cannot be replaced by saves', () => {
  for (const heading of ['## Bad ^bad_id', '## Bad ^', '## Bad ^α', '## Bad ^one ^two', '## Bad ^contains spaces']) {
    const source = '---\nforester-id: ROOT\n---\n' + heading + '\n';
    const doc = parse(source);
    assert.equal(doc.trees[1].id, undefined, heading);
    assert.ok(doc.diagnostics.some(d => d.code === 'invalid-id'), heading);
    const plan = core.planHybridSave(core.indexHybrid([doc]), doc.path, () => 'A12345');
    assert.deepEqual(plan.edits, []);
    assert.ok(plan.diagnostics.some(d => d.code === 'invalid-id'));
  }
  const literal = parse('## Code `^bad_id`\n## Escaped \\^custom\n');
  assert.ok(!literal.diagnostics.some(d => d.code === 'invalid-id'));
  assert.ok(literal.trees.slice(1).every(t => t.id === undefined));
});

test('generated exponent-shaped hex root IDs round-trip as strings instead of YAML numbers', () => {
  for (const id of ['1E0000', '2E1234', '111E11']) {
    const doc = parse('# Note\n', 'hybrid/Note.md', {publicFolders: ['hybrid']});
    const plan = core.planHybridSave(core.indexHybrid([doc]), doc.path, () => id);
    const fixed = parse(plan.edits[0].after, doc.path);
    assert.equal(fixed.root.id, id);
    assert.equal(fixed.frontmatter['forester-id'], id);
    assert.deepEqual(fixed.diagnostics, []);
    assert.deepEqual(core.planHybridSave(core.indexHybrid([fixed]), doc.path).edits, []);
  }
});

test('unclosed metadata comments fail closed even when the folder and YAML root are public', () => {
  for (const comment of ['%% forester\npublish: true\n', '%% publish: true\n', '%% forester\nauthors: [Alice]\n']) {
    const doc = parse('---\npublish: true\npublic-title: true\n---\n# Root\n' + comment, 'hybrid/P.md', { folders: ['hybrid'], publicFolders: ['hybrid'] });
    assert.equal(doc.root.meta.publish, false);
    assert.equal(doc.root.meta.publicTitle, false);
    assert.ok(doc.diagnostics.some(d => d.code === 'invalid-metadata' && d.severity === 'error'));
  }
});

test('heading resolution uses original Markdown headings rather than overriding metadata titles', () => {
  const doc = parse('---\nforester-id: ROOT\ntitle: Catalog title\n---\n# Markdown root\n## Actual heading ^actual\n%% title: Semantic title %%\n### Nested\n', 'hybrid/T.md');
  const index = core.indexHybrid([doc]);
  assert.equal(doc.root.meta.title, 'Catalog title');
  assert.equal(doc.trees[1].meta.title, 'Semantic title');
  assert.equal(core.resolveHybrid(index, '#Markdown root', doc.path).tree, doc.root);
  assert.equal(core.resolveHybrid(index, '#Actual heading#Nested', doc.path).tree, doc.trees[2]);
  assert.equal(core.resolveHybrid(index, '#Semantic title', doc.path).status, 'missing');
  const plan = core.planHybridSave(index, doc.path, () => 'A12345');
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].after, doc.source.replace('### Nested\n', '### Nested ^A12345\n'));
  const saved = parse(plan.edits[0].after, doc.path);
  assert.equal(saved.trees[1].id, 'actual');
  assert.equal(core.resolveHybrid(core.indexHybrid([saved]), '#Actual heading#Nested', doc.path).tree.id, 'A12345');
  assert.equal(core.resolveHybrid(core.indexHybrid([saved]), '#Semantic title', doc.path).status, 'missing');
});

test('a bare filename with heading cannot silently prefer a vault-root file over equal nested stems', () => {
  const rootFile = parse('## H\n', 'Same.md', { folders: ['/'] });
  const nested = parse('## H\n', 'hybrid/Same.md');
  const index = core.indexHybrid([rootFile, nested]);
  assert.equal(core.resolveHybrid(index, 'Same#H', nested.path).status, 'ambiguous');
  assert.equal(core.resolveHybrid(index, 'Same.md#H', nested.path).tree, rootFile.trees[1]);
  assert.equal(core.resolveHybrid(index, 'hybrid/Same#H', rootFile.path).tree, nested.trees[1]);
  const noHeading = parse('Text', 'hybrid/NoHeading.md');
  assert.equal(core.resolveHybrid(core.indexHybrid([noHeading]), '#NoHeading', noHeading.path).status, 'missing');
});

test('lazy blockquote paragraph continuations remain protected during save planning', () => {
  const source = '---\nforester-id: ROOT\n---\n> Quoted paragraph\n[[Target#H]]\ncontinuation ![[Target#H]]\n\n## Real\nBody';
  const doc = parse(source);
  const target = parse('---\nforester-id: TARGET\n---\n## H\n', 'hybrid/Target.md');
  const plan = core.planHybridSave(core.indexHybrid([doc, target]), doc.path, () => 'A12345');
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].after, source.replace('## Real\n', '## Real ^A12345\n'));
  for (const token of ['[[Target#H]]', 'continuation ![[Target#H]]']) {
    const from = source.indexOf(token);
    assert.ok(doc.protectedRanges.some(range => range.from <= from && range.to >= from + token.length));
  }
  assert.equal(doc.trees[1].meta.title, 'Real');
});

test('raw startverb ends only at a complete stopverb token, not stopverbatim prefixes', () => {
  const raw = String.raw`\{ \startverb } { \stopverbatim } { \stopverb \p{kept} }`;
  const source = '# R\n' + raw + '\n## Real ^real\n';
  const doc = parse(source);
  assert.equal(doc.raw.length, 1);
  assert.equal(doc.raw[0].to, source.indexOf(raw) + raw.length);
  assert.equal(doc.raw[0].error, undefined);
  assert.equal(doc.trees[1].id, 'real');
});

test('YAML alias expansion errors are diagnosed instead of throwing or exposing publication', () => {
  const bomb = 'a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]';
  for (const source of ['---\npublish: true\n' + bomb + '\n---\n', '---\npublish: true\n---\n# R\n%% forester\n' + bomb + '\n%%\n']) {
    const doc = parse(source, 'hybrid/P.md', { folders: ['hybrid'], publicFolders: ['hybrid'] });
    assert.equal(doc.root.meta.publish, false);
    assert.ok(doc.diagnostics.some(d => ['invalid-frontmatter', 'invalid-metadata'].includes(d.code) && d.severity === 'error'));
  }
});

test('taxon prologues consume one dedicated line only and never treat indented code as a tag', () => {
  const indented = parse('## S\n    #Ref\nBody\n');
  assert.equal(indented.trees[1].meta.taxon, undefined);
  assert.deepEqual(indented.trees[1].metadataRanges, []);
  assert.equal(indented.source.slice(indented.trees[1].contentFrom), '    #Ref\nBody\n');
  const successive = parse('## S\n#Ref\n#Person\nBody\n');
  assert.equal(successive.trees[1].meta.taxon, 'Reference');
  assert.equal(successive.source.slice(successive.trees[1].contentFrom), '#Person\nBody\n');
  assert.equal(successive.trees[1].metadataRanges.length, 1);
});

test('root comments before H1 and after H1 are both hidden without losing body content', () => {
  const source = '---\nauthors: [Alice]\n---\n%% authors: Bob %%\n\n# Root\n%% dates: [2026] %%\n\nBody\n## Child\n';
  const doc = parse(source);
  assert.deepEqual(doc.root.meta.authors, ['Alice', 'Bob']);
  assert.deepEqual(doc.root.meta.dates, ['2026']);
  assert.equal(source.slice(doc.root.contentFrom, doc.root.contentFrom + 4), 'Body');
  assert.equal(doc.root.meta.title, 'Root');
  assert.equal(doc.root.metadataRanges.length, 3);
  assert.deepEqual(doc.trees[1].meta.authors, ['Alice', 'Bob']);
  assert.deepEqual(doc.trees[1].meta.dates, ['2026']);
});

test('arbitrary taxon tags never use inherited JavaScript object-property aliases', () => {
  for (const tag of ['constructor', '__proto__']) {
    const doc = parse(`## Arbitrary\n#${tag}\nBody\n## Ordinary #${tag}\n`);
    assert.equal(doc.trees[1].meta.taxon, tag);
    assert.equal(doc.trees[2].meta.taxon, undefined);
    assert.equal(doc.trees[2].meta.title, `Ordinary #${tag}`);
  }
});

test('closing fences accept tab whitespace but not a literal t as whitespace', () => {
  const closed = parse('```md\n## Fake ^fake\n```\t\n## Visible ^visible\n');
  assert.deepEqual(closed.trees.slice(1).map(t => t.id), ['visible']);
  const notClosed = parse('```md\n## Fake ^fake\n```t\n## Still code ^hidden\n```\n## Visible ^visible\n');
  assert.deepEqual(notClosed.trees.slice(1).map(t => t.id), ['visible']);
});

test('root title priority cannot be overridden by a metadata comment title', () => {
  const fm = parse('---\ntitle: YAML title\n---\n# H1 title\n%% title: Comment title %%\nBody');
  assert.equal(fm.root.meta.title, 'YAML title');
  assert.equal(parse('# H1 title\n%% title: Comment title %%\nBody').root.meta.title, 'H1 title');
  assert.equal(parse('%% title: Comment title %%\nBody').root.meta.title, 'Note');
});

test('H1 supports known taxon aliases without consuming ordinary heading tags or IDs as root identities', () => {
  const doc = parse('# Root #rEf\nBody\n');
  assert.equal(doc.root.meta.title, 'Root');
  assert.equal(doc.root.meta.taxon, 'Reference');
  assert.equal(doc.root.id, undefined);
  const ordinary = parse('# Root #reading\nBody\n');
  assert.equal(ordinary.root.meta.title, 'Root #reading');
  assert.equal(ordinary.root.meta.taxon, undefined);
  const caret = parse('# Root ^native\nBody\n');
  assert.equal(caret.root.id, undefined);
  assert.equal(core.indexHybrid([caret]).ids.size, 0);
});

test('BOM-prefixed settled saves preserve YAML offsets and line endings for required and existing root IDs', () => {
  for (const newline of ['\n', '\r\n']) {
    const opt = options({publicFolders: ['/']});
    const body = '# Note\n## Child ^manual-id\n'.replace(/\n/g, newline);
    const bare = core.parseHybrid('Bom.md', '\uFEFF' + body, opt);
    assert.equal(bare.root.meta.title, 'Note');
    const minted = core.planHybridSave(core.indexHybrid([bare]), bare.path, () => '1E0000');
    assert.deepEqual(minted.diagnostics, []);
    assert.equal(minted.edits.length, 1);
    assert.equal(minted.edits[0].after, '\uFEFF' + `---${newline}forester-id: "1E0000"${newline}---${newline}` + body);
    const fixed = core.parseHybrid(bare.path, minted.edits[0].after, opt);
    assert.equal(fixed.root.id, '1E0000');
    assert.equal(fixed.root.meta.title, 'Note');
    assert.equal(fixed.trees[1].id, 'manual-id');
    assert.deepEqual(fixed.diagnostics, []);
    assert.deepEqual(core.planHybridSave(core.indexHybrid([fixed]), fixed.path, () => { throw new Error('idempotence'); }), {edits: [], diagnostics: []});
    const source = '\uFEFF' + '---\n# preserve comment\nforester-mode: false\nforester-id: custom-Root\n---\n# Note\n## New\n'.replace(/\n/g, newline);
    const existing = core.parseHybrid('Existing.md', source, opt);
    assert.equal(existing.root.id, 'custom-Root');
    const plan = core.planHybridSave(core.indexHybrid([existing]), existing.path, () => 'A12345');
    assert.deepEqual(plan.diagnostics, []);
    assert.equal(plan.edits[0].before, source);
    assert.equal(plan.edits[0].after, source.replace(`## New${newline}`, `## New ^A12345${newline}`));
    const reparsed = core.parseHybrid(existing.path, plan.edits[0].after, opt);
    assert.equal(reparsed.root.id, 'custom-Root');
    assert.equal(reparsed.frontmatter['forester-mode'], false);
    assert.equal(reparsed.trees[1].id, 'A12345');
    assert.deepEqual(core.planHybridSave(core.indexHybrid([reparsed]), reparsed.path), {edits: [], diagnostics: []});
    const firstSource = '\uFEFF' + '## First\n```md\n## Fake\n```\n'.replace(/\n/g, newline);
    const first = core.parseHybrid('First.md', firstSource, options());
    assert.equal(first.trees[1]?.from, 1, 'BOM is not part of the first heading offset');
    assert.equal(first.trees.length, 2, 'BOM does not disable protected code guards');
    const firstPlan = core.planHybridSave(core.indexHybrid([first]), first.path, () => 'B12345');
    assert.deepEqual(firstPlan.diagnostics, []);
    assert.equal(firstPlan.edits[0].after, firstSource.replace(`## First${newline}`, `## First ^B12345${newline}`));
    const malformed = core.parseHybrid('Malformed.md', '\uFEFF---\npublish: true\nauthors: [\n---\n## Child\n'.replace(/\n/g, newline), opt);
    assert.equal(malformed.enabled, true);
    assert.equal(malformed.root.meta.publish, false);
    assert.ok(malformed.diagnostics.some(d => d.code === 'invalid-frontmatter'));
    assert.deepEqual(core.planHybridSave(core.indexHybrid([malformed]), malformed.path).edits, []);
  }
});

test('automatic heading IDs preserve protected regions, manual identities, BOM and LF/CRLF byte-for-byte', () => {
  const guards = [
    '```md\n## Code\n[[Target#H]]\n```', '~~~\n### Tilde\n~~~', '    ## Indented',
    '> ## Quote\n> [[Target#H]]', '$$\n#### Display math\n[[Target#H]]\n$$',
    '%% comment\n##### Obsidian comment\n%%', '<!--\n###### HTML comment\n-->',
    '\\{ \\p{raw}\n## Raw\n[[Target#H]]\n}', '`literal [[Target#H]]` $[[Target#H]]$ \\( [[Target#H]] \\)',
  ].join('\n\n');
  for (const newline of ['\n', '\r\n']) for (const bom of ['', '\uFEFF']) {
    const source = bom + ('---\nforester-mode: unknown\nforester-id: manual-ROOT\naliases: [Keep]\n---\n# Root ^not-a-root-id\n\n' + guards +
      '\n\n## Visible `literal` $x$\nBody\n### Manual ^202610\n## Other ##  \n####### Not a subtree\n').replace(/\n/g, newline);
    const doc = parse(source, 'Saved.md', {});
    const other = parse('---\nforester-id: TARGET\n---\n## H\n', 'Target.md', {});
    assert.deepEqual(doc.trees.slice(1).map(tree => tree.meta.title), ['Visible `literal` $x$', 'Manual', 'Other']);
    const expected = source.replace(`## Visible \`literal\` $x$${newline}`, `## Visible \`literal\` $x$ ^A12345${newline}`)
      .replace(`## Other ##  ${newline}`, `## Other ^B12345 ##  ${newline}`);
    const ids = ['A12345', 'B12345'];
    const plan = core.planHybridSave(core.indexHybrid([doc, other]), doc.path, () => ids.shift());
    assert.deepEqual(plan.diagnostics, []);
    assert.equal(plan.edits.length, 1);
    assert.deepEqual(plan.edits[0], {path: doc.path, before: source, after: expected});
    const fixed = parse(expected, doc.path, {});
    assert.equal(fixed.root.id, 'manual-ROOT');
    assert.equal(fixed.frontmatter['forester-mode'], 'unknown');
    assert.deepEqual(fixed.trees.slice(1).map(tree => tree.id), ['A12345', '202610', 'B12345']);
    assert.deepEqual(fixed.diagnostics, []);
    assert.deepEqual(core.planHybridSave(core.indexHybrid([fixed, other]), fixed.path, () => { throw new Error('idempotence'); }), {edits: [], diagnostics: []});
  }
});

// End of hybrid-core regression suite.
