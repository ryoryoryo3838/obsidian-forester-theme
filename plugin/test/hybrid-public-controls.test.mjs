import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseHybrid, indexHybrid, resolveHybrid, planHybridSave } from './build/hybrid-core.mjs';
import { projectPublicForest } from './build/hybrid-public-forest.mjs';
import { projectPublic, privateImageRanges } from './build/hybrid-public.mjs';

const options = { folders: [], publicFolders: [], reservedIds: [] };
const prefix = '---\nforester-id: PUBLICA\ntitle: Public A\npublish: true\n---\n';
const doc = (path, source, overrides = {}) => parseHybrid(path, source, { ...options, ...overrides });
const publicDoc = body => doc('Public.md', prefix + body);
const sha = text => createHash('sha256').update(text).digest('hex');
const identities = document => document.trees.map(t => [t.key, t.id, t.from, t.contentFrom, t.to, t.meta.publish, t.meta.publicTitle]);
// Projection must not rewrite source or change the shared local parser's IDs/ranges.
function project(...documents) {
  const snapshots = documents.map(d => ({ source: d.source, hash: sha(d.source), ids: identities(d) }));
  const result = projectPublicForest(indexHybrid(documents));
  documents.forEach((d, i) => {
    assert.equal(d.source, snapshots[i].source);
    assert.equal(sha(d.source), snapshots[i].hash);
    assert.deepEqual(identities(d), snapshots[i].ids);
    assert.deepEqual(identities(doc(d.path, d.source, d.enabled ? {} : { excludedFolders: ['/'] })), snapshots[i].ids);
  });
  return result;
}
const root = result => result.forest.trees.find(t => t.id === 'PUBLICA');
const noCanary = result => assert.ok(!JSON.stringify(result).includes('CANARY'), 'public payload/diagnostics cannot carry private data');

// Vertical slice 1: known-private embed, real parse → resolve → public-v2.
test('known private embeds become closed unavailable nodes without source changes', () => {
  const local = publicDoc('Before.\n\n![[CANARYPATH/Secret|CANARYALIAS]] %%ht%%\n\nAfter.\n');
  const secret = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY\n');
  assert.equal(resolveHybrid(indexHybrid([local, secret]), 'CANARYPATH/Secret', local.path).tree, secret.root);
  const result = project(local, secret);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [
    { kind: 'markdown', text: 'Before.' },
    { kind: 'unavailable' },
    { kind: 'markdown', text: 'After.' },
  ]);
  assert.deepEqual(result.forest.trees.map(t => t.id), ['PUBLICA']);
  assert.deepEqual(result.forest.assets, []);
  noCanary(result);
});

test('unavailable label uses only the independently authorized semantic public title', () => {
  const secret = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: Approved semantic title\npublic-title: true\n---\nCANARYBODY\n');
  const result = project(publicDoc('![[CANARYPRIVATEID|CANARYALIAS]]\n'), secret);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'unavailable', label: 'Approved semantic title' }]);
  assert.equal(secret.root.meta.publish, false, 'title permission cannot authorize body');
  noCanary(result);
});

test('unavailable labels reject unsafe authorized title payloads with source-free diagnostics', () => {
  for (const title of ['Approved <!-- CANARYCOMMENT -->', '[[CANARYPRIVATEID]]', '%%CANARY%%', 'CANARY\u0000', 'CANARY\nTITLE', 'CANARY\tTITLE', '<img src=CANARY>']) {
    const secret = doc('CANARYPATH/Secret.md', `---\nforester-id: CANARYPRIVATEID\ntitle: ${JSON.stringify(title)}\npublic-title: true\n---\nCANARYBODY\n`);
    const result = project(publicDoc('![[CANARYPRIVATEID]]\n'), secret);
    assert.deepEqual(result.forest.trees, [], title);
    assert.ok(result.diagnostics.some(d => d.severity === 'error'), title);
    noCanary(result);
  }
});

test('public-title cannot authorize filename fallback in an unavailable node', () => {
  const secret = doc('CANARYFILENAME.md', '---\nforester-id: CANARYPRIVATEID\npublic-title: true\n---\nCANARYBODY\n');
  assert.equal(secret.root.meta.titleSource, 'filename');
  const result = project(publicDoc('![[CANARYPRIVATEID]]\n'), secret);
  assert.deepEqual(result.forest.trees, []);
  assert.ok(result.diagnostics.some(d => d.code === 'implicit-public-title'));
  noCanary(result);
});

