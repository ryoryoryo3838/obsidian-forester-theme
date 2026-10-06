# v2 default-on workspace acceptance

This records real execution for the default-on scope/input/sidebar replacement, not the earlier opt-in acceptance in `ACCEPTANCE.md`.

## Verified locally

| Check | Result |
|---|---|
| Hybrid/parser/public/controller/input/sidebar regressions | 625 passed, 0 failed |
| Real controller/workspace integration through the public Obsidian API mock boundary | 24 passed, 0 failed |
| Chromium computed-style/theme tests | 15 passed, 0 failed |
| Retained legacy pure-module checks | 57 successful checks |
| Project TypeScript and production bundle | passed |
| Actual Chromium/CodeMirror browser fixture | all reported assertions passed |
| Production dependency audit | 0 vulnerabilities |
| Version and self-contained theme checks | passed |
| Read-only public CLI on synthetic demo | 1 public tree |

The public demo result was checked independently for the expected ID and absence of its private canaries. Tests use synthetic notes, not the research vault.

The four independently identified module failures were reproduced and fixed with new regressions: malformed-frontmatter guards, unclosed protected EOF insertion, inert aliases preserving outer links, and in-flight sidebar open after unload. The parent rebuilt and reran the resulting 77 module tests successfully; independent re-review also passed 77 tests and 39 boundary observations.

Final integration review reproduced one additional cursor/CAS defect: moving the source selection during awaited picker target I/O could still replace the captured range. After adding real registered-picker regressions and extending the transaction guard, the full suite and 24 workspace tests passed again. Independent final re-review passed 24 workspace tests, 54 buffer regressions, the original two-case executable counterexample and 8 extra boundary probes. Source hashes were checked against both signoffs before publication. This approval covers the synthetic/API-boundary implementation, not native acceptance.

## Native Obsidian: blocked, not accepted

A new synthetic-only vault/config/profile was launched with host/home filesystem access removed and only the fixture directory allowed. The active app reports Obsidian 1.13.7. Its startup page and exact synthetic-vault path were read back.

Obsidian then required its initial **trust vault / enable plugins** confirmation. The permission clarification received no answer before timing out. No confirmation was bypassed: the plugin was not loaded, and native command, automatic-ID, picker, sidebar and occurrence-navigation acceptance could not run. A renderer readiness timeout at this gate is not evidence of a Forester freeze.

The passing controller/DOM tests are not substitutes for this native acceptance. Previously accepted native ID paths belong to the earlier build and do not prove this replacement's new features. Mobile, native Canvas internals, a full production-equivalent plugin/workspace test and the original sustained-freeze event source remain unverified.

## Native sidebar constructor correction

A subsequent live Obsidian report showed **“the plugin that created this pane is no longer active”** even though Forester and all four view factories were registered. Console capture during real view creation identified a `getViewType` exception: Obsidian's base View constructor dispatches this virtual getter before the derived constructor's `spec` parameter property exists.

The factories now create closure-bound subclasses whose type/title/icon are valid during `super(leaf)`. A realistic base-constructor mock reproduced the same exception before the fix; all four identities pass afterward. Full regressions, production build and independent review also pass.

The existing Backlinks pane was restored in the live app using the exact fixed sidebar module with native ItemView inheritance and the actual controller, replacing only that pane's factory **in memory**. Readback confirmed a real `data-forester-sidebar` and no removed-plugin message. Installed plugin files, other panes and note content were not changed by this temporary repair. This demonstrates the narrow constructor/Backlinks path; it does not establish full plugin reload/restart, all four native tab interactions, Mobile or production-freeze acceptance. Re-download the plugin assets to persist the source correction across restart.

## Scope and risks

- All Markdown is parsed by default, except excluded folders. Syntax scope does not grant publication permissions.
- Startup does not bulk-write IDs. Editing an in-scope note can add IDs to all valid H2–H6 subtrees after settled input. Existing source identifiers and manual IDs are preserved.
- `enabled` represents path scope; malformed-source diagnostics separately refuse semantic UI operations, rewrites and publication.
- Tree relation semantics mirror Forester's direct `links-to` and transclusion closure, not semantic similarity search or arbitrary Datalog evaluation.
- Synthetic graph measurements exercised 1,000 notes and bounded large lexical inputs. They are not an all-vault latency guarantee. Rebuilding relations is synchronous; dense cached result sets can grow quadratically.
- Existing conservative math/escape masking remains. Full APA/CSL, complete BibTeX/contributor/native-property rendering, authenticated private routes, site deployment and external-sync atomicity are not claimed.
- No production plugin, settings or note content was modified by this replacement work.

Distribution must remain an explicitly labeled **Pre-release**, without replacing the stable Latest release. Re-download all plugin assets when updating the same `2.0.0` tag; the theme archive carries the separate theme manifest.
