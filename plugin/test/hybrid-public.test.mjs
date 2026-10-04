import test from 'node:test';
import assert from 'node:assert/strict';

let projectPublic;
try {
  ({ projectPublic } = await import('./build/hybrid-public.mjs'));
} catch (error) {
  if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
}

const SECRET = 'CANARY-PRIVATE-BODY';
const SECRET_TITLE = 'CANARY-PRIVATE-TITLE';
const SECRET_PATH = 'CANARY-PRIVATE-PATH/private.md';
const SECRET_AUTHOR = 'CANARY-PRIVATE-AUTHOR';
const SECRET_DATE = 'CANARY-PRIVATE-DATE';

/** Explicit shared-contract fixtures, with real JS-string source offsets. */
function documentFixture({ path = SECRET_PATH, id, title = SECRET_TITLE, publish = false,
  publicTitle = false, intro = '', sections = [], meta = {}, diagnostics = [] } = {}) {
  const frontmatter = { title, publish, authors: [SECRET_AUTHOR], dates: [SECRET_DATE],
    arbitrary: SECRET, ...(id ? { id } : {}) };
  const prefix = `---\n${Object.entries(frontmatter).map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join('\n')}\n---\n`;
  let source = prefix;
  const trees = [];
  const rootMeta = { title, authors: [SECRET_AUTHOR], dates: [SECRET_DATE],
    citationAuthors: [], publish, publicTitle, ...meta };
  const root = { key: `${path}:root`, ...(id ? { id } : {}), path, level: 0,
    line: prefix.split('\n').length, endLine: 0, from: prefix.length, to: 0,
    contentFrom: prefix.length, meta: rootMeta, metadataRanges: [], children: [], number: '' };
  trees.push(root);
  source += intro;
  function append(spec, parent) {
    const from = source.length;
    const level = spec.level ?? (parent.level ? parent.level + 1 : 2);
    const heading = `${'#'.repeat(level)} ${spec.title ?? 'Public section'}${spec.id ? ` ^${spec.id}` : ''}\n`;
    const treeMeta = { ...parent.meta, title: spec.title ?? 'Public section', ...spec.meta };
    source += heading;
    const metadataRanges = [];
    if (spec.directive) {
      const start = source.length;
      source += `${spec.directive}\n`;
      metadataRanges.push({ from: start, to: source.length });
    }
    const tree = { key: `${path}:${from}`, ...(spec.id ? { id: spec.id } : {}),
      path, parentKey: parent.key, level, line: source.slice(0, from).split('\n').length,
      endLine: 0, from, to: 0, contentFrom: source.length,
      meta: treeMeta, metadataRanges, children: [], number: `${parent.children.length + 1}` };
    parent.children.push(tree);
    trees.push(tree);
    source += spec.body ?? '';
    for (const child of spec.children ?? []) append(child, tree);
    tree.to = source.length;
    tree.endLine = source.split('\n').length;
  }
  for (const section of sections) append(section, root);
  root.to = source.length;
  root.endLine = source.split('\n').length;
  return { path, source, enabled: true, frontmatter, root, trees,
    protectedRanges: [], raw: [], diagnostics };
}

function indexFixture(...documents) {
  const ids = new Map();
  for (const document of documents) {
    for (const tree of document.trees) {
      if (tree.id) ids.set(tree.id.toLowerCase(), [...(ids.get(tree.id.toLowerCase()) ?? []), tree]);
    }
  }
  return { documents: new Map(documents.map(document => [document.path, document])), ids, diagnostics: [] };
}

function noSecrets(projection, forbidden = [SECRET, SECRET_TITLE, SECRET_PATH, SECRET_AUTHOR, SECRET_DATE]) {
  const json = JSON.stringify(projection);
  for (const secret of forbidden) assert.ok(!json.includes(secret), `leaked canary: ${secret}`);
}

function failClosed(projection, code) {
  assert.deepEqual(projection.trees, []);
  assert.ok(projection.diagnostics.some(item => item.severity === 'error' && item.code === code),
    `expected safe ${code} error, got ${JSON.stringify(projection.diagnostics)}`);
  noSecrets(projection);
}

