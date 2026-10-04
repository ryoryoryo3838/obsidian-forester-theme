import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, readFile, readdir, lstat, readlink, symlink, rm} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {resolve, join} from 'node:path';
import {parseHybrid, indexHybrid} from './build/hybrid-core.mjs';
import {projectPublic} from './build/hybrid-public.mjs';

const options = {folders: [], publicFolders: [], reservedIds: []};
const publicNote = body => '---\nforester-mode: true\nforester-id: PUBLIC\ntitle: Public\npublish: true\n---\n' + body;
const privateNote = '---\nforester-mode: true\nforester-id: PRIVATE-ID\n---\n# PRIVATE-TITLE\nPRIVATE-BODY';
const secrets = ['PRIVATE-ID', 'PRIVATE-LABEL', 'PRIVATE-TITLE', 'PRIVATE-BODY', 'PRIVATE-ASSET', 'PRIVATE-PATH'];
const thematicBreaks = ['*', '_', '-'].flatMap(marker =>
  ['', ' ', '  ', '   '].flatMap(indent => [
    marker.repeat(3), marker.repeat(7),
    Array(3).fill(marker).join(' '), `${marker}\t${marker} \t${marker}\t `,
  ].map(line => indent + line)));
const payloads = [
  ['private link', '[[PRIVATE-ID|PRIVATE-LABEL]]', undefined],
  ['private embed', '![[PRIVATE-ID]]', 'private-embed'],
  ['Markdown asset', '![image](PRIVATE-ASSET.png)', 'unvetted-asset'],
  ['wiki asset', '![[PRIVATE-ASSET.png]]', 'unvetted-asset'],
  ['HTML resource', 'Text <img src="PRIVATE-ASSET.png" onerror="alert(1)">', 'unsafe-html'],
  ['unsafe URL', '[PRIVATE-LABEL](javascript:alert(1))', 'unsafe-url'],
  ['raw dependency', String.raw`\{ \import{PRIVATE-PATH} }`, 'unsupported-raw'],
];

function noDisclosure(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  for (const secret of secrets) assert.ok(!text.includes(secret), `private value escaped: ${secret}`);
}

function project(body, extra = []) {
  const visible = parseHybrid('Public.md', publicNote(body), options);
  const hidden = parseHybrid('Private.md', privateNote, options);
  const index = indexHybrid([visible, hidden, ...extra]);
  assert.deepEqual(index.diagnostics.filter(d => d.severity === 'error'), []);
  return {document: visible, projection: projectPublic(index)};
}

// The scanners still preserve CR source offsets, but tree structure parsing does
// not support bare CR. Publication must refuse that source rather than normalize it.
function expectUnsupportedLineEnding(projection) {
  assert.deepEqual(projection.trees, []);
  assert.equal(projection.diagnostics.length, 1);
  assert.equal(projection.diagnostics[0].code, 'unsupported-line-ending');
  assert.equal(projection.diagnostics[0].severity, 'error');
  assert.equal(projection.diagnostics[0].path, '');
  noDisclosure(projection);
}

function expectProjection(projection, body, payload, code) {
  if (/\r(?!\n)/.test(body)) {
    expectUnsupportedLineEnding(projection);
    return;
  }
  if (code) {
    assert.deepEqual(projection.trees, [], `must block ${code}`);
    assert.ok(projection.diagnostics.some(d => d.code === code && d.severity === 'error'),
      `expected ${code}: ${JSON.stringify(projection.diagnostics)}`);
  } else {
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.trees.length, 1);
    assert.equal(projection.trees[0].body, body.replace(payload, '[非公開]'));
  }
  noDisclosure(projection);
}

// Snapshot directory entries AND contents/mtimes; never follow source symlinks.
async function snapshot(root, prefix = '') {
  const result = [];
  for (const name of (await readdir(root)).sort()) {
    const path = join(root, name), relative = prefix + name;
    const stat = await lstat(path);
    const entry = {path: relative, mode: stat.mode, mtimeMs: stat.mtimeMs};
    if (stat.isSymbolicLink()) entry.link = await readlink(path);
    else if (stat.isDirectory()) {
      entry.directory = true;
      result.push(entry, ...await snapshot(path, relative + '/'));
      continue;
    } else entry.bytes = await readFile(path);
    result.push(entry);
  }
  return result;
}

async function withVault(body, run) {
  const base = await mkdtemp(join(process.env.TMPDIR ?? resolve('test/build'), 'hybrid-second-review-'));
  const vault = join(base, 'vault');
  try {
    await mkdir(vault);
    await writeFile(join(vault, 'Public.md'), publicNote(body));
    await writeFile(join(vault, 'Private.md'), privateNote);
    await run({base, vault, out: join(base, 'public.json')});
  } finally {
    await rm(base, {recursive: true, force: true});
  }
}

