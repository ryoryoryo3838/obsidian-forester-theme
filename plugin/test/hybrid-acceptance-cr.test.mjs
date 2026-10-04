import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {fileURLToPath} from 'node:url';
import {mkdtemp, mkdir, writeFile, readFile, readdir, lstat, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';

// Build the real parser, projector and CLI in an isolated generated namespace.
const root = fileURLToPath(new URL('../', import.meta.url));
const buildDirectory = new URL('./build/crfix/', import.meta.url);
await build({
  absWorkingDir: root,
  entryPoints: {
    'hybrid-core': 'src/hybrid-core.ts', 'hybrid-public': 'src/hybrid-public.ts',
    'project-public': 'scripts/project-public.ts',
  },
  bundle: true, format: 'esm', platform: 'node',
  outdir: fileURLToPath(buildDirectory), outExtension: {'.js': '.mjs'}, logLevel: 'warning',
});
const {parseHybrid, indexHybrid} = await import(new URL('hybrid-core.mjs', buildDirectory));
const {projectPublic} = await import(new URL('hybrid-public.mjs', buildDirectory));
const cliPath = fileURLToPath(new URL('project-public.mjs', buildDirectory));
const options = {folders: [], publicFolders: [], reservedIds: []};
const canary = 'ACCEPTANCE-PRIVATE-CANARY';
const titleCanary = 'ACCEPTANCE-PRIVATE-TITLE';
const privatePath = 'ACCEPTANCE-PRIVATE-PATH/ACCEPTANCE-PRIVATE-FILENAME.md';
const header = '---\nforester-mode: true\nforester-id: PUBLIC\ntitle: Public\npublish: true\n---\n';
const unsupportedSource = header + `## Hidden ^hidden\r%% publish: false %%\r${canary}`;
const blockedDiagnostic = {
  code: 'unsupported-line-ending', message: '未対応の改行を含む入力は公開できません。',
  path: '', severity: 'error',
};
const validBody = `Visible body.\n\n## Hidden ^hidden\n%% publish: false %%\n${canary}\n`;
const validSources = [
  ['LF', header + validBody],
  ['CRLF', (header + validBody).replace(/\n/g, '\r\n')],
  ['LF/CRLF mixed', header + validBody.replace(/\n/g, '\r\n')],
];
const unsupportedCases = [
  ['all-bare-CR', unsupportedSource.replace(/\n/g, '\r')],
  ['LF/bare-CR mixed', unsupportedSource],
  ['CRLF/bare-CR mixed', unsupportedSource.replace(/\n/g, '\r\n')],
  ['trailing bare-CR', header + 'Visible body.\r'],
  ['double CR before LF', header + 'Visible body.\r\r\n'],
  ['fenced literal', header + '~~~text\nliteral\rcarriage\n~~~\n'],
  ['comment', header + 'Visible body.\n<!-- example\rcarriage -->\n'],
  ['omitted private body', header + validBody.replace(canary, `${canary}\r${canary}`)],
];

function noDisclosure(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of [canary, titleCanary, privatePath, 'ACCEPTANCE-PRIVATE-FILENAME', 'Hidden', 'hidden']) {
    assert.ok(!text.includes(secret), `private value escaped: ${secret}`);
  }
}

function assertBlocked(projection) {
  assert.deepEqual(projection.trees, [], 'unsupported source must not expose a public title or body');
  assert.deepEqual(projection.diagnostics, [blockedDiagnostic], 'only a source-free error may be returned');
  noDisclosure(projection);
}

function projectDocuments(documents) {
  const before = documents.map(document => document.source);
  const index = indexHybrid(documents);
  assert.deepEqual(index.diagnostics.filter(d => d.severity === 'error'), []);
  const projection = projectPublic(index);
  for (const [i, document] of documents.entries()) {
    assert.equal(document.source, before[i], 'projection must not rewrite source line endings');
  }
  return projection;
}

function targetSource(state, body = `${canary}\r${canary}`) {
  return ['---', `forester-mode: ${state !== 'disabled'}`, 'forester-id: TARGET',
    `title: ${titleCanary}`, `publish: ${state === 'public'}`, 'public-title: true',
    'aliases: [TargetAlias]', '---', body].join('\n');
}

test('bare-CR private subtree is rejected before public projection', () => {
  const document = parseHybrid('Public.md', unsupportedSource, options);
  assert.deepEqual(document.diagnostics, []);
  assertBlocked(projectDocuments([document]));
  assert.equal(document.source, unsupportedSource);
});

for (const [name, source] of unsupportedCases.filter(([name]) => name !== 'LF/bare-CR mixed')) {
  test(`raw source preflight rejects ${name}`, () => {
    const document = parseHybrid(privatePath, source, options);
    assert.deepEqual(document.diagnostics, []);
    assertBlocked(projectDocuments([document]));
    assert.equal(document.source, source);
  });
}

for (const state of ['public', 'private', 'disabled']) {
  for (const [referenceName, reference] of [
    ['unreferenced', 'Visible body.'], ['alias link', '[[TargetAlias]]'],
    ['alias embed', '![[TargetAlias]]'], ['alias citation', '{ref:[[TargetAlias]]}'],
  ]) {
    test(`preflight includes ${state} source even with ${referenceName}`, () => {
      const visible = parseHybrid('Public.md', header + reference, options);
      const target = parseHybrid(privatePath, targetSource(state), options);
      assert.equal(target.enabled, state !== 'disabled');
      assert.deepEqual(target.diagnostics, []);
      assertBlocked(projectDocuments([visible, target]));
    });
  }
}

