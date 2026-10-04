import assert from 'node:assert/strict';import test from 'node:test';
import {Decoration,EditorView,WidgetType} from '@codemirror/view';
import {createHarness,document} from './controller-obsidian-mock.mjs';
import {HybridController} from './build/hybrid-controller.mjs';
const optin=(body,meta='')=>`---\nforester-mode: true\n${meta}---\n${body}`;
class NativeEmbed extends WidgetType{toDOM(){const el=document.createElement('div');el.className='native-filename-block-embed';return el;}}
test('hybrid full-tree replacements take precedence over native same-range embed decorations',async()=>{
 const source=optin('# Host\n\n![[subtree-id]]\n\nEnd'),target=optin('# Book\n\n## Section ^subtree-id\n\nFirst\n\nSecond');
 const h=createHarness({'Host.md':source,'Book.md':target}),c=new HybridController(h.plugin,h.getter);await c.initialize();
 try{const from=source.indexOf('![[subtree-id]]'),to=from+'![[subtree-id]]'.length;
 const native=EditorView.decorations.of(Decoration.set([Decoration.replace({widget:new NativeEmbed(),block:true}).range(from,to)]));
 const state=h.open('Host.md').editor.attach([native,...h.plugin.extensions]);const order=[];
 for(const ds of state.facet(EditorView.decorations))if(typeof ds.between==='function')ds.between(from,to,(at,_to,d)=>{if(at!==from)return;if(d.spec.widget?.span?.kind==='embed')order.push('hybrid');else if(d.spec.widget instanceof NativeEmbed)order.push('native');});
 assert.deepEqual(order,['hybrid','native']);assert.equal(state.doc.toString(),source);
 }finally{h.plugin.unload();}
});