test('resolved private targets need no tree ID to become unavailable', () => {
  const secret = doc('CANARYFILENAME.md', '# CANARYTITLE\nCANARYBODY\n## CANARYHEADING\nCANARYCHILD\n');
  assert.equal(secret.root.id, undefined);
  const result = project(publicDoc('![[CANARYFILENAME]]\n\n![[CANARYFILENAME#CANARYHEADING]]\n'), secret);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'unavailable' }, { kind: 'unavailable' }]);
  noCanary(result);
});

test('standalone wikilink image p is omitted only from public output', () => {
  const local = publicDoc('Before.\n\n![[CANARYPATH/photo.jpg|CANARYALT]] %%p%%\n\nAfter.\n## Child ^CHILD\nChild body.\n');
  const before = identities(local);
  const result = project(local);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content[0], { kind: 'markdown', text: 'Before.\n\n\nAfter.' });
  assert.equal(root(result).content[1].tree.id, 'CHILD');
  assert.deepEqual(result.forest.assets, []);
  assert.deepEqual(identities(local), before, 'binary image creates no tree identity');
  assert.ok(local.source.includes('![[CANARYPATH/photo.jpg|CANARYALT]] %%p%%'));
  noCanary(result);
});

test('standalone Markdown image p omits target and private alt from the public forest', () => {
  const local = publicDoc('Before.\n\n![CANARYALT](CANARYPATH/photo.jpg) %%p%%\n\nAfter.\n');
  const result = project(local);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'markdown', text: 'Before.\n\n\nAfter.' }]);
  assert.ok(local.source.includes('![CANARYALT](CANARYPATH/photo.jpg) %%p%%'));
  assert.deepEqual(result.forest.assets, []);
  noCanary(result);
});

test('the legacy public projection also omits private image occurrences without changing local source', () => {
  const local = publicDoc('Before.\n\n![[CANARYPATH/photo.jpg|600x400]] %%p%%\n\n![CANARYALT](CANARYPATH/photo.jpg) %%p%%\n\nAfter.\n');
  const before = sha(local.source);
  const result = projectPublic(indexHybrid([local]));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.trees[0].body, 'Before.\n\n\n\nAfter.');
  assert.equal(sha(local.source), before);
  assert.deepEqual(identities(doc(local.path, local.source)), identities(local));
  noCanary(result);
});

test('Unicode separators cannot truncate a private image physical line into an approved placement', () => {
  for (const separator of ['\u2028', '\u2029']) {
    const local = publicDoc(`![CANARYALT](CANARY.jpg) %%p%%${separator}CANARYSUFFIX\n`);
    const result = project(local);
    assert.deepEqual(result.forest.trees, []);
    assert.ok(result.diagnostics.some(d => d.severity === 'error'));
    noCanary(result);
  }
});

const blocked = result => {
  assert.deepEqual(result.forest.trees, []);
  assert.ok(result.diagnostics.some(d => d.severity === 'error'));
  noCanary(result);
};
for (const newline of ['\n', '\r\n']) for (const eof of ['', newline]) test(`private images preserve LF/CRLF, aliases, dimensions and EOF: ${JSON.stringify([newline, eof])}`, () => {
  for (const placement of ['![[CANARYPATH/photo.JPG|600x400]]', '![[CANARYPATH/photo.svg|CANARYALT]]', '![CANARYALT](<CANARYPATH/photo name.jpg> "CANARYTITLE")']) {
    const source = (prefix + `Before.\n\n  ${placement} \t%%p%% \t`).replaceAll('\n', newline) + eof;
    const local = doc('Public.md', source);
    const result = project(local);
    assert.deepEqual(result.diagnostics, []);
    assert.deepEqual(root(result).content, [{ kind: 'markdown', text: 'Before.' }]);
    noCanary(result);
  }
});

