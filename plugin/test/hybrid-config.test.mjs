import assert from 'node:assert/strict';
import {test} from 'node:test';
const lib=await import('./build/hybrid-config.mjs').catch(()=>({}));
test('hybrid settings default to no exclusions or public folders and sanitize persisted lists',()=>{
 assert.equal(typeof lib.hybridOptions,'function');
 assert.deepEqual(lib.hybridOptions(undefined),{folders:[],excludedFolders:[],publicFolders:[],reservedIds:[]});
 assert.deepEqual(lib.hybridOptions({folders:true,excludedFolders:['Private',42],publicFolders:['Public',42],reservedIds:['ABCDEF']}),
  {folders:[],excludedFolders:[],publicFolders:[],reservedIds:['ABCDEF']});
 const legacy={folders:['Notes'],publicFolders:['Notes/Public'],reservedIds:['ABCDEF']};
 assert.deepEqual(lib.hybridOptions(legacy),{...legacy,excludedFolders:[]});
 const input={...legacy,excludedFolders:['Private']};
 const out=lib.hybridOptions(input);assert.deepEqual(out,input);
 out.folders.push('Other');out.excludedFolders.push('Other');out.publicFolders.push('Other');out.reservedIds.push('B12345');
 assert.deepEqual(input,{...legacy,excludedFolders:['Private']});
});
