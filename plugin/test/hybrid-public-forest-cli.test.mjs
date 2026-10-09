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
  ['private embed','![[PRIVATE]]\n'],['raw','\\{ \\import{CANARY} }'],['asset','![[CANARY.png]]'],['inline','Inline ![[PUBLICA]].'],['cycle','![[PUBLICA]]\n'],['dangling','[[CANARY-MISSING]]'],
]) test(`actual forest CLI privacy refusal leaves no artifact: ${name}`,async()=>fixture(async(base,vault)=>{
  await writeFile(join(vault,'Public.md'),source.split('Intro.')[0]+body);
  await writeFile(join(vault,'CANARY-PRIVATE.md'),'---\nforester-id: PRIVATE\ntitle: CANARY-TITLE\n---\nCANARY-BODY');
  const out=join(base,'out.json');const result=run(vault,out);assert.notEqual(result.status,0);assert.equal(existsSync(out),false);
  assert.ok(!result.stderr.includes('CANARY'));assert.ok(!result.stderr.includes(vault));
  const failure=JSON.parse(result.stderr);assert.equal(failure.status,'blocked');assert.ok(failure.count>0);assert.ok(Array.isArray(failure.codes));
}));