test('metadata ranges and directive comments are never exported as public body', () => {
  const document = documentFixture({ id: 'visible-root', title: 'Visible root', publish: true,
    intro: `Visible\n<!-- arbitrary: ${SECRET} -->\n%% authors: ${SECRET_AUTHOR} %%\n`, sections: [
      { title: 'Visible child', directive: `<!-- tree: {dates: [${SECRET_DATE}]} -->`, body: 'Child body\n' },
    ] });
  const projection = projectPublic(indexFixture(document));
  assert.equal(projection.trees[0].body, 'Visible\n\n\n## Visible child\nChild body');
  noSecrets(projection);
});

for (const [name, document] of [
  ['root', documentFixture({ title: 'Public root', publish: true, intro: 'Visible' })],
  ['private parent', documentFixture({ sections: [{ title: 'Public island', meta: { publish: true }, body: 'Visible' }] })],
  ['private boundary inside public ancestor', documentFixture({ id: 'public-root', title: 'Public', publish: true, sections: [
    { title: SECRET_TITLE, meta: { publish: false }, body: SECRET, children: [
      { title: 'Unaddressed island', meta: { publish: true }, body: 'Visible' },
    ] },
  ] })],
]) {
  test(`an unaddressed public visibility island fails closed: ${name}`, () => {
    failClosed(projectPublic(indexFixture(document)), 'unaddressed-public-tree');
  });
}

for (const publicCollision of [false, true]) {
  test(`vault-wide ID collisions block export even when a target is private: ${publicCollision}`, () => {
    const visible = documentFixture({ path: 'visible.md', id: 'visible', title: 'Public', publish: true, intro: 'Visible' });
    const first = documentFixture({ path: SECRET_PATH, id: 'collision', intro: SECRET });
    const second = documentFixture({ path: 'other-private.md', id: 'collision',
      publish: publicCollision, title: publicCollision ? 'Public collision' : SECRET_TITLE, intro: publicCollision ? 'Visible' : SECRET });
    failClosed(projectPublic(indexFixture(visible, first, second)), 'id-collision');
  });
}

for (const origin of ['index', 'document']) {
  test(`source errors block export without disclosing diagnostic payloads: ${origin}`, () => {
    const document = documentFixture({ id: 'public', title: 'Public', publish: true, intro: 'Visible' });
    const index = indexFixture(document);
    const diagnostic = { code: SECRET_TITLE, message: SECRET, path: SECRET_PATH, line: 999, severity: 'error' };
    if (origin === 'index') index.diagnostics.push(diagnostic);
    else document.diagnostics.push(diagnostic);
    failClosed(projectPublic(index), 'invalid-source');
  });
}

test('private links redact both explicit labels and ID destinations', () => {
  const hiddenId = 'private-secret-id';
  const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
    intro: `Before [[${hiddenId}|${SECRET_TITLE}]] after [[${hiddenId}]]` });
  const hidden = documentFixture({ id: hiddenId, intro: SECRET });
  const projection = projectPublic(indexFixture(visible, hidden));
  assert.equal(projection.trees[0].body, 'Before [非公開] after [非公開]');
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection, [SECRET, SECRET_TITLE, SECRET_PATH, SECRET_AUTHOR, SECRET_DATE, hiddenId]);
});

test('publicTitle grants only an inert locked title stub, never a private route or label', () => {
  const hiddenId = 'private-secret-id';
  const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
    intro: `See [[${hiddenId}|${SECRET_TITLE}]].` });
  const hidden = documentFixture({ id: hiddenId, title: 'Approved [title]', publicTitle: true, intro: SECRET });
  const projection = projectPublic(indexFixture(visible, hidden));
  assert.equal(projection.trees[0].body, 'See Approved \\[title\\] 🔒.');
  assert.equal(projection.trees.length, 1);
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection, [SECRET, SECRET_TITLE, SECRET_PATH, SECRET_AUTHOR, SECRET_DATE, hiddenId]);
});

