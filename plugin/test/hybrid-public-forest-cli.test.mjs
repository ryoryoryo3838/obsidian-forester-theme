import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, stat, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
const source = '---\nforester-id: PUBLICA\ntitle: Public A\npublish: true\n---\nIntro.\n## Named ^CHILD\nChild body.\n### Anonymous\nAnonymous body.\n';
const run = (vault, out, extra = []) => spawnSync(process.execPath, ['dist/project-public.mjs', '--vault', vault, '--out', out, '--format', 'forest', ...extra], {encoding:'utf8'});
async function fixture(fn) {
  const base = await mkdtemp(join(tmpdir(), 'forest-cli-'));
  const vault = join(base, 'vault'); await mkdir(vault);
  await writeFile(join(vault, 'Public.md'), source);
  try { await fn(base, vault); } finally { await rm(base,{recursive:true,force:true}); }
}
test('actual --format forest CLI emits the exact public-v2 wire artifact and leaves v1 default intact', async () => fixture(async (base, vault) => {
  const out = join(base,'forest.json'); const result = run(vault,out);
  assert.equal(result.status,0,result.stderr);
  const forest = JSON.parse(await readFile(out,'utf8'));
  assert.equal(forest.schema,'forester-public-v2');
  assert.deepEqual(Object.keys(forest).sort(),['assets','schema','trees']);
  assert.equal(forest.trees[0].content[1].tree.id,'CHILD');
  const v1out = join(base,'v1.json');
  const v1 = spawnSync(process.execPath,['dist/project-public.mjs','--vault',vault,'--out',v1out],{encoding:'utf8'});
  assert.equal(v1.status,0,v1.stderr); assert.equal(JSON.parse(await readFile(v1out,'utf8')).format,'forester-public-v1');
}));
for (const attack of ['inside missing parent','source parent symlink','outside via source','final symlink','configuration overwrite']) test(`forest CLI rejects output namespace before source mutation: ${attack}`, async () => fixture(async (base,vault) => {
  const path=join(vault,'Public.md'); const before=await readFile(path,'utf8'); const mtime=(await stat(path)).mtimeMs;
  let out; let extra=[];
  if(attack==='inside missing parent') out=join(vault,'missing','out.json');
  if(attack==='source parent symlink'){await symlink(vault,join(base,'alias'));out=join(base,'alias','missing','out.json');}
  if(attack==='outside via source'){await symlink(base,join(vault,'escape'));await symlink(join(vault,'escape'),join(base,'alias'));out=join(base,'alias','out.json');}
  if(attack==='final symlink'){out=join(base,'out.json');await symlink(path,out);}
  if(attack==='configuration overwrite'){out=join(base,'config.json');await writeFile(out,'{}');extra=['--config',out];}
  const result=run(vault,out,extra); assert.notEqual(result.status,0);
  assert.equal(await readFile(path,'utf8'),before); assert.equal((await stat(path)).mtimeMs,mtime);
  assert.equal(existsSync(join(vault,'missing')),false);
  assert.ok(!result.stderr.includes(vault));
}));
for (const body of ['![[TARGET]] `suffix`\n', '![[TARGET]] %%ht%% `suffix`\n', '![[TARGET]] <!--hidden--> `suffix`\n', '![[TARGET]] %%ht%% `suffix\ncontinued`\n', '`prefix` ![[TARGET]] %%ht%%\n']) test(`actual forest CLI refuses physical-line embed suffix before mkdir/write: ${JSON.stringify(body)}`, async () => fixture(async (base, vault) => {
  const path = join(vault, 'Public.md');
  await writeFile(path, source.split('Intro.')[0] + body);
  await writeFile(join(vault, 'Target.md'), '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.');
  const before = await readFile(path, 'utf8'); const mtime = (await stat(path, {bigint:true})).mtimeNs;
  const parent = join(base, 'new-output-parent'); const out = join(parent, 'out.json');
  const result = run(vault, out);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
  assert.equal(await readFile(path, 'utf8'), before); assert.equal((await stat(path, {bigint:true})).mtimeNs, mtime);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, 'blocked'); assert.ok(failure.codes.includes('unsupported-transclusion-placement'));
  assert.ok(!result.stderr.includes(vault)); assert.ok(!result.stderr.includes(body));
}));

