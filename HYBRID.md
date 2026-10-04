# Hybrid Markdown implementation

This opt-in mode follows miya's Markdown × Forester design rather than the legacy site's tree-md conventions. The legacy mode is retained; no existing note is bulk-migrated. Implementation and native-app verification are separate.

## Safety and scope

- New syntax is disabled by default. Configure **Hybrid folders**, or set `forester-mode: true` in a note. `false` opts a note out of an enabled folder.
- **Public folders** is a separate setting. Publication defaults to private. A folder rule makes newly placed opt-in notes public too: use an intentional publication staging area.
- Source repositories containing private notes must themselves be private. A `publish` property cannot hide files already in a public Git repository.
- Public roots and title-only stubs require an explicit title/header. Filename-derived local fallback titles never enter the projection. Malformed metadata or unclosed block math stops projection; invalid YAML even in an ordinary/disabled input file currently stops the build conservatively.
- Public lookup uses the same resolver as editing, including aliases, relative paths, nested headings and case-insensitive IDs. Ambiguity is never resolved by insertion order.
- LF and CRLF source line endings are supported. A bare CR anywhere in an indexed input (including private or disabled notes) blocks the entire public projection with `unsupported-line-ending`. The original source is never silently normalized.
- No upload, deployment, legacy site build, arbitrary Forester evaluation or asset copying runs automatically.

## Root metadata

```yaml
---
forester-mode: true
forester-id: ABCDEF
title: Information concepts
authors: [person-miya]
publish: false
---
```

Root IDs live only in `forester-id`. Legacy `id` is diagnosed, not silently reinterpreted. Existing handwritten IDs are never renamed. Custom numeric root IDs need YAML quotes, e.g. `forester-id: "261111"`.

## Subtrees and taxa

```markdown
## Definition ^B4C2D1
#Claim

A definition.

### Commentary

A child tree without an ID.
```

H2–H6 define subtrees. A section ends at the next heading of equal or smaller level. Code, quotes/callouts, math and raw Forester are protected from structure/ID rewriting. A dedicated taxon line contains one tag; general tags belong elsewhere. Taxa can be added simply by using a new tag in this position. `#Ref`/`#Reference` map to `Reference`, and `#Person` to `Person`. Known aliases may also appear inside a heading.

Authors/dates inherit from the nearest parent and explicit values add to them. Bibliographic authors and year do not use this inheritance.

### Note-linked metadata and Properties UI

Prefer Obsidian's standard Properties UI: make `authors` and `dates` list properties and enter `[[miya]]` or `[[2026-10-04]]`. Obsidian manages the YAML quotation marks on save; they do not need to be typed manually. A date-note link is a Text/List value, not Obsidian's Date-type scalar.

The hybrid parser preserves quoted wikilink values and their subtree inheritance, but does **not** yet resolve person/date notes into display names or calendar values. Only plural `authors`/`dates` are recognized as hybrid attribution keys; singular `author`/`date` remain ordinary unknown frontmatter. Citation metadata is separate: `citation-authors` currently needs display-ready strings, because wikilinks there are not resolved before author-year formatting. Likewise, a wikilink-valued `taxon` is not normalized into a classification-note relation. Preservation is not full relational metadata support.

## Identity and settled save

- Automatic IDs: uppercase six-hex in `111111`–`FFFFFF`, with at least one `A`–`F`. Decimal-only six-digit values are reserved for custom IDs such as dates.
- Custom IDs: nonempty `[A-Za-z0-9-]+`, no six-character/hex restriction.
- Root/subtree IDs share one case-insensitive uniqueness check; source spelling is preserved. File names/aliases colliding with IDs are warnings and ambiguous bare references are not silently chosen.
- IDs never encode a parent, section order or position.
- On settled editing, the missing active root is addressed. A heading reference to an enabled target addresses its missing root/heading and becomes a fixed-ID reference. Public visibility islands also receive IDs as needed.

```markdown
[[Note#Heading|A label]]
<!-- after a guarded normalization pass -->
[[Note#^B4C2D1|A label]]
```

The store preflights every before-snapshot and uses compare-and-swap. A conflict skips the pass. A later failure attempts CAS rollback without overwriting concurrent edits; any partial rollback must be reported. No plan modifies disabled documents or code examples. This is not a filesystem-wide transaction or protection against every external sync tool.

