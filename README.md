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

**Numbering.** `src/forest.ts` is a direct port of `tree.xsl`'s
`tree-taxon-with-number`, including the rule that silently drops the number when
a subtree is its parent's only child and has at most one child of its own:

```
implicitly-unnumbered = count(../f:tree) = 1 and not(count(f:mainmatter/f:tree) > 1)
```

Numbering crosses transclusion boundaries: a heading inside a transcluded note
continues the host page's sequence, resolved through `data-forester-number` on
the enclosing block.

**Addresses.** Only trees that have one get a `[slug]`: files, and headings
preceded by `<!-- subtree: ID -->` — the directive `tree-md` already understands.
The slug is a real link: click to open the tree, mod-click or middle-click for a
new tab, hover for a page preview. A named subtree's slug jumps to that heading
inside its own note.

**Front matter.** `taxon`, `date`, `authors`, `contributors`, and the meta fields
(`institution`, `orcid`, `doi`, `external`, `slides`, `video`, …) are rendered in
the order `tree.xsl` emits them. Meta fields are read both as top-level keys and
from a nested `meta:` table, matching `tree-md`'s `promoted_meta_keys`. Setting
`author: false` suppresses the byline, as it does on the site.

Run `npm test` in `plugin/` to check the numbering port against the XSL rules.

## Current limits

- **Live Preview** gets the transclusion blocks; heading numbering and the root
  title are reading-view only so far.
- **Named subtrees across files.** Forester addresses every named subtree
  globally, so `\transclude{research-interest}` reaches into another file.
  Obsidian addresses files (and headings within a file), so a subtree that is
  transcluded elsewhere has to live in its own note today.
- **Author names must be tree ids.** `authors: ["[[清宮亮太郎]]"]` is a `TM101`,
  because a `[[…]]` attribution has to match `[A-Za-z0-9][A-Za-z0-9._-]*`. Use a
  literal string, or give the person a tree with an ASCII id.

Note on filenames: Obsidian reads `research.tree.md` as the note `research.tree`
and so writes `![[research.tree]]`. `tree-md` accepts that spelling — it retries
a missed target without the `.tree` suffix and emits the identity — so the
Obsidian-native form is the one to write in the vault.
- **Fonts.** `site/theme/style.css` asks for `Honoka Shin Mincho` first, but
  `site/theme/fonts/honoka-shin-mincho-l.woff2` does not exist, so the site
  currently falls back to the browser's sans-serif for Japanese. The theme here
  declares the same stack with `BIZ UDMincho` behind it; the two will agree once
  the font file is added to the site.
