import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHybrid, indexHybrid, planHybridSave } from './build/hybrid-core.mjs';
import { projectPublic } from './build/hybrid-public.mjs';

const options = { folders: ['hybrid'], publicFolders: [], reservedIds: [] };
const parse = (path, source) => parseHybrid(path, source, options);
const canary = 'PRIVATE-TITLE-LABEL-SUBTREE-CANARY';
const source = (body = '[[tArGeT]]') => parse('hybrid/Source.md',
  `---\nforester-id: source-id\ntitle: Source\npublish: true\n---\n${body}\n\n## Hidden ^PRIVATE\n%% publish: false %%\n${canary}\n`);
const target = (title, extra = 'publish: true\n') => parse('hybrid/Target.md',
  `---\nforester-id: target-id\ntitle: ${JSON.stringify(title)}\n${extra}---\nTarget body\n`);
const noDiagnostics = value => assert.deepEqual(value.diagnostics, []);

function saveAndReparse(a, b, draw = () => { throw new Error('must not mint'); }) {
  const index = indexHybrid([a, b]);
  noDiagnostics(index);
  const plan = planHybridSave(index, a.path, draw);
  noDiagnostics(plan);
  const documents = [a, b].map(document => parse(document.path,
    plan.edits.find(edit => edit.path === document.path)?.after ?? document.source));
  const savedIndex = indexHybrid(documents);
  noDiagnostics(savedIndex);
  const saved = documents[0];
  assert.deepEqual(saved.trees.map(tree => [tree.id, tree.meta.publish]),
    a.trees.map(tree => [tree.id, tree.meta.publish]), 'save must retain the following private subtree');
  assert.equal(saved.trees.find(tree => tree.id === 'PRIVATE')?.meta.publish, false);
  assert.deepEqual(planHybridSave(savedIndex, a.path).edits, [], 'save must be idempotent');
  const projection = projectPublic(savedIndex);
  noDiagnostics(projection);
  assert.equal(JSON.stringify(projection).includes(canary), false);
  return { plan, saved, projection };
}

test('generated unclosed-math title label survives real save/reparse without swallowing private subtrees', () => {
  const a = source();
  const b = target('Cost $$');
  noDiagnostics(projectPublic(indexHybrid([a, b])));
  const { saved, projection } = saveAndReparse(a, b);
  assert.match(saved.source, /\[\[tArGeT\|[^\n]+\]\]/, 'exact target spelling must be retained');
  assert.ok(!saved.source.includes('Cost $$'), 'generated label must not activate block math');
  assert.ok(projection.trees.find(tree => tree.id === 'source-id').body.includes('target-id'));
});

// Independent display oracle: Markdown escapes, then exactly one entity layer.
// In particular &amp;amp; displays the literal text &amp;, not an ampersand.
function semanticLabel(body, id = 'target-id') {
  const match = new RegExp(`^\\[\\[${id}\\|([^\\n]*)\\]\\]$`).exec(body);
  assert.ok(match, `expected one intact public ID link, got ${body}`);
  return match[1].replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~])/g, '$1')
    .replace(/&(?:amp|lt|gt|#\d+|#x[0-9a-f]+);/gi, entity => {
      if (entity === '&amp;') return '&';
      if (entity === '&lt;') return '<';
      if (entity === '&gt;') return '>';
      return String.fromCodePoint(entity[2].toLowerCase() === 'x'
        ? parseInt(entity.slice(3, -1), 16) : Number(entity.slice(2, -1)));
    });
}

test('save-to-public labels retain literal title characters with exactly one entity decode', () => {
  const title = 'A | B & C';
  const a = source();
  const b = target(title);
  const baseline = projectPublic(indexHybrid([a, b]));
  noDiagnostics(baseline);
  assert.equal(semanticLabel(baseline.trees.find(tree => tree.id === 'source-id').body), title);
  const { projection } = saveAndReparse(a, b);
  assert.equal(semanticLabel(projection.trees.find(tree => tree.id === 'source-id').body), title);
  assert.deepEqual(projection, baseline, 'generated labels must equal projection from the literal metadata title');
});

