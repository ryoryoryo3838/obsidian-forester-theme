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

const result = validateReleaseVersion(root, "v0.1.0");
assert.equal(result.version, "0.1.0");
assert.deepEqual(Object.values(result.versions), ["0.1.0", "0.1.0", "0.1.0"]);
assert.throws(() => validateReleaseVersion(root, "0.1.1"), /version mismatch/);

const fixture = await mkdtemp(join(tmpdir(), "forester-release-version-"));
try {
  await mkdir(join(fixture, "plugin"));
  for (const file of ["manifest.json", "plugin/manifest.json", "plugin/package.json"]) {
    await copyFile(join(root, file), join(fixture, file));
  }

  const packageFile = join(fixture, "plugin/package.json");
  const packageJson = JSON.parse(await readFile(packageFile, "utf8"));
  packageJson.version = "0.1.1";
  await writeFile(packageFile, `${JSON.stringify(packageJson, null, 2)}\n`);

  assert.throws(
    () => validateReleaseVersion(fixture, "v0.1.0"),
    /plugin\/package\.json=0\.1\.1/,
  );
} finally {
  await rm(fixture, { recursive: true, force: true });
}

console.log("release version validation passes");
