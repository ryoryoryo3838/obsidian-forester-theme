import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHybrid,indexHybrid,planHybridSave} from './build/hybrid-core.mjs';
const opts={folders:['hybrid'],excludedFolders:['ordinary'],publicFolders:[],reservedIds:[]};
const parse=(path,source)=>parseHybrid(path,source,opts);
const source=(body)=>`---\nforester-id: SOURCE\n---\n${body}`;
const after=(plan,path,before)=>plan.edits.find(e=>e.path===path)?.after??before;

// v0.6 writes no display text: Forester and the editor show the target's own title.
test('v0.6: save writes no display text to file, bare-ID or aliased links',()=>{
 const a=parse('hybrid/Source.md',source('[[tArGeT]] [[book-id]] [[hybrid/Target.md]] [[Target|My label]] ![[Target]]\n'));
 const b=parse('hybrid/Target.md','---\nforester-id: book-id\ntitle: 情報の概念\n---\n# H1 fallback\nBody');
 const plan=planHybridSave(indexHybrid([a,b]),a.path,()=>{throw Error('must not mint');});
 assert.deepEqual(plan.edits,[]);
});

for (const title of ['"A | [[B]] <script>\\nsecond line"', '"ends with \\\\"', '"`code` and $$ %% <!-- x"'])
 test(`v0.6: a hostile title is never written into a link: ${title}`,()=>{
  const a=parse('hybrid/Source.md',source('[[Target]] [[book-id]]\n'));
  const b=parse('hybrid/Target.md',`---\nforester-id: book-id\ntitle: ${title}\n---\nBody`);
  assert.deepEqual(planHybridSave(indexHybrid([a,b]),a.path).edits,[]);
 });

test('v0.6: heading-named links are pinned to IDs, without display text',()=>{
 const a=parse('hybrid/Source.md',source('[[Target#Actual heading]] [[Target#^manual-id]] [[manual-id]] [[#Local]] ![[Target#Actual heading]]\n## Local ^local-id\n'));
 const b=parse('hybrid/Target.md','---\nforester-id: book-id\n---\n## Actual heading ^manual-id\n%% title: Semantic heading %%\nBody');
 const plan=planHybridSave(indexHybrid([a,b]),a.path,()=>{throw Error('must not mint');});
 assert.equal(after(plan,a.path,a.source),source('[[Target#^manual-id]] [[Target#^manual-id]] [[manual-id]] [[#^local-id]] ![[Target#^manual-id]]\n## Local ^local-id\n'));
 assert.equal(plan.edits.length,1);
});

test('code, math, raw, comments, ordinary targets and ambiguous heading links are not rewritten',()=>{
 const guarded=['`[[book-id]]`','$[[book-id]]$','\\( [[book-id]] \\)','%% [[book-id]] %%','<!-- [[book-id]] -->','\\{ \\p{[[book-id]]} }','```\n[[book-id]]\n```','    [[book-id]]','> [[book-id]]'].join('\n\n');
 const a=parse('hybrid/Source.md',source('[[missing]] [[Plain]] [[Same#One]] [[Target|]] [[Target|Custom]] ![[book-id]]\n\n'+guarded));
 const docs=[a,parse('hybrid/Target.md','---\nforester-id: book-id\n---\n# H1 title'),parse('ordinary/Plain.md','---\ntitle: Ordinary title\n---\nBody'),parse('hybrid/Same.md','# One'),parse('other/Same.md','---\nforester-mode: true\n---\n# Two')];
 const plan=planHybridSave(indexHybrid(docs),a.path,()=>{throw Error('must not mint');});
 assert.deepEqual(plan.edits,[]);
 assert.ok(plan.diagnostics.some(d=>d.code==='ambiguous-reference'),JSON.stringify(plan.diagnostics));
});

test('an ordinary source is not rewritten and malformed target identity aborts before any heading edits',()=>{
 const b=parse('hybrid/Target.md','---\nforester-id: "bad id"\n---\n# Title\n## Part\n');
 const a=parse('hybrid/Source.md',source('[[Target#Part]]'));
 const plan=planHybridSave(indexHybrid([a,b]),a.path,()=>{throw Error('preflight');});
 assert.deepEqual(plan.edits,[]);
 assert.ok(plan.diagnostics.some(d=>d.severity==='error'));
 const plain=parse('ordinary/Plain.md','[[Target]]');
 assert.deepEqual(planHybridSave(indexHybrid([plain,b]),plain.path).edits,[]);
});