for (const title of [
  '`code` and ``two``',
  'Cost $$ and $inline$',
  'A %% B %% and %',
  '\\{ \\p{raw} } \\(x\\) \\[x\\]',
  '*bold* _em_ ~~strike~~',
  'A | B & C <D> \\',
  '[[B]] [brackets] ![] () # HTML <!-- comment -->',
  '&amp; &#124; &lt; &#96; &#x24; 日本語 🌳',
]) {
  test(`generated literal label has a safe save/reparse/public round trip: ${JSON.stringify(title)}`, () => {
    const a = source();
    const b = target(title);
    const { saved, projection } = saveAndReparse(a, b);
    assert.match(saved.source, /\[\[tArGeT\|[^\n]+\]\]/);
    const body = projection.trees.find(tree => tree.id === 'source-id').body;
    assert.equal(semanticLabel(body), title);
    const baseline = projectPublic(indexHybrid([a, b]));
    noDiagnostics(baseline);
    assert.deepEqual(projection, baseline);
  });
}

test('generated private titles and source aliases never become public fallback data', () => {
  const privateTitle = 'PRIVATE-ALIAS-TITLE-CANARY `code` $$ %% <secret> &amp;';
  const a = source('[[tArGeT]] [[tArGeT|PRIVATE-RAW-LABEL-CANARY]] [[tArGeT|]]');
  const b = target(privateTitle, 'publish: false\ncontributors: [PRIVATE-CONTRIBUTOR-CANARY]\ndoi: PRIVATE-DOI-CANARY\n');
  noDiagnostics(projectPublic(indexHybrid([a, b])));
  const { saved, projection } = saveAndReparse(a, b);
  assert.ok(saved.source.includes('[[tArGeT|PRIVATE-RAW-LABEL-CANARY]] [[tArGeT|]]'));
  assert.equal(projection.trees.find(tree => tree.id === 'source-id').body, '[非公開] [非公開] [非公開]');
  for (const secret of ['PRIVATE-ALIAS-TITLE-CANARY', 'PRIVATE-RAW-LABEL-CANARY', 'PRIVATE-CONTRIBUTOR-CANARY', 'PRIVATE-DOI-CANARY', 'target-id']) {
    assert.ok(!JSON.stringify(projection).includes(secret), `private data escaped: ${secret}`);
  }
  assert.deepEqual(Object.keys(projection.trees[0]).sort(), ['body', 'citationAuthors', 'id', 'title']);
});

test('save retains manual and empty aliases, embeds, and guarded source bytes', () => {
  const guarded = [
    '`[[tArGeT]]`', '$[[tArGeT]]$', '\\( [[tArGeT]] \\)',
    '%% [[tArGeT]] %%', '<!-- [[tArGeT]] -->',
    '\\{ \\p{[[tArGeT]]} }', '```\n[[tArGeT]]\n```', '    [[tArGeT]]', '> [[tArGeT]]',
  ].join('\n\n');
  const a = source('[[tArGeT]] [[tArGeT|Manual &amp;]] [[tArGeT|]] ![[tArGeT]]\n\n' + guarded);
  const b = target('Literal label');
  const plan = planHybridSave(indexHybrid([a, b]), a.path);
  noDiagnostics(plan);
  assert.deepEqual(plan.edits.map(edit => edit.path), [a.path]);
  assert.equal(plan.edits[0].after, a.source.replace('[[tArGeT]]', '[[tArGeT|Literal label]]'));
  const saved = parse(a.path, plan.edits[0].after);
  noDiagnostics(saved);
  assert.deepEqual(planHybridSave(indexHybrid([saved, b]), a.path).edits, []);
  assert.deepEqual(projectPublic(indexHybrid([saved, b])).trees, [], 'unchanged active raw region must still fail closed');
});

test('decoded labels stay literal when a public heading has no independent ID yet', () => {
  const title = 'Cost $$ %% \\{ raw';
  const quotedTitle = JSON.stringify(title).replace(/%/g, '\\u0025');
  const b = parse('hybrid/Target.md',
    `---\nforester-id: target-id\ntitle: Target\npublish: true\n---\n## Section\n%% title: ${quotedTitle} %%\nTarget body\n`);
  const a = source('[[Target#Section|Cost &#36;&#36; &#37;&#37; &#92;&#123; raw]]');
  const baseline = projectPublic(indexHybrid([a, b]));
  noDiagnostics(baseline);
  const body = baseline.trees.find(tree => tree.id === 'source-id').body;
  assert.equal(body, 'Cost &#36;&#36; &#37;&#37; &#92;&#123; raw', 'idless fallback must not reactivate math, comments or raw syntax');
  const { projection } = saveAndReparse(a, b, () => 'ABCDEF');
  assert.equal(semanticLabel(projection.trees.find(tree => tree.id === 'source-id').body, 'ABCDEF'), title);
});
