import { strict as assert } from "node:assert";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeTag, validateReleaseVersion } from "./release-version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));

assert.equal(normalizeTag("0.1.0"), "0.1.0");
assert.equal(normalizeTag("v0.1.0"), "0.1.0");
assert.throws(() => normalizeTag("release-0.1.0"), /MAJOR\.MINOR\.PATCH/);
assert.throws(() => normalizeTag("v0.1"), /MAJOR\.MINOR\.PATCH/);

const currentVersion = JSON.parse(await readFile(join(root, "manifest.json"), "utf8")).version;
const mismatchVersion = currentVersion === "0.1.1" ? "0.1.2" : "0.1.1";
const result = validateReleaseVersion(root, `v${currentVersion}`);
assert.equal(result.version, currentVersion);
assert.deepEqual(Object.values(result.versions), [currentVersion, currentVersion, currentVersion]);
assert.throws(() => validateReleaseVersion(root, mismatchVersion), /version mismatch/);

const fixture = await mkdtemp(join(tmpdir(), "forester-release-version-"));
try {
  await mkdir(join(fixture, "plugin"));
  for (const file of ["manifest.json", "plugin/manifest.json", "plugin/package.json"]) {
    await copyFile(join(root, file), join(fixture, file));
  }

  const packageFile = join(fixture, "plugin/package.json");
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  packageJson.version = mismatchVersion;
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

  assert.throws(
    () => validateReleaseVersion(fixture, `v${currentVersion}`),
    error => error.message.includes(`plugin/package.json=${mismatchVersion}`),
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log("release version validation passes");
