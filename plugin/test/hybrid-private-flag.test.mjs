import assert from 'node:assert/strict';
import test from 'node:test';
import { parseHybrid, indexHybrid, resolveHybrid, planHybridSave } from './build/hybrid-core.mjs';
import { projectPublic } from './build/hybrid-public.mjs';
import { planDisplay, parseEmbedLine } from './build/hybrid-display.mjs';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const options = { folders: [], publicFolders: [], reservedIds: [] };
const prefix = '---\nforester-id: PUBLIC\ntitle: Public root\npublish: true\n---\n';
const parse = (source, overrides = {}) => parseHybrid('Note.md', source, { ...options, ...overrides });

test('private shorthand excludes a subtree and inherited descendants from a public parent', () => {
  const source = prefix + 'Visible introduction.\n\n## PRIVATE-TITLE-CANARY ^PRIVATE\n%%p%%\nPRIVATE-BODY-CANARY\n\n### PRIVATE-CHILD-TITLE-CANARY ^CHILD\nPRIVATE-CHILD-BODY-CANARY\n\n## Visible sibling ^SIBLING\nVisible sibling body.\n';
  const doc = parse(source);
  assert.deepEqual(doc.trees.map(tree => tree.meta.publish), [true, false, false, true]);
  assert.equal(doc.source, source, 'parsing never rewrites the author source');
  const projection = projectPublic(indexHybrid([doc]));
  assert.deepEqual(projection.diagnostics, []);
  const json = JSON.stringify(projection);
  assert.ok(json.includes('Visible introduction.'));
  assert.ok(json.includes('Visible sibling body.'));
  assert.ok(!json.includes('CANARY'), 'neither private heading nor body may enter any projection field');
});

test('unclosed private shorthand with a following body fails publication closed', () => {
  for (const ending of ['%%p', '%% p \nPRIVATE-CANARY', '%%p\r\nPRIVATE-CANARY']) {
    const doc = parse(prefix + 'Visible.\n## Secret ^PRIVATE\n' + ending);
    assert.equal(doc.trees[1].meta.publish, false, ending);
    assert.ok(doc.diagnostics.some(d => d.code === 'invalid-metadata' && d.severity === 'error'), ending);
    const projection = projectPublic(indexHybrid([doc]));
    assert.deepEqual(projection.trees, []);
    assert.ok(projection.diagnostics.some(d => d.severity === 'error'));
    assert.ok(!JSON.stringify(projection).includes('PRIVATE-CANARY'));
  }
});

for (const newline of ['\n', '\r\n']) {
  test(`private shorthand matches longhand across metadata positions and whitespace: ${JSON.stringify(newline)}`, () => {
    for (const directive of ['%%p%%', '%% p %%', '  %%p%%', '%%\np\n%%']) {
      for (const metadata of [directive, '#Claim\n' + directive, directive + '\n#Claim', '\n' + directive + '\n%% authors: [PrivateAuthor], dates: [2026] %%']) {
        const source = (prefix + '## Secret ^PRIVATE\n' + metadata + '\n\nPRIVATE-CANARY\n## Next ^NEXT\nNext body.\n').replaceAll('\n', newline);
        const doc = parse(source), long = parse(source.replace(/%%\s*p\s*%%/, '%% publish: false %%'));
        assert.equal(doc.trees[1].meta.publish, false, metadata);
        assert.deepEqual(doc.trees.map(tree => tree.meta), long.trees.map(tree => tree.meta));
        assert.deepEqual(doc.diagnostics, []);
        assert.deepEqual(projectPublic(indexHybrid([doc])), projectPublic(indexHybrid([long])));
        assert.ok(doc.trees[1].metadataRanges.some(range => /%%\s*p\s*%%/.test(source.slice(range.from, range.to))));
      }
    }
  });
}

test('private shorthand preserves the existing explicit public-island override', () => {
  const doc = parse(prefix + '## PRIVATE-TITLE-CANARY ^PRIVATE\n%%p%%\nPRIVATE-BODY-CANARY\n### Approved island ^ISLAND\n%% publish: true %%\nApproved body.\n### PRIVATE-SIBLING-TITLE-CANARY ^SIBLING\nPRIVATE-SIBLING-BODY-CANARY\n');
  assert.deepEqual(doc.trees.map(tree => tree.meta.publish), [true, false, true, false]);
  const projection = projectPublic(indexHybrid([doc]));
  assert.deepEqual(projection.diagnostics, []);
  assert.ok(projection.trees.some(tree => tree.id === 'ISLAND' && tree.body.includes('Approved body.')));
  assert.ok(!JSON.stringify(projection).includes('CANARY'));
});

test('root shorthand overrides public folders and inherited children without granting title visibility', () => {
  for (const placement of ['%%p%%\n# Root\n', '# Root\n%%p%%\n']) {
    const doc = parse(placement + 'PRIVATE-CANARY\n## Child ^CHILD\nChild body.\n', { publicFolders: ['/'] });
    assert.ok(doc.trees.every(tree => !tree.meta.publish && !tree.meta.publicTitle));
    assert.deepEqual(projectPublic(indexHybrid([doc])), { trees: [], diagnostics: [] });
  }
});

