import assert from 'node:assert/strict';
import {test} from 'node:test';
import {build} from 'esbuild';
import {resolve} from 'node:path';
await build({entryPoints:['src/main.ts'],outfile:'test/build/hybrid-main-mock.mjs',bundle:true,format:'esm',platform:'node',alias:{obsidian:resolve('test/hybrid-main-obsidian.mjs')},external:['@codemirror/state','@codemirror/view']});
const {default:Plugin}=await import('./build/hybrid-main-mock.mjs');
const on=()=>({});
const app={vault:{getFiles:()=>[],getMarkdownFiles:()=>[],on,getAbstractFileByPath:()=>null,read:async()=>'',cachedRead:async()=>''},metadataCache:{on,getFileCache:()=>null},workspace:{on,onLayoutReady:()=>{},iterateAllLeaves:()=>{},getLeavesOfType:()=>[],getActiveFile:()=>null,getActiveViewOfType:()=>null},commands:{commands:{'editor:save-file':{callback:()=>{}}}}};
global.document={body:{addClass(){},toggleClass(){},removeClass(){},style:{setProperty(){}}}};
global.MutationObserver=class{observe(){}disconnect(){}};
test('plugin entrypoint registers default-on hybrid hooks without exclusions or publication folders',async()=>{
 const plugin=new Plugin(app);await plugin.onload();
 assert.equal(plugin.extensions.length,1);
 assert.ok(plugin.commands.some(c=>c.id==='check-hybrid-trees'));
 assert.ok(plugin.commands.some(c=>c.id==='preview-public-projection'));
 assert.deepEqual(plugin.settings.hybrid.excludedFolders,[]);
 assert.deepEqual(plugin.settings.hybrid.publicFolders,[]);
 for(const cleanup of plugin.cleanups)cleanup();plugin.onunload();
});
