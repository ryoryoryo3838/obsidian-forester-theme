import assert from 'node:assert/strict';
import test from 'node:test';
import {createHarness, document} from './controller-obsidian-mock.mjs';
import {HybridController} from './build/hybrid-controller.mjs';
const optin=(body,meta='')=>`---\nforester-mode: true\n${meta}---\n${body}`;
const book=optin('# Book\n\n## Section ^subtree-id\n\nFIRST-PARAGRAPH\n\nSECOND-PARAGRAPH\n\n### Nested\n\nNESTED-PARAGRAPH\n\n## Following ^other-id\n\nOUTSIDE-SENTINEL\n','forester-id: book-root\n');
const drain=async()=>{for(let n=0;n<6;n++)await new Promise(setImmediate);};
function nativePhase(section){
 // Observed native Obsidian pipeline: it discovers .internal-embed placeholders
 // after plugin postprocessing and populates them using filename/block lookup.
 for(const el of section.querySelectorAll('.internal-embed'))el.replaceChildren(document.createTextNode(el.getAttribute('src').includes('#^')?'Section only':'File not found'));
}
test('Reading owns known explicit/bare subtree embeds before native filename/block population',async()=>{
 const host=optin('# Host\n\n![[Book#^subtree-id]]\n\n![[subtree-id]]\n');
 const h=createHarness({'Host.md':host,'Book.md':book});const c=new HybridController(h.plugin,h.getter);await c.initialize();
 try{
  const section=document.createElement('section');section.innerHTML='<p><span class="internal-embed" src="Book#^subtree-id">placeholder</span></p><p><span class="internal-embed" src="subtree-id">placeholder</span></p>';
  const start=host.split('\n').indexOf('![[Book#^subtree-id]]');const ctx=h.context('Host.md',start,host.split('\n').length-1);
  await h.plugin.postprocessors[0](section,ctx);await drain();nativePhase(section);await drain();
  const embeds=[...section.querySelectorAll('.hybrid-embed')];assert.equal(embeds.length,2,'native pass must not overwrite either hybrid rendering');
  for(const el of embeds){assert.ok(el.textContent.includes('FIRST-PARAGRAPH'));assert.ok(el.textContent.includes('SECOND-PARAGRAPH'));assert.ok(el.textContent.includes('NESTED-PARAGRAPH'));assert.ok(!el.textContent.includes('OUTSIDE-SENTINEL'));}
  assert.equal(section.querySelectorAll('.hybrid-managed-embed').length,2);
  const children=ctx.children.length;await h.plugin.postprocessors[0](section,ctx);await drain();assert.equal(ctx.children.length,children,'repeat pass must reuse owners');assert.equal(section.querySelectorAll('.hybrid-embed').length,2);
  ctx.children.forEach(child=>child.unload());assert.equal(c.readingEmbeds.size,0);assert.equal(section.querySelectorAll('.hybrid-managed-embed').length,0,'ownership marker released with section');
  assert.equal(h.vault.data.get('Host.md'),host);assert.equal(h.vault.data.get('Book.md'),book);
 }finally{h.plugin.unload();}
});
test('Reading leaves disabled notes and assets to the native embed pipeline',async()=>{
 const host=optin('# Host\n\n![[Plain]]\n');const h=createHarness({'Host.md':host,'Native/Plain.md':'# Plain\nBody'}, {folders:[],excludedFolders:['Native'],publicFolders:[],reservedIds:[]}),c=new HybridController(h.plugin,h.getter);await c.initialize();
 try{const section=document.createElement('section');section.innerHTML='<p><span class="internal-embed" src="Plain">placeholder</span></p>';const line=host.split('\n').indexOf('![[Plain]]');await h.plugin.postprocessors[0](section,h.context('Host.md',line,line));await drain();assert.equal(section.querySelectorAll('.internal-embed').length,1);assert.equal(section.querySelector('.hybrid-managed-embed'),null);assert.equal(section.querySelector('.hybrid-embed'),null);}finally{h.plugin.unload();}
});
