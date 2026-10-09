# Gothic headings and metadata — bounded acceptance

## Typography contract

- Owned Forester headings (Reading H1–H6 with source ownership, tree/embedded headers and Live Preview heading lines/tokens) use proportional Latin `Inria Sans` with Japanese Gothic fallbacks: `BIZ UDGothic`, `Hiragino Kaku Gothic ProN`, `Yu Gothic`, `Noto Sans JP`, `sans-serif`.
- Dates/authors metadata and References/Backlinks/Related headings use the same Gothic stack. Forester companion theme's `--h1-font` through `--h6-font` also apply it to ordinary note headings.
- Body prose and paragraph content inside headers retain their previous typography; the companion theme's BIZ UDMincho text stack is unchanged. Plugin-only operation does not impose Gothic on unrelated/native headings or UI/property inputs.
- Colors, sizes, neutral taxon numbers, markerless footer, native disclosures, navigation and layout remain unchanged. Font files, embedded font-face data, versions/manifests are not altered.

## Verification

Three staged RED→GREEN cycles cover owned headings, metadata and ordinary companion-theme headings. Actual Chromium computed-style tests use Reading/Live Preview fixtures, light/dark, plugin-only/companion-theme and both stylesheet orders. Each contract covers the same eight configurations and compares the owned H1–H6/CM tokens/date metadata/backmatter against Mincho prose, unrelated headings and native disclosure/property controls.

Parent full rerun: 710 hybrid, 24 workspace and 51 CSS/theme tests pass, plus all retained legacy checks. Production build/TypeScript, the existing 18 Chromium/CodeMirror assertions, and `git diff --check` pass. All six WOFF2 files and all six embedded font-face blocks match the pre-change versions.

These are synthetic browser/style assertions, not native Obsidian acceptance or proof that every Japanese fallback font is installed. A read-only native inspection found no visible matching Dates/Backlinks headings and did not validate their appearance. No font installation, vault notes/settings, live plugin files or native reload was performed.

## Distribution

The standing Pre-release policy updates plugin assets and the companion `forester-theme.zip` together after independent review. The theme ZIP contains root `theme.css` and the theme `manifest.json` (different from the plugin manifest). Verify both ZIP members against the tested files after downloading. Apply the new plugin CSS and, when using the companion theme, its new theme CSS; publishing alone does not apply them to a live vault.
