# BRAT Distribution Design

## Goal

Make this monorepo installable through BRAT as both an Obsidian theme and a
companion plugin without splitting the repository. Preserve the current local
development workflow while making the theme self-contained and automating
plugin releases.

## Constraints

- BRAT themes read `manifest.json` and `theme.css` from the repository root.
- BRAT plugins read `manifest.json`, `main.js`, and `styles.css` from a GitHub
  Release asset set.
- The plugin and theme currently use the same `0.1.0` version.
- `install.sh` must continue to support symlink-based desktop development and
  copy-based mobile installation.
- Existing plugin functionality and the already committed baseline must remain
  unchanged.

## Repository Layout

The theme distribution files move to the repository root:

```text
manifest.json
theme.css
fonts/
  inria-sans-v14-latin_latin-ext-300.woff2
  inria-sans-v14-latin_latin-ext-300italic.woff2
  inria-sans-v14-latin_latin-ext-regular.woff2
  inria-sans-v14-latin_latin-ext-italic.woff2
  inria-sans-v14-latin_latin-ext-700.woff2
  inria-sans-v14-latin_latin-ext-700italic.woff2
plugin/
  manifest.json
  main.js
  styles.css
  src/
  ...
scripts/
  install.sh
.github/workflows/release.yml
```

The six Inria Sans files are retained as source material, but the distributed
`theme.css` embeds each one as a `data:font/woff2;base64,...` URL. The CSS must
not depend on the separate `fonts/` directory at runtime. BIZ UDMincho keeps
the existing local-font and platform-serif fallback behavior.

The theme manifest and plugin manifest remain separate files with the same
basename because they are consumed through different BRAT paths.

## Distribution Data Flow

### Beta Theme

BRAT reads:

```text
HEAD/manifest.json
HEAD/theme.css
```

Because the CSS contains all Inria Sans data, no additional theme asset is
required. The root files are the theme's canonical distribution files.

### Beta Plugin

Pushing a release tag starts the release workflow. The workflow builds from
`plugin/` and uploads exactly these assets:

```text
plugin/manifest.json
plugin/main.js
plugin/styles.css
```

BRAT resolves the repository's plugin release and installs those assets into
the plugin directory. The source tree, `node_modules`, tests, and build maps
are not release assets.

Users add the same repository URL separately under BRAT's Beta Themes and Beta
Plugins lists. BRAT does not combine those two installation operations.

## Release Workflow

Add `.github/workflows/release.yml` with a tag-push trigger. The workflow may
receive tags with or without a leading `v`, such as `0.1.1` and `v0.1.1`.

The workflow performs these steps in order:

1. Check out the tagged commit.
2. Normalize `GITHUB_REF_NAME` by removing one leading `v`.
3. Compare the normalized version with `version` in the root theme manifest,
   plugin manifest, and plugin package manifest.
4. Install plugin dependencies with `npm ci`.
5. Run the production plugin build with `npm run build`.
6. Create a GitHub Release for the original tag with generated notes and the
   three plugin assets.

Version mismatch, invalid release context, dependency installation failure,
build failure, or release failure must fail the job. The workflow must not
rewrite manifests. A release is created only when the tagged commit already
contains the intended version in all three manifests.

The workflow uses the repository-provided `GITHUB_TOKEN` through the GitHub CLI
and declares `contents: write` permission. It does not introduce a third-party
release action.

## Installer Changes

`install.sh` continues to accept:

```sh
./scripts/install.sh [--copy] [VAULT]
```

Before modifying a vault, it verifies the root theme files and the built plugin
entry point exist.

### Link mode

The script creates `.obsidian/themes/Forester/` and symlinks the root
`manifest.json` and `theme.css` into it individually. It continues to symlink
the complete `plugin/` directory so development builds are visible without a
copy step.

Existing symlinks may be replaced. Existing regular files are not removed or
silently overwritten; the script exits with an error instead.

### Copy mode

The script copies the root theme manifest and CSS into the theme directory and
copies the three plugin distribution files into the plugin directory. It does
not create or copy a theme font directory because the CSS is self-contained.

The existing mobile warning about vault synchronization remains.

## Documentation Changes

Update `README.md` to describe:

- the root theme files and nested plugin layout;
- the separate BRAT Beta Theme and Beta Plugin additions using the same URL;
- the tag-push release flow and the required version agreement;
- local installation, including the distinction between link and copy modes;
- embedded Inria Sans and the existing BIZ UDMincho fallback behavior.

The README must not imply that a single BRAT add operation installs both
components.

## Error Handling and Compatibility

- A missing root `manifest.json` or `theme.css` is an installation error.
- A missing `plugin/main.js` remains an installation error, with the existing
  build guidance.
- An old theme directory symlink is removed only as an existing symlink before
  the new individual links are created.
- A missing or stale release asset is a GitHub Release problem, not something
  the installer tries to repair.
- The plugin source, manifest id, and Obsidian minimum version are unchanged.

## Verification

After implementation, verify the following:

- The existing plugin test suite passes with `npm test` from `plugin/`.
- `sh -n scripts/install.sh` succeeds.
- The three manifests and `plugin/package.json` are valid JSON.
- The root theme CSS contains six WOFF2 data URLs and no relative
  `fonts/*.woff2` URL.
- The release workflow references the correct build directory and exactly the
  three intended assets.
- `git diff --check` reports no whitespace errors.
- A dry inspection of link and copy paths confirms that regular vault files are
  protected from replacement.

## Non-Goals

- Splitting the theme and plugin into separate repositories.
- Building a BRAT feature that installs both components with one action.
- Rewriting versions automatically from tags.
- Packaging the theme as GitHub Release assets.
- Changing plugin behavior unrelated to packaging or installation.
