import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Exercise fresh production code without writing bundles or using a stale test/build artifact.
const { outputFiles } = await build({
  entryPoints: [fileURLToPath(new URL('../src/hybrid-core.ts', import.meta.url))],
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'warning',
});
const core = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
const options = { folders: ['hybrid'], publicFolders: [], reservedIds: [] };
const parse = (source, overrides = {}) => core.parseHybrid('hybrid/Metadata.md', source, { ...options, ...overrides });

test('contributors are preserved on their declaring tree, not inherited like authors and dates', () => {
  const source = `---
authors: ["[[Alice]]"]
dates: ["[[2026-10-04]]"]
contributors: ["[[Root contributor]]"]
---
# Root
%% contributors: "[[Root comment contributor]]" %%
Root body
## Parent
%% forester
contributors: ["[[Parent contributor]]", "[[Another contributor]]"]
authors: Bob
dates: [2025]
%%
Parent body
### Child
Child body
## Sibling
Sibling body
`;
  const doc = parse(source);
  const [root, parent, child, sibling] = doc.trees;
  assert.deepEqual(root.meta.contributors, ['[[Root contributor]]', '[[Root comment contributor]]']);
  assert.deepEqual(parent.meta.contributors, ['[[Parent contributor]]', '[[Another contributor]]']);
  for (const tree of [child, sibling]) assert.equal(Object.hasOwn(tree.meta, 'contributors'), false);
  assert.deepEqual(child.meta.authors, ['[[Alice]]', 'Bob']);
  assert.deepEqual(child.meta.dates, ['[[2026-10-04]]', '2025']);
  assert.deepEqual(sibling.meta.authors, ['[[Alice]]']);
  assert.deepEqual(sibling.meta.dates, ['[[2026-10-04]]']);
  assert.deepEqual(doc.diagnostics, []);
  assert.equal(doc.source, source);
  assert.ok(source.slice(parent.contentFrom).startsWith('Parent body\n'));
});

test('recognized native properties survive frontmatter and subtree comments without inheritance', () => {
  const rootProperties = {
    position: ['Professor'], institution: ['[[University]]', '[[Institute]]'],
    venue: ['Root venue'], source: ['[[Source]]'], doi: ['10.1000/root'],
    orcid: ['0000-0000-0000-000X'], external: ['https://example.org/root'],
    slides: ['https://example.org/slides', '[[Slides]]'], video: ['https://example.org/video'],
    bibtex: ['@article{root,\n  title = {Root title}\n}'],
  };
  const localProperties = Object.fromEntries(Object.keys(rootProperties).map(key => [key, [`Local ${key}`, `Second ${key}`]]));
  const source = `---
position: Professor
institution: ["[[University]]", "[[Institute]]"]
venue: Root venue
source: "[[Source]]"
doi: 10.1000/root
orcid: 0000-0000-0000-000X
external: https://example.org/root
slides: [https://example.org/slides, "[[Slides]]"]
video: https://example.org/video
bibtex: |-
  @article{root,
    title = {Root title}
  }
custom-private: {nested: [not, native, properties]}
citation-authors: [Bibliographic author]
publication-year: 2024
---
# Root
Root body
## Parent
%% forester
${JSON.stringify(localProperties)}
%%
Parent body
### Child
Child body
## Sibling
Sibling body
`;
  const doc = parse(source);
  const [root, parent, child, sibling] = doc.trees;
  assert.deepEqual(root.meta.properties, rootProperties);
  assert.deepEqual(parent.meta.properties, localProperties);
  for (const tree of [child, sibling]) assert.equal(Object.hasOwn(tree.meta, 'properties'), false);
  assert.deepEqual(root.meta.citationAuthors, ['Bibliographic author']);
  assert.equal(root.meta.publicationYear, '2024');
  assert.deepEqual(parent.meta.citationAuthors, []);
  assert.equal(parent.meta.publicationYear, undefined);
  assert.deepEqual(doc.diagnostics, []);
  assert.equal(doc.source, source);
  assert.ok(source.slice(parent.contentFrom).startsWith('Parent body\n'));
});

