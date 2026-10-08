import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, readdir, access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright-core';

// Synthetic DOM in real Chromium, not a claim of native Obsidian acceptance.
async function executable() {
  if (process.env.HYBRID_CHROMIUM) return process.env.HYBRID_CHROMIUM;
  const cache = join(homedir(), '.cache/ms-playwright');
  const entries = await readdir(cache);
  for (const entry of entries.filter(name => name.startsWith('chromium_headless_shell-')).sort().reverse()) {
    const path = join(cache, entry, 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (await access(path).then(() => true, () => false)) return path;
  }
  assert.fail('Set HYBRID_CHROMIUM to installed Chromium');
}
const css = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const theme = await readFile(new URL('../../theme.css', import.meta.url), 'utf8');
const bundle = await build({ entryPoints: [fileURLToPath(new URL('../src/hybrid-backmatter.ts', import.meta.url))],
  bundle: true, platform: 'browser', format: 'iife', globalName: 'BackmatterFixture', write: false });

test('backmatter styles are scoped, Forester-like and theme-neutral in Reading and Live Preview', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  try {
    for (const mode of ['light', 'dark']) for (const companion of [false, true]) for (const view of ['reading', 'live']) {
      await t.test(`${mode}/${view}/${companion ? 'companion' : 'plugin'}`, async () => {
        const page = await browser.newPage({ colorScheme: mode });
        try {
          const wrapper = view === 'reading' ? 'markdown-preview-view markdown-rendered' : 'markdown-source-view mod-cm6 is-live-preview cm-content';
          await page.setContent(`<body class="theme-${mode}"><div class="${wrapper}"><article id="target"><h2 id="native-heading">Native note title</h2><p id="native-body">Note body</p></article><footer id="native-footer">Native footer</footer></div></body>`);
          if (companion) await page.addStyleTag({ content: theme });
          await page.addStyleTag({ content: css });
          await page.addStyleTag({ content: `body { --text-normal:${mode === 'light' ? '#222' : '#ddd'};--text-muted:#888;--text-accent:#d31572;--text-error:#e00;--background-modifier-border:#999;--font-monospace:"Courier New";color:var(--text-normal);font-family:Arial,sans-serif } .markdown-rendered h2, .cm-content h2 { color:#0645dd; font-family:Arial,sans-serif }` });
          await page.addScriptTag({ content: bundle.outputFiles[0].text });
          await page.evaluate(() => {
            window.calls = { renders: 0, releases: 0, opens: [] };
            const tree = { key:'Defs.md:ABCD01', id:'ABCD01', path:'Defs.md', level:2, number:'9.7',
              meta:{title:'Result title',taxon:'Claim',authors:['Alice'],dates:['2026-10-04']} };
            window.cleanup = BackmatterFixture.renderBackmatter(document.querySelector('#target'), {references:[tree],backlinks:[],related:[]}, {
              resolve:()=>({status:'missing',message:'missing'}),open:()=>{},openTree:(tree,newLeaf)=>{calls.opens.push([tree.id,newLeaf]);},
              renderBody:el=>{calls.renders++;el.textContent='Full expanded target body';return()=>{calls.releases++;};},
            });
          });
          const result = await page.evaluate(() => {
            const style = selector => getComputedStyle(document.querySelector(selector));
            return { body:style('#native-body').color, headingColor:style('.hybrid-backmatter-group > h2').color,
              headingFont:style('.hybrid-backmatter-group > h2').fontFamily,
              taxonColor:style('.hybrid-taxon-number').color, slugFont:style('.hybrid-slug').fontFamily,
              slugColor:style('.hybrid-slug').color, summaryDisplay:style('.hybrid-backmatter-item > summary').display,
              border:style('.hybrid-backmatter').borderTopWidth,
              nativeHeadingColor:style('#native-heading').color,nativeHeadingFont:style('#native-heading').fontFamily,
              nativeFooterBorder:style('#native-footer').borderTopWidth,
              open:document.querySelector('details').open,renders:calls.renders };
          });
          assert.equal(result.headingColor, result.body, 'group headings use neutral ink, not external heading accents');
          assert.match(result.headingFont, /serif/i);
          assert.equal(result.taxonColor, result.body);
          assert.match(result.slugFont, /Courier New/i);
          assert.equal(result.slugColor, 'rgb(136, 136, 136)');
          assert.equal(result.summaryDisplay, 'list-item', 'native disclosure marker is retained');
          assert.equal(result.border, '1px');
          assert.equal(result.nativeHeadingColor, 'rgb(6, 69, 221)');
          assert.match(result.nativeHeadingFont, /Arial/);
          assert.equal(result.nativeFooterBorder, '0px');
          assert.equal(result.open, false); assert.equal(result.renders, 0);
          const summary = page.locator('.hybrid-backmatter-item > summary');
          await summary.focus(); await page.keyboard.press('Space');
          await page.waitForFunction(() => calls.renders === 1);
          assert.equal(await page.locator('.hybrid-backmatter-body').isVisible(), true);
          await summary.click(); await summary.click();
          assert.equal(await page.evaluate(() => calls.renders), 1);
          const slug = page.locator('.hybrid-slug');
          await slug.focus(); await page.keyboard.press('Enter');
          await slug.click({ modifiers:['Control'] });
          assert.deepEqual(await page.evaluate(() => calls.opens), [['ABCD01',false],['ABCD01',true]]);
          await page.evaluate(() => cleanup());
          assert.equal(await page.locator('.hybrid-backmatter').count(), 0);
          assert.equal(await page.evaluate(() => calls.releases), 1);
          assert.equal(await page.locator('#native-heading').textContent(), 'Native note title');
        } finally { await page.close(); }
      });
    }
  } finally { await browser.close(); }
});