for (const control of ['%%ph%%', '%%pt%%', '%%pp%%', '%%px%%', '%%P%%', '%% p %%', '%%p', '%%p%', '%%p%% %%h%%', '%%h%%%%p%%', '%%p%% <!--CANARY-->', '<!--CANARY--> %%p%%', '%%p%% `CANARY`', '%%p%% CANARY', '%%p%%\u2028CANARY']) {
  for (const syntax of ['![[CANARYPATH/photo.jpg|CANARYALT]]', '![CANARYALT](CANARYPATH/photo.jpg)']) {
    for (const newline of ['\n', '\r\n']) test(`image controls fail closed rather than acquire asset permission: ${JSON.stringify([syntax, control, newline])}`, () => {
      const local = publicDoc(`${syntax} ${control}\n`.replaceAll('\n', newline));
      blocked(project(local));
      const legacy = projectPublic(indexHybrid([local]));
      assert.deepEqual(legacy.trees, []);
      noCanary(legacy);
    });
  }
}
for (const body of [
  'Inline ![[CANARYPATH/photo.jpg]] %%p%%\n',
  '- ![[CANARYPATH/photo.jpg]] %%p%%\n',
  '> ![[CANARYPATH/photo.jpg]] %%p%%\n',
  '<!--CANARY-->![[CANARYPATH/photo.jpg]] %%p%%\n',
  '![[CANARYPATH/photo.jpg]]\n%%p%%\n',
  '![[CANARYPATH/photo.jpg]]\n',
  '![CANARYALT](CANARYPATH/photo.jpg)\n',
  '![[CANARYPATH/document.pdf]] %%p%%\n',
  '![CANARYALT](CANARYPATH/photo.jpg) %%p%%\n![[CANARYPATH/photo.jpg]]\n',
]) test(`unmarked, non-standalone and non-image placements remain refused: ${JSON.stringify(body)}`, () => blocked(project(publicDoc(body))));

test('image privacy is occurrence-local and does not revoke another tree occurrence or create IDs', () => {
  const local = publicDoc('![[CANARY.jpg]] %%p%%\n\n![[TARGET]] %%ht%%\n');
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.\n');
  const result = project(local, target);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'transclude', id: 'TARGET', header: false, toc: false }]);
  noCanary(result);
});

test('private-image omission cannot erase protected code, math or raw examples', () => {
  const example = '![[example.jpg|600x400]] %%p%%';
  for (const body of ['```md\n' + example + '\n```\n', '~~~md\n' + example + '\n~~~\n', '    ' + example + '\n', '`' + example + '`\n', '$$\n' + example + '\n$$\n', '$a\n' + example + '\nb$\n', '\\[\n' + example + '\n\\]\n', '\\{\n' + example + '\n}\n', '> ' + example + '\n']) {
    const local = publicDoc(body);
    assert.deepEqual(privateImageRanges(local, local.root.contentFrom, local.root.to), [], body);
    assert.equal(local.source, prefix + body);
  }
  const body = '```md\n' + example + '\n![example](example.jpg) %%p%%\n```\n\n`' + example + '`\n\n    ' + example + '\n';
  const result = project(publicDoc(body));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'markdown', text: body.trimEnd() }]);
  const raw = project(publicDoc('\\{\n' + example + '\n}\n'));
  assert.deepEqual(raw.forest.trees, []);
  assert.ok(raw.diagnostics.some(d => d.severity === 'error'), 'image p cannot weaken existing raw/placement guards');
});

test('unknown and ambiguous embeds are never disguised as private unavailable targets', () => {
  blocked(project(publicDoc('![[CANARYUNKNOWN]]\n')));
  const one = doc('One.md', '---\nforester-id: ONE\ntitle: CANARYTITLE\naliases: [CANARYALIAS]\n---\nCANARYBODY');
  const two = doc('Two.md', '---\nforester-id: TWO\ntitle: CANARYTITLE\naliases: [CANARYALIAS]\n---\nCANARYBODY');
  blocked(project(publicDoc('![[CANARYALIAS]]\n'), one, two));
});

test('disabled known targets produce only the default unavailable node', () => {
  const disabled = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\npublish: true\npublic-title: true\n---\nCANARYBODY', { excludedFolders: ['/'] });
  const result = project(publicDoc('![[CANARYPATH/Secret|CANARYALIAS]]\n'), disabled);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'unavailable' }]);
  noCanary(result);
});

test('inline private references retain paragraph semantics without leaking source aliases or routes', () => {
  const privateDoc = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY');
  const result = project(publicDoc('See [[CANARYPRIVATEID|CANARYALIAS]] and [CANARYALIAS](CANARYPATH/Secret.md).\n'), privateDoc);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'markdown', text: 'See [非公開] and [非公開].' }]);
  noCanary(result);
});