test('author display flags stay local native properties without erasing inherited authors', () => {
  for (const value of [false, 'false', ['false'], true, 'true']) {
    const source = `---
${JSON.stringify({ authors: ['Alice'], dates: ['2026-10-04'], author: value, 'citation-authors': ['Cite'], 'publication-year': 2020 })}
---
# Root
Root body
## Parent
%% author: false, authors: Bob %%
Parent body
### Child
Child body
`;
    const doc = parse(source);
    const [root, parent, child] = doc.trees;
    assert.deepEqual(root.meta.properties, { author: [String(value)] });
    assert.deepEqual(parent.meta.properties, { author: ['false'] });
    assert.equal(Object.hasOwn(child.meta, 'properties'), false);
    assert.deepEqual(root.meta.authors, ['Alice']);
    assert.deepEqual(child.meta.authors, ['Alice', 'Bob']);
    assert.deepEqual(child.meta.dates, ['2026-10-04']);
    assert.deepEqual(root.meta.citationAuthors, ['Cite']);
    assert.equal(root.meta.publicationYear, '2020');
    assert.deepEqual(child.meta.citationAuthors, []);
    assert.equal(child.meta.publicationYear, undefined);
    assert.deepEqual(doc.diagnostics, []);
  }
});

test('malformed native metadata is rejected rather than flattened or stored as empty declarations', () => {
  const keys = ['contributors', 'position', 'institution', 'venue', 'source', 'doi', 'orcid', 'external', 'slides', 'video', 'bibtex', 'author'];
  const invalidValues = [null, 42, { nested: 'not text' }, [['nested list']], ['valid', 42], ['valid', null], ['valid', false]];
  for (const key of keys) {
    for (const value of [...invalidValues, ...(key === 'author' ? [] : [false, true])]) {
      const values = { publish: true, 'public-title': true, [key]: value };
      for (const subtree of [false, true]) {
        const source = subtree
          ? `---\npublish: true\n---\n# Root\nRoot body\n## Child\n%% ${JSON.stringify(values)} %%\nChild body\n`
          : `---\n${JSON.stringify(values)}\n---\n# Root\nRoot body\n`;
        const doc = parse(source, { publicFolders: ['hybrid'] });
        const tree = subtree ? doc.trees[1] : doc.root;
        assert.ok(doc.diagnostics.some(d => d.code === 'invalid-metadata' && d.severity === 'error' && d.line === tree.line && d.message.startsWith(`${key} `)), `${key}: ${JSON.stringify(value)}`);
        assert.equal(Object.hasOwn(tree.meta, key === 'contributors' ? 'contributors' : 'properties'), false);
        assert.equal(tree.meta.publish, false);
        assert.equal(tree.meta.publicTitle, false);
        assert.equal(doc.source, source);
        if (subtree) assert.equal(doc.root.meta.publish, true);
      }
    }
  }
});

// Characterize the probed parser contract: singular author/date are not attribution aliases.
test('singular author and date do not populate plural attribution or publication citation fields', () => {
  const doc = parse(`---
author: Alice
date: 2026-10-04
---
# Root
Root body
## Child
%% author: Bob, date: 2025 %%
Child body
`);
  assert.deepEqual(doc.root.meta.properties, { author: ['Alice'] });
  assert.deepEqual(doc.trees[1].meta.properties, { author: ['Bob'] });
  for (const tree of doc.trees) {
    assert.deepEqual(tree.meta.authors, []);
    assert.deepEqual(tree.meta.dates, []);
    assert.deepEqual(tree.meta.citationAuthors, []);
    assert.equal(tree.meta.publicationYear, undefined);
  }
  assert.deepEqual(doc.diagnostics, []);
});

