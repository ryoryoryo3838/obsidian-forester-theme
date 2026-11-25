import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHybrid, indexHybrid } from './build/hybrid-core.mjs';
let projectPublicForest;
try { ({ projectPublicForest } = await import('./build/hybrid-public-forest.mjs')); }
catch (error) { if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error; }
const options = { folders: [], publicFolders: [], reservedIds: [] };
const doc = (path, source) => parseHybrid(path, source, options);
const project = (...docs) => {
  assert.equal(typeof projectPublicForest, 'function', 'structured projection export must be available');
  return projectPublicForest(indexHybrid(docs));
};
const publicDoc = (body = '', meta = '') => doc('Public.md', `---\nforester-id: PUBLICA\ntitle: Public A\npublish: true\n${meta}---\n${body}`);
const text = tree => tree.content.filter(n => n.kind === 'markdown').map(n => n.text).join('\n');
const blocked = (result, code) => {
  assert.deepEqual(result.forest.trees, []);
  assert.ok(result.diagnostics.some(d => d.code === code && d.severity === 'error'), JSON.stringify(result.diagnostics));
  assert.ok(!JSON.stringify(result).includes('CANARY'));
};

test('PUBLICA links to an independently public ISLAND without private ancestor data', () => {
  const privateDoc = doc('CANARY-PATH/secret.md', '---\nforester-id: PRIVATE\ntitle: CANARY-TITLE\nauthors: [CANARY-AUTHOR]\ndates: [CANARY-DATE]\n---\nCANARY-BODY\n## Island ^ISLAND\n%% publish: true %%\nApproved island.\n## CANARY-SIBLING ^PRIVATECHILD\nCANARY-SIBLING-BODY\n');
  const result = project(publicDoc('See [[CANARY-PATH/secret#^ISLAND|Approved label]].\n'), privateDoc);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(Object.keys(result.forest).sort(), ['assets', 'schema', 'trees']);
  assert.equal(result.forest.schema, 'forester-public-v2');
  assert.deepEqual(result.forest.assets, []);
  assert.deepEqual(result.forest.trees.map(t => t.id), ['ISLAND', 'PUBLICA']);
  assert.equal(text(result.forest.trees[1]), 'See [[ISLAND|Approved label]].');
  assert.equal(text(result.forest.trees[0]), 'Approved island.');
  assert.deepEqual(result.forest.trees[0].authors, []);
  assert.deepEqual(result.forest.trees[0].dates, []);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  assert.deepEqual(Object.keys(result.forest.trees[0]).sort(), ['authors', 'citationAuthors', 'content', 'contributors', 'dates', 'id', 'properties', 'title']);
});