for (const publicTitle of [false, true]) {
  test(`private embeds fail closed even when the title is public: ${publicTitle}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
      intro: `![[private-secret-id|${SECRET_TITLE}]]` });
    const hidden = documentFixture({ id: 'private-secret-id', publicTitle, intro: SECRET });
    failClosed(projectPublic(indexFixture(visible, hidden)), 'private-embed');
  });
}

test('same-file sibling references use the tree index and public destinations contain only IDs', () => {
  const document = documentFixture({ id: 'private-root', intro: `${SECRET}\n`, sections: [
    { id: 'source', title: 'Source', meta: { publish: true },
      body: `[[#Target]] [[#^target|Explicit label]] [[${SECRET_PATH}#Target]] [[#^hidden-sibling|${SECRET_TITLE}]]\n` },
    { id: 'target', title: 'Target', meta: { publish: true }, body: 'Target body\n' },
    { id: 'hidden-sibling', title: SECRET_TITLE, body: `${SECRET}\n` },
  ] });
  const projection = projectPublic(indexFixture(document));
  assert.equal(projection.trees.find(tree => tree.id === 'source').body,
    '[[target|Target]] [[target|Explicit label]] [[target|Target]] [非公開]');
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection);
});

for (const syntax of ['[[missing-private-target|CANARY-PRIVATE-TITLE]]', '![[missing-private-target]]']) {
  test(`unresolved public references fail closed: ${syntax.startsWith('!') ? 'embed' : 'link'}`, () => {
    const visible = documentFixture({ id: 'visible', title: 'Public', publish: true, intro: syntax });
    failClosed(projectPublic(indexFixture(visible)), 'unresolved-reference');
  });
}

test('ambiguous heading references cannot choose between a public and private tree', () => {
  const document = documentFixture({ id: 'public', title: 'Public', publish: true, intro: '[[#Duplicate]]\n', sections: [
    { id: 'open', title: 'Duplicate', body: 'Visible\n' },
    { id: 'closed', title: 'Duplicate', meta: { publish: false }, body: `${SECRET}\n` },
  ] });
  failClosed(projectPublic(indexFixture(document)), 'unresolved-reference');
});

test('ambiguous file-name references cannot choose a private root', () => {
  const visible = documentFixture({ path: 'public.md', id: 'visible', title: 'Public', publish: true, intro: '[[same]]' });
  const hidden = documentFixture({ path: 'private/same.md', id: 'hidden', intro: SECRET });
  const open = documentFixture({ path: 'open/same.md', id: 'open', title: 'Open', publish: true, intro: 'Visible' });
  failClosed(projectPublic(indexFixture(visible, hidden, open)), 'unresolved-reference');
});

test('Markdown code examples stay literal while nearby live private references are redacted', () => {
  const body = '    [[missing-code-target]]\n\nLive [[private]]\n`[[private]]` and ``{ref:[[missing-citation]]}``\n' +
    '~~~~forester\n\\{ \\import{example} }\n<!-- literal code comment -->\n![[private]]\n![example](example.png)\n<script>example</script>\n~~~~\n';
  const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true, intro: body });
  const hidden = documentFixture({ id: 'private', intro: SECRET });
  const projection = projectPublic(indexFixture(visible, hidden));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees[0].body, body.replace('Live [[private]]', 'Live [非公開]').trimEnd());
  noSecrets(projection);
});

for (const syntax of [
  `\\{ \\import{${SECRET_PATH}} \\transclude{${SECRET}} }`,
  `\\import{${SECRET_PATH}}`,
]) {
  test(`live raw Forester is unsupported and never echoed: ${syntax.startsWith('\\{') ? 'block' : 'macro'}`, () => {
    const visible = documentFixture({ id: 'public', title: 'Public', publish: true, intro: syntax });
    visible.raw.push({ from: visible.root.from, to: visible.root.to,
      codeFrom: visible.root.from, codeTo: visible.root.to, code: `${SECRET} ${SECRET_PATH}` });
    failClosed(projectPublic(indexFixture(visible)), 'unsupported-raw');
  });
}

