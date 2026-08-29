import { fileURLToPath } from "node:url";
import { validateReleaseVersion } from "./release-version.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const tag = process.env.RELEASE_TAG ?? process.argv[2];

if (!tag) {
  console.error("RELEASE_TAG or a tag argument is required");
  process.exit(2);
}

try {
  const { version } = validateReleaseVersion(root, tag);
  console.log(`release version ${version} matches all manifests`);
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
