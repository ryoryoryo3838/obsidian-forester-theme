# Native attachments and tree suggestions — bounded acceptance

## User-visible contract

- `[[` / `![[` suggestions include native attachments (images, PDF, media and other non-Markdown files) alongside semantic trees. Excluded/not-indexed Markdown files remain available as native file candidates. Enabled Markdown roots keep one semantic tree candidate.
- Native candidates use Obsidian's public `metadataCache.fileToLinktext(file, sourcePath)`. Selection inserts a literal wikilink/embed, consumes auto-paired closing brackets and places the cursor after the insertion. It does not read/write binary files or mint tree IDs. Source/cursor/settings/target identity and changed linktext are revalidated before insertion.
- Native attachments are resolved with `metadataCache.getFirstLinkpathDest(linkpath, sourcePath)`, not just an exact vault path. Basename, folder and relative targets, Unicode/spaces, PDF fragments and image dimensions remain Obsidian-owned.
- Reading leaves native attachment DOM/attributes unchanged. Live Preview does not replace attachment ranges with hybrid widgets. Images embedded within a tree reach MarkdownRenderer with their original syntax, including `|300` / `|300x200`.
- An actual native attachment takes precedence over a colliding bare tree ID for attachment display and click ownership. Genuine missing or ambiguous tree references retain explicit errors.
- Native rendering ownership is decided after the canonical display/numbering plan. No display-only protection mask or cloned document is needed; parser/semantic/footer indexes remain canonical. Reading, Live Preview and TOC retain the same existing numbering, including a subtree after an image. Existing disabled-Markdown nested embed routing is unchanged.
- Local attachment support does **not** grant publication permission. The public projection/CLI still refuse unvetted assets and private embeds.

## Evidence

The two implementers recorded separate RED→GREEN cycles for candidate availability/insertion/context guards and Reading ownership/nested dimensions/Live Preview/click ownership. Parent integration additionally reproduced a display-only mask leaking into the footer overlay index; independent review then found a numbering mismatch after an image. The final correction removes the mask entirely and uses an optional editor-host native ownership callback after the canonical plan. A regression compares the actual CM label, Reading DOM badge and TOC. An existing disabled-Markdown nesting regression was restored without weakening its assertions.

Final parent verification:

| Command / scope | Result |
| --- | --- |
| `npm test`: hybrid | 700 passed, 0 failed |
| workspace | 24 passed, 0 failed |
| CSS/theme | 24 passed, 0 failed |
| retained legacy pure-module checks | all three suites passed |
| `npm run build` | TypeScript and production bundle passed |
| `npm run test:browser` | existing 18 Chromium/CodeMirror checks passed |
| `git diff --check` | passed |

Attachment regressions exercise the actual parser/controller/CodeMirror state and DOM ownership with mocked Obsidian runtime/linkpath APIs. The existing Chromium fixture checks other display/backmatter behavior; it is **not** native image decoding or Obsidian's live attachment renderer. Native-app image display, complete native suggester interaction, Mobile and reload acceptance are not established by these tests. Native-app verification must be recorded separately.

This source update does not install or reload the plugin in a live vault or modify notes/settings. Release assets/tag updates are a separate action. Read-only inspection earlier in the report found no image embeds in the active Markdown view, so that view was not a native reproduction of the image symptom.