for (const [body, code] of [
  ['<!--before-->![[TARGET]] %%ht%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] <!--between--> %%ht%%\n', 'unsupported-transclusion-placement'],
  ['<!--before-->![[TARGET]] %%x%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] <!--between--> %%x%%\n', 'unsupported-transclusion-placement'],
  ['%% ordinary note %%![[TARGET]] %%ht%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %% ordinary note %% %%ht%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %%h%%%%t%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %%ht%% %%x%%\n', 'unsupported-transclusion-placement'],
  ['![[TARGET]] %%H%%\n', 'unsupported-transclusion-flags'],
  ['![[TARGET]] %%p%%\n', 'unsupported-transclusion-flags'],
]) for (const newline of ['\n', '\r\n']) test(`actual forest CLI refuses erased controls before mkdir: ${JSON.stringify(body)} ${JSON.stringify(newline)}`, async () => fixture(async (base, vault) => {
  const path = join(vault, 'Public.md');
  await writeFile(path, (source.split('Intro.')[0] + body).replace(/\n/g, newline));
  await writeFile(join(vault, 'Target.md'), '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.');
  const before = await readFile(path, 'utf8'); const mtime = (await stat(path, {bigint:true})).mtimeNs;
  const parent = join(base, 'new-output-parent'); const out = join(parent, 'out.json');
  const result = run(vault, out);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
  assert.equal(await readFile(path, 'utf8'), before); assert.equal((await stat(path, {bigint:true})).mtimeNs, mtime);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, 'blocked'); assert.ok(failure.codes.includes(code));
  assert.ok(!result.stderr.includes(vault)); assert.ok(!result.stderr.includes(body.trim()));
}));

for (const newline of ['\n', '\r\n']) test(`actual forest CLI preserves canonical flags and literal comment examples: ${JSON.stringify(newline)}`, async () => fixture(async (base, vault) => {
  const body = '<!--preceding own line-->\n![[TARGET]] %%ht%% <!--trailing-->\n%% ordinary note %%\n![[TARGET]] %%h%%\n![[TARGET]] %%t%% %% ordinary trailing note %%\n![[TARGET]]\n\n```md\n<!--before-->![[missing]] %%x%%\n~~~\n![[missing]] %%ht%%\n~~~\n```\n\n`![[missing]] %%x%%`\n<!-- ![[missing]] %%x%% -->\n';
  await writeFile(join(vault, 'Public.md'), (source.split('Intro.')[0] + body).replace(/\n/g, newline));
  await writeFile(join(vault, 'Target.md'), '---\nforester-id: TARGET\ntitle: Target\npublish: true\n---\nSafe target.');
  const out = join(base, 'out.json'); const result = run(vault, out);
  assert.equal(result.status, 0, result.stderr);
  const root = JSON.parse(await readFile(out, 'utf8')).trees.find(t => t.id === 'PUBLICA');
  assert.deepEqual(root.content.filter(n => n.kind === 'transclude').map(n => [n.header, n.toc]), [[false,false], [false,true], [true,false], [true,true]]);
}));

for (const body of ['`Heading`\n=======\n', 'Heading `code`\n=======\n', '`Heading`\n-------\n', '`Heading\ncontinued`\n=======\n']) test(`actual forest CLI refuses complete-block setext before mkdir/write: ${JSON.stringify(body)}`, async () => fixture(async (base, vault) => {
  const path = join(vault, 'Public.md'); await writeFile(path, source.split('Intro.')[0] + body);
  const before = await readFile(path, 'utf8'); const mtime = (await stat(path, {bigint:true})).mtimeNs;
  const parent = join(base, 'new-output-parent'); const out = join(parent, 'out.json');
  const result = run(vault, out);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(existsSync(out), false); assert.equal(existsSync(parent), false);
  assert.equal(await readFile(path, 'utf8'), before); assert.equal((await stat(path, {bigint:true})).mtimeNs, mtime);
  const failure = JSON.parse(result.stderr);
  assert.equal(failure.status, 'blocked'); assert.ok(failure.codes.includes('unsupported-tree-declaration'));
  assert.ok(!result.stderr.includes(vault)); assert.ok(!result.stderr.includes(body));
}));

for(const [name,body] of [
  // Known-private block embeds now succeed only as closed unavailable nodes;
  // keep refusal coverage for p on a tree (p is image-occurrence control only).
  ['private tree with image control','![[PRIVATE]] %%p%%\n'],['raw','\\{ \\import{CANARY} }'],['asset','![[CANARY.png]]'],['inline','Inline ![[PUBLICA]].'],['cycle','![[PUBLICA]]\n'],['dangling','[[CANARY-MISSING]]'],
]) test(`actual forest CLI privacy refusal leaves no artifact: ${name}`,async()=>fixture(async(base,vault)=>{
  await writeFile(join(vault,'Public.md'),source.split('Intro.')[0]+body);
  await writeFile(join(vault,'CANARY-PRIVATE.md'),'---\nforester-id: PRIVATE\ntitle: CANARY-TITLE\n---\nCANARY-BODY');
  const out=join(base,'out.json');const result=run(vault,out);assert.notEqual(result.status,0);assert.equal(existsSync(out),false);
  assert.ok(!result.stderr.includes('CANARY'));assert.ok(!result.stderr.includes(vault));
  const failure=JSON.parse(result.stderr);assert.equal(failure.status,'blocked');assert.ok(failure.count>0);assert.ok(Array.isArray(failure.codes));
}));