test('named and anonymous definitions occur once in source order; v0.6 explicit private swallows nested public markers', () => {
  const result = project(publicDoc('Intro.\n## Named ^CHILD\n%% title: Child semantic, venue: Safe venue %%\nChild body.\n### Anonymous\nAnonymous body.\n## CANARY-PRIVATE ^HIDDEN\n%%p%%\nCANARY-BODY\n### Island ^ISLAND\n%% publish: true %%\nCANARY-ISLAND\n## Last ^LAST\nLast body.\n'));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.forest.trees.map(t => t.id), ['PUBLICA']);
  const root = result.forest.trees[0];
  assert.deepEqual(root.content.map(n => n.kind), ['markdown', 'subtree', 'subtree']);
  assert.equal(text(root), 'Intro.');
  const child = root.content[1].tree;
  assert.equal(child.id, 'CHILD');
  assert.equal(child.title, 'Child semantic');
  assert.equal(text(child), 'Child body.');
  assert.equal(child.content[1].tree.id, undefined);
  assert.equal(child.content[1].tree.title, 'Anonymous');
  assert.equal(text(child.content[1].tree), 'Anonymous body.');
  assert.equal(root.content[2].tree.id, 'LAST');
  const ids = [];
  const visit = tree => { if (tree.id) ids.push(tree.id); for (const n of tree.content) if (n.kind === 'subtree') visit(n.tree); };
  result.forest.trees.forEach(visit);
  assert.deepEqual(ids.sort(), ['CHILD', 'LAST', 'PUBLICA']);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

test('block transclusions retain typed placements and ht while code references stay literal', () => {
  const a = publicDoc('Before.\n\n![[Target]] %%ht%%\n\nAfter `![[missing]]` and `{ref:[[missing]]}`.\n\n```md\n![[missing]] %%ht%%\n## Literal heading\n```\n');
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target title\npublish: true\n---\nTarget body.\n');
  const result = project(a, target);
  assert.deepEqual(result.diagnostics, []);
  const root = result.forest.trees[0];
  assert.deepEqual(root.content.map(n => n.kind), ['markdown', 'transclude', 'markdown']);
  assert.deepEqual(root.content[1], { kind: 'transclude', id: 'TARGET', header: false, toc: false });
  assert.equal(root.content[0].text, 'Before.');
  assert.ok(root.content[2].text.includes('`![[missing]]`'));
  assert.ok(root.content[2].text.includes('`{ref:[[missing]]}`'));
  assert.ok(root.content[2].text.includes('![[missing]] %%ht%%'));
  assert.ok(root.content[2].text.includes('## Literal heading'));
  assert.ok(!text(root).includes('Target body'));
});

for (const body of [
  '![[TARGET]] `suffix`\n',
  '![[TARGET]] %%ht%% `suffix`\n',
  '![[TARGET]] ``suffix`` trailing\n',
  '![[TARGET]] <!--hidden--> `suffix`\n',
  '![[TARGET]] %%ht%% `suffix\ncontinued`\n',
  '![[TARGET]] `suffix` <!--hidden-->\n',
  '`prefix` ![[TARGET]] %%ht%%\n',
  '`prefix\ncontinued` ![[TARGET]]\n',
  'Prose\n![[TARGET]] %%ht%% `suffix`\n',
]) for (const newline of ['\n', '\r\n']) test(`physical-line embed placement rejects literal content: ${JSON.stringify(body)} ${JSON.stringify(newline)}`, () => {
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.');
  blocked(project(publicDoc(body.replace(/\n/g, newline)), target), 'unsupported-transclusion-placement');
});

test('standalone ht belongs only to its preceding embed and protected embed examples stay literal', () => {
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.');
  const result = project(publicDoc('`prefix`\n\n![[TARGET]] %%ht%%\n![[TARGET]]\n\n```md\n![[TARGET]] %%ht%% `suffix`\n```\n\n    ![[TARGET]] %%ht%% `suffix`\n'), target);
  assert.deepEqual(result.diagnostics, []);
  const root = result.forest.trees.find(t => t.id === 'PUBLICA');
  assert.deepEqual(root.content.filter(n => n.kind === 'transclude'), [
    {kind:'transclude', id:'TARGET', header:false, toc:false},
    {kind:'transclude', id:'TARGET', header:true, toc:true},
  ]);
  assert.ok(text(root).includes('    ![[TARGET]] %%ht%% `suffix`'));
});

// Public-v2 accepts only a direct, single same-line control token. Ordinary
// comments must not erase controls or become publication metadata themselves.
for (const [body, code] of [
  ['<!--before-->![[TARGET]] %%ht%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] <!--between--> %%ht%%\n', 'unsupported-transclusion-placement'],
  ['<!--before-->![[TARGET]] %%x%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] <!--between--> %%x%%\n', 'unsupported-transclusion-placement'],
  ['%% ordinary note %%![[TARGET]] %%ht%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %% ordinary note %% %%ht%%\n', 'unsupported-transclusion-placement'],
  ['<!--before-->![[TARGET]]\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %%h%%%%t%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %%ht%% %%x%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %%h%% <!--between--> %%t%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %%x%%\n', 'unsupported-transclusion-flags'],
  ['![[TARGET]] %%H%%\n', 'unsupported-transclusion-flags'],
  ['![[TARGET]] %%h1%%\n', 'unsupported-transclusion-flags'],
  ['![[TARGET]] %%h-x%%\n', 'unsupported-transclusion-flags'],
  ['![[TARGET]] %%p%%\n', 'unsupported-transclusion-flags'],
]) for (const newline of ['\n', '\r\n']) test(`comment-adjacent or unknown controls refuse without defaulting: ${JSON.stringify(body)} ${JSON.stringify(newline)}`, () => {
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.');
  blocked(project(publicDoc(body.replace(/\n/g, newline)), target), code);
});

for (const newline of ['\n', '\r\n']) test(`canonical controls survive standalone and trailing ordinary comments: ${JSON.stringify(newline)}`, () => {
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.');
  const body = '<!--preceding own line-->\n![[TARGET]] %%ht%% <!--trailing-->\n%% ordinary preceding note %%\n![[TARGET]] %%h%%\n![[TARGET]] %%t%% %% ordinary trailing note %%\n![[TARGET]]\n\n```md\n<!--before-->![[missing]] %%x%%\n~~~\n![[missing]] %%ht%%\n~~~\n```\n\n`<!--before-->![[missing]] %%x%%`\n<!-- ![[missing]] %%x%% -->\n';
  const result = project(publicDoc(body.replace(/\n/g, newline)), target);
  assert.deepEqual(result.diagnostics, []);
  const root = result.forest.trees.find(t => t.id === 'PUBLICA');
  assert.deepEqual(root.content.filter(n => n.kind === 'transclude'), [
    {kind:'transclude', id:'TARGET', header:false, toc:false},
    {kind:'transclude', id:'TARGET', header:false, toc:true},
    {kind:'transclude', id:'TARGET', header:true, toc:false},
    {kind:'transclude', id:'TARGET', header:true, toc:true},
  ]);
  assert.ok(text(root).includes('<!--before-->![[missing]] %%x%%'));
});

test('metadata follows declaration visibility and nested trees emit only local native inheritance additions', () => {
  const a = publicDoc('## Child ^CHILD\n%% authors: [Child literal], dates: ["2026-10-09"], contributors: ["[[Person]]"], venue: Safe venue %%\nChild.\n## CANARY-BRIDGE ^PRIVATE\n%% publish: false, authors: [CANARY-AUTHOR], dates: [CANARY-DATE] %%\nCANARY-BODY\n### Island ^ISLAND\n%% publish: true, authors: [Island literal], dates: ["2026-10-10"] %%\nIsland.\n', 'authors: [Parent literal, "[[Person]]", "[[Hidden]]"]\ndates: ["2026-10-08"]\ncontributors: [Parent contributor]\nposition: Safe position\n');
  const person = doc('Person.md', '---\nforester-id: PERSON\ntitle: Person name\npublish: true\n---\nPerson.\n');
  const hidden = doc('Hidden.md', '---\nforester-id: HIDDEN\ntitle: CANARY-PERSON\n---\nCANARY-BODY\n');
  const result = project(a, person, hidden);
  assert.deepEqual(result.diagnostics, []);
  const root = result.forest.trees.find(t => t.id === 'PUBLICA');
  assert.deepEqual(root.authors, [{kind:'literal',value:'Parent literal'}, {kind:'tree',id:'PERSON'}]);
  assert.deepEqual(root.dates, ['2026-10-08']);
  assert.deepEqual(root.contributors, [{kind:'literal',value:'Parent contributor'}]);
  assert.deepEqual(root.properties, {position:['Safe position']});
  const child = root.content.find(n => n.kind === 'subtree').tree;
  assert.deepEqual(child.authors, [{kind:'literal',value:'Child literal'}]);
  assert.deepEqual(child.dates, ['2026-10-09']);
  assert.deepEqual(child.contributors, [{kind:'tree',id:'PERSON'}]);
  assert.deepEqual(child.properties, {venue:['Safe venue']});
  // v0.6: the island sits under an explicit private heading, so it is not published.
  assert.equal(result.forest.trees.find(t => t.id === 'ISLAND'), undefined);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

test('v0.6: a #public heading in an unmarked (default-private) note is a separate public root', () => {
  const note = doc('Note.md', '---\nforester-id: NOTE\n---\n# Note\nCANARY-NOTE-BODY\n## Shared #public ^SHARED\nShared body.\n### Inner ^INNER\nInner body.\n## Hidden ^HIDDEN\nCANARY-HIDDEN\n');
  const result = project(note);
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.forest.trees.map(t => t.id), ['SHARED']);
  const shared = result.forest.trees[0];
  assert.equal(shared.title, 'Shared');
  assert.equal(text(shared), 'Shared body.');
  assert.equal(shared.content.find(n => n.kind === 'subtree').tree.id, 'INNER');
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

test('v0.6: #private on a heading, file tags and a folder note mark visibility at every level', () => {
  const opts = { folders: [], publicFolders: [], reservedIds: [] };
  const folderNote = parseHybrid('Pub/Pub.md', '---\ntags: [public]\nforester-id: PUB\ntitle: Pub\n---\nFolder body.\n', opts);
  const inside = parseHybrid('Pub/In.md', '---\nforester-id: IN\ntitle: In\n---\nIn body.\n## Secret #private ^SECRET\nCANARY-SECRET\n### Below #public ^BELOW\nCANARY-BELOW\n', opts);
  const privateFile = parseHybrid('Pub/Off.md', '---\nforester-id: OFF\ntitle: Off\ntags:\n  - "#private"\n---\nCANARY-OFF\n', opts);
  const outside = parseHybrid('Other/Out.md', '---\nforester-id: OUT\ntitle: Out\n---\nCANARY-OUT\n', opts);
  const result = projectPublicForest(indexHybrid([folderNote, inside, privateFile, outside]));
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.forest.trees.map(t => t.id), ['IN', 'PUB']);
  assert.ok(!JSON.stringify(result).includes('CANARY'));
  assert.deepEqual(inside.trees.map(t => t.meta.publish), [true, false, false]);
  assert.equal(inside.trees[1].meta.title, 'Secret');
  assert.ok(inside.diagnostics.some(d => d.code === 'public-in-private' && d.line === inside.trees[2].line));
});

for (const [name, meta, code] of [
  ['linked dates', 'dates: ["[[CANARY-PATH/Date]]"]\n', 'unsupported-date-link'],
  ['invalid calendar date', 'dates: ["2026-02-30"]\n', 'invalid-public-date'],
  ['unsafe native URL', 'external: "javascript:CANARY"\n', 'unsafe-public-property'],
  ['file relation property', 'source: "[[CANARY-PATH/Note]]"\n', 'unsupported-public-metadata'],
  ['linked bibliography', 'citation-authors: ["[[CANARY-PATH/Person]]"]\npublication-year: 2026\n', 'unsupported-public-metadata'],
]) test(`unsupported metadata is diagnosed instead of dropped: ${name}`, () => {
  blocked(project(publicDoc('Safe.', meta)), code);
});

for (const [name, body, other] of [
  ['self transclusion', '![[PUBLICA]]\n', null],
  ['two-tree cycle', '![[TARGET]]\n', doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\n![[PUBLICA]]\n')],
  ['containment plus transclusion', '## Child ^CHILD\n![[PUBLICA]]\n', null],
]) test(`containment and transclusion cycles fail closed: ${name}`, () => {
  blocked(project(...[publicDoc(body), other].filter(Boolean)), 'forest-cycle');
});

for (const body of [
  '`Heading`\n=======\n',
  'Heading `code`\n=======\n',
  '`Heading` tail\n-------\n',
  '``Heading``\n-------\n',
  '`Heading\ncontinued`\n=======\n',
  'Soft line\nHeading `code`\n-------\n',
  '`prefix` Heading `suffix`\n=======\n',
  '`Heading` <!--hidden-->\n=======\n',
]) for (const newline of ['\n', '\r\n']) test(`complete-block setext guard keeps inline literals in heading text: ${JSON.stringify(body)} ${JSON.stringify(newline)}`, () => {
  blocked(project(publicDoc(body.replace(/\n/g, newline))), 'unsupported-tree-declaration');
});

test('complete-block setext guard keeps fenced/indented code inert and thematic breaks separate', () => {
  const body = '```md\n`Heading`\n=======\n```\n-------\n\n    `Heading`\n    =======\n\n-------\n\nOrdinary `code` text.\n\n-------\n';
  const result = project(publicDoc(body));
  assert.deepEqual(result.diagnostics, []);
  assert.equal(text(result.forest.trees[0]), body.trimEnd());
});

for (const [name, body] of [
  ['extra root heading', 'Safe.\n# Unaccounted ^OTHER\n'],
  ['setext heading', 'Unaccounted\n=======\n'],
]) test(`unaccounted tree declarations cannot survive as Markdown: ${name}`, () => {
  blocked(project(publicDoc(body)), 'unsupported-tree-declaration');
});

for (const [name, body, code] of [
  ['inline embed','Inline ![[PUBLICA]].','unsupported-transclusion-placement'],
  ['list embed','- ![[PUBLICA]]\n','unsupported-transclusion-placement'],
  ['quote embed','> ![[PUBLICA]]\n','unsupported-transclusion-placement'],
  ['unknown flag','![[PUBLICA]] %%x%%\n','unsupported-transclusion-flags'],
  ['dangling link','[[missing|CANARY]]','unresolved-reference'],
  ['asset','![[CANARY.png]]','unvetted-asset'],
  ['raw Forester','\\{ \\import{CANARY} }','unsupported-raw'],
  ['raw HTML','<script>CANARY</script>','unsafe-html'],
  ['unsafe URL','[CANARY](javascript:alert)','unsafe-url'],
]) test(`structured projection uses fail-closed public guards: ${name}`, () => blocked(project(publicDoc(body)), code));

test('identity collisions and malformed source IDs refuse the complete forest', () => {
  const other = doc('CANARY.md','---\nforester-id: publica\ntitle: CANARY\n---\nCANARY');
  blocked(project(publicDoc('Safe.'),other),'invalid-source');
  for (const id of ['../CANARY','CANARY/ID','日本語']) {
    blocked(project(doc('CANARY.md',`---\nforester-id: "${id}"\ntitle: CANARY\npublish: true\n---\nSafe.`)), 'invalid-source');
  }
});

test('safe aliases, private lock titles and public bibliography stay literal without source routes', () => {
  const pub = doc('Target.md','---\nforester-id: TARGET\ntitle: Target\npublish: true\ncitation-authors: [Public writer]\npublication-year: 2026\n---\nTarget.');
  const priv = doc('CANARY.md','---\nforester-id: PRIVATE\ntitle: Approved title\npublic-title: true\n---\nCANARY');
  const result = project(publicDoc('[[Target|A&#96;B]] [[CANARY|CANARY]] {ref:[[Target]]}'),pub,priv);
  assert.deepEqual(result.diagnostics,[]);
  assert.equal(text(result.forest.trees.find(t=>t.id==='PUBLICA')), '[[TARGET|A&#96;B]] Approved title 🔒 (Public writer, 2026)');
  assert.ok(!JSON.stringify(result).includes('CANARY'));
});

for (const [name, source, code] of [
  ['hidden heading comment', '## Public <!-- CANARY-HIDDEN --> ^CHILD\nBody.', 'unsupported-public-metadata'],
  ['anonymous author reference', '## Anonymous\nBody.', 'unaddressed-public-attribution'],
]) test(`metadata cannot hide local source syntax: ${name}`, () => {
  const meta = name === 'anonymous author reference' ? 'authors: ["[[#Anonymous]]"]\n' : '';
  blocked(project(publicDoc(source, meta)), code);
});

test('private public-title links cannot leak hidden title comments', () => {
  const privateDoc = doc('Secret.md','---\nforester-id: PRIVATE\ntitle: "Approved <!-- CANARY-HIDDEN -->"\npublic-title: true\n---\nCANARY');
  blocked(project(publicDoc('[[PRIVATE]]'),privateDoc),'unsupported-public-metadata');
});

test('v0.6: embed flags after | map to Forester transclusion flags, long or short', () => {
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nT.\n');
  const a = publicDoc('![[Target]]\n\n![[Target|-h -t]]\n\n![[Target|-numbered -expanded +metadata]]\n\n![[Target|+h -n]]\n\n![[Target|表示名]]\n');
  const result = project(a, target);
  assert.deepEqual(result.diagnostics, []);
  const placements = result.forest.trees.find(t => t.id === 'PUBLICA').content.filter(n => n.kind === 'transclude');
  assert.deepEqual(placements, [
    { kind: 'transclude', id: 'TARGET', header: true, toc: true },
    { kind: 'transclude', id: 'TARGET', header: false, toc: false },
    { kind: 'transclude', id: 'TARGET', header: true, toc: true, numbered: false, expanded: false, metadata: true },
    { kind: 'transclude', id: 'TARGET', header: true, toc: true, numbered: false },
    { kind: 'transclude', id: 'TARGET', header: true, toc: true },
  ]);
});

for (const [name, body, code] of [
  ['the same flag twice', '![[Target|-h -heading]]\n', 'conflicting-transclusion-flags'],
  ['a flag both ways', '![[Target|+t -t]]\n', 'conflicting-transclusion-flags'],
  ['| flags with a v0.5 %%ht%%', '![[Target|-h]] %%t%%\n', 'unsupported-transclusion-flags'],
]) test(`v0.6: embed flags refuse ${name}`, () => {
  const target = doc('Target.md', '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nT.\n');
  blocked(project(publicDoc(body), target), code);
});

test('v0.6: parseEmbedFlags reads flags only when every word is a flag', async () => {
  const { parseEmbedFlags } = await import('./build/hybrid-core.mjs');
  assert.deepEqual(parseEmbedFlags('-h +m')?.flags, { heading: false, toc: true, numbered: true, expanded: true, metadata: true });
  assert.equal(parseEmbedFlags('-h alias'), undefined);
  assert.equal(parseEmbedFlags('100x145'), undefined);
  assert.equal(parseEmbedFlags('-x'), undefined);
  assert.equal(parseEmbedFlags(''), undefined);
});
