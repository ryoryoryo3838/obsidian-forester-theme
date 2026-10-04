import assert from 'node:assert/strict';
import {test} from 'node:test';
const lib=await import('./build/hybrid-config.mjs').catch(()=>({}));
test('hybrid settings default to no enabled/public folders and do not accept malformed persisted activation',()=>{
 assert.equal(typeof lib.hybridOptions,'function');
 assert.deepEqual(lib.hybridOptions(undefined),{folders:[],publicFolders:[],reservedIds:[]});
 assert.deepEqual(lib.hybridOptions({folders:true,publicFolders:['Public',42],reservedIds:['ABCDEF']}),{folders:[],publicFolders:[],reservedIds:['ABCDEF']});
 const input={folders:['Notes'],publicFolders:['Notes/Public'],reservedIds:['ABCDEF']};
 const out=lib.hybridOptions(input);assert.deepEqual(out,input);out.folders.push('Other');assert.deepEqual(input.folders,['Notes']);
});