function cli(vault, out, config) {
  const args = [resolve('dist/project-public.mjs'), '--vault', vault, '--out', out];
  if (config) args.push('--config', config);
  const result = spawnSync(process.execPath, args, {encoding: 'utf8'});
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  noDisclosure(result.stdout + result.stderr);
  return result;
}

for (const line of thematicBreaks) {
  test(`root inline code cannot hide a private link across thematic break ${JSON.stringify(line)}`, () => {
    for (const newline of ['\n', '\r\n', '\r']) for (const delimiter of ['`', '``']) {
      const payload = payloads[0][1];
      const body = `Opening ${delimiter}example\n${line}\n${payload}\nClosing${delimiter}`.replace(/\n/g, newline);
      const {document, projection} = project(body);
      expectProjection(projection, body, payload);
      const payloadFrom = document.source.indexOf(payload);
      assert.ok(!document.protectedRanges.some(r => r.from <= payloadFrom && r.to > payloadFrom),
        'the parser must not mask the paragraph following the thematic break');
    }
  });
}

for (const line of ['***', '___']) for (const [name, payload, code] of payloads.slice(1)) {
  test(`root inline code cannot conceal ${name} after ${line}`, () => {
    const body = `Opening \`example\n${line}\n${payload}\nClosing\``;
    expectProjection(project(body).projection, body, payload, code);
  });
}

for (const line of ['***', '___']) for (const [name, payload, code] of payloads) {
  test(`composed-output inline code guard catches ${name} after ${line}`, () => {
    // The target's unclosed fence consumes the source fence after expansion, exposing
    // source text which WAS a valid literal fence before the bodies were composed.
    const examples = parseHybrid('Examples.md', publicNote('~~~text\nUnclosed fenced example\n')
      .replace('forester-id: PUBLIC', 'forester-id: EXAMPLES').replace('title: Public', 'title: Examples'), options);
    const body = `![[EXAMPLES]]\n~~~\nOpening \`example\n${line}\n${payload}\nClosing\`\n~~~`;
    const {projection} = project(body, [examples]);
    // Final validation does not resolve wiki targets again (including wiki assets).
    const expectedCode = payload.includes('[[') ? 'unresolved-reference' : code;
    assert.deepEqual(projection.trees, []);
    assert.ok(projection.diagnostics.some(d => d.code === expectedCode && d.severity === 'error'),
      `composed output must block ${expectedCode}: ${JSON.stringify(projection.diagnostics)}`);
    noDisclosure(projection);
  });
}

for (const line of ['***', '___']) {
  test(`actual CLI redacts/blocks live payloads beyond thematic break ${line}`, async () => {
    await withVault('', async ({vault, out}) => {
      for (const newline of ['\n', '\r\n', '\r']) for (const [, payload, code] of payloads) {
        const body = `Opening \`example\n${line}\n${payload}\nClosing\``.replace(/\n/g, newline);
        await writeFile(join(vault, 'Public.md'), publicNote(body));
        const before = await snapshot(vault);
        const result = cli(vault, out);
        assert.deepEqual(await snapshot(vault), before, 'projection CLI must not modify source');
        const expectedCode = newline === '\r' ? 'unsupported-line-ending' : code;
        assert.equal(result.status, expectedCode ? 1 : 0, result.stderr);
        if (expectedCode) {
          await assert.rejects(readFile(out), {code: 'ENOENT'});
          assert.ok(JSON.parse(result.stderr).diagnostics.some(d => d.code === expectedCode));
        } else {
          const artifact = JSON.parse(await readFile(out, 'utf8'));
          noDisclosure(artifact);
          assert.equal(artifact.trees[0].body, body.replace(payload, '[非公開]'));
          await rm(out);
        }
      }
    });
  });
}

for (const body of [
  'Opening `example\nsoft continuation\nClosing`',
  'Opening ``example\n__not a thematic break__\nClosing``',
  'Opening `example\n**\nClosing`',
  'Opening `example\n__\nClosing`',
  'Opening `example\n***not a break\nClosing`',
  'Opening `example\n____not a break\nClosing`',
  'Opening `example\n    ***\nClosing`',
  'Opening `example\n\t___\nClosing`',
  '~~~text\nOpening `example\n***\n![literal](example.png)\nClosing`\n~~~',
  '```text\nOpening `example\n___\n<img src="example.png">\nClosing`\n```',
  '    Opening `example\n    ***\n    ![[literal-example]]\n    Closing`',
]) {
  test(`valid soft-line-break or block code remains literal: ${JSON.stringify(body)}`, () => {
    const {projection} = project(body);
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.trees.length, 1);
    assert.equal(projection.trees[0].body, body);
  });
}

