import { readFileSync } from "node:fs";
import { join } from "node:path";

const VERSION_FILES = [
  "manifest.json",
  "plugin/manifest.json",
  "plugin/package.json",
];

export function normalizeTag(tag) {
  const version = tag.startsWith("v") ? tag.slice(1) : tag;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`release tag must be MAJOR.MINOR.PATCH, got ${tag}`);
  }
  return version;
}

export function validateReleaseVersion(rootDir, tag) {
  const version = normalizeTag(tag);
  const versions = Object.fromEntries(
    VERSION_FILES.map((file) => {
      const json = JSON.parse(readFileSync(join(rootDir, file), "utf8"));
      return [file, json.version];
    }),
  );
  const mismatched = Object.entries(versions).filter(([, value]) => value !== version);
  if (mismatched.length > 0) {
    const details = mismatched.map(([file, value]) => `${file}=${value}`).join(", ");
    throw new Error(`version mismatch: tag=${version}; ${details}`);
  }
  return { version, versions };
}

export { VERSION_FILES };
