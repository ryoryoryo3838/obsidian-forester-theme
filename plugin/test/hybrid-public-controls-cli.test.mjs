import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, stat, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseHybrid } from './build/hybrid-core.mjs';

const prefix = '---\nforester-id: PUBLICA\ntitle: Public A\npublish: true\n---\n';
const options = { folders: [], publicFolders: [], reservedIds: [] };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const ids = document => document.trees.map(t => [t.id, t.from, t.contentFrom, t.to, t.meta.publish, t.meta.publicTitle]);
const cli = (vault, out, extra = [], format = 'forest', timeout = 10000) => spawnSync(process.execPath, ['dist/project-public.mjs', '--vault', vault, '--out', out, ...(format === 'forest' ? ['--format', 'forest'] : []), ...extra], { encoding: 'utf8', timeout });
async function fixture(fn) {
  const base = await mkdtemp(join(tmpdir(), 'public-controls-cli-'));
  const vault = join(base, 'vault'); await mkdir(join(vault, 'CANARYPATH'), { recursive: true });
  try { await fn(base, vault); } finally { await rm(base, { recursive: true, force: true }); }
}
async function snapshot(vault, paths) {
  const result = {};
  for (const path of paths) {
    const bytes = await readFile(join(vault, path)), info = await stat(join(vault, path), { bigint: true });
    result[path] = { bytes, hash: sha(bytes), mtime: info.mtimeNs, inode: info.ino,
      ids: path.endsWith('.md') ? ids(parseHybrid(path, bytes.toString('utf8'), options)) : [] };
  }
  return result;
}
async function unchanged(vault, before) {
  for (const [path, expected] of Object.entries(before)) {
    const bytes = await readFile(join(vault, path)), info = await stat(join(vault, path), { bigint: true });
    assert.deepEqual(bytes, expected.bytes, 'original source bytes');
    assert.equal(sha(bytes), expected.hash, 'original source SHA-256');
    assert.equal(info.mtimeNs, expected.mtime); assert.equal(info.ino, expected.inode);
    if (path.endsWith('.md')) assert.deepEqual(ids(parseHybrid(path, bytes.toString('utf8'), options)), expected.ids, 'local parser roundtrip IDs/ranges/publication');
  }
}

// Read-only component cross-check, not converter/native/HTTP execution.
function siteLabels(forest) {
  const labels = [];
  const visit = tree => {
    for (const node of tree.content ?? []) {
      if (node.kind === 'unavailable' && node.label !== undefined) labels.push(node.label);
      if (node.kind === 'subtree') visit(node.tree);
    }
  };
  for (const tree of forest.trees ?? []) visit(tree);
  if (!process.env.PUBLIC_CONTROLS_SITE_SCRIPT || !labels.length) return undefined;
  const python = String.raw`
import hashlib, importlib.util, json, sys
from pathlib import Path
sys.dont_write_bytecode = True
path = Path(sys.argv[1])
spec = importlib.util.spec_from_file_location('producer_cli_site', path)
site = importlib.util.module_from_spec(spec)
spec.loader.exec_module(site)
rows = []
for value in json.load(sys.stdin):
    try:
        rows.append({'accepted': True, 'unchanged': site.literal(value) == value and site.unavailable_label(value) == value})
    except site.GateError as error:
        rows.append({'accepted': False, 'code': error.code})
print(json.dumps({'site_sha256': hashlib.sha256(path.read_bytes()).hexdigest(), 'results': rows}))
`;
  const run = spawnSync(process.env.PYTHON ?? 'python3', ['-B', '-c', python, process.env.PUBLIC_CONTROLS_SITE_SCRIPT], {
    input: JSON.stringify(labels), encoding: 'utf8', timeout: 20000,
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  assert.equal(result.results.length, labels.length);
  return result;
}

// Optional durable evidence, outside the repository; ordinary tests stay disposable.
async function recordEvidence(name, vault, out, before, result) {
  const artifact = existsSync(out) ? await readFile(out) : undefined;
  const site = artifact ? siteLabels(JSON.parse(artifact)) : undefined;
  const validate = () => {
    if (result.status === 0 && site) for (const row of site.results) {
      assert.equal(row.accepted, true, 'actual CLI successful label must pass the unchanged site');
      assert.equal(row.unchanged, true, 'actual CLI literal bytes must survive both site functions');
    }
  };
  if (!process.env.PUBLIC_CONTROLS_EVIDENCE) { validate(); return; }
  const dir = join(process.env.PUBLIC_CONTROLS_EVIDENCE, name);
  await mkdir(dir, { recursive: true });
  const sources = {};
  for (const [path, expected] of Object.entries(before)) {
    await mkdir(join(dir, 'vault', path, '..'), { recursive: true });
    await writeFile(join(dir, 'vault', path), expected.bytes);
    const current = await readFile(join(vault, path));
    sources[path] = { before: expected.hash, after: sha(current), inode: String(expected.inode), mtimeNs: String(expected.mtime) };
  }
  if (artifact) await writeFile(join(dir, 'output.json'), artifact);
  await writeFile(join(dir, 'result.json'), JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr,
    error_code: result.error?.code ?? null, signal: result.signal, elapsed_s: result.elapsed_s ?? null,
    cli_sha256: sha(await readFile('dist/project-public.mjs')),
    source_sha256: { public: sha(await readFile('src/hybrid-public.ts')), forest: sha(await readFile('src/hybrid-public-forest.ts')) },
    sources, site, artifact_sha256: artifact ? sha(artifact) : null, output_parent_created: existsSync(join(out, '..')) }, null, 2) + '\n');
  validate();
}

