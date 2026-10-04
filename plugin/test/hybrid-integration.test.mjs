import assert from 'node:assert/strict';
import {test} from 'node:test';
import {parseHybrid,indexHybrid,planHybridSave} from './build/hybrid-core.mjs';
import {projectPublic} from './build/hybrid-public.mjs';
const options={folders:[],publicFolders:[],reservedIds:[]};
test('real parser→projection resolves uppercase and case-insensitive private-title stubs without leaking source',()=>{
 const visible=parseHybrid('Public.md','---\nforester-mode: true\nforester-id: ABCDEF\npublish: true\n---\n# Public\n\n[[fedcba|PRIVATE-LABEL]]\n',options);
 const hidden=parseHybrid('CANARY-PATH.md','---\nforester-mode: true\nforester-id: FEDCBA\npublic-title: true\n---\n# Disclosed title\n\nCANARY-BODY\n',options);
 const result=projectPublic(indexHybrid([visible,hidden]));
 assert.deepEqual(result.diagnostics,[]);assert.equal(result.trees.length,1);
 const text=JSON.stringify(result);assert.ok(text.includes('Disclosed title'));for(const secret of ['CANARY','PRIVATE-LABEL','FEDCBA'])assert.ok(!text.includes(secret));
});
test('making a private-note subtree public automatically addresses its visibility island on settled save',()=>{
 const source='---\nforester-mode: true\n---\n# Private parent\n\nPrivate intro.\n\n## Public island\n%% publish: true %%\n\nSafe body.\n';
 const doc=parseHybrid('Private.md',source,options);const draws=['AABCDE','ABCDEE'];
 const plan=planHybridSave(indexHybrid([doc]),doc.path,()=>draws.shift());
 const updated=parseHybrid(doc.path,plan.edits[0].after,options);
 assert.equal(updated.trees[1].id,'ABCDEE');
 const projection=projectPublic(indexHybrid([updated]));assert.deepEqual(projection.diagnostics,[]);assert.equal(projection.trees[0].body,'Safe body.');assert.ok(!JSON.stringify(projection).includes('Private'));
});
