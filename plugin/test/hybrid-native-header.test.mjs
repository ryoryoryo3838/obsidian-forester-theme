import assert from 'node:assert/strict';
import test from 'node:test';
import {EditorView} from '@codemirror/view';
import {createHarness, document, window} from './controller-obsidian-mock.mjs';
import {HybridController} from './build/hybrid-controller.mjs';
const optin=(body,extra='')=>`---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;
const source=optin('# Main\n#Claim\n\n## Part ^ABCD01\n#Lemma\n\nBody\n','forester-id: main-id\nauthors: ["[[Person]]"]\ndates: [2026-10-04]\n');
const entries={'Main.md':source,'Person.md':optin('# Alice','forester-id: person-id\n')};
const drain=async()=>{for(let n=0;n<6;n++)await new Promise(setImmediate);};

test('Reading root taxon sits above H1, ID beside title, and metadata below; repeated passes do not duplicate',async()=>{
 const h=createHarness(entries); const c=new HybridController(h.plugin,h.getter); await c.initialize();
 const el=document.createElement('section');el.innerHTML='<h1>Main</h1><h2>Part ^ABCD01</h2><p>Body</p>';
 const ctx=h.context('Main.md',source.split('\n').indexOf('# Main'),source.split('\n').length-1);
 await h.plugin.postprocessors[0](el,ctx);
 const h1=el.querySelector('h1');
 assert.equal(h1.querySelector('.hybrid-root-taxon')?.textContent.trim(),'Claim');
 assert.equal(h1.firstElementChild?.className,'hybrid-taxon-number hybrid-root-taxon');
 assert.equal(h1.querySelector('.hybrid-slug')?.textContent,'[main-id]');
 assert.equal(h1.nextElementSibling?.className,'hybrid-metadata');
 assert.ok(h1.nextElementSibling.textContent.includes('Alice'));
 assert.ok(h1.nextElementSibling.textContent.includes('October 4, 2026'));
 const person=h1.nextElementSibling.querySelector('a');person.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));
 assert.equal(h.workspace.opens.at(-1)?.[0],'Person.md');
 assert.equal(el.querySelector('h2 .hybrid-slug')?.textContent,'[ABCD01]');
 assert.ok(!el.querySelector('h2').textContent.includes('^ABCD01'));
 await h.plugin.postprocessors[0](el,ctx);
 assert.equal(el.querySelectorAll('.hybrid-slug').length,2);
 assert.equal(el.querySelectorAll('.hybrid-metadata').length,2);
 h.plugin.unload();
 const count=h.workspace.opens.length;person.dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));assert.equal(h.workspace.opens.length,count);
});

test('Live Preview shows root taxon, inline ID and metadata without rewriting text; heading cursor restores caret editing',async()=>{
 const h=createHarness(entries); const c=new HybridController(h.plugin,h.getter);await c.initialize();
 const view=h.open('Main.md');let state=view.editor.attach(h.plugin.extensions);
 const widgets=s=>{const out=[];for(const ds of s.facet(EditorView.decorations))if(typeof ds.between==='function')ds.between(0,s.doc.length,(from,to,d)=>{if(d.spec.widget)out.push({from,to,widget:d.spec.widget});});return out;};
 let dom=document.createElement('div');for(const w of widgets(state))dom.append(w.widget.toDOM({dispatch(){},focus(){}}));
 assert.equal(dom.querySelector('.hybrid-root-taxon')?.textContent.trim(),'Claim');
 assert.equal(dom.querySelector('.hybrid-slug')?.textContent,'[main-id]');
 assert.ok(dom.querySelector('.hybrid-metadata')?.textContent.includes('Alice'));
 assert.ok([...dom.querySelectorAll('.hybrid-slug')].some(el=>el.textContent==='[ABCD01]'));
 assert.equal(state.doc.toString(),source);
 state=state.update({selection:{anchor:source.indexOf('## Part')+4}}).state;
 dom=document.createElement('div');for(const w of widgets(state))dom.append(w.widget.toDOM({dispatch(){},focus(){}}));
 assert.ok(![...dom.querySelectorAll('.hybrid-slug')].some(el=>el.textContent==='[ABCD01]'));
 assert.equal(state.doc.toString(),source);
 h.plugin.unload();
});

test('transclusions use the same native header and ht hides the complete header, not just title',async()=>{
 const page=optin('# Page\n\n![[main-id]]\n\n![[main-id]] %%ht%%\n\nEnd');
 const h=createHarness({...entries,'Page.md':page});const c=new HybridController(h.plugin,h.getter);await c.initialize();
 const view=h.open('Page.md'),state=view.editor.attach(h.plugin.extensions),widgets=[];
 for(const ds of state.facet(EditorView.decorations))if(typeof ds.between==='function')ds.between(0,state.doc.length,(_from,_to,d)=>{if(d.spec.widget?.span?.kind==='embed')widgets.push(d.spec.widget);});
 const dom=widgets[0].toDOM({dispatch(){},focus(){}});await drain();
 assert.equal(dom.querySelector('header h1 .hybrid-root-taxon')?.textContent.trim(),'Claim');
 assert.equal(dom.querySelector('header .hybrid-slug')?.textContent,'[main-id]');
 assert.ok(dom.querySelector('header .hybrid-metadata')?.textContent.includes('Alice'));
 const hidden=widgets[1].toDOM({dispatch(){},focus(){}});await drain();assert.equal(hidden.querySelector('header'),null);
 for(const widget of widgets)widget.destroy();h.plugin.unload();
});