for (const [name, syntax] of [
  ['script', `<script>${SECRET}</script>`],
  ['unsafe link', `<a href="javascript:alert(1)">${SECRET_TITLE}</a>`],
  ['resource loading', `<img src="${SECRET_PATH}" onerror="alert(1)">`],
  ['SVG', `<svg><use href="${SECRET_PATH}"></use></svg>`],
]) {
  test(`raw HTML fails closed without disclosing source attributes: ${name}`, () => {
    const visible = documentFixture({ id: 'public', title: 'Public', publish: true, intro: syntax });
    failClosed(projectPublic(indexFixture(visible)), 'unsafe-html');
  });
}

for (const [name, syntax] of [
  ['wiki image', `![[${SECRET_PATH}.png]]`],
  ['wiki attachment', `![[${SECRET_PATH}.pdf|${SECRET_TITLE}]]`],
  ['inline image', `![${SECRET_TITLE}](${SECRET_PATH}.png)`],
  ['remote image', `![${SECRET_TITLE}](https://example.com/private.png)`],
  ['reference image', `![${SECRET_TITLE}][asset]\n\n[asset]: ${SECRET_PATH}.png`],
]) {
  test(`asset dependencies require a vetted manifest and never disclose filenames: ${name}`, () => {
    const visible = documentFixture({ id: 'public', title: 'Public', publish: true, intro: syntax });
    failClosed(projectPublic(indexFixture(visible)), 'unvetted-asset');
  });
}

for (const [name, syntax] of [
  ['javascript', '[bad](javascript:alert(1))'],
  ['data', '[bad](data:text/html;base64,AAAA)'],
  ['file', `[bad](file:///${SECRET_PATH})`],
  ['mixed case', '[bad](JaVaScRiPt:alert(1))'],
  ['entity scheme', '[bad](java&#x73;cript:alert(1))'],
  ['encoded scheme', '[bad](javascript%3Aalert(1))'],
  ['angle destination', '[bad](<javascript:alert(1)>)'],
  ['reference definition', '[bad][hidden]\n\n[hidden]: javascript:alert(1)'],
  ['autolink', '<javascript:alert(1)>'],
]) {
  test(`unsafe Markdown URLs fail closed: ${name}`, () => {
    const visible = documentFixture({ id: 'public', title: 'Public', publish: true, intro: syntax });
    failClosed(projectPublic(indexFixture(visible)), 'unsafe-url');
  });
}

test('safe external Markdown links and autolinks remain usable', () => {
  const body = '[Web](https://example.org/x?a=1&b=2 "title") <https://example.org/path> [Email](mailto:test@example.org)';
  const visible = documentFixture({ id: 'public', title: 'Public', publish: true, intro: body });
  const projection = projectPublic(indexFixture(visible));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees[0].body, body);
  noSecrets(projection);
});

test('public embeds expand the sanitized target body, never its private ancestors or children', () => {
  const visible = documentFixture({ path: 'public.md', id: 'source', title: 'Source', publish: true, intro: '![[island]]' });
  const hidden = documentFixture({ id: 'private-root', intro: `${SECRET}\n`, sections: [
    { id: 'island', title: 'Visible target', meta: { publish: true }, body: 'Visible body\n', children: [
      { id: 'hidden-child', title: SECRET_TITLE, meta: { publish: false }, body: `${SECRET}\n` },
    ] },
  ] });
  const projection = projectPublic(indexFixture(visible, hidden));
  assert.equal(projection.trees.find(tree => tree.id === 'source').body, '## Visible target\n\nVisible body');
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection);
});

for (const indirect of [false, true]) {
  test(`cyclic public embeds are diagnosed instead of recursing or exporting partial output: ${indirect}`, () => {
    const first = documentFixture({ path: 'first.md', id: 'first', title: 'First', publish: true,
      intro: indirect ? '![[second]]' : '![[first]]' });
    const second = documentFixture({ path: 'second.md', id: 'second', title: 'Second', publish: true, intro: '![[first]]' });
    let projection;
    assert.doesNotThrow(() => { projection = projectPublic(indexFixture(first, ...(indirect ? [second] : []))); });
    failClosed(projection, 'embed-cycle');
  });
}

