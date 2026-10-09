import assert from 'node:assert/strict';import test from 'node:test';
import {access,readFile,readdir} from 'node:fs/promises';import {homedir} from 'node:os';import {join} from 'node:path';import {chromium} from 'playwright-core';
const theme=await readFile(new URL('../../theme.css',import.meta.url),'utf8'),plugin=await readFile(new URL('../styles.css',import.meta.url),'utf8');
async function executable(){if(process.env.HYBRID_CHROMIUM)return process.env.HYBRID_CHROMIUM;const cache=join(homedir(),'.cache/ms-playwright');for(const name of (await readdir(cache)).filter(s=>s.startsWith('chromium_headless_shell-')).sort().reverse()){const p=join(cache,name,'chrome-headless-shell-linux64/chrome-headless-shell');if(await access(p).then(()=>true,()=>false))return p;}throw Error('HYBRID_CHROMIUM or cached Chromium required');}
const html=mode=>`<!doctype html><meta charset="utf-8"><style>
body{font-size:16px;font-family:sans-serif;--text-normal:${mode==='light'?'#000':'#dcdcdc'};--text-muted:#666;--text-accent:#cf2a80;--text-error:#c00;--background-modifier-border:#aaa;color:var(--text-normal)}
h1{font-size:var(--h1-size,2em)}h2,h3{font-size:var(--h2-size,1.5em)}.markdown-rendered{font-family:var(--font-text-theme,serif)}
</style><body class="theme-${mode} forester-enabled"><p id="body">本文 Body</p><span id="size-reference" style="font-size:13pt">Reference</span>
<div class="markdown-rendered"><div class="hybrid-managed-embed"><div id="embed" class="hybrid-embed"><header class="hybrid-tree-header"><h1><span id="root" class="hybrid-taxon-number hybrid-root-taxon">Claim</span><span id="title">情報概念 Information</span> <a id="slug" class="hybrid-slug">[ABCDEF]</a></h1><div id="meta" class="hybrid-metadata"><ul><li>October 4, 2026</li><li>Alice</li></ul></div></header><div class="hybrid-tree-body"><h3 id="nested"><span class="hybrid-taxon-number">Claim 1</span>下位見出し</h3><p>日本語と English の本文。</p></div></div></div><div class="hybrid-embed hybrid-error" id="error">Diagnostic</div></div>
<div class="markdown-source-view mod-cm6 is-live-preview"><div class="cm-content"><div class="hybrid-header-taxon"><span class="hybrid-taxon-number hybrid-root-taxon">Claim</span></div><div class="cm-line HyperMD-header HyperMD-header-2 hybrid-tree-heading" id="lp-heading"><span class="hybrid-taxon-number">Claim 1</span>見出し</div><div class="hybrid-header-metadata"><div class="hybrid-metadata">Alice</div></div></div></div></body>`;
test('v2 companion theme styles hybrid headers, metadata and plain Forester transclusions in both CSS load orders',async t=>{
const browser=await chromium.launch({executablePath:await executable(),headless:true});try{
 for(const mode of ['light','dark'])for(const order of ['theme-first','plugin-first'])await t.test(`${mode} ${order}`,async()=>{
  const page=await browser.newPage();try{await page.setContent(html(mode));for(const css of order==='theme-first'?[theme,plugin]:[plugin,theme])await page.addStyleTag({content:css});await page.evaluate(()=>document.fonts.ready);
  const s=await page.evaluate(()=>{const el=id=>document.getElementById(id),style=id=>getComputedStyle(el(id));return {root:style('root').color,rootDisplay:style('root').display,above:el('root').getBoundingClientRect().bottom<=el('title').getBoundingClientRect().top,slug:style('slug').color,slugLine:style('slug').textDecorationLine,slugStyle:style('slug').textDecorationStyle,meta:style('meta').color,metaFont:style('meta').fontFamily,body:style('body').color,border:style('embed').borderLeftWidth,nested:style('nested').fontSize,lp:style('lp-heading').fontSize,reference:style('size-reference').fontSize,list:getComputedStyle(el('meta').querySelector('ul')).display,error:style('error').color,lpRoot:getComputedStyle(document.querySelector('.hybrid-header-taxon .hybrid-root-taxon')).color};});
  assert.equal(s.root,'rgb(136, 136, 136)');assert.equal(s.lpRoot,s.root);assert.equal(s.rootDisplay,'block');assert.ok(s.above);assert.equal(s.slug,s.root);assert.ok(s.slugLine.includes('underline'));assert.equal(s.slugStyle,'dotted');assert.equal(s.meta,s.body);assert.ok(s.metaFont.includes('BIZ UDGothic'));assert.equal(s.border,'0px');assert.equal(s.nested,s.reference);assert.equal(s.lp,s.reference);assert.equal(s.list,'inline');assert.equal(s.error,'rgb(204, 0, 0)');console.log(JSON.stringify({mode,order,...s}));
 }finally{await page.close();}});
}finally{await browser.close();}});

