import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolve,join} from 'node:path';
test('CI projection command exports only opted-in public material and fails closed for a private embed',async()=>{
 assert.ok(existsSync('dist/project-public.mjs'),'working public projection CLI required');
 const base=await mkdtemp(resolve('test/build/public-cli-'));const vault=join(base,'vault');await mkdir(vault);
 try{
  const out=join(base,'public.json');
  await writeFile(join(vault,'Public.md'),'---\nforester-mode: true\nforester-id: ABCDEF\npublish: true\n---\n# Visible\n\nSafe body.\n');
  await writeFile(join(vault,'Private.md'),'---\nforester-mode: true\nforester-id: FEDCBA\n---\n# CANARY-SECRET-TITLE\n\nCANARY-SECRET-BODY\n');
  const args=['dist/project-public.mjs','--vault',vault,'--out',out];
  const result=spawnSync(process.execPath,args,{encoding:'utf8'});assert.equal(result.status,0,result.stderr);
  const json=await readFile(out,'utf8');assert.ok(!json.includes('CANARY'));assert.equal(JSON.parse(json).trees[0].body,'Safe body.');
  await rm(out);
  await writeFile(join(vault,'Public.md'),'---\nforester-mode: true\nforester-id: ABCDEF\npublish: true\n---\n# Visible\n\n![[Private]]\n');
  const blocked=spawnSync(process.execPath,args,{encoding:'utf8'});assert.notEqual(blocked.status,0);assert.equal(existsSync(out),false);assert.ok(!blocked.stderr.includes('CANARY'));
 }finally{await rm(base,{recursive:true,force:true});}
});
