import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHybrid, indexHybrid, resolveHybrid, planHybridSave } from './build/hybrid-core.mjs';
import { projectPublic } from './build/hybrid-public.mjs';

const options = { folders: ['hybrid'], excludedFolders: ['ordinary'], publicFolders: [], reservedIds: [] };
const privateBody = 'CANARY-PRIVATE-BODY';

function parse(path, source) {
  return parseHybrid(path, source, options);
}

function publicNote(id, title, body, metadata = '') {
  return `---\nforester-id: ${id}\ntitle: ${title}\npublish: true\n${metadata}---\n${body}`;
}

function noDisclosure(projection, ...secrets) {
  const serialized = JSON.stringify(projection);
  for (const secret of secrets) assert.ok(!serialized.includes(secret), `disclosed private data: ${secret}`);
}

test('actual parser bounds inline backticks before a private section across a paragraph break', () => {
  const document = parse('hybrid/N.md', publicNote('public', 'Public',
    `Opening \`example\n\n## Private ^hidden\n%% publish: false %%\n${privateBody}\nClosing\``));
  const projection = projectPublic(indexHybrid([document]));
  assert.deepEqual(projection.diagnostics, []);
  noDisclosure(projection, privateBody, 'Private', 'hidden');
  assert.equal(projection.trees[0].body, 'Opening `example');
  assert.equal(document.root.children[0].id, 'hidden');
  assert.equal(document.root.children[0].meta.publish, false);
});

test('actual published root requires a declared title instead of disclosing its filename fallback', () => {
  const path = 'hybrid/SECRET-FILENAME.md';
  const document = parse(path, '---\nforester-id: public\npublish: true\n---\nVisible');
  const projection = projectPublic(indexHybrid([document]));
  assert.deepEqual(projection.trees, []);
  assert.ok(projection.diagnostics.some(item => item.code === 'implicit-public-title' && item.severity === 'error'));
  noDisclosure(projection, 'SECRET-FILENAME', path);
});

test('actual title-only private references cannot disclose a filename even with public-title permission', () => {
  const path = 'hybrid/SECRET-FILENAME.md';
  const visible = parse('hybrid/A.md', publicNote('source', 'Source',
    `[[hidden|PRIVATE-LABEL]] [[${path}]] [PRIVATE-LABEL](${path})`));
  const hidden = parse(path, '---\nforester-id: hidden\npublic-title: true\n---\n' + privateBody);
  const projection = projectPublic(indexHybrid([visible, hidden]));
  assert.deepEqual(projection.trees, []);
  assert.ok(projection.diagnostics.some(item => item.code === 'implicit-public-title' && item.severity === 'error'));
  noDisclosure(projection, 'SECRET-FILENAME', path, 'PRIVATE-LABEL', privateBody);
});

test('actual public references obey the core alias resolver and emit canonical IDs', () => {
  const visible = parse('hybrid/A.md', publicNote('source', 'Source',
    '[[ApprovedAlias]] [Via alias](approvedalias)'));
  const target = parse('hybrid/B.md', publicNote('target', 'Approved title', 'Visible target',
    'aliases: [ApprovedAlias]\n'));
  const index = indexHybrid([visible, target]);
  const resolution = resolveHybrid(index, 'ApprovedAlias', visible.path);
  assert.equal(resolution.status, 'resolved');
  assert.equal(resolution.tree, target.root);
  const projection = projectPublic(index);
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees.find(tree => tree.id === 'source').body,
    '[[target|Approved title]] [[target|Via alias]]');
});

test('actual projection keeps original nested heading names across independently bundled modules', () => {
  const visible = parse('hybrid/A.md', publicNote('source', 'Source',
    '[[./B.md#Actual heading]] [[./B.md#Actual heading#Nested]] [[./B.md#Markdown root]]'));
  const target = parse('hybrid/B.md', publicNote('target', 'Catalog title',
    '# Markdown root\n## Actual heading ^actual\n%% title: Semantic title %%\nVisible\n### Nested ^nested\nChild body'));
  const index = indexHybrid([visible, target]);
  for (const [heading, id] of [['Actual heading', 'actual'], ['Actual heading#Nested', 'nested'], ['Markdown root', 'target']]) {
    const resolved = resolveHybrid(index, `./B.md#${heading}`, visible.path);
    assert.equal(resolved.status, 'resolved');
    assert.equal(resolved.tree.id, id);
  }
  const projection = projectPublic(index);
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees.find(tree => tree.id === 'source').body,
    '[[actual|Semantic title]] [[nested|Nested]] [[target|Catalog title]]');
});

