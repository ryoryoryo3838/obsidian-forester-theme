# Public-only unavailable references and image privacy

## Closed public-v2 wire

```ts
{ kind: 'unavailable' }
{ kind: 'unavailable', label: 'Explicitly approved semantic title' }
```

- Exact keys are `kind` plus optional `label`. No ID, path, filename, source alias, flags, reason, body or permission bit. Consumers must reject unknown/duplicate keys; understanding a wire kind does not grant publication authority.
- Resolve a tree first. Unknown/ambiguous targets remain errors. A known private/disabled block embed becomes unavailable without reading or evaluating its private body. The private target needs no minted ID. Public embeds remain typed transclusions with their existing `h`/`t` semantics.
- `label` requires an enabled target and independent `public-title: true`. Only semantic metadata/heading titles qualify; filename fallback is refused. Explicit titles that look like filenames, paths or URLs are also refused. The closed producer-output boundary follows the site's `literal`/`unavailable_label`: nonempty strict UTF-8 up to 1 MiB; no C0/C1 controls, Unicode line/paragraph/directional separators, bidi isolates, angle/square/brace markup, backslash, slash, pipe or backtick. URL-start and extension-end word predicates use explicit, case-sensitive `[A-Za-z0-9_]`, a stable conservative subset of Python's Unicode word characters rather than the host Unicode letter/number table. This deliberately also rejects some Unicode-adjacent URL/file-shaped labels (for example `東http: secret` or `Title private.md東 rest`); it is **not** an ASCII-only title policy. Normal Japanese/Unicode semantic titles remain supported. Scheme/extension token casefolding still supports dotted/dotless I, long s and Kelvin sign; `White_Space` remains unchanged (FEFF is not whitespace). Source-free diagnostics never echo the rejected label; no trimming, Unicode normalization or filename repair is performed. Source aliases never become labels. Labels are literal text, not Markdown or Forester code.
- URI-label detection consumes maximal scheme runs with a monotonically advancing cursor; no eligible start rescans an overlapping suffix. Each code unit has bounded visits, and known-protocol suffix matching reads at most 10 code units per run. Known protocols still allow `White_Space` before a colon even with empty payload; generic schemes require an immediate non-`White_Space` payload. Strict UTF-8 byte size, lone surrogates and unsafe controls are checked before lexical scans. Repeated `İ`/`ı`/`ſ`/`K` labels at or below the unchanged 1 MiB cap (no colon or colon plus space) have actual-CLI regressions with a 3-second child deadline; acceptance never truncates, repairs or blanket-refuses long/Unicode titles.
- A standalone, unindented wikilink/Markdown-reference **paragraph** can use unavailable. Inline, list-continuation and soft-line-break paragraphs retain the existing inert redaction/approved-title text; inserting a block node there would change paragraph semantics. Citations retain the existing private-data refusal/redaction behavior.
- Consumer emission uses the pinned native Forester **XML anchor builtin** `\<html:a>[href]{/_unavailable/}{LITERAL_ESCAPED_LABEL}`, not a named `\link`, with fixed root-relative **`/_unavailable/`**, default literal **`[非公開]`**, or the independently approved `label`. It is not a private/missing tree edge or transclusion. No arbitrary Markdown relative URL is newly trusted; a source link to `/_unavailable/` remains an unresolved-reference error.
- The site must serve a fixed target-independent notice with actual HTTP 404. Producer tests do not establish converter/Forester/Workers behavior; their independent integration and review are required.

### Standalone limits versus end-to-end limits

The producer/site literal gate permits up to **1 MiB UTF-8**, but the unchanged `tree_of_md` public-v2 consumer limits **each string, including unavailable labels, to 256 KiB UTF-8**. End-to-end inputs must satisfy that smaller scalar limit and the other existing consumer limits. Exactly 256 KiB is accepted; exceeding it produces generic `PF_LIMIT` refusal with no converted output. Near-1-MiB producer performance tests are standalone evidence, not end-to-end acceptance. Never truncate or normalize a title, change its source, or relax downstream guards to clear a limit refusal.

## Negative image-occurrence control

```markdown
![[photo.jpg|600x400]] %%p%%
![private alt](photo.jpg) %%p%%
```