// Synthetic native-shaped DOM in real Chromium; not native Obsidian acceptance.
const headingLevels = [1, 2, 3, 4, 5, 6];
const gothic = '"Inria Sans", "BIZ UDGothic", "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
const mincho = '"BIZ UDMincho", "Hiragino Mincho ProN", "Yu Mincho", "Noto Serif JP", serif';
const nativeCss = `
body { --font-text-theme:${mincho}; font-family:var(--font-text-theme); }
.markdown-rendered, .markdown-source-view.mod-cm6 .cm-content { font-family:var(--font-text-theme); }
.markdown-rendered div, .cm-content div, .hybrid-metadata { font-family:var(--font-text-theme); }
${headingLevels.map(level => `
.markdown-rendered h${level}, .markdown-source-view.mod-cm6 .HyperMD-header-${level},
.markdown-source-view.mod-cm6 .cm-content .cm-header-${level} { font-family:var(--h${level}-font, var(--font-text-theme)); }
`).join('')}`;
function typographyHtml(mode) {
  const reading = headingLevels.map(level => `<h${level} id="reading-${level}" data-hybrid-heading="tree-${level}">見出し Heading ${level}</h${level}>`).join('');
  const editor = headingLevels.map(level => `<div id="cm-line-${level}" class="cm-line HyperMD-header HyperMD-header-${level} hybrid-tree-heading"><span id="cm-token-${level}" class="cm-header cm-header-${level}">見出し Heading ${level}</span></div>`).join('');
  const plain = headingLevels.map(level => `<h${level} id="plain-${level}">Dates Heading ${level}</h${level}>`).join('');
  const plainEditor = headingLevels.map(level => `<div class="cm-line HyperMD-header HyperMD-header-${level}"><span id="plain-cm-${level}" class="cm-header cm-header-${level}">Dates Heading ${level}</span></div>`).join('');
  const footer = view => `<footer class="hybrid-backmatter">${['References', 'Backlinks', 'Related'].map(group => `<section class="hybrid-backmatter-group"><h2 id="${view}-${group}">${group}</h2><details class="hybrid-backmatter-item" data-taxon="Reference"><summary><span class="hybrid-taxon-number">Reference</span><span class="hybrid-backmatter-title">Reference title</span> <a class="hybrid-slug">[ABCDEF]</a><div id="${view}-${group}-meta" class="hybrid-metadata"><ul><li>Dates</li><li>Alice</li></ul></div></summary><div class="hybrid-backmatter-body">Lazy body</div></details></section>`).join('')}</footer>`;
  return `<!doctype html><meta charset="utf-8"><body class="theme-${mode}">
    <div class="markdown-rendered">
      ${reading}${plain}<p id="reading-prose">本文 Mincho prose</p>
      <div class="hybrid-embed"><header class="hybrid-tree-header">
        <h1 id="embed-root">Root title</h1><h2 id="embed-subtree">Subtree title</h2>
        <p id="header-prose">Header prose stays Mincho</p>
        <div id="reading-meta" class="hybrid-metadata"><ul><li>Dates</li><li>Alice</li></ul></div>
      </header><div class="hybrid-tree-body"><h3 id="embed-nested">Nested title</h3><p id="embed-prose">Embedded prose</p></div></div>
      ${footer('reading')}<details id="plain-details"><summary>Native disclosure</summary>Native body</details>
    </div><div class="markdown-source-view mod-cm6 is-live-preview"><div class="cm-content">
      ${editor}${plainEditor}<div id="cm-prose" class="cm-line">本文 Mincho prose</div>
      <div class="hybrid-header-metadata"><div id="cm-meta" class="hybrid-metadata">Dates / Alice</div></div>
      ${footer('cm')}
    </div></div><div id="property-label">Dates property label</div><input id="property-input" value="Untouched input"></body>`;
}
async function typographyMatrix(t, verify) {
  const browser = await chromium.launch({ executablePath: await executable(), headless: true });
  try {
    for (const mode of ['light', 'dark']) for (const companion of [false, true]) for (const order of ['theme-first', 'plugin-first']) {
      await t.test(`${mode}/${companion ? 'companion' : 'plugin-only'}/${order}`, async () => {
        const page = await browser.newPage({ colorScheme: mode });
        try {
          await page.setContent(typographyHtml(mode));
          // Native theme defaults intentionally use Mincho, including explicit CM token fonts.
          const hostCss = nativeCss + (companion ? theme : '');
          for (const css of order === 'theme-first' ? [hostCss, plugin] : [plugin, hostCss]) await page.addStyleTag({ content: css });
          await page.evaluate(() => document.fonts.ready);
          const result = await page.evaluate(() => {
            const fonts = Object.fromEntries([...document.querySelectorAll('[id]')].map(el => [el.id, getComputedStyle(el).fontFamily]));
            const summaries = [...document.querySelectorAll('.hybrid-backmatter-item > summary')].map(el => ({
              display:getComputedStyle(el).display, list:getComputedStyle(el).listStyleType,
              marker:getComputedStyle(el, '::marker').content, before:getComputedStyle(el, '::before').content,
              after:getComputedStyle(el, '::after').content,
              taxon:getComputedStyle(el.querySelector('.hybrid-taxon-number')).display,
            }));
            const nativeSummary = getComputedStyle(document.querySelector('#plain-details > summary'));
            return { fonts, summaries, nativeDisplay:nativeSummary.display, nativeList:nativeSummary.listStyleType };
          });
          verify(result, companion);
          console.log(JSON.stringify({ mode, companion, order, ...result }));
        } finally { await page.close(); }
      });
    }
  } finally { await browser.close(); }
}