// Existing local save/parser behavior: image controls are not tree permissions.
test('ID-save roundtrip keeps private image bytes and subtree identities', () => {
  const local = publicDoc('![[CANARY.jpg|600x400]] %%p%%\n## Child ^CHILD\nChild.\n');
  const plan = planHybridSave(indexHybrid([local]), local.path, () => { throw new Error('no new tree IDs needed'); });
  assert.deepEqual(plan.diagnostics, []);
  assert.deepEqual(plan.edits, []);
  assert.equal(sha(local.source), sha(prefix + '![[CANARY.jpg|600x400]] %%p%%\n## Child ^CHILD\nChild.\n'));
  assert.deepEqual(identities(doc(local.path, local.source)), identities(local));
});

test('standalone private reference paragraphs share the closed unavailable destination', () => {
  const hidden = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY');
  const result = project(publicDoc('Before.\n\n[[CANARYPRIVATEID|CANARYALIAS]]\n\nAfter [[CANARYPRIVATEID|CANARYALIAS]].\n'), hidden);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [
    { kind: 'markdown', text: 'Before.' },
    { kind: 'unavailable' },
    { kind: 'markdown', text: 'After [非公開].' },
  ]);
  noCanary(result);
});

test('standalone private Markdown-reference paragraphs discard source labels', () => {
  const hidden = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: Approved semantic title\npublic-title: true\n---\nCANARYBODY');
  const result = project(publicDoc('[CANARYALIAS](CANARYPATH/Secret.md)\n'), hidden);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'unavailable', label: 'Approved semantic title' }]);
  noCanary(result);
});

test('an image-like Markdown filename cannot bypass unvetted-asset refusal for malformed p', () => {
  const hidden = doc('CANARYPATH/photo.jpg.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY');
  const local = publicDoc('![[CANARYPATH/photo.jpg]] %%p\nCANARYSUFFIX\n');
  assert.equal(resolveHybrid(indexHybrid([local, hidden]), 'CANARYPATH/photo.jpg', local.path).status, 'resolved');
  const result = project(local, hidden);
  blocked(result);
  assert.ok(result.diagnostics.some(d => d.code === 'unvetted-asset'));
});

test('private references inside list-continuation paragraphs are not split into block nodes', () => {
  const hidden = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY');
  const result = project(publicDoc('- Item.\n\n  [[CANARYPRIVATEID|CANARYALIAS]]\n\nTail.\n'), hidden);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'markdown', text: '- Item.\n\n  [非公開]\n\nTail.' }]);
  noCanary(result);
});

const maxLabelBytes = 1024 * 1024;
const siteRejectedTitles = [
  'CANARYFILE.md', 'CANARYFILE.foo', 'CANARY title.jpg', 'CANARY.MD suffix', 'CANARYPATH/Secret', 'CANARYPATH\\Secret',
  'https://example.invalid/CANARY', 'mailto : CANARY', 'custom-CANARY:payload', 'İ-CANARY:payload', 'CANARY.gİf', 'CANARY.jſon',
  'CANARY <html>', 'CANARY [text]', 'CANARY {literal}', 'CANARY | alias', 'CANARY `literal`', 'CANARY \\link{x}',
  'CANARY\ud800', 'CANARY\udfff', 'A'.repeat(maxLabelBytes + 1), '題'.repeat(Math.floor(maxLabelBytes / 3) + 1),
  ...Array.from({ length: 33 }, (_, i) => `CANARY${String.fromCodePoint(0x7f + i)}TITLE`),
  ...Array.from({ length: 7 }, (_, i) => `CANARY${String.fromCodePoint(0x2028 + i)}TITLE`),
  ...Array.from({ length: 4 }, (_, i) => `CANARY${String.fromCodePoint(0x2066 + i)}TITLE`),
];
// Exact Unicode-17/16 witnesses from the independent rereview: BMP and astral,
// URL start and extension end. Ordinary Unicode titles remain literal/authorized.
const boundaryCharacters = [0x088f, 0x0c5c, 0x0cdc, 0xa7ce, 0xa7cf, 0xa7d2, 0xa7d4, 0xa7f1, 0x10940, 0x10941, 0x33479,
  0x0130, 0x0131, 0x017f, 0x212a, 0x6771, 0x2160, 0x2460].map(codepoint => String.fromCodePoint(codepoint));