test('optional native fields remain absent for unknown metadata and disabled documents', () => {
  const source = `---
properties: {institution: [must not flatten]}
custom-private: {nested: [must, stay, unknown]}
---
# Root
%% properties: {venue: [must not flatten]} %%
Root body
## Child
Child body
`;
  const enabled = parse(source);
  assert.deepEqual(enabled.frontmatter.properties, { institution: ['must not flatten'] });
  assert.deepEqual(enabled.diagnostics, []);
  const disabled = parse('---\nforester-mode: false\ncontributors: Alice\nvenue: Private\nauthor: false\n---\n# Root\n');
  assert.equal(disabled.enabled, false);
  for (const doc of [enabled, disabled]) {
    for (const tree of doc.trees) {
      assert.equal(Object.hasOwn(tree.meta, 'contributors'), false);
      assert.equal(Object.hasOwn(tree.meta, 'properties'), false);
    }
  }
});

test('successive native declarations accumulate without mutating the CRLF source or body ranges', () => {
  const source = `---
contributors: First
venue: [First venue]
---
%% venue: Before H1, contributors: Before H1 %%
# Root
%% forester
venue: [After H1, "[[Venue]]"]
contributors: After H1
%%
Root body
## Child
%% venue: Child venue %%
%% venue: [Second child venue], contributors: [Child contributor] %%
Child body
`.replace(/\n/g, '\r\n');
  const doc = parse(source);
  assert.deepEqual(doc.root.meta.properties, { venue: ['First venue', 'Before H1', 'After H1', '[[Venue]]'] });
  assert.deepEqual(doc.root.meta.contributors, ['First', 'Before H1', 'After H1']);
  assert.deepEqual(doc.trees[1].meta.properties, { venue: ['Child venue', 'Second child venue'] });
  assert.deepEqual(doc.trees[1].meta.contributors, ['Child contributor']);
  assert.equal(doc.root.contentFrom, source.indexOf('Root body'));
  assert.equal(doc.trees[1].contentFrom, source.indexOf('Child body'));
  assert.equal(doc.root.metadataRanges.length, 3);
  assert.equal(doc.trees[1].metadataRanges.length, 2);
  assert.deepEqual(doc.diagnostics, []);
  assert.equal(doc.source, source);
  const empty = parse('---\ncontributors: []\nbibtex: []\n---\n# Root\n');
  assert.deepEqual(empty.root.meta.contributors, []);
  assert.deepEqual(empty.root.meta.properties, { bibtex: [] });
  assert.deepEqual(empty.diagnostics, []);
});

test('preserving local native metadata does not extend the public projection contract', async () => {
  const { outputFiles } = await build({
    entryPoints: [fileURLToPath(new URL('../src/hybrid-public.ts', import.meta.url))],
    bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'warning',
  });
  const { projectPublic } = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`);
  const doc = parse(`---
forester-id: PRIVATE
publish: false
contributors: PRIVATE-CONTRIBUTOR-CANARY
institution: PRIVATE-INSTITUTION-CANARY
author: false
citation-authors: [PRIVATE-CITATION-CANARY]
publication-year: 2001
---
# Private
PRIVATE-BODY-CANARY
## Public ^PUBLIC
%% forester
publish: true
contributors: LOCAL-CONTRIBUTOR-CANARY
institution: LOCAL-INSTITUTION-CANARY
author: false
citation-authors: [Cite]
publication-year: 2024
%%
Public body
### Private child ^CHILD
%% publish: false %%
PRIVATE-CHILD-CANARY
`);
  assert.deepEqual(doc.root.meta.contributors, ['PRIVATE-CONTRIBUTOR-CANARY']);
  assert.deepEqual(doc.trees[1].meta.contributors, ['LOCAL-CONTRIBUTOR-CANARY']);
  assert.deepEqual(doc.trees[1].meta.properties, { institution: ['LOCAL-INSTITUTION-CANARY'], author: ['false'] });
  assert.deepEqual(projectPublic(core.indexHybrid([doc])), {
    trees: [{ id: 'PUBLIC', title: 'Public', body: 'Public body', citationAuthors: ['Cite'], publicationYear: '2024' }],
    diagnostics: [],
  });
});
