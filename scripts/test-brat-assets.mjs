import { strict as assert } from "node:assert";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const file = (name) => new URL(name, root);
const fontNames = [
  "inria-sans-v14-latin_latin-ext-300.woff2",
  "inria-sans-v14-latin_latin-ext-300italic.woff2",
  "inria-sans-v14-latin_latin-ext-regular.woff2",
  "inria-sans-v14-latin_latin-ext-italic.woff2",
  "inria-sans-v14-latin_latin-ext-700.woff2",
  "inria-sans-v14-latin_latin-ext-700italic.woff2",
];

await access(file("manifest.json"));
await access(file("theme.css"));
const manifest = JSON.parse(await readFile(file("manifest.json"), "utf8"));
assert.equal(manifest.name, "Forester");

const css = await readFile(file("theme.css"), "utf8");
const dataUrls = css.match(/url\("data:font\/woff2;base64,[A-Za-z0-9+/=]+"\)/g) ?? [];
assert.equal(dataUrls.length, 6);
assert.doesNotMatch(css, /url\(["']?fonts\/[^"')]+/);

for (const name of fontNames) {
  const payload = (await readFile(file(`fonts/${name}`))).toString("base64");
  assert.ok(
    css.includes(`url("data:font/woff2;base64,${payload}")`),
    `missing embedded font data for ${name}`,
  );
}

console.log("BRAT theme assets are self-contained");