const boundaryRejectedTitles = boundaryCharacters.flatMap(character => [`${character}http: secret`, `Title private.md${character} rest`]);
const casefoldRejectedTitles = ['maİlto : secret', 'maılto : secret', 'javascrİpt : secret', 'fıle : secret', 'vbſcrİpt : secret',
  'Title private.gİf rest', 'Title private.gıf rest', 'Title private.jſon rest', 'Title private.marKdown rest'];
const whitespaceRejectedTitles = ['http\u00a0: secret', 'http\u3000: secret', 'custom:\ufeff', 'private\ufeff.foo', 'Title:\ufeff Introduction'];
siteRejectedTitles.push(...boundaryRejectedTitles, ...casefoldRejectedTitles, ...whitespaceRejectedTitles);
const siteAcceptedTitles = ['Approved title', '独立した公開題名', 'Café', 'Cafe\u0301', 'Approved & meaningful',
  'A (semantic) title', "An author's title", 'Chapter: Introduction', '  Approved title  ', 'Meaning — notation!',
  '公開された題名', 'Public semantic title', 'Information philosophy: An authorized public title', 'Public & "semantic" e\u0301 題名',
  '  Authorized semantic title  ', 'A😀 title', 'Title:\u3000Introduction', 'Title\ufeff: Introduction',
  'title.md_1 rest', 'title.mdA rest', 'Ahttp: secret', '1http: secret', '_http: secret', 'http\ufeff: secret', 'custom:\u00a0',
  'custom:\u3000', 'private\u00a0.foo', 'İıſK — 承認済み題名', ...boundaryCharacters.map(character => `Approved ${character} 題名`),
  'A'.repeat(maxLabelBytes), '題'.repeat(Math.floor(maxLabelBytes / 3))];
// A maximal scheme run can have a blocked first start but an eligible inner
// start after a non-ASCII predecessor. Known protocols also need suffix checks.
const uriTraversalTitles = [
  ['_custom:x', true], ['1custom:x', true], ['_İcustom:x', false], ['1İcustom:x', false],
  ['_ıcustom:x', false], ['_ſcustom:x', false], ['_Kcustom:x', false],
  ['custom:', true], ['custom: ', true], ['custom\u00a0:x', true], ['custom:\ufeff', false],
  ['http:', false], ['http :', false], ['https\u00a0:', false], ['http\u3000:', false],
  ['Ahttp :', true], ['_http :', true], ['1http :', true], ['Aİhttp :', false],
  ['_İhttp :', false], ['Aſhttp :', false], ['AKhttp :', false],
  ['xxxjavascript :', true], ['İjavascript :', false], ['ſjavascrİpt :', false],
  ['Aſvbſcrıpt\u00a0:', false], ['maılto\u3000:', false], ['fİle :', false], ['data :', false],
  ['http\ufeff:', true], ['http\ufeff: ', true], ['İıſK — literal title', true],
];
for (const [title, accepted] of uriTraversalTitles) (accepted ? siteAcceptedTitles : siteRejectedTitles).push(title);
for (const [variant, title] of boundaryRejectedTitles.entries()) test(`stable unavailable boundary rejects Unicode-adjacent URL/extension: ${variant}`, () => {
  const result = labelProjection(title);
  blocked(result);
  assert.ok(result.diagnostics.some(d => d.code === 'unsafe-unavailable-label'));
});
const labelProjection = title => project(publicDoc('![[CANARYPRIVATEID|CANARYALIAS]]\n'),
  doc('CANARYPATH/Secret.md', `---\nforester-id: CANARYPRIVATEID\ntitle: ${JSON.stringify(title)}\npublic-title: true\n---\nCANARYBODY\n`));