test('private links are redacted and private embeds fail closed with shorthand metadata', () => {
  const doc = parse(prefix + 'See [[PRIVATE|PRIVATE-LABEL-CANARY]].\n## PRIVATE-TITLE-CANARY ^PRIVATE\n%%p%%\nPRIVATE-BODY-CANARY\n');
  const projection = projectPublic(indexHybrid([doc]));
  assert.deepEqual(projection.diagnostics, []);
  assert.ok(projection.trees[0].body.includes('[非公開]'));
  assert.ok(!JSON.stringify(projection).includes('CANARY'));
  const embedded = parse(doc.source.replace('See [[PRIVATE|PRIVATE-LABEL-CANARY]].', '![[PRIVATE]]'));
  const blocked = projectPublic(indexHybrid([embedded]));
  assert.deepEqual(blocked.trees, []);
  assert.ok(blocked.diagnostics.some(d => d.severity === 'error'));
  assert.ok(!JSON.stringify(blocked).includes('CANARY'));
});

test('explicit public-title remains independent from the private shorthand', () => {
  const doc = parse(prefix + 'See [[PRIVATE]].\n## Approved title ^PRIVATE\n%%p%%\n%% public-title: true %%\nPRIVATE-CANARY\n');
  assert.equal(doc.trees[1].meta.publish, false);
  assert.equal(doc.trees[1].meta.publicTitle, true);
  const projection = projectPublic(indexHybrid([doc]));
  assert.deepEqual(projection.diagnostics, []);
  assert.ok(projection.trees[0].body.includes('Approved title'));
  assert.ok(!JSON.stringify(projection).includes('PRIVATE-CANARY'));
});

test('private shorthand is not an inline heading, body, code, raw, math or embed display flag', () => {
  for (const source of [
    '## Example ^EXAMPLE\n```md\n%%p%%\n```\nBody.',
    '## Example ^EXAMPLE\n`%%p%%`\nBody.',
    '## Example ^EXAMPLE\n    %%p%%\nBody.',
    '## Example ^EXAMPLE\n> %%p%%\n\nBody.',
    '## Example ^EXAMPLE\n$$\n%%p%%\n$$\nBody.',
    '## Example ^EXAMPLE\n\\{ %%p%% }\nBody.',
    '## Example ^EXAMPLE\nBody.\n%%p%%\n',
    '## Example %%p%% ^EXAMPLE\nBody.',
    '## Example ^EXAMPLE\n\\%%p%%\nBody.',
    '## Example ^EXAMPLE\n![[PUBLIC]] %%p%%\n',
  ]) {
    const doc = parse(prefix + source);
    assert.equal(doc.trees[1].meta.publish, true, source);
    assert.ok(!doc.trees[1].metadataRanges.length, source);
  }
  assert.equal(parseEmbedLine('![[PUBLIC]] %%p%%')?.error, 'Unknown embed flag: p');
  assert.deepEqual(parseEmbedLine('![[PUBLIC]] %%ht%%'), { target: 'PUBLIC', heading: false, toc: false });
  const excluded = parse(prefix + '## Secret ^PRIVATE\n%%p%%\nBody.', { excludedFolders: ['/'] });
  assert.equal(excluded.enabled, false);
  assert.deepEqual(excluded.root.metadataRanges, []);
});

test('shorthand metadata remains in source and locally displays private content', () => {
  const doc = parse(prefix + '## Secret ^PRIVATE\n%%p%%\nLocal private body.\n');
  const index = indexHybrid([doc]);
  const plan = planDisplay(doc, [], target => resolveHybrid(index, target, doc.path));
  assert.equal(plan.headings.length, 1, 'private does not hide the local subtree');
  assert.ok(plan.spans.some(span => span.kind === 'metadata' && doc.source.slice(span.from, span.to).includes('%%p%%')));
  assert.ok(doc.source.slice(doc.trees[1].contentFrom).includes('Local private body.'));
  assert.ok(!JSON.stringify(projectPublic(index)).includes('Local private body.'));
});

test('settled ID save retains shorthand and publication boundaries after reparse', () => {
  const doc = parse(prefix + '## Secret\n%%p%%\nPRIVATE-CANARY\n');
  const plan = planHybridSave(indexHybrid([doc]), doc.path, () => 'ABCDEF');
  assert.deepEqual(plan.diagnostics, []);
  assert.equal(plan.edits.length, 1);
  assert.ok(plan.edits[0].after.includes('%%p%%'));
  const saved = parse(plan.edits[0].after);
  assert.equal(saved.trees[1].id, 'ABCDEF');
  assert.equal(saved.trees[1].meta.publish, false);
  assert.ok(!JSON.stringify(projectPublic(indexHybrid([saved]))).includes('PRIVATE-CANARY'));
  assert.deepEqual(planHybridSave(indexHybrid([saved]), saved.path, () => { throw new Error('already addressed'); }).edits, []);
});

test('public CLI consumes private shorthand without shipping private subtree data', async () => {
  assert.ok(existsSync('dist/project-public.mjs'));
  const base = await mkdtemp(resolve('test/build/private-flag-cli-'));
  const vault = join(base, 'vault'), output = join(base, 'forest.json');
  try {
    await mkdir(vault);
    const source = prefix + 'Visible body.\n## PRIVATE-TITLE-CANARY ^PRIVATE\n%%p%%\nPRIVATE-BODY-CANARY\n';
    await writeFile(join(vault, 'Note.md'), source);
    const args = ['dist/project-public.mjs', '--vault', vault, '--out', output];
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const json = await readFile(output, 'utf8');
    assert.ok(!json.includes('CANARY'));
    assert.ok(json.includes('Visible body.'));
    await rm(output);
    await writeFile(join(vault, 'Note.md'), source.replace('Visible body.', '![[PRIVATE]]'));
    const blocked = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000 });
    assert.notEqual(blocked.status, 0);
    assert.equal(existsSync(output), false);
    assert.ok(!blocked.stderr.includes('CANARY'));
  } finally { await rm(base, { recursive: true, force: true }); }
});
