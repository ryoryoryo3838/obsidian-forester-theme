import assert from 'node:assert/strict';
import { test } from 'node:test';
const lib=await import('./build/hybrid-save.mjs').catch(()=>({}));
const edits=[{path:'target.md',before:'old target',after:'new target'},{path:'source.md',before:'old source',after:'new source'}];
const store=(initial)=>{const files=new Map(Object.entries(initial));return{files,read:async p=>files.get(p),compareWrite:async(p,b,a)=>{if(files.get(p)!==b)return false;files.set(p,a);return true;}};};
test('save plan is preflighted across all files before any modification',async()=>{
 assert.equal(typeof lib.commitHybridPlan,'function');
 const s=store({'target.md':'old target','source.md':'concurrent source'});
 const result=await lib.commitHybridPlan({edits,diagnostics:[]},s);
 assert.equal(result.committed,false);assert.equal(s.files.get('target.md'),'old target');
 assert.deepEqual(result.conflicts,['source.md']);
});
test('a compare-and-swap race rolls back prior edits without clobbering concurrent content',async()=>{
 const s=store({'target.md':'old target','source.md':'old source'});
 const write=s.compareWrite;s.compareWrite=async(p,b,a)=>{if(p==='source.md'){s.files.set(p,'user edit');return false;}return write(p,b,a);};
 const result=await lib.commitHybridPlan({edits,diagnostics:[]},s);
 assert.equal(result.committed,false);assert.equal(s.files.get('target.md'),'old target');assert.equal(s.files.get('source.md'),'user edit');assert.deepEqual(result.partial,[]);
});
test('an IO exception after a write rolls back both the previous and uncertain current edit',async()=>{
 const s=store({'target.md':'old target','source.md':'old source'});
 const write=s.compareWrite;let failed=false;s.compareWrite=async(p,b,a)=>{const ok=await write(p,b,a);if(p==='source.md'&&!failed){failed=true;throw new Error('disk error after mutation');}return ok;};
 const result=await lib.commitHybridPlan({edits,diagnostics:[]},s);
 assert.equal(result.committed,false);assert.equal(s.files.get('target.md'),'old target');assert.equal(s.files.get('source.md'),'old source');assert.deepEqual(result.partial,[]);
});