test('bibliographic metadata inherited from a private ancestor is not public reference data', () => {
  const document = documentFixture({ id: 'private-root', meta: { citationAuthors: [SECRET_AUTHOR], publicationYear: SECRET_DATE },
    intro: `${SECRET}\n`, sections: [
      { id: 'inherited', title: 'Public', meta: { publish: true }, body: 'Visible\n' },
      { id: 'declared', title: 'Declared reference', meta: { publish: true, citationAuthors: ['Public author'], publicationYear: '2024' },
        directive: '<!-- tree: {citationAuthors: [Public author], publicationYear: 2024} -->', body: 'Visible\n' },
    ] });
  const projection = projectPublic(indexFixture(document));
  assert.deepEqual(projection.trees.find(tree => tree.id === 'inherited'),
    { id: 'inherited', title: 'Public', body: 'Visible', citationAuthors: [] });
  assert.deepEqual(projection.trees.find(tree => tree.id === 'declared').citationAuthors, ['Public author']);
  assert.equal(projection.trees.find(tree => tree.id === 'declared').publicationYear, '2024');
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection);
});

test('public citations use only separately visible bibliographic authors and publication year', () => {
  const visible = documentFixture({ path: 'public.md', id: 'source', title: 'Source', publish: true, intro: 'See {ref:[[reference]]}.' });
  const reference = documentFixture({ path: 'reference.md', id: 'reference', title: 'Reference', publish: true,
    meta: { citationAuthors: ['Author A', 'Author B'], publicationYear: '2024', taxon: 'Reference' }, intro: 'Reference body' });
  const projection = projectPublic(indexFixture(visible, reference));
  assert.equal(projection.trees.find(tree => tree.id === 'source').body, 'See (Author A, Author B, 2024).');
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection);
});

for (const missing of ['authors', 'year']) {
  test(`missing public citation metadata is an error, not note author/date fallback: ${missing}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'source', title: 'Source', publish: true, intro: '{ref:[[reference]]}' });
    const reference = documentFixture({ path: 'reference.md', id: 'reference', title: 'Reference', publish: true,
      meta: missing === 'authors' ? { publicationYear: '2024' } : { citationAuthors: ['Author'] }, intro: 'Visible' });
    failClosed(projectPublic(indexFixture(visible, reference)), 'missing-citation-metadata');
  });
}

for (const publicTitle of [false, true]) {
  test(`private citations never disclose bibliographic data even with a public title: ${publicTitle}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'source', title: 'Source', publish: true, intro: 'See {ref:[[reference]]}.' });
    const reference = documentFixture({ id: 'reference', title: publicTitle ? 'Approved title' : SECRET_TITLE, publicTitle,
      meta: { citationAuthors: [SECRET_AUTHOR], publicationYear: SECRET_DATE }, intro: SECRET });
    const projection = projectPublic(indexFixture(visible, reference));
    assert.equal(projection.trees[0].body, publicTitle ? 'See Approved title 🔒.' : 'See [非公開].');
    assert.deepEqual(projection.diagnostics, []);
    noSecrets(projection);
  });
}

for (const [name, syntax] of [
  ['inline-code label', '[bad `example`](javascript:alert(1))'],
  ['multiline label', '[bad\nlabel](javascript:alert(1))'],
  ['split reference definition', '[bad][hidden]\n\n[hidden]:\n javascript:alert(1)'],
]) {
  test(`unsupported link shapes cannot bypass URL validation: ${name}`, () => {
    const visible = documentFixture({ id: 'public', title: 'Public', publish: true, intro: syntax });
    failClosed(projectPublic(indexFixture(visible)), 'unsafe-url');
  });
}

test('inline backticks inside raw HTML do not turn an active tag into a trusted code example', () => {
  const visible = documentFixture({ id: 'public', title: 'Public', publish: true,
    intro: `<img src="${SECRET_PATH}" alt="\`example\`" onerror="alert(1)">` });
  failClosed(projectPublic(indexFixture(visible)), 'unsafe-html');
});