const scoped = (vault, out, extra = []) => run(vault, out, ['--scope', 'PUBLIC', ...extra]);
const publicNote = body => '---\nforester-id: PUBLICA\ntitle: Public A\npublish: true\n---\n' + body;
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
/** Synthetic baseline JPEG carrying Exif/GPS, MPF, a comment and trailing bytes; decoding is not needed. */
const jpeg = ({ frame = 0xc0 } = {}) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  segment(0xe1, Buffer.from('Exif\0\0CANARY-GPS-EXIF')),
  segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
  segment(0xe2, Buffer.from('MPF\0CANARY-MPF')),
  segment(0xe2, Buffer.from('ICC_PROFILE\0\x01\x01icc', 'binary')),
  segment(0xfe, Buffer.from('CANARY-COMMENT')),
  segment(0xdb, Buffer.alloc(65, 1)),
  segment(frame, Buffer.from([8, 0, 3, 0, 2, 1, 1, 0x11, 0])),
  segment(0xc4, Buffer.alloc(20, 2)),
  segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd0, 0x56, 0xff, 0xd9]),
  Buffer.from('CANARY-TRAILING-SECONDARY-IMAGE'),
]);

test('actual forest CLI replaces a resolved private embed by a fixed unavailable placement', async () => fixture(async (base, vault) => {
  await writeFile(join(vault, 'Public.md'), publicNote('Intro.\n\n![[PRIVATE]]\n\nOutro.\n'));
  await writeFile(join(vault, 'CANARY-PRIVATE.md'), '---\nforester-id: PRIVATE\ntitle: CANARY-TITLE\n---\nCANARY-BODY');
  const out = join(base, 'out.json'); const result = run(vault, out);
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(out, 'utf8');
  assert.deepEqual(JSON.parse(text).trees[0].content, [{ kind: 'markdown', text: 'Intro.' }, { kind: 'unavailable' }, { kind: 'markdown', text: 'Outro.' }]);
  assert.ok(!text.includes('CANARY'));
}));

test('a private embed is labelled only by an authorized explicit title', async () => fixture(async (base, vault) => {
  await writeFile(join(vault, 'Public.md'), publicNote('![[PRIVATE]]\n'));
  await writeFile(join(vault, 'Private.md'), '---\nforester-id: PRIVATE\ntitle: Shared Title\npublic-title: true\n---\nCANARY-BODY');
  const out = join(base, 'out.json'); const result = run(vault, out);
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(out, 'utf8');
  assert.deepEqual(JSON.parse(text).trees[0].content, [{ kind: 'unavailable', label: 'Shared Title' }]);
  assert.ok(!text.includes('CANARY'));
}));

test('scoped CLI confines out-of-scope notes: resolvable, never published, never blocking', async () => fixture(async (base, vault) => {
  await rm(join(vault, 'Public.md'));
  await mkdir(join(vault, 'PUBLIC')); await mkdir(join(vault, 'Elsewhere'));
  await writeFile(join(vault, 'PUBLIC', 'Public.md'), publicNote('![[OUTSIDE]]\n\n![[Quote#^0009]]\n'));
  await writeFile(join(vault, 'PUBLIC', 'template.md'), '---\nforester-id: "{{date:YYMMDD}}"\n---\n');
  await writeFile(join(vault, 'Elsewhere', 'Outside.md'), '---\nforester-id: OUTSIDE\ntitle: CANARY-OUTSIDE-TITLE\npublish: true\npublic-title: true\n---\nCANARY-OUTSIDE-BODY');
  await writeFile(join(vault, 'Elsewhere', 'Quote.md'), 'CANARY-QUOTE a passage ^0009\n');
  await writeFile(join(vault, 'Elsewhere', 'Broken.md'), '---\nforester-id: [unclosed\n---\nCANARY-BROKEN');
  const out = join(base, 'out.json');
  const result = scoped(vault, out, ['--exclude', 'PUBLIC/template.md']);
  assert.equal(result.status, 0, result.stderr);
  const text = await readFile(out, 'utf8'); const forest = JSON.parse(text);
  assert.deepEqual(forest.trees.map(t => t.id), ['PUBLICA']);
  assert.deepEqual(forest.trees[0].content, [{ kind: 'unavailable' }, { kind: 'unavailable' }]);
  assert.ok(!text.includes('CANARY'));
  const unexcluded = scoped(vault, join(base, 'unexcluded.json'));
  assert.notEqual(unexcluded.status, 0, 'an in-scope template still blocks unless excluded');
}));