Only a same-line standalone image with one exact `%%p%%` token is omitted from public-v1/v2. Zero to three leading spaces, spaces/tabs around the control, LF/CRLF and unterminated EOF are supported. The complete original line is checked before comment stripping. Recognized wikilink image suffixes are avif, bmp, gif, ico, jpg/jpeg, png, svg, tif/tiff and webp; explicit Markdown image syntax is already an image. Other assets such as PDF do not acquire this permission.

This is an omission, **not** a publication grant: no binary is read, copied, indexed as a tree, or entered into `assets`. Unmarked images and malformed/unknown/mixed controls remain refused; another occurrence is evaluated independently. A known Markdown filename resembling an asset cannot bypass the unvetted-asset guard. The raw input, local parser IDs/ranges, local private embeds, image dimensions/aliases and native image DOM ownership remain unchanged.

The canonical parser's protected ranges are read without mutation. The **whole image-to-control range** is checked; only that placement's exact own `%%p%%` comment may intersect it. An HTML/Obsidian comment, inline code, math or raw opener inside the alt, alias or destination cannot be partially removed and expose its following payload. Code, math, raw and quote examples never become active occurrence controls. Code examples retain their original literal bytes in public output. Existing raw/HTML and other public guards remain in force, including refusals for unsupported example shapes; this does not introduce raw evaluation or broaden math/image acceptance.

For a known-private tree embed, the original LF/CRLF physical suffix is validated before unavailable emission, even when an unclosed comment has disappeared from scanner callbacks. `p` is never a tree-placement flag. Mixed/unknown, unclosed, padded or Unicode-separated control candidates fail closed. Ordinary trailing HTML comments and descriptive multiword Obsidian comments remain compatible with canonical `h`/`t`; ambiguous single-token Obsidian suffixes are not silently downgraded to ordinary comments. Public tree placements and the existing unvetted-asset diagnostic path are unchanged.

## Intentional compatibility changes (not privacy-gate waivers)

1. The public-v2 CLI's former `private embed` refusal is replaced by exact closed-unavailable success assertions, source-byte/SHA-256/inode/mtime and local parser roundtrip checks, and serialized/output-directory/diagnostic canary checks. The old refusal matrix now tests private-tree `%%p%%`, which remains invalid: `p` is not a tree embed flag.
2. Unmarked public-v2 asset embeds now report `unvetted-asset` rather than relying on an unresolved tree lookup. This closes the known `photo.jpg.md` filename ambiguity and retains empty-forest/nonzero/no-output behavior. The corresponding focused asset diagnostic assertion is updated, not removed.
3. The default public-v1 schema and private-tree embed refusal are unchanged. Only private image occurrence omission is shared by v1/v2. Existing unaffected public-v2 bytes are compared to the baseline in local evidence.
4. No local editor/core/render/controller/native-image source modules, consumer/site implementation, version, release, installation or deployment are changed by this producer work.

## Verification

```sh
cd plugin
npm run test:public-controls
npm test
npm run build:public
npm run build
npm run test:browser
```

The focused tests exercise real parse → index → resolve → projection, the actual bundled CLI, and the actual local controller/CodeMirror/renderer with only Obsidian native API boundaries mocked. They cover source hashes and parser roundtrip identity, title/body authority separation, generic canary-free refusal, protected examples, Unicode versus physical line boundaries, malformed controls, native image ownership and local private-body rendering. Boundary mocks are not installed Obsidian acceptance.

For read-only cross-validator fixtures, set `PUBLIC_CONTROLS_SITE_SCRIPT` to the reviewed site's `scripts/safe-web.py` and run `npm run test:public-controls`. The test invokes the actual current `literal` and `unavailable_label` functions with Python bytecode writes disabled, and requires every successful producer label to pass unchanged. Without that external path this one integration test is explicitly skipped, not replaced with a simulated site gate. Optional `PUBLIC_CONTROLS_EVIDENCE` stores synthetic CLI source snapshots, output/diagnostics and exact CLI/source hashes outside the repository. Consumer/site validators are not weakened or edited.

New behavior is developed in vertical RED→GREEN slices. Logs, exact changed-source hashes, baseline compatibility bytes and wholly synthetic integration inputs are retained in an external local-only verification report rather than committed as generated test artifacts. Independent exact-source review and consumer/site integration are still separate gates.