test('actual public citation fields retain explicit provenance when redeclared with private-parent values', () => {
  const visible = parse('hybrid/A.md', publicNote('source', 'Source', 'See {ref:[[reference]]}.'));
  const reference = parse('hybrid/PRIVATE-NOTE.md',
    '---\nforester-id: private-root\ncitation-authors: [Author]\npublication-year: 2024\n---\n' +
    '# Private parent\n' + privateBody + '\n## Public reference ^reference\n' +
    '%% publish: true, citation-authors: [Author], publication-year: 2024 %%\nVisible bibliography');
  assert.equal(reference.root.meta.publish, false);
  assert.deepEqual(reference.trees[1].meta.citationAuthors, ['Author']);
  assert.equal(reference.trees[1].meta.publicationYear, '2024');
  const projection = projectPublic(indexHybrid([visible, reference]));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees.find(tree => tree.id === 'source').body, 'See (Author, 2024).');
  assert.deepEqual(projection.trees.find(tree => tree.id === 'reference').citationAuthors, ['Author']);
  assert.equal(projection.trees.find(tree => tree.id === 'reference').publicationYear, '2024');
  noDisclosure(projection, privateBody, 'PRIVATE-NOTE', 'private-root', 'Private parent');
});

// Coverage of the repaired boundaries and shared contracts, using real parser output.
for (const [name, opening, newline] of [
  ['heading block without blank line', 'Opening `example\n', '\n'],
  ['fenced block', 'Opening `example\n~~~text\nLiteral example\n~~~\n', '\n'],
  ['CRLF paragraph break', 'Opening `example\n \t\n', '\r\n'],
  ['multiple backticks', 'Opening ``example\n\n', '\n'],
]) {
  test(`actual inline code cannot swallow private subtree at ${name}`, () => {
    const closing = name === 'multiple backticks' ? '``' : '`';
    const source = publicNote('public', 'Public',
      `${opening}## Private ^hidden\n%% publish: false %%\n${privateBody}\nClosing${closing}`)
      .replace(/\n/g, newline);
    const document = parse('hybrid/N.md', source);
    const projection = projectPublic(indexHybrid([document]));
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(document.root.children[0].id, 'hidden');
    assert.equal(document.root.children[0].from, source.indexOf('## Private'));
    noDisclosure(projection, privateBody, 'Private', 'hidden');
  });
}

test('actual parser preserves soft-line-break inline code and fenced Forester/verbatim examples', () => {
  const body = 'Opening ``example\n[[not-a-live-target]] \\{ not raw }\nClosing``\n\n' +
    '~~~forester\n## Example ^example\n%% publish: false %%\n\\{ \\startverb } { \\stopverb }\n~~~';
  const document = parse('hybrid/N.md', publicNote('public', 'Public', body));
  assert.equal(document.trees.length, 1);
  assert.deepEqual(document.raw, []);
  const inlineStart = document.source.indexOf('``example');
  const inlineEnd = document.source.indexOf('Closing``') + 'Closing``'.length;
  assert.ok(document.protectedRanges.some(range => range.from === inlineStart && range.to === inlineEnd));
  const projection = projectPublic(indexHybrid([document]));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees[0].body, body);
});

for (const [declaration, titleSource] of [
  ['title: Approved title\n---\nVisible', 'metadata'],
  ['---\n# Approved title\nVisible', 'heading'],
]) {
  test(`actual public root accepts explicitly declared ${titleSource} title without exposing filename`, () => {
    const document = parse('hybrid/SECRET-FILENAME.md',
      `---\nforester-id: public\npublish: true\n${declaration}`);
    assert.equal(document.root.meta.titleSource, titleSource);
    const projection = projectPublic(indexHybrid([document]));
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.trees[0].title, 'Approved title');
    assert.equal(projection.trees[0].body, 'Visible');
    noDisclosure(projection, 'SECRET-FILENAME');
  });
}

test('actual root comment title does not launder a filename-origin title into public metadata', () => {
  const document = parse('hybrid/SECRET-FILENAME.md',
    '---\nforester-id: public\npublish: true\n---\n%% title: Approved title %%\nVisible');
  assert.equal(document.root.meta.titleSource, 'filename');
  const projection = projectPublic(indexHybrid([document]));
  assert.deepEqual(projection.trees, []);
  assert.ok(projection.diagnostics.some(item => item.code === 'implicit-public-title'));
  noDisclosure(projection, 'SECRET-FILENAME');
});

for (const publicTitle of [false, true]) {
  test(`actual declared private root obeys title-stub policy for IDs and filenames: ${publicTitle}`, () => {
    const visible = parse('hybrid/A.md', publicNote('source', 'Source',
      '[[hidden|PRIVATE-LABEL]] [[hybrid/SECRET-FILENAME.md]] [PRIVATE-LABEL](./SECRET-FILENAME.md)'));
    const hidden = parse('hybrid/SECRET-FILENAME.md',
      `---\nforester-id: hidden\npublic-title: ${publicTitle}\n---\n# Approved title\n${privateBody}`);
    const projection = projectPublic(indexHybrid([visible, hidden]));
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.trees.length, 1);
    const stub = publicTitle ? 'Approved title 🔒' : '[非公開]';
    assert.equal(projection.trees[0].body, `${stub} ${stub} ${stub}`);
    noDisclosure(projection, privateBody, 'SECRET-FILENAME', 'PRIVATE-LABEL', 'hidden');
  });
}