for (const newline of ['\n', '\r\n']) for (const [variant, control] of [
  '%%p', '%%p%', '%%ph', '%%ht%% %%p', '%%ht%% %% p %%', '%% p %%', '%%p\u2028%%', '%%p\u2029%%', '%%p\u0085%%',
].entries()) test(`actual CLI malformed private control refuses before mkdir: ${JSON.stringify([control, newline])}`, async () => fixture(async (base, vault) => {
  await writeFile(join(vault, 'Public.md'), (prefix + `![[CANARYPRIVATEID]] ${control}\nCANARY_AFTER_CONTROL\n`).replaceAll('\n', newline));
  await writeFile(join(vault, 'CANARYPATH/Secret.md'), '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\n---\nCANARYBODY\n');
  const before = await snapshot(vault, ['Public.md', 'CANARYPATH/Secret.md']);
  const parent = join(base, 'new-output-parent'), out = join(parent, 'forest.json');
  const result = cli(vault, out);
  await recordEvidence(`private-control-${variant}-${newline.length}`, vault, out, before, result);
  assert.equal(result.status, 1, 'malformed private controls cannot silently become unavailable');
  assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
  assert.ok(!result.stdout.includes('CANARY')); assert.ok(!result.stderr.includes('CANARY'));
  assert.ok(!result.stderr.includes(vault));
  await unchanged(vault, before);
}));

for (const [variant, title] of ['CANARYFILE.md', 'CANARYFILE.foo', 'CANARYPATH/Secret', 'https://example.invalid/CANARY',
  'CANARY\u0085TITLE', 'CANARY\u2028TITLE', 'CANARY\u202eTITLE', 'CANARY [label]', 'CANARY {literal}', 'CANARY \\link', 'CANARY `code`'].entries()) {
  test(`actual CLI incompatible unavailable label refuses before mkdir: ${variant}`, async () => fixture(async (base, vault) => {
    await writeFile(join(vault, 'Public.md'), prefix + '![[CANARYPRIVATEID|CANARYALIAS]]\n');
    await writeFile(join(vault, 'CANARYPATH/Secret.md'), `---\nforester-id: CANARYPRIVATEID\ntitle: ${JSON.stringify(title)}\npublic-title: true\n---\nCANARYBODY\n`);
    const before = await snapshot(vault, ['Public.md', 'CANARYPATH/Secret.md']);
    const parent = join(base, 'new-output-parent'), out = join(parent, 'forest.json');
    const result = cli(vault, out);
    await recordEvidence(`unavailable-label-${variant}`, vault, out, before, result);
    assert.equal(result.status, 1, 'site-incompatible labels cannot produce a successful snapshot');
    assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
    assert.ok(!result.stdout.includes('CANARY')); assert.ok(!result.stderr.includes('CANARY'));
    assert.ok(!result.stderr.includes(vault));
    await unchanged(vault, before);
  }));
}

