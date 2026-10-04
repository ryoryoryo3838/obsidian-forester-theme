import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHybrid,indexHybrid} from './build/hybrid-core.mjs';
import {projectPublic} from './build/hybrid-public.mjs';
const options={folders:[],publicFolders:[],reservedIds:[]};
const source=(opening,closing)=>`---\nforester-mode: true\nforester-id: public\ntitle: Public\npublish: true\n---\nOpening ${opening}example\n\n## Private ^hidden\n%% publish: false %%\nMATH-CANARY-PRIVATE-BODY\nClosing${closing}`;
test('inline dollar math cannot consume a later private tree across a paragraph boundary',()=>{
 const d=parseHybrid('N.md',source('$','$'),options);
 assert.equal(d.trees.length,2);assert.equal(d.trees[1].meta.publish,false);
 assert.ok(!JSON.stringify(projectPublic(indexHybrid([d]))).includes('MATH-CANARY'));
});
test('inline parenthesis math is also bounded while valid multiline expressions remain protected',()=>{
 const d=parseHybrid('N.md',source('\\(','\\)'),options);assert.equal(d.trees.length,2);assert.ok(!JSON.stringify(projectPublic(indexHybrid([d]))).includes('MATH-CANARY'));
 for(const math of ['$x\n+y$',String.raw`\(x+y\)`, '$$\n## literal\n\nx+y\n$$',String.raw`\[x+y\]`]){
  const valid=parseHybrid('N.md','---\nforester-mode: true\n---\n# Note\n\n'+math,options);
  assert.equal(valid.trees.length,1);assert.ok(!valid.diagnostics.some(d=>d.severity==='error'));assert.ok(valid.protectedRanges.some(r=>valid.source.slice(r.from,r.to)===math));
 }
});
test('an unclosed block math region is a source error and cannot suppress private content into public output',()=>{
 const d=parseHybrid('N.md',source('$$',''),options);
 assert.ok(d.diagnostics.some(d=>d.code==='unclosed-math'));
 const p=projectPublic(indexHybrid([d]));assert.deepEqual(p.trees,[]);assert.ok(!JSON.stringify(p).includes('MATH-CANARY'));
});
test('an invalid backtick fence info string must not conceal a private heading from the core parser',()=>{
 const s='---\nforester-mode: true\nforester-id: public\ntitle: Public\npublish: true\n---\n```bad`info\n\n## Private ^hidden\n%% publish: false %%\nFENCE-CANARY\n```';
 const d=parseHybrid('N.md',s,options);assert.equal(d.trees.length,2);assert.ok(!JSON.stringify(projectPublic(indexHybrid([d]))).includes('FENCE-CANARY'));
});