for (const syntax of ['[[disabled|CANARY-PRIVATE-TITLE]]', '![[disabled]]', '{ref:[[disabled]]}']) {
  test(`disabled documents never grant public visibility: ${syntax.startsWith('!') ? 'embed' : syntax.startsWith('{') ? 'citation' : 'link'}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true, intro: syntax });
    const disabled = documentFixture({ id: 'disabled', publish: true, publicTitle: true,
      meta: { citationAuthors: [SECRET_AUTHOR], publicationYear: SECRET_DATE }, intro: SECRET });
    disabled.enabled = false;
    const projection = projectPublic(indexFixture(visible, disabled));
    if (syntax.startsWith('!')) failClosed(projection, 'private-embed');
    else {
      assert.equal(projection.trees[0].body, '[非公開]');
      assert.deepEqual(projection.diagnostics, []);
      noSecrets(projection);
    }
  });
}

for (const publicTitle of [false, true]) {
  test(`local Markdown links obey the same private-title policy as wikilinks: ${publicTitle}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
      intro: `[${SECRET_TITLE}](${SECRET_PATH})` });
    const hidden = documentFixture({ id: 'hidden', title: publicTitle ? 'Approved title' : SECRET_TITLE, publicTitle, intro: SECRET });
    const projection = projectPublic(indexFixture(visible, hidden));
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.trees[0].body, publicTitle ? 'Approved title 🔒' : '[非公開]');
    noSecrets(projection);
  });
}

test('local Markdown links to a public island use its ID instead of a private note path', () => {
  const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
    intro: `[Visible label](${SECRET_PATH}#^island)` });
  const hidden = documentFixture({ intro: `${SECRET}\n`, sections: [
    { id: 'island', title: 'Island', meta: { publish: true }, body: 'Visible\n' },
  ] });
  const projection = projectPublic(indexFixture(visible, hidden));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees[0].body, '[[island|Visible label]]');
  noSecrets(projection);
});

test('local Markdown asset links cannot export unvetted source filenames', () => {
  const visible = documentFixture({ id: 'public', title: 'Public', publish: true, intro: `[download](${SECRET_PATH}.pdf)` });
  failClosed(projectPublic(indexFixture(visible)), 'unvetted-asset');
});

for (const id of ['bad/path', 'bad|route', ' ABCDEF ', 'bad_id']) {
  test(`malformed IDs are rejected without inventing or repairing a route: ${JSON.stringify(id)}`, () => {
    const visible = documentFixture({ id, title: 'Public', publish: true, intro: 'Visible' });
    failClosed(projectPublic(indexFixture(visible)), 'invalid-id');
  });
}

for (const [name, corrupt] of [
  ['frontmatter included in body range', document => { document.root.contentFrom = 0; }],
  ['negative source offset', document => { document.root.from = -1; }],
  ['out-of-bounds source offset', document => { document.root.to = document.source.length + 1; }],
  ['metadata range outside its tree', document => { document.root.metadataRanges.push({ from: -1, to: 1 }); }],
]) {
  test(`invalid source ranges fail closed rather than slicing private text: ${name}`, () => {
    const document = documentFixture({ id: 'public', title: 'Public', publish: true, intro: 'Visible' });
    corrupt(document);
    failClosed(projectPublic(indexFixture(document)), 'invalid-index');
  });
}

test('a child missing from the flattened index cannot leak through its public parent body', () => {
  const document = documentFixture({ id: 'public', title: 'Public', publish: true, intro: 'Visible\n', sections: [
    { id: 'hidden', title: SECRET_TITLE, meta: { publish: false }, body: `${SECRET}\n` },
  ] });
  const index = indexFixture(document);
  document.trees = [document.root];
  failClosed(projectPublic(index), 'invalid-index');
});

test('an ID map may not substitute an unindexed tree with different visibility', () => {
  const document = documentFixture({ id: 'public', title: 'Public', publish: true, intro: '[[hidden]]' });
  const hidden = documentFixture({ path: 'hidden.md', id: 'hidden', intro: SECRET });
  const index = indexFixture(document, hidden);
  index.ids.set('hidden', [{ ...hidden.root, meta: { ...hidden.root.meta, publish: true } }]);
  failClosed(projectPublic(index), 'invalid-index');
});