Legacy writes also skip a note when its disk source or any open, matching editor opts into hybrid mode, including inactive Markdown leaves and other leaves exposing a file/editor pair. An unreadable matching editor refuses the write rather than granting permission. Frontmatter callbacks recheck ownership before native serialization. Opaque native Canvas internals are not covered by a claim of full Canvas support.

## Embeds

```markdown
![[Note#^B4C2D1]] %%ht%%
```

`h` hides the complete header, `t` omits that occurrence from the tree TOC. Only the preceding standalone embed on the same line is affected. Unknown short flags are diagnosed. Metadata/title of the definition is unchanged. The Live Preview tree TOC is collapsible and bounded; it includes transclusions unless `t` hides them. It is independent of Obsidian's core Outline pane.

## Author–year citations

A Reference note has explicit bibliographic fields:

```yaml
---
forester-mode: true
forester-id: C1D2E3
taxon: Reference
citation-authors: [Bates]
publication-year: 2022
---
```

```markdown
An ordinary link [[Reference note]]. An inline citation {ref:[[Reference note]]}.
```

The latter produces `(Bates, 2022)` using a small author–year formatter, not full APA/CSL. Two authors use `&`, more use the first plus `et al.`. Supply display-ready surnames; name disambiguation, page locators, same-author/year suffixes and full bibliographic styling are deferred. Missing citation fields are shown as a diagnostic rather than guessed from note authors/dates.

## Forester source islands

```text
Normal Markdown. \{ \strong{Forester source} } More Markdown.
```

The scanner balances nested braces and protects Forester escapes/comments/verbatim. There is no recursive Markdown parsing inside. The island is highlighted and marked **unevaluated**; macros, imports, Datalog, TeX and side effects are not executed. Regular `forester` code fences remain code examples, not executable declarations.

## Partial publication

```markdown
## Public island
%% publish: true %%

Only this section is public, even if its parent note is private.

## Title-visible private section
%% publish: false, public-title: true %%

Private body.
```

Default-private and explicit partial publication are distinct from syntax enablement. Public projection excludes private ancestor/sibling/child bodies and metadata. A private target permits only an inert locked title stub if `public-title: true` is explicitly set; otherwise labels/destinations are redacted. No private page/body is generated. This initial projection creates no authenticated route or HTTP service.

Projection fails closed for private embeds, unresolved/ambiguous dependencies, malformed/duplicate IDs, live raw Forester, unvetted assets and unsafe/raw HTML. Some complex Markdown is conservatively rejected. Bibliographic information from private targets is not disclosed via a citation. A literal code example explicitly included in public prose is still public text: review examples before publishing.

## Public projection CLI / CI

```sh
cd plugin
npm ci --ignore-scripts
npm run build:public
node dist/project-public.mjs \
  --vault /path/to/private/vault \
  --config /path/to/hybrid-config.json \
  --out /path/outside-vault/public-forest.json
```

Configuration (the same three arrays as plugin settings):

```json
{"folders":["Notes"],"publicFolders":["Notes/Public"],"reservedIds":["ABCDEF"]}
```

No configuration means no enabled/public folders; explicitly opted-in notes still work. Traversal skips hidden directories and symlinks. The command does not mutate source notes, follows no imports, makes no network requests, and returns nonzero without creating an artifact on validation failure. An existing successful output is left untouched on refusal, so it is not evidence that the latest build succeeded. Diagnostics emitted to CI are source-free. Output must be a JSON file outside the source vault, written through a temporary file and atomic rename. Do not publish after a nonzero exit; use a fresh build directory.

The JSON is a validated public projection, **not a complete Forester HTML website**. Connecting it to the existing site/CI is a subsequent step. Keep public indexes, URLs and asset copying behind the same projection boundary; hiding private HTML in CSS is not sufficient.

## Commands and tests

Native `[[`/heading/block selection, `#` tag selection and `##` heading entry remain primary. New commands are **Check hybrid trees** and **Preview public projection**. No mandatory special subtree insertion hotkey, slash conversion or Linter integration is added.

```sh
npm test             # legacy and hybrid unit/integration suites
npm run build        # strict project typecheck + Obsidian main.js bundle
npm run test:browser # actual Chromium + CodeMirror subsystem
```

Browser tests require an installed Chromium headless shell under the Playwright cache, or `HYBRID_CHROMIUM=/absolute/path`. They are not a claim of native Obsidian/mobile verification. The original repo's dependency audit already reports a moderate advisory through the development-only `obsidian` → `moment` typing dependency; do not apply the suggested incompatible Obsidian downgrade blindly.