const versionDelta = [0x088f, 0x0c5c, 0x0cdc, 0xa7ce, 0xa7cf, 0xa7d2, 0xa7d4, 0xa7f1, 0x10940, 0x10941, 0x33479];
const stableBoundaryTitles = [...versionDelta, 0x0130, 0x0131, 0x017f, 0x212a, 0x6771, 0x2160, 0x2460]
  .flatMap(codepoint => [`${String.fromCodePoint(codepoint)}http: secret`, `Title private.md${String.fromCodePoint(codepoint)} rest`]);
const additionalRejectedTitles = ['maİlto : secret', 'maılto : secret', 'Title private.gİf rest', 'Title private.jſon rest',
  'Title private.marKdown rest', 'http\u00a0: secret', 'http\u3000: secret', 'custom:\ufeff', 'private\ufeff.foo', 'Title:\ufeff Introduction'];
for (const [variant, title] of [...stableBoundaryTitles, ...additionalRejectedTitles].entries()) {
  test(`actual CLI stable Unicode boundary refuses before mkdir: ${variant}`, async () => fixture(async (base, vault) => {
    await writeFile(join(vault, 'Public.md'), prefix + '![[CANARYPRIVATEID|CANARYALIAS]]\n');
    await writeFile(join(vault, 'CANARYPATH/Secret.md'), `---\nforester-id: CANARYPRIVATEID\ntitle: ${JSON.stringify(title)}\npublic-title: true\n---\nCANARYBODY\n`);
    const before = await snapshot(vault, ['Public.md', 'CANARYPATH/Secret.md']);
    const parent = join(base, 'new-output-parent'), out = join(parent, 'forest.json');
    const result = cli(vault, out);
    await recordEvidence(`stable-boundary-${variant}`, vault, out, before, result);
    assert.equal(result.status, 1, 'unsafe Unicode boundary cannot succeed');
    assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
    assert.ok(JSON.parse(result.stderr).codes.includes('unsafe-unavailable-label'));
    assert.ok(!result.stdout.includes('CANARY')); assert.ok(!result.stderr.includes('CANARY'));
    assert.ok(!result.stderr.includes(vault)); assert.ok(!result.stderr.includes(title));
    await unchanged(vault, before);
  }));
}
const approvedUnicodeTitles = ['独立した公開題名', 'Café', 'Cafe\u0301', 'Public & "semantic" e\u0301 題名',
  '  Approved semantic title  ', 'A😀 title', 'Title:\u3000Introduction', 'Title\ufeff: Introduction',
  'İıſK — 承認済み題名', 'title.md_1 rest', 'title.mdA rest', 'Ahttp: secret', 'http\ufeff: secret',
  'custom:\u00a0', 'custom:\u3000', 'private\u00a0.foo', ...versionDelta.map(codepoint => `Approved ${String.fromCodePoint(codepoint)} 題名`)];
for (const [variant, title] of approvedUnicodeTitles.entries()) {
  test(`actual CLI Unicode literal title stays authorized and unchanged: ${variant}`, async () => fixture(async (base, vault) => {
    await writeFile(join(vault, 'Public.md'), prefix + '![[CANARYPRIVATEID|CANARYALIAS]] %%ht%%\n');
    await writeFile(join(vault, 'CANARYPATH/Secret.md'), `---\nforester-id: CANARYPRIVATEID\ntitle: ${JSON.stringify(title)}\npublic-title: true\n---\nCANARYBODY\n`);
    const before = await snapshot(vault, ['Public.md', 'CANARYPATH/Secret.md']);
    const out = join(base, 'public-output', 'forest.json'), result = cli(vault, out);
    await recordEvidence(`stable-approved-${variant}`, vault, out, before, result);
    assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(out), forest = JSON.parse(bytes);
    assert.deepEqual(forest.trees[0].content, [{ kind: 'unavailable', label: title }]);
    assert.deepEqual(forest.trees.map(t => t.id), ['PUBLICA']); assert.deepEqual(forest.assets, []);
    assert.ok(!bytes.includes(Buffer.from('CANARY')));
    assert.ok(!result.stdout.includes('CANARY')); assert.ok(!result.stderr.includes('CANARY'));
    assert.deepEqual(await readdir(join(out, '..')), ['forest.json']);
    await unchanged(vault, before);
  }));
}