for (const [name, body] of [['unknown note', '![[NOWHERE]]\n'], ['unknown block', '![[Quote#^9999]]\n'], ['unknown file', '![[Nowhere#^0009]]\n']])
  test(`scoped CLI keeps an unknown reference a failure: ${name}`, async () => fixture(async (base, vault) => {
    await rm(join(vault, 'Public.md'));
    await mkdir(join(vault, 'PUBLIC')); await mkdir(join(vault, 'Elsewhere'));
    await writeFile(join(vault, 'PUBLIC', 'Public.md'), publicNote(body));
    await writeFile(join(vault, 'Elsewhere', 'Quote.md'), 'a passage ^0009\n');
    const out = join(base, 'out.json'); const result = scoped(vault, out);
    assert.equal(result.status, 1); assert.equal(existsSync(out), false);
    assert.deepEqual(JSON.parse(result.stderr).codes, ['unresolved-reference']);
  }));

test('scoped CLI publishes in-scope JPEGs only as sanitized, digest-named media', async () => fixture(async (base, vault) => {
  await rm(join(vault, 'Public.md'));
  await mkdir(join(vault, 'PUBLIC', '_assets'), { recursive: true });
  await writeFile(join(vault, 'PUBLIC', 'Public.md'), publicNote('Before.\n\n![[photo.jpg]]\n\n![[photo.jpg|A described photo]]\n'));
  await writeFile(join(vault, 'PUBLIC', '_assets', 'photo.jpg'), jpeg());
  await writeFile(join(vault, 'PUBLIC', '_assets', 'unused.jpg'), jpeg());
  const out = join(base, 'out.json'), media = join(base, 'media');
  const result = scoped(vault, out, ['--media-dir', media]);
  assert.equal(result.status, 0, result.stderr);
  const forest = JSON.parse(await readFile(out, 'utf8'));
  assert.equal(forest.assets.length, 1);
  const [asset] = forest.assets;
  assert.deepEqual(Object.keys(asset).sort(), ['bytes', 'height', 'mime', 'sha256', 'width']);
  assert.deepEqual([asset.mime, asset.width, asset.height], ['image/jpeg', 2, 3]);
  assert.deepEqual(forest.trees[0].content, [{ kind: 'markdown', text: 'Before.' },
    { kind: 'image', sha256: asset.sha256, alt: '' }, { kind: 'image', sha256: asset.sha256, alt: 'A described photo' }]);
  assert.deepEqual(await readdir(media), [asset.sha256 + '.jpg']);
  const bytes = await readFile(join(media, asset.sha256 + '.jpg'));
  assert.equal(bytes.length, asset.bytes);
  assert.equal((await import('node:crypto')).createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  for (const canary of ['CANARY', 'Exif', 'MPF']) assert.ok(!bytes.includes(canary), canary);
  assert.ok(bytes.includes('JFIF') && bytes.includes('ICC_PROFILE'));
  assert.deepEqual([...bytes.subarray(-2)], [0xff, 0xd9]);
  assert.ok(!JSON.stringify(forest).includes('photo.jpg') && !JSON.stringify(forest).includes('_assets'));
}));

for (const [name, setup, extra] of [
  ['outside scope', async vault => { await mkdir(join(vault, 'Elsewhere')); await writeFile(join(vault, 'Elsewhere', 'photo.jpg'), jpeg()); }, true],
  ['progressive', async vault => writeFile(join(vault, 'PUBLIC', 'photo.jpg'), jpeg({ frame: 0xc2 })), true],
  ['no media dir', async vault => writeFile(join(vault, 'PUBLIC', 'photo.jpg'), jpeg()), false],
]) test(`scoped CLI refuses an unpublishable image: ${name}`, async () => fixture(async (base, vault) => {
  await rm(join(vault, 'Public.md')); await mkdir(join(vault, 'PUBLIC'));
  await writeFile(join(vault, 'PUBLIC', 'Public.md'), publicNote('![[photo.jpg]]\n'));
  await setup(vault);
  const out = join(base, 'out.json'), media = join(base, 'media');
  const result = scoped(vault, out, extra ? ['--media-dir', media] : []);
  assert.notEqual(result.status, 0); assert.equal(existsSync(out), false); assert.equal(existsSync(media), false);
  assert.ok(!result.stderr.includes(vault));
}));