for (const [name, source] of validSources) {
  test(`${name} source still removes an explicit private subtree`, () => {
    const document = parseHybrid('Public.md', source, options);
    assert.deepEqual(document.diagnostics, []);
    assert.equal(document.trees.length, 2);
    assert.equal(document.trees[1].meta.publish, false);
    const projection = projectDocuments([document]);
    assert.deepEqual(projection, {
      trees: [{id: 'PUBLIC', title: 'Public', body: 'Visible body.', citationAuthors: []}], diagnostics: [],
    });
    noDisclosure(projection);
    assert.equal(document.source, source);
  });
}

test('LF and CRLF public embed composition still strips the target private subtree', () => {
  const visible = parseHybrid('Public.md', header + '![[TARGET]]', options);
  const target = parseHybrid('Target.md', (header.replace('forester-id: PUBLIC', 'forester-id: TARGET')
    .replace('title: Public', 'title: Target') + validBody).replace(/\n/g, '\r\n'), options);
  const projection = projectDocuments([visible, target]);
  assert.deepEqual(projection, {trees: [
    {id: 'PUBLIC', title: 'Public', body: '## Target\n\nVisible body.', citationAuthors: []},
    {id: 'TARGET', title: 'Target', body: 'Visible body.', citationAuthors: []},
  ], diagnostics: []});
  noDisclosure(projection);
});

// Include directory entries, bytes and mtimes, so refusal cannot create even an output parent.
async function snapshot(path) {
  const stat = await lstat(path);
  const entry = {mode: stat.mode, mtimeMs: stat.mtimeMs, ino: stat.ino, size: stat.size};
  if (stat.isDirectory()) {
    entry.entries = [];
    for (const name of (await readdir(path)).sort()) {
      entry.entries.push({name, snapshot: await snapshot(join(path, name))});
    }
  } else entry.bytes = await readFile(path);
  return entry;
}

async function withVault(source, run) {
  const scratch = process.env.TMPDIR ?? fileURLToPath(new URL('./build/', import.meta.url));
  const base = await mkdtemp(join(scratch, 'hybrid-crfix-cli-'));
  const vault = join(base, 'vault');
  const file = join(vault, 'Public.md');
  try {
    await mkdir(vault);
    await mkdir(join(vault, 'ACCEPTANCE-PRIVATE-PATH'));
    await writeFile(file, source);
    await writeFile(join(vault, privatePath), targetSource('private', canary));
    await run({base, vault, file, out: join(base, 'outside', 'new', 'public.json')});
  } finally {
    await rm(base, {recursive: true, force: true});
  }
}

function cli(vault, out) {
  const result = spawnSync(process.execPath, [cliPath, '--vault', vault, '--out', out], {encoding: 'utf8'});
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  noDisclosure(result.stdout + result.stderr);
  assert.ok(!result.stderr.includes(vault), 'diagnostics must not echo absolute source paths');
  assert.ok(!result.stderr.includes(out), 'diagnostics must not echo output paths');
  return result;
}

function assertCliBlocked(result) {
  assert.equal(result.status, 1, 'unsupported source must fail closed, not succeed with a partial artifact');
  assert.equal(result.stdout, '');
  assert.deepEqual(JSON.parse(result.stderr), {status: 'blocked', diagnostics: [blockedDiagnostic]});
}

for (const [name, source] of unsupportedCases.slice(0, 4)) {
  test(`actual CLI refuses ${name} without creating output or modifying source`, async () => {
    await withVault(source, async ({base, vault, out}) => {
      const before = await snapshot(base);
      const result = cli(vault, out);
      assertCliBlocked(result);
      await assert.rejects(readFile(out), {code: 'ENOENT'});
      assert.deepEqual(await snapshot(base), before, 'refusal must leave directories, files and mtimes unchanged');
    });
  });
}

for (const [name, source] of validSources) {
  test(`actual CLI still exports public-only ${name} input`, async () => {
    await withVault(source, async ({vault, out}) => {
      const before = await snapshot(vault);
      const result = cli(vault, out);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, '');
      assert.deepEqual(JSON.parse(result.stdout), {status: 'ok', publicTrees: 1});
      const artifact = JSON.parse(await readFile(out, 'utf8'));
      assert.deepEqual(artifact, {format: 'forester-public-v1', trees: [
        {id: 'PUBLIC', title: 'Public', body: 'Visible body.', citationAuthors: []},
      ]});
      noDisclosure(artifact);
      assert.deepEqual(await snapshot(vault), before);
    });
  });
}

test('actual CLI refusal preserves the previous successful artifact byte-for-byte', async () => {
  await withVault(validSources[0][1], async ({base, vault, file, out}) => {
    assert.equal(cli(vault, out).status, 0);
    const successfulArtifact = await readFile(out);
    noDisclosure(successfulArtifact.toString('utf8'));
    await writeFile(file, unsupportedSource);
    const before = await snapshot(base);
    assertCliBlocked(cli(vault, out));
    assert.deepEqual(await readFile(out), successfulArtifact);
    assert.deepEqual(await snapshot(base), before, 'refusal must not replace the existing artifact or alter source');
  });
});
