import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('.',import.meta.url));
let executablePath=process.env.HYBRID_CHROMIUM;
if(!executablePath){
 const cache=join(process.env.HOME,'.cache/ms-playwright');
 const candidates=(await readdir(cache)).filter(n=>n.startsWith('chromium_headless_shell-')).sort();
 assert.ok(candidates.length,'Set HYBRID_CHROMIUM to an installed Chromium executable');
 executablePath=join(cache,candidates.at(-1),'chrome-headless-shell-linux64/chrome-headless-shell');
}
const server=createServer(async(req,res)=>{
 const routes={'/':'hybrid-browser.html','/build/hybrid-browser.js':'build/hybrid-browser.js'};
 const file=routes[req.url];if(!file){res.writeHead(404);res.end();return;}
 try{res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/html');res.end(await readFile(join(root,file)));}catch{res.writeHead(500);res.end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
let browser;
try{
 browser=await chromium.launch({executablePath,headless:true});
 const page=await browser.newPage({viewport:{width:1100,height:850}});
 const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:${server.address().port}/`);
 await page.waitForFunction(()=>typeof window.runChecks==='function');
 const checks=await page.evaluate(()=>window.runChecks());
 assert.deepEqual(errors,[]);
 assert.equal(checks.noInlineToc,true,'Live Preview has no inline Tree目次 widget');
 for(const [name,result]of Object.entries(checks))assert.equal(result,true,name);
 await page.addStyleTag({path:join(root,'../styles.css')});
 const item=page.locator('.hybrid-backmatter-item').first();
 await item.locator('summary').click();
 await page.waitForFunction(()=>document.querySelector('.hybrid-backmatter-body')?.textContent.includes('Embedded body.'));
 checks.footerClickExpands=await item.evaluate(el=>el.open);
 await page.evaluate(()=>window.probe.view.dispatch({selection:{anchor:0}}));
 checks.footerSurvivesCursor=await item.evaluate(el=>el.open);
 await item.locator('.hybrid-slug').click({modifiers:['Control']});
 const opened=await page.evaluate(()=>window.openedTree);
 assert.deepEqual(opened,{path:'Book.md',newLeaf:true});
 checks.footerModifierNavigation=true;
 checks.footerSourceUnchanged=await page.evaluate(()=>window.probe.view.state.doc.toString()===window.probe.source);
 for(const [name,result]of Object.entries(checks))assert.equal(result,true,name);
 assert.deepEqual(errors,[]);
 await page.screenshot({path:join(root,'build/hybrid-browser.png'),fullPage:true});
 await writeFile(join(root,'build/hybrid-browser-results.json'),JSON.stringify({checks,errors,scope:'Actual Chromium + real CodeMirror, not a native Obsidian session'},null,2)+'\n');
 console.log(JSON.stringify(checks,null,2));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
