import assert from 'node:assert/strict';
import { access, readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';

// Standalone: node --test test/hybrid-styles.test.mjs (from plugin/).
// Uses the same HYBRID_CHROMIUM override / Playwright cache as test:browser.
async function chromiumExecutable() {
  if (process.env.HYBRID_CHROMIUM) return process.env.HYBRID_CHROMIUM;
  const cache = join(homedir(), '.cache/ms-playwright');
  const entries = await readdir(cache).catch(error => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const candidates = entries.filter(name => name.startsWith('chromium_headless_shell-'))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse();
  for (const candidate of candidates) {
    const executable = join(cache, candidate, 'chrome-headless-shell-linux64/chrome-headless-shell');
    if (await access(executable).then(() => true, () => false)) return executable;
  }
  assert.fail('Set HYBRID_CHROMIUM to an installed Chromium executable');
}

const pluginCss = await readFile(new URL('../styles.css', import.meta.url), 'utf8');
const companionCss = await readFile(new URL('../../theme.css', import.meta.url), 'utf8');
const palettes = {
  light: { body: '#222222', accent: '#d31572', heading: '#0645dd' },
  dark: { body: '#dedede', accent: '#75baff', heading: '#ed826f' },
};
const levels = [1, 2, 3, 4, 5, 6];
const labels = ['Claim 1', '1'];
const badge = label => `<span class="hybrid-taxon-number">${label} </span>`;
const headings = levels.flatMap(level => labels.map(label => `
  <h${level} style="color: var(--fixture-heading-color)">
    ${badge(label)}<span class="fixture-title">Heading ${level}</span>
  </h${level}>`)).join('');
// The Live Preview badge is a widget at the start of the decorated CM line,
// alongside the heading token rather than nested inside it.
const editorLines = levels.flatMap(level => labels.map(label => `
  <div class="cm-line HyperMD-header HyperMD-header-${level} hybrid-tree-heading"
       style="color: var(--fixture-heading-color)">
    ${badge(label)}<span class="cm-header cm-header-${level} fixture-title">Heading ${level}</span>
  </div>`)).join('');

function fixture(mode, legacyEnabled) {
  const palette = palettes[mode];
  return `<!doctype html><html><head><meta charset="utf-8"></head>
    <body class="theme-${mode}${legacyEnabled ? ' forester-enabled' : ''}"
      style="--text-normal: ${palette.body}; --text-accent: ${palette.accent};
             --fixture-heading-color: ${palette.heading}; color: var(--text-normal)">
      <p id="body-probe">Neutral body text</p>
      <span id="accent-probe" style="color: var(--text-accent)">Accent</span>
      <div class="markdown-preview-view markdown-rendered">${headings}</div>
      <div class="markdown-source-view mod-cm6 is-live-preview">
        <div class="cm-editor"><div class="cm-content">${editorLines}</div></div>
      </div>
    </body></html>`;
}

test('hybrid taxon numbers use neutral body ink despite coloured headings and accents',
  { timeout: 30_000 }, async t => {
    const browser = await chromium.launch({ executablePath: await chromiumExecutable(), headless: true });
    let checked = 0;
    try {
      for (const mode of Object.keys(palettes)) {
        for (const withCompanion of [false, true]) {
          for (const legacyEnabled of [false, true]) {
            const name = `${mode}, ${withCompanion ? 'Forester companion' : 'plugin only'}, ${legacyEnabled ? 'legacy enabled' : 'hybrid only'}`;
            await t.test(name, async () => {
              const page = await browser.newPage({ colorScheme: mode });
              try {
                await page.setContent(fixture(mode, legacyEnabled));
                if (withCompanion) await page.addStyleTag({ content: companionCss });
                await page.addStyleTag({ content: pluginCss });
                const result = await page.evaluate(() => {
                  const color = el => getComputedStyle(el).color;
                  return {
                    body: color(document.querySelector('#body-probe')),
                    accent: color(document.querySelector('#accent-probe')),
                    titles: [...document.querySelectorAll('.fixture-title')].map(color),
                    badges: [...document.querySelectorAll('.hybrid-taxon-number')].map(el => ({
                      label: el.textContent.trim(),
                      context: el.closest('.cm-line') ? 'Live Preview' : 'Reading',
                      color: color(el),
                    })),
                  };
                });
                const expectedCount = levels.length * labels.length * 2;
                assert.equal(result.badges.length, expectedCount, 'Both labels at all six heading levels in both views');
                assert.equal(result.titles.length, expectedCount);
                assert.notEqual(result.accent, result.body, 'Fixture accent must differ from neutral body ink');
                for (const titleColor of result.titles) {
                  assert.notEqual(titleColor, result.body, 'Fixture headings must remain coloured');
                  assert.notEqual(titleColor, result.accent, 'Fixture distinguishes heading colour from accent');
                }
                for (const entry of result.badges) {
                  assert.equal(entry.color, result.body, `${entry.context} ${entry.label} must use body ink, not accent or heading colour`);
                }
                checked += result.badges.length;
                console.log(`${name}: ${result.badges.length} neutral labels (${result.body}); accent ${result.accent}`);
              } finally {
                await page.close();
              }
            });
          }
        }
      }
      console.log(`Computed-style checks: ${checked} labels; synthetic Reading / Live Preview DOM, not native Obsidian.`);
    } finally {
      await browser.close();
    }
  });

test('native root taxon is gray above title; slug is inline and metadata is a compact list',async()=>{
 const browser=await chromium.launch({executablePath:await chromiumExecutable(),headless:true});
 try{
  const page=await browser.newPage();
  await page.setContent('<body style="--text-normal:#222;--text-muted:#888"><h1><span class="hybrid-taxon-number hybrid-root-taxon">Claim</span><span id="title">Title</span> <a class="hybrid-slug">[ABCD01]</a></h1><div class="hybrid-metadata"><ul><li>Alice</li><li>October 4, 2026</li></ul></div></body>');
  await page.addStyleTag({content:pluginCss});
  const result=await page.evaluate(()=>{const taxon=document.querySelector('.hybrid-root-taxon'),title=document.querySelector('#title'),slug=document.querySelector('.hybrid-slug'),li=document.querySelector('.hybrid-metadata li');return {taxon:getComputedStyle(taxon).color,above:taxon.getBoundingClientRect().bottom<=title.getBoundingClientRect().top,slug:getComputedStyle(slug).color,inline:getComputedStyle(slug).display,list:getComputedStyle(li).display};});
  assert.equal(result.taxon,'rgb(136, 136, 136)');assert.equal(result.above,true);assert.equal(result.slug,'rgb(136, 136, 136)');assert.equal(result.inline,'inline');assert.equal(result.list,'inline');
 }finally{await browser.close();}
});