// Bounded real-CLI regression: each non-ASCII casefold letter previously
// triggered another overlapping sticky scheme scan of the same long suffix.
for (const character of ['İ', 'ı', 'ſ', 'K']) for (const suffix of ['', ': ']) {
  test(`actual CLI linear unavailable URI scan stays bounded: ${JSON.stringify([character, suffix])}`, async t => fixture(async (base, vault) => {
    const cap = 1024 * 1024;
    const title = character.repeat(Math.floor((cap - Buffer.byteLength(suffix)) / Buffer.byteLength(character))) + suffix;
    await writeFile(join(vault, 'Public.md'), prefix + '![[CANARYPRIVATEID|CANARYALIAS]] %%ht%%\n');
    await writeFile(join(vault, 'CANARYPATH/Secret.md'), `---\nforester-id: CANARYPRIVATEID\ntitle: ${JSON.stringify(title)}\npublic-title: true\n---\nCANARYBODY\n`);
    const before = await snapshot(vault, ['Public.md', 'CANARYPATH/Secret.md']);
    const out = join(base, 'public-output', 'forest.json');
    const start = performance.now(), result = cli(vault, out, [], 'forest', 3000);
    result.elapsed_s = (performance.now() - start) / 1000;
    t.diagnostic(JSON.stringify({ label_bytes: Buffer.byteLength(title), elapsed_s: result.elapsed_s, error_code: result.error?.code ?? null }));
    await recordEvidence(`linear-uri-${character.codePointAt(0).toString(16)}-${suffix ? 'colon-space' : 'no-colon'}`, vault, out, before, result);
    assert.equal(result.error?.code, undefined, 'label at or below 1 MiB must finish within the 3 s child deadline');
    assert.equal(result.status, 0, result.stderr);
    const bytes = await readFile(out), forest = JSON.parse(bytes);
    assert.deepEqual(forest.trees[0].content, [{ kind: 'unavailable', label: title }]);
    assert.deepEqual(forest.trees.map(tree => tree.id), ['PUBLICA']);
    assert.deepEqual(forest.assets, []);
    assert.ok(!bytes.includes(Buffer.from('CANARY')));
    assert.deepEqual(await readdir(join(out, '..')), ['forest.json']);
    await unchanged(vault, before);
  }));
}

for (const newline of ['\n', '\r\n']) for (const publicTitle of [false, true]) test(`actual public-v2 CLI preserves embeds and excludes private images/canaries: ${JSON.stringify([newline, publicTitle])}`, async () => fixture(async (base, vault) => {
  const body = 'Before.\n\n![[CANARYPRIVATEID|CANARYALIAS]] %%ht%%\n\n![[CANARYPATH/photo.jpg|600x400]] %%p%%\n\n![CANARYALT](CANARYPATH/photo.jpg) %%p%%\n\n[[CANARYPRIVATEID|CANARYALIAS]]\n\nAfter.\n## Child ^CHILD\nChild body.\n';
  const publicSource = (prefix + body).replaceAll('\n', newline);
  const hidden = `---\nforester-id: CANARYPRIVATEID\ntitle: ${publicTitle ? 'Approved semantic title' : 'CANARYTITLE'}\npublic-title: ${publicTitle}\n---\nCANARYBODY\n## CANARYHEADING ^CANARYCHILDID\nCANARYCHILDBODY\n`.replaceAll('\n', newline);
  await writeFile(join(vault, 'Public.md'), publicSource);
  await writeFile(join(vault, 'CANARYPATH/Secret.md'), hidden);
  await writeFile(join(vault, 'CANARYPATH/photo.jpg'), Buffer.from('CANARYFILEBYTES\u0000binary'));
  const before = await snapshot(vault, ['Public.md', 'CANARYPATH/Secret.md', 'CANARYPATH/photo.jpg']);
  const parent = join(base, 'public-only-output'), out = join(parent, 'forest.json');
  const result = cli(vault, out);
  await recordEvidence(`normal-omission-${newline.length}-${publicTitle}`, vault, out, before, result);
  assert.equal(result.status, 0, result.stderr);
  const bytes = await readFile(out), forest = JSON.parse(bytes);
  assert.equal(forest.schema, 'forester-public-v2');
  assert.deepEqual(forest.assets, []);
  assert.deepEqual(forest.trees.map(t => t.id), ['PUBLICA']);
  const unavailable = publicTitle ? { kind: 'unavailable', label: 'Approved semantic title' } : { kind: 'unavailable' };
  assert.deepEqual(forest.trees[0].content.filter(n => n.kind === 'unavailable'), [unavailable, unavailable]);
  assert.equal(forest.trees[0].content.at(-1).tree.id, 'CHILD');
  assert.ok(!bytes.includes(Buffer.from('CANARY')), 'all serialized public fields are canary-free');
  assert.ok(!result.stdout.includes('CANARY')); assert.ok(!result.stderr.includes('CANARY'));
  assert.deepEqual(await readdir(parent), ['forest.json'], 'no assets or source copies');
  await unchanged(vault, before);
}));