test('owned Forester headings are Gothic while prose and non-owned external-theme headings retain Mincho', async t => {
  await typographyMatrix(t, ({ fonts }, companion) => {
    const owned = ['embed-root', 'embed-subtree', 'embed-nested', ...headingLevels.flatMap(level => [`reading-${level}`, `cm-line-${level}`, `cm-token-${level}`])];
    for (const id of owned) assert.equal(fonts[id], gothic, `${id} must use proportional Latin + Japanese Gothic`);
    for (const id of ['reading-prose', 'header-prose', 'embed-prose', 'cm-prose', 'property-label']) assert.equal(fonts[id], mincho, `${id} must not be restyled by owned heading rules`);
    if (!companion) for (const level of headingLevels) {
      assert.equal(fonts[`plain-${level}`], mincho, 'plugin must leave non-owned Reading headings alone');
      assert.equal(fonts[`plain-cm-${level}`], mincho, 'plugin must leave non-owned CM tokens alone');
    }
  });
});

test('Forester metadata is Gothic without changing markerless relation groups or native disclosures', async t => {
  await typographyMatrix(t, ({ fonts, summaries, nativeDisplay, nativeList }) => {
    for (const id of ['reading-meta', 'cm-meta']) assert.equal(fonts[id], gothic, `${id} must use Gothic, not prose Mincho`);
    for (const view of ['reading', 'cm']) for (const group of ['References', 'Backlinks', 'Related']) {
      assert.equal(fonts[`${view}-${group}`], gothic, `${view} ${group} heading stays Gothic`);
      assert.equal(fonts[`${view}-${group}-meta`], gothic, `${view} ${group} metadata stays Gothic`);
    }
    assert.equal(summaries.length, 6);
    for (const summary of summaries) assert.deepEqual(summary, {
      display:'block', list:'none', marker:'""', before:'none', after:'none', taxon:'none',
    }, 'owned footer stays markerless and keeps Reference taxon hidden');
    assert.equal(nativeDisplay, 'list-item', 'native disclosure remains untouched');
    assert.equal(nativeList, 'disclosure-closed');
  });
});

test('companion theme makes ordinary Dates headings Gothic at all six Reading and CM levels while retaining Mincho prose', async t => {
  await typographyMatrix(t, ({ fonts }, companion) => {
    if (companion) for (const level of headingLevels) {
      assert.equal(fonts[`plain-${level}`], gothic, `companion Reading H${level} must use Gothic`);
      assert.equal(fonts[`plain-cm-${level}`], gothic, `companion CM H${level} token must use Gothic`);
    }
    for (const id of ['reading-prose', 'header-prose', 'embed-prose', 'cm-prose']) assert.equal(fonts[id], mincho);
    assert.doesNotMatch(fonts['property-input'], /Inria Sans|BIZ UDGothic/, 'native property inputs must not be restyled');
  });
});
