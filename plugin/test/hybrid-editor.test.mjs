import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
const editor = await import('./build/hybrid-editor.mjs').catch(() => ({}));
const source = '## Heading ^ABCDEF\n#Claim\n\nText {ref:[[Book]]}\n\n![[Book]] %%ht%%\n';
const meta = {title:'Book',authors:[],dates:[],citationAuthors:['Bates'],publicationYear:'2022',publish:false,publicTitle:false};
const tree = {key:'Test:0',id:'ABCDEF',path:'Test.md',level:2,line:0,endLine:7,from:0,to:source.length,contentFrom:source.indexOf('Text'),meta:{...meta,title:'Heading',taxon:'Claim'},metadataRanges:[{from:source.indexOf('#Claim'),to:source.indexOf('#Claim')+6}],children:[],number:'1'};
const doc = {path:'Test.md',source,enabled:true,frontmatter:{},root:tree,trees:[tree],protectedRanges:[],raw:[],diagnostics:[]};
const host = {document:() => doc, resolve:() => ({status:'resolved',tree:{...tree,meta},document:doc}), renderEmbed:() => () => {}, open:() => {}};
test('real CodeMirror state provides replacements without modifying source, revealing a citation at the cursor', () => {
 assert.equal(typeof editor.createHybridEditor,'function');
 let state=EditorState.create({doc:source,extensions:editor.createHybridEditor(host)});
 const count=s => {let n=0; for(const ds of s.facet(EditorView.decorations)) if(typeof ds.between==='function') ds.between(0,s.doc.length,(_a,_b,v)=>{if(v.spec?.widget?.span?.kind==='citation')n++;}); return n;};
 assert.equal(count(state),1);
 assert.equal(state.doc.toString(),source);
 state=state.update({selection:{anchor:source.indexOf('{ref:')+2}}).state;
 assert.equal(count(state),0);
 assert.equal(state.doc.toString(),source);
});
test('real CodeMirror extension includes a bounded tree TOC widget for headed subtrees',async()=>{
 const {parseHybrid}=await import('./build/hybrid-core.mjs');
 const text='---\nforester-mode: true\nforester-id: AAAAAA\n---\n# Main\n\n## First ^ABCD01\n\nBody.\n';
 const parsed=parseHybrid('Main.md',text,{folders:[],publicFolders:[],reservedIds:[]});
 const h={...host,document:()=>parsed};
 const s=EditorState.create({doc:text,selection:{anchor:text.length},extensions:editor.createHybridEditor(h)});
 const entries=[];for(const ds of s.facet(EditorView.decorations))if(typeof ds.between==='function')ds.between(0,s.doc.length,(_a,_b,v)=>{if(v.spec.widget?.entries)entries.push(...v.spec.widget.entries);});
 assert.equal(entries[0]?.title,'First');
});