for (const [body, code] of [
  ['![[CANARYUNKNOWN]]\n', 'unresolved-reference'],
  ['![[CANARYALIAS]]\n', 'unresolved-reference'],
  ['![[CANARYPRIVATEID]] %%p%%\n', 'unsupported-transclusion-flags'],
  ['![CANARYALT](CANARYPATH/photo.jpg) %%ph%%\n', 'unvetted-asset'],
  ['![[CANARYPATH/photo.jpg]] %%p\nCANARYSUFFIX\n', 'unvetted-asset'],
  ['![[CANARYPATH/photo.jpg]] %%p%% %%h%%\n', 'unsupported-transclusion-placement'],
  ['![[CANARYPATH/photo.jpg]]\n', 'unvetted-asset'],
  ['![CANARYALT](CANARYPATH/photo.jpg)\n', 'unvetted-asset'],
  ['[CANARYALIAS](/_unavailable/)\n', 'unresolved-reference'],
]) test(`actual CLI fails closed before output mkdir with source-free diagnostics: ${JSON.stringify(body)}`, async () => fixture(async (base, vault) => {
  await writeFile(join(vault, 'Public.md'), prefix + body);
  await writeFile(join(vault, 'CANARYPATH/Secret.md'), '---\nforester-id: CANARYPRIVATEID\ntitle: CANARYTITLE\naliases: [CANARYALIAS]\n---\nCANARYBODY');
  await writeFile(join(vault, 'CANARYPATH/Other.md'), '---\nforester-id: CANARYOTHERID\ntitle: CANARYTITLE\naliases: [CANARYALIAS]\n---\nCANARYBODY');
  const before = await snapshot(vault, ['Public.md', 'CANARYPATH/Secret.md', 'CANARYPATH/Other.md']);
  const parent = join(base, 'new-output-parent'), out = join(parent, 'forest.json');
  const result = cli(vault, out);
  assert.equal(result.status, 1);
  assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, 'blocked'); assert.ok(failure.codes.includes(code), result.stderr);
  assert.ok(!result.stdout.includes('CANARY')); assert.ok(!result.stderr.includes('CANARY'));
  assert.ok(!result.stderr.includes(vault));
  await unchanged(vault, before);
}));

for (const newline of ['\n', '\r\n']) for (const [variant, body] of [
  '![[CANARY.jpg|<!--]] %%p%%\nCANARY_COMMENT_BODY\n-->\nTail.\n',
  '![<!--](CANARY.jpg) %%p%%\nCANARY_COMMENT_BODY\n-->\nTail.\n',
  '![alt](<CANARY<!--.jpg>) %%p%%\nCANARY_COMMENT_BODY\n-->\nTail.\n',
].entries()) for (const format of ['v1', 'forest']) {
  test(`actual CLI protected image comment overlap refuses before mkdir: ${JSON.stringify([variant, newline, format])}`, async () => fixture(async (base, vault) => {
    await writeFile(join(vault, 'Public.md'), (prefix + body).replaceAll('\n', newline));
    const before = await snapshot(vault, ['Public.md']);
    const parent = join(base, 'new-output-parent'), out = join(parent, 'forest.json');
    const result = cli(vault, out, [], format);
    await recordEvidence(`image-comment-${variant}-${newline.length}-${format}`, vault, out, before, result);
    assert.equal(result.status, 1, 'protected comment must not be reopened as public body');
    assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
    assert.ok(!result.stdout.includes('CANARY')); assert.ok(!result.stderr.includes('CANARY'));
    await unchanged(vault, before);
  }));
}
