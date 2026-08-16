# obsidian-forester-theme

Make Obsidian render a note the way [Forester](https://www.forester-notes.org/)
renders the `.tree` it compiles to — so that a `.tree.md` source and its
published page look like the same document.

The published site is authoritative. Every rule here is ported from
`~/Documents/OCaml/miya-lis.net/site/theme/` (`tree.xsl`, `metadata.xsl`,
`style.css`), and each ported block quotes the original selector in a comment.
When the site's theme changes, change this repo to follow.

```
theme/     Obsidian theme  — typography, palette, widths, link/code/list rules
plugin/    Obsidian plugin — transclusion blocks, taxon prefixes, 1.1 numbering
scripts/   install.sh — symlinks both into a vault
```

## Install

```sh
./scripts/install.sh ~/wiki.miya-lis.net
```

Then enable **Appearance → Themes → Forester** and **Community plugins →
Forester**. The script links rather than copies, so `npm run dev` in `plugin/`
is picked up by a reload.

### Mobile

The plugin runs on Obsidian mobile: it uses only the Obsidian API and the DOM,
no Node or Electron, and the manifest declares `isDesktopOnly: false`. Two
things differ from desktop:

- Install with `./scripts/install.sh --copy <vault>`. A symlink does not resolve
  on a phone, so the files have to be real. They then need to reach the device —
  note that `~/wiki.miya-lis.net/.gitignore` ignores `/.obsidian`, so
  obsidian-git will not carry them as things stand.
- Hover effects are behind `@media (hover: hover)`, because a tap latches
  `:hover` on touch and the block tint would never clear. Mod-click, middle-click
  and hover previews on `[slug]` are desktop-only by nature; a plain tap opens
  the tree.

The observer that finds embeds is document-wide, so it is gated twice: a
mutation batch is ignored unless it actually touches an `.internal-embed`, and
the scan waits 150ms on mobile against 40ms on desktop.

## What the plugin does

A Forester page is one root tree whose mainmatter holds nested trees. `tree-md`
produces exactly that from Markdown: the leading `#` is the root `\title`, every
`##`–`######` is a `\subtree`, and a standalone `![[id]]` is a `\transclude{id}`
that splices the target tree in as a sibling. The plugin rebuilds that tree from
Obsidian's metadata cache and renders it with the site's own DOM shape.

**Transclusions.** `![[note]]` loses Obsidian's embed frame and title bar and
becomes a `.block`: a header carrying `Taxon 1.2. Title [slug]`, a metadata line
(`August 4, 2026 · miya`), 5px of left padding, the site's hover tint, and
click-to-collapse. Nesting is deliberately almost flat — that is what makes a
note inside a note read as part of the same document.

**Untitled subtrees.** `<!-- hN -->` and `<!-- hN:ID -->` open a subtree with no
`\title`; `<!-- /hN -->` closes every open subtree at level *N* or deeper, so
what follows belongs to the parent again. Headings and directives share one
level stack, exactly as they do in `tree-md`, which means an untitled subtree is
numbered, indented and addressed like any other. In its own note the header
hangs off the comment that opens it — there is no heading to decorate.

**Transcluding a subtree.** `![[note#^id]]` shows the whole subtree named `id`,
not the single block Obsidian anchors `^id` to: the extent comes from the level
stack, so it ends where `<!-- /hN -->` says it does. `[[#^id]]` reaches a
subtree of the current note. The note in that spelling only locates the anchor —
the subtree's identity *is* the anchor, so that is what the reference resolves
to. The header carries that subtree's number and `[id]` and nothing else: a
subtree has no title, front matter or address of its own to borrow from the note
around it. The anchor has to sit inside the subtree of the same name, or the
embed is left exactly as Obsidian drew it. Splicing a range in reads the target
note once through `cachedRead`, because the closing directives exist only in the
raw text.

`![[note#Heading]]` is **not** resolved, and `tree-md` rejects it too. A section
has no Forester address unless its heading was given one, and making the title
the address is the brittleness identities exist to remove: retitle the section
and every reference to it breaks.

**Numbering.** `src/forest.ts` is a direct port of `tree.xsl`'s
`tree-taxon-with-number`, including the rule that silently drops the number when
a subtree is its parent's only child and has at most one child of its own:

```
implicitly-unnumbered = count(../f:tree) = 1 and not(count(f:mainmatter/f:tree) > 1)
```

Numbering crosses transclusion boundaries: a heading inside a transcluded note
continues the host page's sequence, resolved through `data-forester-number` on
the enclosing block. The DOM is built in the wrong order for that — Obsidian
renders an embed's contents before the block around them — so a heading also
keeps its own number in `data-forester-local`, and the full path is rebuilt once
the block has one. That is what makes `Heading 2` inside a transcluded note read
`1.1` rather than `1`.

**Identity.** A tree's address is the `id` in its front matter, and its file
name only if it states none. Stating it is what lets the file be renamed —
retitled, translated — without moving the address the published site and every
existing reference use. So `id: mlnet-7` in `information-concept.tree.md` shows
`[mlnet-7]`, and a reference resolves through the ladder `tree-md` uses, in its
order: the identity, the identity with `.tree` taken off, the file name, the
file name with `.tree` taken off. Identities win, so a tree whose `id` matches
another tree's file name is not shadowed by it. Obsidian resolves links by file
name and cannot answer the first two, so the plugin keeps its own index of the
vault.

**Naming a subtree.** Four spellings, one meaning — and saying it twice is an
error, as it is in `tree-md`:

```markdown
<!-- subtree: ID -->     <!-- id: ID -->      ## Heading ^ID     <!-- hN:ID -->
## Heading               ## Heading
```

The first three name a heading; only `<!-- hN:ID -->` opens a subtree of its
own. `<!-- id -->` in particular is a name for the heading below it, not the
start of anything — an untitled subtree is opened and closed by `<!-- hN -->`
and `<!-- /hN -->`, and `<!-- /id -->` closes nothing (`tree-md` says so in as
many words: *use `<!-- /hN -->` to close a subtree*).

Of the three, only `## Heading ^ID` is one Obsidian can address, because
`![[note#^ID]]` needs an anchor and a comment is not one. So the lint **moves**
a directive's name onto its heading rather than adding an anchor beside it —
adding one would be naming the subtree twice. The blank line that separated the
directive from its heading goes with it.

`^ID` ends a block and is Obsidian's, not content: it is stripped from the
title and from the body, and a paragraph holding nothing else leaves nothing
behind. Only a token ending the block counts, and only one that starts the run
or follows a space, so `the value x^2` keeps its caret.

**Minting.** Two commands — *Forester: mint address for this note* and *…for
subtree at cursor* — write an address where one is missing. The scheme is the
one `tree-md.toml`'s `[id]` table configures, copied into the plugin's settings
because that file lives in the forest repository and a phone does not have it:
base 36, four digits, `random`. Random rather than sequential because addresses
are minted from more than one place — `tree-md`, this plugin, this plugin
offline on a phone — and two of them would otherwise hand out the same next
number. An address that is written is never minted over, and a policy that
could mint something that is not a legal identity is refused before it is used.

**Minting on save.** Obsidian has no "saved" event — it writes continuously — so
the only thing that means *the author stopped* is the save command. **On save**
wraps it directly. **When something else asks** leaves it alone and waits for
*Forester: lint this note* to be called, which is what to choose alongside the
[Linter](https://github.com/platers/obsidian-linter) plugin: add that command to
Linter → Custom Commands, and Ctrl+S lints and then mints, in that order. Two
plugins are then not rewriting one file at once, and the addresses go into text
Linter has finished with rather than text it is about to rewrite. **Requests only** fills in an empty `id:`, a bare
`<!-- id -->`, a bare `<!-- hN -->`, and any heading a `#Heading` reference
points at, so nothing that already had an address is given a different one.
**Every note** also addresses a note that states nothing, and that does move it
— from the file name to the minted id. Off by default.

A heading is not otherwise addressed. Writing `## Section` is writing a section,
not asking for an address. Writing `![[note#Section]]` *is* asking, though —
that is a request to address the section, and the section has no address until
its heading is given one. So the reference mints, and it mints into the note
holding the heading, which is rarely the note doing the asking. The reference is
then rewritten to the address, and both sides say the same thing.

A `#` title is the exception, because it is not a section at all: it is the root
`\title`, which is to say the tree. `![[research.tree#研究]]` is `![[research.tree]]`
said the long way, so the fragment is dropped rather than addressed.

`<!-- hN -->` counts as a request because an untitled subtree is the one thing
with nothing to fall back on: a note that states no `id` is still addressed by
its file name, and that is what makes minting for it a change, but an untitled
subtree has no address at all until one is written. `tree-md` does not mint
there, which is not a disagreement — minting decides what to write, not how to
read it, and the source is unambiguous once written.

**Heading references get corrected.** Obsidian autocompletes `![[note#Heading]]`,
so it gets written by habit, and `tree-md` rejects it. Where that heading has
been given an id, saving rewrites the reference to `![[note#^id]]`, keeping any
alias — and minting an address sweeps the rest of the vault for references to
the heading it just named, because the note holding a heading is rarely the note
pointing at it. *Forester: rewrite heading references to addresses* does the
sweep on its own. A reference whose heading has no id is left exactly as
written: there is nothing to correct it to.

Minting from a directive raises a second question, because Obsidian reaches a
subtree only through an anchor: `<!-- h2:0073 -->` names it for `tree-md`, but
`![[note#^0073]]` needs a `^0073` inside it. The body is often not written when
the address is minted, so the anchor is placed on the first block of the body on
whichever save first finds one. The address itself does not care: it says
nothing about the tree, so a `<!-- /h2 -->` added later moves the subtree's
*extent* and not its *identity*, and every reference keeps pointing at the same
subtree.

**The slug is a real link.** Click to open the tree, mod-click or middle-click
for a new tab, hover for a page preview. A named subtree's slug jumps to it
inside its own note, through the `^id` anchor that names it.

**Front matter.** `taxon`, `date`, `authors`, `contributors`, and the meta fields
(`institution`, `orcid`, `doi`, `external`, `slides`, `video`, …) are rendered in
the order `tree.xsl` emits them. Meta fields are read both as top-level keys and
from a nested `meta:` table, matching `tree-md`'s `promoted_meta_keys`. Setting
`author: false` suppresses the byline, as it does on the site.

Run `npm test` in `plugin/`. It checks the numbering port against the XSL rules,
and the identity rules against `test/fixtures/identity.json` — shared fixtures
that `tree-md`'s own suite should read too, so that changing a rule in one
repository fails the other. The vault and the published site giving a tree the
same address is the invariant the whole project rests on.

## Current limits

- **Live Preview** gets the transclusion blocks, spliced ranges included; heading
  numbering, the root title and the header on an untitled subtree are
  reading-view only so far.
- **Duplicate identities are not reported.** Two trees claiming one address is
  an error in `tree-md`. Here the first note found keeps it, so the ambiguity
  shows up as one address rather than as a diagnostic.
- **Block ids are narrower than tree ids.** Obsidian's `^id` allows letters,
  digits and dashes; the identity grammar is `[A-Za-z0-9][A-Za-z0-9._-]*`. A
  subtree meant to be reachable from Obsidian has to keep to the intersection.
- **Author names must be tree ids.** `authors: ["[[清宮亮太郎]]"]` is a `TM101`,
  because a `[[…]]` attribution has to match `[A-Za-z0-9][A-Za-z0-9._-]*`. Use a
  literal string, or give the person a tree with an ASCII id.

Note on filenames: Obsidian reads `research.tree.md` as the note `research.tree`
and so writes `![[research.tree]]`. `tree-md` accepts that spelling — it retries
a missed target without the `.tree` suffix and emits the identity — so the
Obsidian-native form is the one to write in the vault.
- **Fonts.** Prose is set in BIZ UDMincho on both sides. The site self-hosts
  it, as 248 unicode-range slices under `site/theme/fonts/biz-udmincho/`, so a
  visitor needs nothing installed. This theme does not ship them: 8MB is right
  for a page loaded once and wrong for a file copied into every vault. Install
  the font on the machine instead — it comes with Windows, and is otherwise at
  <https://github.com/googlefonts/morisawa-biz-ud-mincho> — or the stack falls
  back to the platform mincho, and on Android, which bundles none, to the
  platform serif. Inria Sans is shipped here and covers the hero, the
  navigation and the metadata on both sides.
