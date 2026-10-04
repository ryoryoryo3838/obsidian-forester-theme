import assert from 'node:assert/strict';
import { test } from 'node:test';
const display = await import('./build/hybrid-display.mjs').catch(() => ({}));
test('parenthetical citation uses bibliographic authors, not inherited note authors', () => {
  assert.equal(typeof display.citationLabel, 'function');
  assert.equal(display.citationLabel({ title:'Book', authors:['Note owner'], dates:['2026-10-04'], citationAuthors:['Bates'], publicationYear:'2022', publish:false, publicTitle:false }), '(Bates, 2022)');
});
test('ht is a short hide instruction bound to exactly one standalone embed', () => {
  assert.equal(typeof display.parseEmbedLine, 'function');
  assert.deepEqual(display.parseEmbedLine('![[Note#^ABCDEF]] %%ht%%'), { target:'Note#^ABCDEF', heading:false, toc:false });
  assert.deepEqual(display.parseEmbedLine('![[Note]] %%h%%'), { target:'Note', heading:false, toc:true });
  assert.equal(display.parseEmbedLine('%%ht%%'), null);
  assert.equal(display.parseEmbedLine('text ![[Note]] %%ht%%'), null);
  assert.equal(display.parseEmbedLine('![[A]] ![[B]] %%ht%%'), null);
  assert.equal(display.parseEmbedLine('![[Note]] %%hx%%')?.error, 'Unknown embed flag: x');
});
const meta = { title:'Book', authors:[], dates:[], citationAuthors:['Bates'], publicationYear:'2022', publish:false, publicTitle:false };
const source = '## Heading ^ABCDEF\n#Claim\n\nText {ref:[[Book]]}\n\n![[Book]] %%ht%%\n';
const tree = { key:'Test.md:0', id:'ABCDEF', path:'Test.md', level:2, line:0, endLine:7, from:0, to:source.length, contentFrom:source.indexOf('Text'), meta:{...meta,title:'Heading',taxon:'Claim'}, metadataRanges:[{from:source.indexOf('#Claim'),to:source.indexOf('#Claim')+6}], children:[],number:'1' };
const doc = { path:'Test.md', source, enabled:true, frontmatter:{}, root:tree, trees:[tree], protectedRanges:[], raw:[], diagnostics:[] };
const resolve = () => ({status:'resolved',tree:{...tree,meta},document:{...doc,path:'Book.md'}});
test('display plan decorates a heading, hides its metadata and renders an inline citation plus ht embed', () => {
  assert.equal(typeof display.planDisplay, 'function');
  const plan = display.planDisplay(doc, [], resolve);
  assert.equal(plan.headings[0].label,'Claim 1');
  assert.deepEqual(plan.spans.map(s => s.kind), ['metadata','citation','embed']);
  assert.equal(plan.spans.find(s => s.kind==='citation').text, '(Bates, 2022)');
  assert.equal(plan.spans.find(s => s.kind==='embed').flags.heading, false);
  const cursor = source.indexOf('{ref:')+2;
  assert.equal(display.planDisplay(doc,[{from:cursor,to:cursor}],resolve).spans.some(s => s.kind==='citation'),false);
  assert.deepEqual(display.planDisplay({...doc,enabled:false},[],resolve),{headings:[],spans:[]});
});
const {parseHybrid,indexHybrid,resolveHybrid}=await import('./build/hybrid-core.mjs');
const options={folders:[],publicFolders:[],reservedIds:[]};
test('real parsed trailing ht comments decorate the embed while root frontmatter remains native-editable',()=>{
 const main=parseHybrid('Main.md','---\nforester-mode: true\nforester-id: AAAAAA\n---\n# Main\n\n![[Book]] %%ht%%\n',options);
 const book=parseHybrid('Book.md','---\nforester-mode: true\nforester-id: BBBBBB\ncitation-authors: [Bates]\npublication-year: 2022\n---\n# Book\n\nBook body.\n',options);
 const idx=indexHybrid([main,book]);
 const p=display.planDisplay(main,[],target=>resolveHybrid(idx,target,'Main.md'));
 assert.equal(p.spans.filter(s=>s.kind==='embed').length,1);
 assert.equal(p.spans.some(s=>s.kind==='metadata'&&s.from===0),false);
});
test('Forester highlighting preserves literal source exactly and never evaluates commands',()=>{
 assert.equal(typeof display.foresterTokens,'function');
 const code=String.raw`\strong{A} % comment`;
 const ts=display.foresterTokens(code);
 assert.equal(ts.map(t=>t.text).join(''),code);
 assert.deepEqual(ts.filter(t=>t.kind!=='text').map(t=>t.kind),['command','delimiter','delimiter','comment']);
});
test('tree outline includes transclusions except t-hidden occurrences and stops cycles',()=>{
 assert.equal(typeof display.treeOutline,'function');
 const main=parseHybrid('Main.md','---\nforester-mode: true\nforester-id: AAAAAA\n---\n# Main\n\n## First ^ABCD01\n\n![[Book]] %%h%%\n\n![[Book]] %%ht%%\n',options);
 const book=parseHybrid('Book.md','---\nforester-mode: true\nforester-id: BBBBBB\n---\n# Book\n\n### Inner ^ABCD02\n\n![[Book]]\n',options);
 const idx=indexHybrid([main,book]);
 const entries=display.treeOutline(main,t=>resolveHybrid(idx,t,'Main.md'));
 assert.equal(entries[0].title,'First');
 assert.equal(entries[0].children.filter(e=>e.title==='Book').length,1);
 assert.equal(entries[0].children[0].children[0].title,'Inner');
 assert.ok(JSON.stringify(entries).includes('循環参照'));
});
test('heading numbers agree with occurrence TOC when a preceding root embed occupies a sibling slot',()=>{
 const main=parseHybrid('Main.md','---\nforester-mode: true\nforester-id: AAAAAA\n---\n# Main\n\n![[Book]]\n\n## Later ^ABCD01\n#Claim\n\nBody.\n',options);
 const book=parseHybrid('Book.md','---\nforester-mode: true\nforester-id: BBBBBB\n---\n# Book\n\nBook body.\n',options);
 const idx=indexHybrid([main,book]);const resolve=(t,p='Main.md')=>resolveHybrid(idx,t,p);
 assert.equal(display.treeOutline(main,resolve)[1].number,'2');
 assert.equal(display.planDisplay(main,[],resolve).headings[0].label,'Claim 2');
});
