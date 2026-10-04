# Forester 2.0.0 startup freeze — findings and acceptance limits

## Status

**2.0.0 must not be treated as native-app accepted.** The original published artifact passed automated functional/privacy checks but froze a user's actual startup. With subsequent recovery consent, only Forester was disabled and the user confirmed normal operation after restart. The installed bundle was not overwritten. The replacement Pre-release contains bounded performance fixes, not a claim that the complete sustained production failure has been reproduced or resolved.

## Observed live state

- Open vault: wiki.miya-lis.net (actual Obsidian configuration).
- Installed Forester version: 2.0.0.
- Original installed main.js SHA-256: `937edb22673aa8811f207344f2214cb47965cf32c5c602d85bcf5d72a8674d68`, matching the initial published artifact before replacement.
- Obsidian renderer repeatedly observed at approximately one CPU core of sustained usage.
- Existing settings do not configure hybrid folders; default opt-in is disabled unless individual notes explicitly opt in.
- No live JS CPU profile has been obtained. These observations alone do not prove the complete live call stack.

## Reproduced mechanisms (synthetic notes, real source)

1. Disabled documents still run protected-body scanning.
2. isEnabled calls the full parser, including repeated legacy treeFor cache hits.
3. Every queued refresh reparses/indexes the entire source set, even for identical notifications. Source caching reduces reads but not parsing.
4. Disabled Live Preview can build full-vault overlays before rejecting applicability; unchanged refreshes dispatch/rerender ordinary views.
5. Inline code/math guards repeatedly rescan whole suffixes; backslash escape checks also rescan prefixes. These are demonstrated superlinear hotspots, not proven infinite loops.

Examples from actual bounded reproduction:

- 1000 ordinary notes, 20 identical metadata events: about 1 second of repeated work, 20,000 parse calls in the instrumented run.
- 500 notes with one 128KiB delimiter-rich disabled note, 5 unchanged events: about 2.4 seconds of work with timers not progressing until it completed.
- Cached legacy treeFor, five calls on the same 32KiB source: old code 0.003ms versus 2.0.0 224.59ms in the reported single-run benchmark.

A perpetual legacy MutationObserver feedback loop and a RAM leak were **not** reproduced. Normal embed rendering converged in both DOM and Chromium controls. No observer-disconnect workaround is justified by the evidence.

## Fix work — subsystems passed; production recovered with Forester disabled

Parallel TDD scopes:

- Core: shared cheap activation, disabled scan bypass while preserving metadata/index diagnostics, scanner computational cost improvements with privacy grammar unchanged.
- Controller/main: event coalescing, no-op suppression, source/config generation-aware caches, cooperative scheduling and disabled-view fast paths.

Parent integration registered both performance suites and updated the renderer-owner test to emit a real dependency change rather than assume a no-op refresh must invalidate everything. All existing renderer-owner assertions remain.

- Parent `npm test`: hybrid 521/521 and legacy 57/57 passed.
- Plugin build, actual Chromium/CodeMirror checks, strict CLI typechecking, runtime audit and diff check passed.
- Independent core/public review passed 358 tests and 13,891 bounded comparisons/cases; no blocking safety/logic issue was found.
- Independent controller review passed 18 startup tests, 161 existing regressions and 7 independent probes; native timers progressed during startup and repeated identical events did not parse/index again.
- These results accept the subsystems and do not establish recovery of the user's native Obsidian process. Detailed review JSON is local under `plugin/test/build/startup-{core,controller}-review.json`.
- The actual installed bundle remains unchanged. Forester was removed from the enabled list with consent; user-confirmed recovery does not establish that re-enabling the replacement is safe.

Do not disable the controller solely because folders are empty: per-note explicit opt-in must keep working. Do not trade privacy validation for speed or use stale source/settings snapshots as authority for public projection or writing.

## Verification required

- Real parser/controller synthetic startup and burst regressions, including timer progress and large code/math/backslash cases.
- Existing functional, publication canary, CAS/rollback, renderer lifecycle and mode-switch suites.
- Fresh independent privacy/performance review.
- Explicitly separate these tests from native Obsidian recovery and the full original startup diagnosis.
- Any revised Release or live plugin installation requires separate scope/consent; never overwrite the installed bundle while Obsidian is still frozen.

## Additional attribution checks

Read-only bounded checks of 197 actual Markdown inputs found every note hybrid-disabled. A single old-core read/hash/parse pass finished in about 178ms; no individual nonterminating parser input was reproduced. With real controller/core and mocked native IO/UI, 197 injected identical metadata notifications caused 38,809 old-version parses and about 14.4s of timer starvation. The fixed controller performed no reparse for those duplicate notifications. These injected counts are not a recording of production event traffic.

A separate native Obsidian control used the original published bundle, companion theme and 197 synthetic notes with no other community plugin. A short CPU sampling window was predominantly idle and did not reproduce spontaneous refresh reentry. This does not exclude other workspace/DOM conditions or interactions with other plugins. The original production event source and CPU call stack remain unknown.

The later fixed-build native trial with 1006 synthetic notes was interrupted; its large-note timeout is not an exact reproduction of the production freeze. Earlier Reading assertions also counted hidden Source DOM, so native Reading acceptance remains incomplete. The replacement must remain a Pre-release.

Detailed local investigation artifacts reside under scratch and plugin/test/build and are not public-source inputs. No private note bodies, filenames or diagnostic inventory are included here or in the Release assets.
