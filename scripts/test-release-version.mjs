import { strict as assert } from "node:assert";
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

console.log("release version validation passes");
