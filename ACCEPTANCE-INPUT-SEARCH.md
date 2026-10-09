# Prepared wikilink search — bounded acceptance

## Contract

`[[` / `![[` query a reusable, normalized metadata catalog prepared outside interactive completion. Trees are searchable by ID/title/path; native files by name/path. This is a local, in-memory search catalog, not a persisted database or a promise of sublinear substring search for every query.

- Canonical index publications trigger coalesced tree preparation. Facts for unchanged document objects are reused; changed documents replace only their normalized facts.
- Initial native file enumeration occurs once outside interactive queries. Metadata normalization and tree preparation yield every 128 work steps or an 8ms checkpoint budget. Those checkpoints do not strictly bound the intrinsic cost of one native operation.
- Create/delete/rename update native file facts; identity checks prevent bootstrap snapshots from restoring deleted/replaced/renamed objects. A new canonical publication immediately retires a yielded old tree generation before its queued replacement runs.
- Completion creates at most 100 rows, balancing trees and native files when both are available. Expensive tree-resolution attempts and native linktext formatting are bounded before candidate materialization, not by slicing an already expanded list. Type a more specific query to find candidates beyond the visible cap.
- Queries do not enumerate the vault, read files, normalize trees, or rebuild the catalog. Rare substring/multi-word queries may still scan prepared normalized facts. A changed draft is checked against the current source; affected old tree facts are withheld until their canonical replacement is prepared. Preparation can temporarily leave fewer suggestions.
- Tree selection retains source/cursor/target/settings/CAS checks; native selection retains object/path/linktext validation and literal insertion without binary reads, writes or ID minting. Native attachment drawing and public privacy policy are unchanged.
- Unload clears subscriptions/catalogs and invalidates pending preparation; no late facts, rows or insertion are allowed.

## Measurements and verification

The original registered suggester/controller on 3,662 synthetic Markdown notes, ten subtrees per note and 276 assets did not complete before a 40-second child-process safety timeout. No final elapsed time was invented for that timeout. A smaller 512-note baseline did finish in 790.19ms, generating 5,898 rows and making 5,622 real resolver calls (2,878,464 document visits). Repeated `currentIndex` calls reused cached indexes; full index rebuilding was not the demonstrated cause.

The corrected standalone large fixture completed in 98.50ms; the parent's concurrent full-suite fixture took 147.94ms. It produced 100 rows (50 trees/50 native files), made 50 real resolves and 50 simulated native formatting calls, visited 50 prepared tree facts, and performed zero tree normalizations/catalog builds/vault enumerations/file reads during completion. The native formatter uniqueness scan is simulated; these timings are not native Obsidian latency guarantees.

Parent `npm test` passes 710 hybrid, 24 workspace and 24 CSS/theme tests, plus all retained legacy runners. TypeScript/production build, existing Chromium/CodeMirror 18 assertions and `git diff --check` pass. Ten focused input-performance tests cover bounds/rare matches, readiness, file lifecycle/replacement races, fact reuse, scope/source changes, private local selection, canonical create/rename/delete, remote title refresh, notification-gap cancellation and unload.

Native app `[[` responsiveness, initial inventory API latency, Mobile and reload acceptance remain unverified. A read-only native inventory eval during the user's report produced no evaluation result; it was not used as a performance measurement. Source/fixture acceptance and independent review must not be described as native recovery.

Release 2.0 stays a Pre-release and preserves stable Latest. Verified fixes are reflected in its assets under the standing release-update policy; installed plugin files/settings/notes are not changed by publishing.