for (const line of thematicBreaks) {
  test(`inline math cannot mask the paragraph beyond thematic break ${JSON.stringify(line)}`, () => {
    for (const [opening, closing] of [['$', '$'], [String.raw`\(`, String.raw`\)`]]) {
      for (const newline of ['\n', '\r\n', '\r']) {
        const payload = payloads[0][1];
        const body = `Opening ${opening}example\n${line}\n${payload}\nClosing${closing}`.replace(/\n/g, newline);
        const {document, projection} = project(body);
        const openingFrom = document.source.indexOf(opening + 'example');
        const payloadFrom = document.source.indexOf(payload);
        assert.ok(!document.protectedRanges.some(r => r.from === openingFrom && r.to > payloadFrom),
          'a terminated inline math guard must not span a CommonMark block boundary');
        expectProjection(projection, body, payload);
      }
    }
  });
}

for (const math of [
  '$x\n+y$', String.raw`\(x` + '\n+y' + String.raw`\)`,
  '$x\n**\n+y$', '$x\n__\n+y$', '$x\n    ***\n+y$',
  '$x\n\t___\n+y$', '$x\n___not a thematic break\n+y$',
  '$$\n***\n___\n- - -\n\nx+y\n$$',
  String.raw`\[` + '\n***\n___\n- - -\n\nx+y\n' + String.raw`\]`,
]) {
  test(`valid inline/block math stays protected: ${JSON.stringify(math)}`, () => {
    const {document, projection} = project(math);
    assert.ok(document.protectedRanges.some(r => document.source.slice(r.from, r.to) === math));
    assert.deepEqual(projection.diagnostics, []);
    assert.equal(projection.trees[0].body, math);
  });
}

for (const [opening, closing] of [['$', '$'], [String.raw`\(`, String.raw`\)`]]) {
  test(`actual CLI keeps math-boundary private references live: ${opening}`, async () => {
    const payload = payloads[0][1];
    const body = `Opening ${opening}example\n_\t_ \t_\n${payload}\nClosing${closing}`;
    await withVault(body, async ({vault, out}) => {
      const before = await snapshot(vault);
      const result = cli(vault, out);
      assert.equal(result.status, 0, result.stderr);
      noDisclosure(await readFile(out, 'utf8'));
      assert.equal(JSON.parse(await readFile(out, 'utf8')).trees[0].body, body.replace(payload, '[非公開]'));
      assert.deepEqual(await snapshot(vault), before);
    });
  });
}

for (const [name, opening, closing] of [
  ['code', '``', '``'], ['dollar math', '$', '$'], ['parenthesis math', String.raw`\(`, String.raw`\)`],
]) {
  test(`valid soft-line-break ${name} keeps exact ranges; bare CR publication is refused`, () => {
    for (const newline of ['\n', '\r\n', '\r']) {
      const span = `${opening}example${newline}ordinary continuation${newline}Closing${closing}`;
      const body = 'Opening ' + span;
      const {document, projection} = project(body);
      const from = document.source.indexOf(span);
      assert.ok(document.protectedRanges.some(r => r.from === from && r.to === from + span.length));
      if (newline === '\r') {
        expectUnsupportedLineEnding(projection);
        continue;
      }
      assert.deepEqual(projection.diagnostics, []);
      assert.equal(projection.trees[0].body, body);
    }
  });
}

