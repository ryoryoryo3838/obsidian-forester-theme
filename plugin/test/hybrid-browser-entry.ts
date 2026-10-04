import {EditorState} from '@codemirror/state';
import {EditorView} from '@codemirror/view';
import {parseHybrid,indexHybrid,resolveHybrid} from '../src/hybrid-core';
import {createHybridEditor} from '../src/hybrid-editor';
const options={folders:[],publicFolders:[],reservedIds:[]};
const source='---\nforester-mode: true\nforester-id: AAAAAA\n---\n# Demo\n\n## Claim ^ABCD01\n#Claim\n\nA citation {ref:[[Book]]}.\n\n![[Book]] %%ht%%\n\nRaw: \\{ \\strong{Example} }.\n';
const book=parseHybrid('Book.md','---\nforester-mode: true\nforester-id: BBBBBB\ncitation-authors: [Bates]\npublication-year: 2022\n---\n# Book\n\nEmbedded body.\n',options);
const doc=parseHybrid('Demo.md',source,options);
const index=indexHybrid([doc,book]);
const host={
 document:(s:EditorState)=>parseHybrid('Demo.md',s.doc.toString(),options),
 resolve:(target:string,path:string)=>resolveHybrid(index,target,path),
 renderEmbed:(el:HTMLElement,target:string,flags:{heading:boolean;toc:boolean},path:string)=>{
  const r=resolveHybrid(index,target,path);if(r.status!=='resolved'){el.textContent=r.message;return;}
  el.dataset.toc=String(flags.toc);
  if(flags.heading){const h=document.createElement('h3');h.textContent=r.tree.meta.title;el.append(h);}
  const body=document.createElement('div');body.textContent=r.document.source.slice(r.tree.contentFrom,r.tree.to);el.append(body);
 },
 open:(target:string)=>{(window as any).opened=target;}
};
const view=new EditorView({state:EditorState.create({doc:source,selection:{anchor:source.length},extensions:[createHybridEditor(host)]}),parent:document.getElementById('editor')!});
(window as any).probe={view,source,doc,index};
(window as any).runChecks=()=>{
 const results:Record<string,boolean>={};
 results.citation=document.querySelector('.hybrid-citation')?.textContent==='(Bates, 2022)';
 results.badge=document.querySelector('.hybrid-taxon-number')?.textContent==='Claim 1 ';
 const embed=document.querySelector('.hybrid-embed');results.embed=embed?.textContent?.includes('Embedded body.')??false;
 results.hideHeading=!embed?.querySelector('h3');results.hideToc=(embed as HTMLElement)?.dataset.toc==='false';
 results.raw=document.querySelector('.hybrid-raw')?.textContent?.includes('Forester · 未評価')??false;
 results.highlight=!!document.querySelector('.hybrid-token-command');
 results.toc=document.querySelectorAll('.hybrid-toc a').length===1;
 results.unchanged=view.state.doc.toString()===source;
 const cursor=source.indexOf('{ref:')+2;view.dispatch({selection:{anchor:cursor}});
 results.editable=!document.querySelector('.hybrid-citation');
 view.dispatch({selection:{anchor:source.length}});
 results.restored=!!document.querySelector('.hybrid-citation');
 return results;
};