for (const [name, syntax] of [
  ['unterminated wikilink', '[[private-secret-id|CANARY-PRIVATE-TITLE'],
  ['multiline wikilink', '[[private\nsecret-id]]'],
  ['empty wikilink', '[[]]'],
  ['unterminated citation', '{ref:[[public]]'],
  ['inline-code label', '[[private-secret-id|`example`]]'],
]) {
  test(`unsupported reference shapes cannot export raw private destinations: ${name}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true, intro: syntax });
    const hidden = documentFixture({ id: 'private-secret-id', intro: SECRET });
    failClosed(projectPublic(indexFixture(visible, hidden)), 'unresolved-reference');
  });
}

test('a public self-citation reads bibliography without being mistaken for an embed cycle', () => {
  const document = documentFixture({ id: 'self', title: 'Public reference', publish: true,
    meta: { citationAuthors: ['Visible author'], publicationYear: '2024' }, intro: '{ref:[[self]]}' });
  const projection = projectPublic(indexFixture(document));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees[0].body, '(Visible author, 2024)');
  noSecrets(projection);
});

for (const [name, body] of [
  ['paragraph break', 'Opening `example\n\n[[private-secret-id|CANARY-PRIVATE-TITLE]]\n\nClosing`'],
  ['fenced block boundary', 'Opening `example\n~~~text\nLiteral example\n~~~\n[[private-secret-id|CANARY-PRIVATE-TITLE]]\nClosing`'],
]) {
  test(`inline code cannot hide a live reference across a Markdown block boundary: ${name}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true, intro: body });
    const hidden = documentFixture({ id: 'private-secret-id', intro: SECRET });
    const projection = projectPublic(indexFixture(visible, hidden));
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.trees[0].body, body.replace('[[private-secret-id|CANARY-PRIVATE-TITLE]]', '[非公開]'));
    noSecrets(projection);
  });
}

test('a mixed citation-author list cannot launder private inherited authors through a public addition', () => {
  const document = documentFixture({ id: 'private-root', meta: { citationAuthors: [SECRET_AUTHOR], publicationYear: SECRET_DATE }, sections: [
    { id: 'public-reference', title: 'Public reference', meta: { publish: true,
      citationAuthors: [SECRET_AUTHOR, 'Visible author'], publicationYear: '2024' }, body: 'Visible\n' },
  ] });
  const projection = projectPublic(indexFixture(document));
  assert.deepEqual(projection.trees[0].citationAuthors, ['Visible author']);
  assert.equal(projection.trees[0].publicationYear, '2024');
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection);
});

test('expanded public embeds retain literal code without reprocessing its Markdown links', () => {
  const example = '~~~text\n[example](file:///example.md)\n![example](example.png)\n![[private]]\n~~~';
  const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true, intro: '![[examples]]' });
  const target = documentFixture({ path: 'examples.md', id: 'examples', title: 'Code examples', publish: true, intro: example });
  const hidden = documentFixture({ id: 'private', intro: SECRET });
  const projection = projectPublic(indexFixture(visible, target, hidden));
  assert.deepEqual(projection.diagnostics, []);
  assert.equal(projection.trees.find(tree => tree.id === 'public').body, `## Code examples\n\n${example}`);
  noSecrets(projection);
});

test('embed composition cannot turn a fenced asset example into a live resource', () => {
  const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
    intro: `![[examples]]\n~~~\n![example](${SECRET_PATH}.png)\n~~~` });
  const target = documentFixture({ path: 'examples.md', id: 'examples', title: 'Code examples', publish: true,
    intro: '~~~text\nUnclosed fenced example\n' });
  failClosed(projectPublic(indexFixture(visible, target)), 'unvetted-asset');
});

