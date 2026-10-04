import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './controller-obsidian-mock.mjs';
import {HybridController} from './build/hybrid-controller.mjs';
const optin=(body,extra='')=>`---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;

test('settled save writes title aliases to both disk and editor without modifying the target or repeating writes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const source=optin('# Page\n\n[[Book]] [[book-id]] [[Book#Part]] [[part-id]] [[Book|Custom]] ![[Book]]','forester-id: page-id\n');
 const book=optin('# Native heading\n\n## Part ^part-id\n%% title: Section title %%\nBody','forester-id: book-id\ntitle: Book title\n');
 const h=createHarness({'Page.md':source,'Book.md':book});
 const c=new HybridController(h.plugin,h.getter);await c.initialize();
 try{
  const view=h.open('Page.md');
  await h.workspace.emit('editor-change',view.editor,view);
  t.mock.timers.tick(2000);
  for(let i=0;i<8;i++)await new Promise(setImmediate);
  const expected=source.replace('[[Book]]','[[Book|Book title]]').replace('[[book-id]]','[[book-id|Book title]]').replace('[[Book#Part]]','[[Book#^part-id|Section title]]').replace('[[part-id]]','[[part-id|Section title]]');
  assert.equal(h.vault.data.get('Page.md'),expected);
  assert.equal(view.editor.getValue(),expected);
  assert.equal(h.vault.data.get('Book.md'),book);
  const writes=h.vault.processes.length;
  await h.workspace.emit('editor-change',view.editor,view);t.mock.timers.tick(2000);
  for(let i=0;i<8;i++)await new Promise(setImmediate);
  assert.equal(h.vault.processes.length,writes);
 }finally{h.plugin.unload();}
});
