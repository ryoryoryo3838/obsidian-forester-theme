import { strict as assert } from "node:assert";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const file = (name) => new URL(name, root);
const fontNames = [
  ["inria-sans-v14-latin_latin-ext-300.woff2", "normal", "300"],
  ["inria-sans-v14-latin_latin-ext-300italic.woff2", "italic", "300"],
  ["inria-sans-v14-latin_latin-ext-regular.woff2", "normal", "400"],
  ["inria-sans-v14-latin_latin-ext-italic.woff2", "italic", "400"],
  ["inria-sans-v14-latin_latin-ext-700.woff2", "normal", "700"],
  ["inria-sans-v14-latin_latin-ext-700italic.woff2", "italic", "700"],
];

await access(file("manifest.json"));
await access(file("theme.css"));
const manifest = JSON.parse(await readFile(file("manifest.json"), "utf8"));
assert.equal(manifest.name, "Forester");

const css = await readFile(file("theme.css"), "utf8");
const dataUrls = css.match(/url\("data:font\/woff2;base64,[A-Za-z0-9+/=]+"\)/g) ?? [];
assert.equal(dataUrls.length, 6);
assert.doesNotMatch(css, /url\(["']?fonts\/[^"')]+/);
const fontFaceBlocks = [...css.matchAll(/@font-face\s*\{[\s\S]*?\}/g)].map(
  ([block]) => block,
);
assert.equal(fontFaceBlocks.length, 6);

for (const [name, style, weight] of fontNames) {
  const payload = (await readFile(file(`fonts/${name}`))).toString("base64");
  const dataUrl = `url("data:font/woff2;base64,${payload}")`;
  const block = fontFaceBlocks.find((candidate) => candidate.includes(dataUrl));
  assert.ok(
    block,
    `missing embedded font data for ${name}`,
  );
  assert.match(block, new RegExp(`font-style:\\s*${style};`));
  assert.match(block, new RegExp(`font-weight:\\s*${weight};`));
}

console.log("BRAT theme assets are self-contained");