for (const [path, metadata, collisionCode] of [
  ['ordinary/C.md', 'aliases: [ToPiC]\n', 'alias-id-collision'],
  ['ordinary/ToPiC.md', '', 'file-id-collision'],
]) {
  test(`actual projection rejects case-insensitive ID collisions with disabled ${collisionCode}`, () => {
    const visible = parse('hybrid/A.md', publicNote('source', 'Source', '[[topic|PRIVATE-LABEL]]'));
    const target = parse('hybrid/B.md', publicNote('TOPIC', 'Public target', 'Visible target'));
    const disabled = parse(path, `---\n${metadata}---\n${privateBody}`);
    assert.equal(disabled.enabled, false);
    const index = indexHybrid([visible, target, disabled]);
    assert.ok(index.diagnostics.some(item => item.code === collisionCode));
    assert.equal(resolveHybrid(index, 'topic', visible.path).status, 'ambiguous');
    const projection = projectPublic(index);
    assert.deepEqual(projection.trees, []);
    assert.ok(projection.diagnostics.some(item => item.code === 'unresolved-reference'));
    noDisclosure(projection, privateBody, path, 'PRIVATE-LABEL', 'ToPiC');
  });
}

test('actual filename or semantic metadata title is never invented as a Markdown root heading', () => {
  for (const [title, anchor] of [['', 'B'], ['title: Catalog title\n', 'Catalog title']]) {
    const visible = parse('hybrid/A.md', publicNote('source', 'Source', `[[./B.md#${anchor}]]`));
    const target = parse('hybrid/B.md', `---\nforester-id: target\n${title}---\n${privateBody}`);
    const index = indexHybrid([visible, target]);
    assert.equal(resolveHybrid(index, `./B.md#${anchor}`, visible.path).status, 'missing');
    const projection = projectPublic(index);
    assert.deepEqual(projection.trees, []);
    assert.ok(projection.diagnostics.some(item => item.code === 'unresolved-reference'));
    noDisclosure(projection, privateBody, target.path);
  }
});

test('actual child bibliography does not inherit undeclared private-parent citation fields', () => {
  const document = parse('hybrid/PRIVATE-NOTE.md',
    '---\nforester-id: private-root\ncitation-authors: [PRIVATE-AUTHOR]\npublication-year: PRIVATE-YEAR\n---\n' +
    `# Private parent\n${privateBody}\n## Public child ^child\n%% publish: true %%\nVisible`);
  const projection = projectPublic(indexHybrid([document]));
  assert.deepEqual(projection.diagnostics, []);
  assert.deepEqual(projection.trees[0].citationAuthors, []);
  assert.equal(projection.trees[0].publicationYear, undefined);
  noDisclosure(projection, privateBody, 'PRIVATE-AUTHOR', 'PRIVATE-YEAR', 'PRIVATE-NOTE', 'Private parent');
});

test('actual save/reparse projection preserves uppercase island IDs and YAML exponent-shaped IDs', () => {
  const document = parse('hybrid/SECRET-FILENAME.md',
    `# Private parent\n${privateBody}\n## Public island\n%% publish: true %%\n[[#Public island|Approved label]]`);
  const ids = ['1E0000', 'ABCDEF'];
  const plan = planHybridSave(indexHybrid([document]), document.path, () => ids.shift());
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.edits.length, 1);
  assert.equal(plan.edits[0].before, document.source);
  const updated = parse(document.path, plan.edits[0].after);
  assert.equal(updated.root.id, '1E0000');
  assert.equal(updated.trees[1].id, 'ABCDEF');
  const index = indexHybrid([updated]);
  assert.equal(index.ids.get('abcdef')[0].id, 'ABCDEF');
  assert.equal(resolveHybrid(index, 'abcdef', document.path).tree.id, 'ABCDEF');
  const projection = projectPublic(index);
  assert.deepEqual(projection.diagnostics, []);
  assert.deepEqual(projection.trees, [{ id: 'ABCDEF', title: 'Public island',
    body: '[[ABCDEF|Approved label]]', citationAuthors: [] }]);
  noDisclosure(projection, privateBody, 'SECRET-FILENAME', 'Private parent', '1E0000');
  assert.deepEqual(planHybridSave(index, updated.path, () => { throw new Error('must not mint again'); }).edits, []);
});