for (const [variant, title] of siteRejectedTitles.entries()) test(`unavailable producer label rejects the closed site subset boundary: ${variant}`, () => {
  blocked(labelProjection(title));
});
for (const [variant, title] of siteAcceptedTitles.entries()) test(`unavailable producer label preserves approved literal bytes: ${variant}`, () => {
  const result = labelProjection(title);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'unavailable', label: title }]);
  noCanary(result);
});
test('explicit heading titles also reject filename-shaped unavailable labels', () => {
  const hidden = doc('CANARYPATH/Secret.md', '# Hidden note\n## CANARYFILE.md ^CANARYPRIVATEID\n%% public-title: true %%\nCANARYBODY\n');
  assert.equal(hidden.trees[1].meta.titleSource, 'heading');
  blocked(project(publicDoc('![[CANARYPRIVATEID]]\n'), hidden));
});
test('unsafe semantic title without public-title permission stays omitted, not normalized or authorized', () => {
  const hidden = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYFILE.md\n---\nCANARYBODY\n');
  const result = project(publicDoc('![[CANARYPRIVATEID]]\n'), hidden);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(root(result).content, [{ kind: 'unavailable' }]);
  noCanary(result);
});

test('every successful producer fixture label passes the actual current site validators', {
  skip: !process.env.PUBLIC_CONTROLS_SITE_SCRIPT && 'Set PUBLIC_CONTROLS_SITE_SCRIPT for independent read-only site validation',
}, () => {
  const titles = [...siteAcceptedTitles, ...siteRejectedTitles];
  const projections = titles.map(title => labelProjection(title));
  const values = projections.map((result, i) => {
    if (result.diagnostics.length) return titles[i];
    assert.deepEqual(root(result).content, [{ kind: 'unavailable', label: titles[i] }], 'no literal repair/normalization');
    return root(result).content[0].label;
  });
  const python = String.raw`
import hashlib, importlib.util, json, sys
from pathlib import Path
sys.dont_write_bytecode = True
path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('producer_control_site', path)
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)
results = []
for value in json.load(sys.stdin):
    try:
        unchanged = site.literal(value) == value and site.unavailable_label(value) == value
        results.append({'accepted': True, 'unchanged': unchanged})
    except site.GateError as error:
        results.append({'accepted': False, 'code': error.code})
print(json.dumps({'site_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'results': results}))
`;
  const run = spawnSync(process.env.PYTHON ?? 'python3', ['-B', '-c', python, process.env.PUBLIC_CONTROLS_SITE_SCRIPT], {
    input: JSON.stringify(values), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr);
  const checked = JSON.parse(run.stdout);
  assert.equal(checked.results.length, titles.length);
  const rows = projections.map((result, i) => ({ index: i, label_sha256: sha(titles[i]),
    producer_accepted: result.diagnostics.length === 0, site: checked.results[i] }));
  if (process.env.PUBLIC_CONTROLS_EVIDENCE) {
    mkdirSync(process.env.PUBLIC_CONTROLS_EVIDENCE, { recursive: true });
    writeFileSync(join(process.env.PUBLIC_CONTROLS_EVIDENCE, 'cross-site-labels.json'), JSON.stringify({ site_sha256: checked.site_sha256, rows }, null, 2) + '\n');
  }
  for (const row of rows) if (row.producer_accepted) {
    assert.equal(row.site.accepted, true, `successful producer fixture ${row.index} must pass site`);
    assert.equal(row.site.unchanged, true, `successful producer fixture ${row.index} must preserve literal bytes`);
  }
});

const malformedPrivateControls = ['%%p', '%%p%', '%%ph', '%%ht%% %%p', '%%h%% %%t', '%%ht%% %% p %%',
  '%% p %%', '%%p %%', '%% p%%', '%% P %%', '%%x', '%% x %%', '%%p\u2028%%', '%%p\u2029%%', '%%p\u0085%%', '%%p\u000b%%', '%%p\u000c%%'];
for (const newline of ['\n', '\r\n']) for (const control of malformedPrivateControls) {
  test(`private embed original physical controls fail closed: ${JSON.stringify([control, newline])}`, () => {
    const hidden = doc('CANARYPATH/Secret.md', '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY\n');
    const local = doc('Public.md', (prefix + `![[CANARYPRIVATEID]] ${control}\nCANARY_AFTER_CONTROL\n`).replaceAll('\n', newline));
    blocked(project(local, hidden));
    const legacy = projectPublic(indexHybrid([local, hidden]));
    assert.deepEqual(legacy.trees, []);
    noCanary(legacy);
  });
}
for (const newline of ['\n', '\r\n']) for (const publish of [false, true]) {
  test(`original controls retain h/t and ordinary trailing comment compatibility: ${JSON.stringify([newline, publish])}`, () => {
    const target = doc('Target.md', `---\nforester-id: TARGET\ntitle: Approved target\npublish: ${publish}\n---\nSafe target.\n`);
    for (const [suffix, header, toc] of [['', true, true], ['%%h%%', false, true], ['%%t%%', true, false], ['%%ht%%', false, false]]) {
      for (const comment of ['', ' <!-- ordinary trailing comment -->', ' %% ordinary trailing note %%']) {
        const result = project(doc('Public.md', (prefix + `![[TARGET]] ${suffix}${comment}\n`).replaceAll('\n', newline)), target);
        assert.deepEqual(result.diagnostics, [], suffix + comment);
        assert.deepEqual(root(result).content, [publish ? { kind: 'transclude', id: 'TARGET', header, toc } : { kind: 'unavailable' }]);
      }
    }
  });
}

const commentOverlaps = [
  '![[CANARY.jpg|<!--]] %%p%%\nCANARY_COMMENT_BODY\n-->\nTail.\n',
  '![<!--](CANARY.jpg) %%p%%\nCANARY_COMMENT_BODY\n-->\nTail.\n',
  '![alt](<CANARY<!--.jpg>) %%p%%\nCANARY_COMMENT_BODY\n-->\nTail.\n',
];
for (const newline of ['\n', '\r\n']) for (const [variant, body] of commentOverlaps.entries()) {
  for (const format of ['v1', 'v2']) test(`protected image comment overlap never reactivates canaries: ${JSON.stringify([variant, newline, format])}`, () => {
    const local = doc('Public.md', (prefix + body).replaceAll('\n', newline));
    const before = sha(local.source), index = indexHybrid([local]);
    const result = format === 'v1' ? projectPublic(index) : project(local);
    noCanary(result);
    assert.deepEqual(format === 'v1' ? result.trees : result.forest.trees, []);
    assert.ok(result.diagnostics.some(d => d.severity === 'error'));
    assert.deepEqual(privateImageRanges(local, local.root.contentFrom, local.root.to), []);
    assert.equal(sha(local.source), before);
  });
}

for (const newline of ['\n', '\r\n']) for (const [kind, marker, close] of [
  ['code', '`', '`'], ['inline-math', '$', '$'], ['block-math', '$$', '$$'],
  ['paren-math', '\\(', '\\)'], ['bracket-math', '\\[', '\\]'], ['raw', '\\{', '}'],
]) for (const syntax of ['wiki', 'markdown-alt', 'markdown-destination']) {
  test(`protected image ${kind} overlap is not partially omitted: ${JSON.stringify([syntax, newline])}`, () => {
    const image = syntax === 'wiki' ? `![[example.jpg|${marker}]]` :
      syntax === 'markdown-alt' ? `![${marker}](example.jpg)` : `![alt](<example${marker}.jpg>)`;
    const local = doc('Public.md', (prefix + `${image} %%p%%\nLiteral example.\n${close}\nTail.\n`).replaceAll('\n', newline));
    const before = JSON.stringify(local);
    assert.deepEqual(privateImageRanges(local, local.root.contentFrom, local.root.to), []);
    const v1 = projectPublic(indexHybrid([local])), v2 = project(local);
    assert.deepEqual(v1.trees, [], 'unomitted live image stays refused');
    assert.deepEqual(v2.forest.trees, [], 'unomitted live image stays refused');
    assert.ok(v1.diagnostics.some(d => d.severity === 'error'));
    assert.ok(v2.diagnostics.some(d => d.severity === 'error'));
    assert.equal(JSON.stringify(local), before);
  });
}

test('only the exact own p comment may intersect a normal image omission range', () => {
  const body = 'Before.\n\n![[CANARY.jpg|600x400]] %%p%%\n![CANARYALT](CANARY.jpg) %%p%%\n\nAfter.\n';
  const local = publicDoc(body);
  const ranges = privateImageRanges(local, local.root.contentFrom, local.root.to);
  assert.equal(ranges.length, 2);
  for (const range of ranges) {
    const protectedParts = local.protectedRanges.filter(p => p.from < range.to && p.to > range.from);
    assert.equal(protectedParts.length, 1);
    assert.equal(local.source.slice(protectedParts[0].from, protectedParts[0].to), '%%p%%');
  }
  for (const result of [projectPublic(indexHybrid([local])), project(local)]) {
    assert.deepEqual(result.diagnostics, []);
    noCanary(result);
  }
});