const rejectedOutputs = [
  ['missing nested directory inside source', async ({vault}) => ({out: join(vault, 'new-dir', 'nested', 'public.json')})],
  ['parent symlink into source with missing suffix', async ({base, vault}) => {
    const alias = join(base, 'vault-alias');
    await symlink(vault, alias, 'dir');
    return {out: join(alias, 'new-dir', 'nested', 'public.json')};
  }],
  ['chained parent symlinks into source', async ({base, vault}) => {
    const inner = join(base, 'inner'), outer = join(base, 'outer');
    await symlink(vault, inner, 'dir');
    await symlink(inner, outer, 'dir');
    return {out: join(outer, 'new-dir', 'nested', 'public.json')};
  }],
  ['lexical source path whose parent symlink escapes source', async ({base, vault}) => {
    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(vault, 'escape'), 'dir');
    return {out: join(vault, 'escape', 'new-dir', 'public.json')};
  }],
  ['ancestor symlink enters source before another symlink escapes', async ({base, vault}) => {
    const outside = join(base, 'outside'), alias = join(base, 'vault-alias');
    await mkdir(outside);
    await symlink(outside, join(vault, 'escape'), 'dir');
    await symlink(vault, alias, 'dir');
    return {out: join(alias, 'escape', 'new-dir', 'public.json')};
  }],
  ['lexical vault-argument alias before an escaping symlink', async ({base, vault}) => {
    const alias = join(base, 'vault-alias'), outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(vault, alias, 'dir');
    await symlink(outside, join(vault, 'escape'), 'dir');
    return {vault: alias, out: join(alias, 'escape', 'new-dir', 'public.json')};
  }],
  ['canonical source path when vault argument is an alias', async ({base, vault}) => {
    const alias = join(base, 'vault-alias');
    await symlink(vault, alias, 'dir');
    return {vault: alias, out: join(vault, 'new-dir', 'nested', 'public.json')};
  }],
  ['existing source JSON file', async ({vault}) => {
    const out = join(vault, 'input.json');
    await writeFile(out, '{"source":"unchanged"}\n');
    return {out};
  }],
  ['final output symlink to a source input', async ({base, vault}) => {
    const out = join(base, 'public.json');
    await symlink(join(vault, 'Public.md'), out);
    return {out};
  }],
  ['dangling final output symlink', async ({base, vault}) => {
    const out = join(base, 'public.json');
    await symlink(join(vault, 'not-created.json'), out);
    return {out};
  }],
  ['dangling parent symlink', async ({base, vault}) => {
    const alias = join(base, 'broken-parent');
    await symlink(join(vault, 'not-created'), alias, 'dir');
    return {out: join(alias, 'nested', 'public.json')};
  }],
  ['file used as an output parent', async ({base}) => {
    const file = join(base, 'file-parent');
    await writeFile(file, 'not a directory');
    return {out: join(file, 'nested', 'public.json')};
  }],
  ['directory used as final JSON output', async ({base}) => {
    const out = join(base, 'directory.json');
    await mkdir(out);
    return {out};
  }],
  ['non-JSON suffix below a missing directory', async ({base}) => ({out: join(base, 'not-created', 'public.json.tmp')})],
  ['output equal to the configuration input', async ({base}) => {
    const config = join(base, 'config.json');
    await writeFile(config, '{"folders":[],"publicFolders":[],"reservedIds":[]}\n');
    return {out: config, config};
  }],
];

for (const [name, setup] of rejectedOutputs) {
  test(`actual CLI rejects ${name} before any filesystem mutation`, async () => {
    await withVault('Safe public body.', async fixture => {
      const target = await setup(fixture);
      const before = await snapshot(fixture.base);
      const result = cli(target.vault ?? fixture.vault, target.out, target.config);
      assert.deepEqual(await snapshot(fixture.base), before,
        'a rejected output must not create directories, alter inputs, or leave temporary files');
      assert.equal(result.status, 1, 'unsafe output namespace must be rejected');
      assert.ok(!result.stderr.includes(fixture.vault), 'failure details must not echo source paths');
    });
  });
}

const acceptedOutputs = [
  ['new nested directory outside source', async ({base}) => ({out: join(base, 'new-dir', 'nested', 'public.json')})],
  ['vault-name prefix sibling directory', async ({base}) => ({out: join(base, 'vault-copy', 'nested', 'public.json')})],
  ['safe external parent symlink', async ({base}) => {
    const outside = join(base, 'outside'), alias = join(base, 'outside-alias');
    await mkdir(outside);
    await symlink(outside, alias, 'dir');
    return {out: join(alias, 'new-dir', 'nested', 'public.json')};
  }],
  ['existing external JSON artifact via atomic rename', async ({base}) => {
    const out = join(base, 'public.json');
    await writeFile(out, '{"old":true}\n');
    return {out, previousInode: (await lstat(out)).ino};
  }],
];

for (const [name, setup] of acceptedOutputs) {
  test(`actual CLI still publishes to ${name}`, async () => {
    await withVault('Safe public body.', async fixture => {
      const target = await setup(fixture);
      const before = await snapshot(fixture.vault);
      const result = cli(fixture.vault, target.out);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {status: 'ok', publicTrees: 1});
      const artifact = JSON.parse(await readFile(target.out, 'utf8'));
      assert.equal(artifact.format, 'forester-public-v1');
      assert.deepEqual(artifact.trees, [{id: 'PUBLIC', title: 'Public', body: 'Safe public body.', citationAuthors: []}]);
      noDisclosure(artifact);
      const stat = await lstat(target.out);
      assert.ok(stat.isFile() && !stat.isSymbolicLink());
      assert.equal(stat.mode & 0o777, 0o600);
      if (target.previousInode !== undefined) assert.notEqual(stat.ino, target.previousInode);
      assert.deepEqual(await snapshot(fixture.vault), before);
      const files = await snapshot(fixture.base);
      assert.ok(!files.some(entry => entry.path.endsWith('.tmp')), 'temporary artifact must be removed');
    });
  });
}
