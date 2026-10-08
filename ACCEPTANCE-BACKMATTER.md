# Document backmatter and sidebar-only TOC acceptance

## Contract

Reading and Live Preview append local **References → Backlinks → Related** below the note without inserting Markdown or changing Obsidian's native Backlinks settings/UI. The order follows fixed Forester `f8fb5f5d88923db36643cf9c20c662adff969c98` (`lib/compiler/Eval.ml:70–89`, selecting only the three requested groups). `lib/frontend/Html_client.ml:799–864` omits empty backmatter groups and renders unnumbered, initially collapsed result sections in an article footer. The adapter uses scoped footer typography, neutral taxon text, monospace `[ID]` slugs, existing local metadata and lazily rendered result bodies.

The document `Tree目次` toggle/widget is removed. Independent TOC and relation sidebar tabs remain. TOC title navigation still focuses the current occurrence; `[ID]` in the footer opens its definition, with Ctrl/Cmd requesting another leaf. Local private notes remain locally readable; this UI is not a public export or authenticated route.

## Real execution

| Check | Result |
|---|---|
| Full hybrid/parser/privacy/controller/sidebar/backmatter regressions | 679 passed, 0 failed |
| Real entrypoint/workspace integration through Obsidian API mock | 24 passed, 0 failed |
| Chromium computed-style/theme/backmatter tests | 24 passed, 0 failed |
| Retained legacy pure-module checks | 57 successful checks |
| Production TypeScript and bundle | passed |
| Actual Chromium with real CodeMirror | all reported checks passed, no page errors |

Focused tests reproduce missing Reading and EOF widgets before implementation, the native late-section/footer-order boundary, and resetting an addressed subtree page by reopening its parent file. They verify per-leaf scope instead of globally active context; unsaved editor overlays; graph dependency updates; no source writes; mode/exclusion/malformed-frontmatter/empty-group removal; idempotent placement; cursor movement preserving expansion; modifier navigation; lazy rendering; source-click capture not treating a footer as an EOF source link; and teardown/late callback safety. Existing tests formerly inspecting the removed inline widget now exercise the maintained sidebar outline/focus contract rather than fabricating inline DOM.

The actual Chromium fixture mounts the real EOF StateField widget and DOM renderer. Physical summary and Ctrl-click interactions verify expansion, target navigation, source preservation and survival across cursor movement. Computed-style tests load the actual plugin stylesheet and companion theme with light/dark and stylesheet-order controls. Their notes, graph and rendering boundaries are synthetic.

## Performance and traversal corrections

Independent review found two failures despite the initial suites passing: rebuilding a whole-vault graph synchronously inside each CM edit, and wrongly treating an ordinary self-related result as an embed cycle. Both were reproduced before their targeted fixes. CM now only reads/queues exact-context snapshots; preparation is trailing-coalesced for 30ms and cooperatively yields (32 steps or an 8ms budget), aborting obsolete source/config/leaf/tree-page generations. Pending footers are absent until the matching result is ready. The synchronous sidebar API and async preparation share one relation builder, rather than forking relation meaning. A deferred widget retains its immutable index so old summary and body stay consistent.

On the same synthetic 2,502-document / 3,461,790-character fixture, the original independent median edit observation was 750.31ms versus HEAD 3.06ms. The fixer observed 4.50ms median and zero synchronous graph constructions after correction. The parent's concurrent full-suite run observed edit transactions of 10.68/10.77/13.59ms, zero synchronous graph constructions, 316 preparation heartbeats and one final graph publication. These are bounded synthetic observations, not native latency guarantees; async work still has a total preparation cost.

Each footer body starts a fresh traversal. Ordinary self-links and a target that non-recursively embeds the current page now render, while actual nested cycles remain bounded. Additional regressions cover rapid edits preparing only the final snapshot, leaf/state/source/options/unload gates, obsolete in-progress work, per-leaf context and immutable delayed-body snapshots. Final independent re-review is separate from the fixer's test report.

## Limits and publication state

This is not full native Obsidian acceptance. A read-only native CLI layout probe timed out and did not provide selector/placement evidence. In particular, full native Reading virtualization, native CM decoration interoperation, plugin reload/restart, Mobile and production-scale responsiveness are still unverified. Browser/DOM tests do not establish that those native paths have passed.

No live note, installed plugin bundle, configuration or core Backlinks UI was edited for this change. Standard in-document Backlinks may coexist with the new footer when enabled. Existing Release/tag assets are not replaced by this source update. Distribution should remain a verification build/Pre-release until native acceptance is performed; do not infer deployment from passing tests.