for (const [name, literal, code] of [
  ['private reference', `[[private-secret-id|${SECRET_TITLE}]]`, 'unresolved-reference'],
  ['HTML resource', `<img src="${SECRET_PATH}">`, 'unsafe-html'],
  ['raw Forester', `\\{ \\import{${SECRET_PATH}} }`, 'unsupported-raw'],
]) {
  test(`embed composition cannot activate literal private dependencies: ${name}`, () => {
    const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
      intro: `![[examples]]\n~~~\n${literal}\n~~~` });
    const target = documentFixture({ path: 'examples.md', id: 'examples', title: 'Code examples', publish: true,
      intro: '~~~text\nUnclosed fenced example\n' });
    const hidden = documentFixture({ id: 'private-secret-id', intro: SECRET });
    failClosed(projectPublic(indexFixture(visible, target, hidden)), code);
  });
}

test('excessive public embed depth fails closed before exhausting the JavaScript stack', () => {
  const documents = Array.from({ length: 70 }, (_, i) => documentFixture({ path: `chain-${i}.md`, id: `chain-${i}`,
    title: 'Public', publish: true, intro: i === 69 ? 'Visible' : `![[chain-${i + 1}]]` }));
  let projection;
  assert.doesNotThrow(() => { projection = projectPublic(indexFixture(...documents)); });
  assert.equal(projection.trees.length, 0, 'over-budget expansion must not produce a partial public export');
  failClosed(projection, 'embed-limit');
});

test('excessive public embed fan-out fails closed without exponential expansion', () => {
  const visible = documentFixture({ path: 'public.md', id: 'public', title: 'Public', publish: true,
    intro: Array(1025).fill('![[leaf]]').join('\n') });
  const leaf = documentFixture({ path: 'leaf.md', id: 'leaf', title: 'Leaf', publish: true, intro: 'Visible' });
  const projection = projectPublic(indexFixture(visible, leaf));
  assert.equal(projection.trees.length, 0, 'over-budget expansion must not produce a partial public export');
  failClosed(projection, 'embed-limit');
});

test('default-private documents produce no public trees or private metadata', () => {
  assert.equal(typeof projectPublic, 'function', 'projectPublic must be implemented and bundled');
  const projection = projectPublic(indexFixture(documentFixture({ id: 'private-root', intro: SECRET })));
  assert.deepEqual(projection, { trees: [], diagnostics: [] });
  noSecrets(projection);
});

test('an addressed public visibility island exports only its whitelisted fields', () => {
  const document = documentFixture({ id: 'private-root', intro: `${SECRET}\n`, sections: [
    { id: 'open-section', title: '公開 🌳', meta: { publish: true, taxon: 'Reference',
      citationAuthors: ['Visible Author'], publicationYear: '2025' }, body: 'Published text\n' },
    { id: 'private-sibling', title: SECRET_TITLE, body: `${SECRET}\n` },
  ] });
  const projection = projectPublic(indexFixture(document));
  assert.deepEqual(projection, { trees: [{ id: 'open-section', title: '公開 🌳', taxon: 'Reference',
    body: 'Published text', citationAuthors: ['Visible Author'], publicationYear: '2025' }], diagnostics: [] });
  noSecrets(projection);
});

test('hidden child intervals are omitted while inherited public children stay embedded', () => {
  const document = documentFixture({ intro: `${SECRET} 🌳\n`, sections: [
    { id: 'island', title: 'Public island', meta: { publish: true }, body: 'Visible intro\n', children: [
      { title: 'Inherited child', body: 'Inherited public body\n' },
      { id: 'hidden', title: SECRET_TITLE, meta: { publish: false }, body: `${SECRET}\n`, children: [
        { id: 'reopened', title: 'Separate island', meta: { publish: true }, body: 'Independent visible body\n' },
      ] },
    ] },
  ] });
  const projection = projectPublic(indexFixture(document));
  assert.deepEqual(projection.trees.map(({ id, body }) => ({ id, body })), [
    { id: 'island', body: 'Visible intro\n### Inherited child\nInherited public body' },
    { id: 'reopened', body: 'Independent visible body' },
  ]);
  assert.deepEqual(projection.diagnostics, []);
  noSecrets(projection);
});
