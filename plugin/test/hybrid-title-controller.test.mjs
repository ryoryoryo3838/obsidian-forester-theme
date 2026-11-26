import test from 'node:test';
import assert from 'node:assert/strict';
import {createHarness} from './controller-obsidian-mock.mjs';
import {HybridController} from './build/hybrid-controller.mjs';
const optin=(body,extra='')=>`---\nforester-mode: hybrid-v1\n${extra}---\n${body}`;

test('v0.6: settled save pins heading-named links to IDs without writing display text, the target untouched and no repeated writes',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const source=optin('# Page\n\n[[Book]] [[book-id]] [[Book#Part]] [[part-id]] [[Book|Custom]] ![[Book]]','forester-id: page-id\n');
 const book=optin('# Native heading\n\n## Part ^part-id\n%% title: Section title %%\nBody','forester-id: book-id\ntitle: Book title\n');
 const h=createHarness({'Page.md':source,'Book.md':book});
 const c=new HybridController(h.plugin,h.getter);await c.initialize();
 try{
  const view=h.open('Page.md');
  await h.workspace.emit('editor-change',view.editor,view);
  // The ID links on the caret's line were normalized in the editor; Obsidian autosaves that before the settle.
  await view.save();
  t.mock.timers.tick(2000);
  for(let i=0;i<8;i++)await new Promise(setImmediate);
  // Typing near ID links normalizes them to the native form; the save pins heading names to IDs. No display text.
  const expected=source.replace('[[book-id]]','[[Book]]').replace('[[part-id]]','[[Book#^part-id]]').replace('[[Book#Part]]','[[Book#^part-id]]');
  assert.equal(h.vault.data.get('Page.md'),expected);
  assert.equal(view.editor.getValue(),expected);
  assert.equal(h.vault.data.get('Book.md'),book);
  const writes=h.vault.processes.length;
  await h.workspace.emit('editor-change',view.editor,view);t.mock.timers.tick(2000);
  for(let i=0;i<8;i++)await new Promise(setImmediate);
  assert.equal(h.vault.processes.length,writes);
 }finally{h.plugin.unload();}
});
