import test from 'node:test';
import assert from 'node:assert/strict';
import {parseHybrid,indexHybrid,planHybridSave} from './build/hybrid-core.mjs';
const opts={folders:['hybrid'],publicFolders:[],reservedIds:[]};
const parse=(path,source)=>parseHybrid(path,source,opts);
const source=(body)=>`---\nforester-id: SOURCE\n---\n${body}`;
const after=(plan,path,before)=>plan.edits.find(e=>e.path===path)?.after??before;

test('save labels file and bare-ID links with semantic title while retaining their exact target',()=>{
 const a=parse('hybrid/Source.md',source('[[tArGeT]] [[book-id]] [[hybrid/Target.md]] [[Target|My label]] ![[Target]]\n'));
 const b=parse('hybrid/Target.md','---\nforester-id: book-id\ntitle: 情報の概念\n---\n# H1 fallback\nBody');
 const plan=planHybridSave(indexHybrid([a,b]),a.path,()=>{throw Error('must not mint');});
 assert.equal(after(plan,a.path,a.source),source('[[tArGeT|情報の概念]] [[book-id|情報の概念]] [[hybrid/Target.md|情報の概念]] [[Target|My label]] ![[Target]]\n'));
 assert.equal(plan.edits.length,1);
 const saved=parse(a.path,plan.edits[0].after);
 assert.deepEqual(planHybridSave(indexHybrid([saved,b]),a.path).edits,[]);
});

test('save safely encodes wikilink delimiters and multiline semantic titles',()=>{
 const a=parse('hybrid/Source.md',source('[[Target]]\n'));
 const b=parse('hybrid/Target.md','---\nforester-id: book-id\ntitle: "A | [[B]] <script>\\nsecond line"\n---\nBody');
 const plan=planHybridSave(indexHybrid([a,b]),a.path);
 assert.equal(after(plan,a.path,a.source),source('[[Target|A &#124; &#91;&#91;B&#93;&#93; &lt;script&gt; second line]]\n'));
 const saved=parse(a.path,after(plan,a.path,a.source));
 assert.deepEqual(planHybridSave(indexHybrid([saved,b]),a.path).edits,[]);
});

test('heading links stabilize IDs and take semantic titles; addressed blocks and bare subtree IDs get labels too',()=>{
 const a=parse('hybrid/Source.md',source('[[Target#Actual heading]] [[Target#^manual-id]] [[manual-id]] [[#Local]] ![[Target#Actual heading]]\n## Local ^local-id\n'));
 const b=parse('hybrid/Target.md','---\nforester-id: book-id\n---\n## Actual heading ^manual-id\n%% title: Semantic heading %%\nBody');
 const plan=planHybridSave(indexHybrid([a,b]),a.path,()=>{throw Error('must not mint');});
 assert.equal(after(plan,a.path,a.source),source('[[Target#^manual-id|Semantic heading]] [[Target#^manual-id|Semantic heading]] [[manual-id|Semantic heading]] [[#^local-id|Local]] ![[Target#^manual-id]]\n## Local ^local-id\n'));
 assert.equal(plan.edits.length,1);
});

test('code, math, raw, comments, ordinary targets and ambiguous links are not relabelled',()=>{
 const guarded=['`[[book-id]]`','$[[book-id]]$','\\( [[book-id]] \\)','%% [[book-id]] %%','<!-- [[book-id]] -->','\\{ \\p{[[book-id]]} }','```\n[[book-id]]\n```','    [[book-id]]','> [[book-id]]'].join('\n\n');
 const a=parse('hybrid/Source.md',source('[[missing]] [[Plain]] [[Same]] [[Target|]] [[Target|Custom]] ![[book-id]]\n\n'+guarded));
 const docs=[a,parse('hybrid/Target.md','---\nforester-id: book-id\n---\n# H1 title'),parse('ordinary/Plain.md','---\ntitle: Ordinary title\n---\nBody'),parse('hybrid/Same.md','# One'),parse('other/Same.md','---\nforester-mode: true\n---\n# Two')];
 const plan=planHybridSave(indexHybrid(docs),a.path,()=>{throw Error('must not mint');});
 assert.deepEqual(plan.edits,[]);
 assert.ok(plan.diagnostics.some(d=>d.code==='ambiguous-reference'),JSON.stringify(plan.diagnostics));
});

test('save encodes backslashes so a title cannot escape its wikilink closing brackets',()=>{
 const a=parse('hybrid/Source.md',source('[[Target]]'));
 const b=parse('hybrid/Target.md','---\nforester-id: book-id\ntitle: "ends with \\\\"\n---\nBody');
 const plan=planHybridSave(indexHybrid([a,b]),a.path);
 assert.equal(after(plan,a.path,a.source),source('[[Target|ends with &#92;]]'));
});

test('an ordinary source is not rewritten and malformed target identity aborts before any title edits',()=>{
 const b=parse('hybrid/Target.md','---\nforester-id: "bad id"\n---\n# Title');
 const a=parse('hybrid/Source.md',source('[[Target]]'));
 const plan=planHybridSave(indexHybrid([a,b]),a.path,()=>{throw Error('preflight');});
 assert.deepEqual(plan.edits,[]);
 assert.ok(plan.diagnostics.some(d=>d.severity==='error'));
 const plain=parse('ordinary/Plain.md','[[Target]]');
 assert.deepEqual(planHybridSave(indexHybrid([plain,b]),plain.path).edits,[]);
});
