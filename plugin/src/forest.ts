/**
 * A faithful port of the tree model that `site/theme/tree.xsl` walks over.
 *
 * Forester renders one page as a single root `f:tree` whose `f:mainmatter`
 * holds nested `f:tree` elements. `tree-md` produces exactly that shape from
 * Markdown: the leading `#` becomes the root `\title`, every `##`..`######`
 * becomes a nested `\subtree`, `<!-- hN -->` opens a `\subtree` that has no
 * title at all, and a standalone `![[id]]` becomes a `\transclude{id}` which
 * splices the target tree in as a sibling subtree.
 *
 * This module rebuilds the same tree from Obsidian's metadata cache so that
 * taxon prefixes and `1.1`-style numbers agree with the published site. Every
 * node also carries the source range it spans, because a `#…` embed addresses a
 * *subtree* rather than a document, and Obsidian's idea of how far that reaches
 * — to the next heading of the same level, or exactly one block — is not
 * tree-md's, which stops at `<!-- /hN -->`.
 */

import type { App, TFile } from "obsidian";

export type NodeKind = "root" | "heading" | "subtree" | "embed";

export interface NodeMeta {
	taxon?: string;
	date?: string;
	authors?: string[];
	contributors?: string[];
	/** `\meta{author}{false}` — the site's switch for suppressing the byline. */
	hideAuthors?: boolean;
	/** Meta entries, already ordered the way `tree.xsl` emits them. */
	extra?: Array<{ name: string; value: string }>;
}

/**
 * Meta names `tree-md` accepts as top-level front-matter keys as well as under
 * `meta:` (see its `promoted_meta_keys`). Both spellings mean the same thing, so
 * both are read here.
 */
const PROMOTED_META_KEYS = [
	"position",
	"institution",
	"venue",
	"source",
	"doi",
	"orcid",
	"external",
	"slides",
	"video",
	"bibtex",
	"author",
	"toc",
	"lang",
];

/**
 * `tree.xsl` applies the metadata templates in a fixed order, so the rendered
 * line reads the same on every page. Anything not in this list is dropped, as
 * the site drops it.
 */
const META_ORDER = [
	"position",
	"institution",
	"venue",
	"source",
	"doi",
	"orcid",
	"external",
	"slides",
	"video",
];

/** The lines a transcluded subtree occupies in the file that owns it. */
export interface TargetRange {
	/** Vault path of that file. */
	path: string;
	/** Source lines to splice in, `[start, end)`. */
	start: number;
	end: number;
}

/**
 * An identity, and the grammar every one of them has to satisfy — a note's `id`,
 * a subtree's name, a minted address alike.
 */
export const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * What the plugin knows about the forest as a whole. A document cannot be built
 * alone: an identity lives in another note's front matter, and a range lives in
 * another note's text, and neither is in the metadata cache.
 */
export interface Forest {
	/** Raw vault text for a note, once it has been read. */
	sourceOf(file: TFile): string | undefined;
	/** The identity a note publishes under. */
	identityOf(file: TFile): string;
	/** Resolve the file part of a wiki target. */
	resolve(target: string, from: TFile): TFile | null;
}

export interface ForesterNode {
	kind: NodeKind;
	/** Markdown heading level; 1 for the root, 0 for embeds (depth comes from the parent). */
	level: number;
	title: string;
	/** Forester `display-uri`; only addressable trees get a `[slug]`. */
	uri?: string;
	meta: NodeMeta;
	/** Zero-based source line of the heading, directive or embed. */
	line: number;
	/** Source lines this node spans, `[startLine, endLine)`. */
	startLine: number;
	endLine: number;
	children: ForesterNode[];
	/** 1-based position among numbered siblings. */
	index: number;
	/** Dotted number path relative to this document's root, e.g. `1.2`. */
	localPath: string;
	shouldNumber: boolean;
	/**
	 * How many subtrees this node owns. For an embed this is read from the
	 * *target* document, because Forester counts the transcluded tree's own
	 * mainmatter when applying the implicit-unnumbered rule.
	 */
	childCount: number;
	/** Set by `<!-- forester: numbered=false -->`, mirroring `@numbered='false'`. */
	explicitlyUnnumbered: boolean;
	/** For an embed: the link exactly as written, which is also its `src`. */
	link?: string;
	/** For `![[note#…]]`: the fragment, which addresses a subtree, not a note. */
	fragment?: string;
	/** Where that subtree's body lives, once the target's text has been read. */
	target?: TargetRange;
	/** A `#…` embed whose subtree could not be found. */
	unresolved?: boolean;
	/** Named twice, which tree-md rejects; the two spellings are recorded. */
	conflict?: string;
}

/**
 * The file name with any `.tree` taken off: `foo.tree.md` and `foo.md` are both
 * the file `foo`. This is the *search key* Obsidian autocompletes and writes —
 * it is only the address for a note that states no `id`.
 */
export function fileStem(file: TFile): string {
	return file.basename.replace(/\.tree$/, "");
}

/**
 * A tree's identity: its `id` if it states one, its file name otherwise.
 *
 * Stating it is what lets the file be renamed — retitled, translated — without
 * moving the address the published site and every existing reference use. An
 * `id` that could not be an identity is not one, so the file name stands and
 * the note reads as unaddressed rather than addressed wrongly.
 */
export function identityOf(app: App, file: TFile): string {
	const declared = app.metadataCache.getFileCache(file)?.frontmatter?.["id"];
	if (typeof declared === "string" && IDENTITY.test(declared)) return declared;
	return fileStem(file);
}

/**
 * The forest as seen through the metadata cache alone, for callers with nothing
 * better. Resolution is by file name only: without an index of the whole vault
 * there is no way to look a note up by the identity it states.
 */
export function metadataForest(app: App): Forest {
	return {
		sourceOf: () => undefined,
		identityOf: (file) => identityOf(app, file),
		resolve: (target, from) => resolveByFilename(app, target, from),
	};
}

/** Steps 3 and 4 of the ladder, which Obsidian can answer on its own. */
export function resolveByFilename(app: App, target: string, from: TFile): TFile | null {
	const direct = app.metadataCache.getFirstLinkpathDest(target, from.path);
	if (direct) return direct;
	const bare = target.replace(/\.tree$/, "");
	return bare === target ? null : app.metadataCache.getFirstLinkpathDest(bare, from.path);
}

function emptyNode(partial: Partial<ForesterNode>): ForesterNode {
	return {
		kind: "heading",
		level: 2,
		title: "",
		meta: {},
		line: 0,
		startLine: 0,
		endLine: 0,
		children: [],
		index: 1,
		localPath: "",
		shouldNumber: false,
		childCount: 0,
		explicitlyUnnumbered: false,
		...partial,
	};
}

function readMeta(frontmatter: Record<string, unknown> | undefined): NodeMeta {
	if (!frontmatter) return {};
	const meta: NodeMeta = {};

	const taxon = frontmatter["taxon"];
	if (typeof taxon === "string" && taxon.length > 0) meta.taxon = taxon;

	const date = frontmatter["date"];
	if (typeof date === "string" && date.length > 0) meta.date = date;
	else if (date instanceof Date) meta.date = date.toISOString().slice(0, 10);

	// `author` is a meta switch in Forester, never a name; the list key is
	// `authors`, matching tree-md's front-matter schema.
	const authors = attributionList(frontmatter["authors"]);
	if (authors.length > 0) meta.authors = authors;

	const contributors = attributionList(frontmatter["contributors"]);
	if (contributors.length > 0) meta.contributors = contributors;

	const table = metaTable(frontmatter);
	meta.hideAuthors = String(table["author"] ?? "") === "false";

	const extra = META_ORDER.flatMap((name) => {
		const raw = table[name];
		const value =
			typeof raw === "string" ? raw : typeof raw === "number" ? String(raw) : "";
		return value.length > 0 ? [{ name, value }] : [];
	});
	if (extra.length > 0) meta.extra = extra;

	return meta;
}

function attributionList(value: unknown): string[] {
	if (typeof value === "string") return [stripWikiLink(value)];
	if (Array.isArray(value)) {
		return value.filter((a): a is string => typeof a === "string").map(stripWikiLink);
	}
	return [];
}

/** Merge the `meta:` mapping with the promoted top-level keys. */
function metaTable(frontmatter: Record<string, unknown>): Record<string, unknown> {
	const table: Record<string, unknown> = {};

	const nested = frontmatter["meta"];
	if (nested && typeof nested === "object" && !Array.isArray(nested)) {
		Object.assign(table, nested as Record<string, unknown>);
	}

	for (const name of PROMOTED_META_KEYS) {
		const value = frontmatter[name];
		if (value !== undefined && value !== null) table[name] = value;
	}

	return table;
}

/** `authors: ["[[miya]]"]` is idiomatic in tree-md; the site prints just the name. */
function stripWikiLink(value: string): string {
	const match = value.match(/^\s*\[\[([^\]|]+)(?:\|([^\]]+))?\]\]\s*$/);
	if (!match) return value.trim();
	return (match[2] ?? match[1]).trim();
}

/**
 * `<!-- subtree: ID -->` immediately before a heading names that subtree, which
 * is what gives it an address — and therefore a `[slug]` in the rendered page.
 */
const SUBTREE_DIRECTIVE =
	/^<!--\s*(?:subtree|id)\s*:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->\s*$/;
/** `<!-- id -->` with no value asks for an address to be minted. */
export const MINT_REQUEST = /^<!--\s*id\s*-->\s*$/;
const NUMBERED_DIRECTIVE = /^<!--\s*forester:\s*numbered\s*=\s*false\s*-->\s*$/;

/**
 * `<!-- hN -->` and `<!-- hN:ID -->` open a subtree with no `\title`, and
 * `<!-- /hN -->` closes every open subtree at level N or deeper so that what
 * follows belongs to the parent again. A Markdown heading expresses neither: it
 * always carries a title, and it always runs to the next heading of the same or
 * a lower level.
 *
 * The opening form names its own level, so it shares one level stack with
 * headings and the two forms mix freely. Both are matched against the raw line:
 * indented or quoted, the comment sits inside a list or block quote, which
 * tree-md rejects (TM104) rather than reading as document structure.
 */
const OPEN_SUBTREE = /^<!--\s*h([2-6])(?::\s*([A-Za-z0-9][A-Za-z0-9._-]*))?\s*-->[ \t]*$/;
const CLOSE_SUBTREE = /^<!--\s*\/h([2-6])\s*-->[ \t]*$/;

const CODE_FENCE = /^\s{0,3}(?:```|~~~)/;

/**
 * An anchor ending a block. Only a token at the end counts, and only one that
 * starts the run or follows a space, so `the value x^2` keeps its caret.
 */
export const BLOCK_ANCHOR = /(?:^|[ \t])\^([A-Za-z0-9][A-Za-z0-9._-]*)$/;

interface Directives {
	uri?: string;
	explicitlyUnnumbered: boolean;
}

/** Scan backwards from a heading line over blank lines and comment directives. */
function directivesBefore(lines: string[] | undefined, line: number): Directives {
	const result: Directives = { explicitlyUnnumbered: false };
	if (!lines) return result;

	for (let i = line - 1; i >= 0; i--) {
		const text = lines[i]?.trim() ?? "";
		if (text.length === 0) continue;

		const subtree = text.match(SUBTREE_DIRECTIVE);
		if (subtree) {
			result.uri = subtree[1];
			continue;
		}
		if (NUMBERED_DIRECTIVE.test(text)) {
			result.explicitlyUnnumbered = true;
			continue;
		}
		break;
	}
	return result;
}

/** The slices of Obsidian's cache this module reads, spelled out so the tests
 * can stand in for it without pulling the whole API. */
interface HeadingLike {
	level: number;
	heading: string;
	position: { start: { line: number } };
}

interface EmbedLike {
	link: string;
	position: { start: { line: number } };
}

type ItemKind = "heading" | "subtree" | "embed" | "close";

interface Item {
	line: number;
	kind: ItemKind;
	level: number;
	title: string;
	uri?: string;
	meta: NodeMeta;
	childCount: number;
	explicitlyUnnumbered: boolean;
	link?: string;
	fragment?: string;
	target?: TargetRange;
	unresolved?: boolean;
	conflict?: string;
}

/**
 * Count the subtrees a document's root owns, without building its whole tree.
 * Used for the implicit-unnumbered rule across a transclusion boundary.
 */
export function countRootChildren(app: App, file: TFile): number {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return 0;

	const headings = cache.headings ?? [];
	const body = headings.length > 0 && headings[0].level === 1 ? headings.slice(1) : headings;
	const topLevel = body.length > 0 ? Math.min(...body.map((h) => h.level)) : 0;

	let count = body.filter((h) => h.level === topLevel).length;

	// Embeds that sit above every heading are root-level subtrees too.
	const firstHeadingLine = body.length > 0 ? body[0].position.start.line : Infinity;
	for (const embed of cache.embeds ?? []) {
		if (embed.position.start.line < firstHeadingLine) count++;
	}
	return count;
}

export interface DocumentTree {
	root: ForesterNode;
	/** Line-indexed lookup for the reading-view post-processor. */
	byLine: Map<number, ForesterNode>;
	/** Subtrees that `<!-- subtree: ID -->` or `<!-- hN:ID -->` gave an address. */
	byId: Map<string, ForesterNode>;
}

/** Where a subtree begins and ends, read from the text and nothing else. */
export interface SubtreeSpan {
	/** Line of the heading or directive that opens it. */
	line: number;
	level: number;
	/** The name it was given, in whichever of the four spellings. */
	id?: string;
	/** A heading opened it, so it has somewhere of its own to carry an anchor. */
	titled: boolean;
	/** That heading's text, with the anchor taken off. */
	title?: string;
	/** Its body, `[start, end)` — the opener is not part of it. */
	start: number;
	end: number;
}

/**
 * Every subtree a note's text states, with its extent.
 *
 * Text only: no metadata cache, no vault. Minting has to run over a document
 * that is being written, where the cache is a step behind and the closing
 * directive may not have been typed yet.
 */
export function subtreeSpans(source: string): SubtreeSpan[] {
	const lines = source.split("\n");
	const spans: SubtreeSpan[] = [];
	const open: SubtreeSpan[] = [];

	const closeTo = (level: number, line: number): void => {
		while (open.length > 0 && open[open.length - 1].level >= level) {
			const span = open.pop();
			if (span) span.end = line;
		}
	};

	let fenced = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		if (CODE_FENCE.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		const close = line.match(CLOSE_SUBTREE);
		if (close) {
			closeTo(Number(close[1]), i);
			continue;
		}

		const untitled = line.match(OPEN_SUBTREE);
		if (untitled) {
			const level = Number(untitled[1]);
			closeTo(level, i);
			const span: SubtreeSpan = {
				line: i,
				level,
				id: untitled[2],
				titled: false,
				start: i + 1,
				end: lines.length,
			};
			spans.push(span);
			open.push(span);
			continue;
		}

		const heading = line.match(/^(#{1,6})[ \t]+(\S.*?)[ \t]*$/);
		if (!heading) continue;

		const level = heading[1].length;
		// A leading `#` is the root title, not a subtree.
		if (level === 1) {
			closeTo(2, i);
			continue;
		}
		closeTo(level, i);

		const anchor = heading[2].match(BLOCK_ANCHOR);
		const directive = directivesBefore(lines, i).uri;
		const span: SubtreeSpan = {
			line: i,
			level,
			id: directive ?? anchor?.[1],
			titled: true,
			title: anchor ? heading[2].replace(BLOCK_ANCHOR, "").trimEnd() : heading[2],
			start: i + 1,
			end: lines.length,
		};
		spans.push(span);
		open.push(span);
	}

	closeTo(2, lines.length);
	return spans;
}

/**
 * Headings and subtree directives, in source order. A `close` item is not a
 * tree; it only pops the level stack.
 */
function structureItems(headings: HeadingLike[], lines: string[] | undefined): Item[] {
	const items: Item[] = [];

	for (const heading of headings) {
		const line = heading.position.start.line;
		const directives = directivesBefore(lines, line);
		// `## Title ^id` names a titled subtree the same way `^id` names an
		// untitled one, so one spelling addresses both and `![[note#^id]]` reaches
		// either. The marker is Obsidian's, not part of the title.
		const anchor = (lines?.[line] ?? "").replace(/[ \t]+$/, "").match(BLOCK_ANCHOR);
		items.push({
			line,
			kind: "heading",
			level: heading.level,
			title: anchor ? heading.heading.replace(BLOCK_ANCHOR, "").trimEnd() : heading.heading,
			uri: directives.uri ?? anchor?.[1],
			// `<!-- subtree: ID -->`, `<!-- id: ID -->` and `## Heading ^ID` are
			// four ways of saying one thing; saying it twice is not one of them,
			// even when the two agree.
			conflict:
				directives.uri !== undefined && anchor
					? `${directives.uri} / ^${anchor[1]}`
					: undefined,
			meta: {},
			childCount: 0,
			explicitlyUnnumbered: directives.explicitlyUnnumbered,
		});
	}

	let fenced = false;
	for (let i = 0; lines !== undefined && i < lines.length; i++) {
		const line = lines[i];
		if (CODE_FENCE.test(line)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		const open = line.match(OPEN_SUBTREE);
		if (open) {
			items.push({
				line: i,
				kind: "subtree",
				level: Number(open[1]),
				title: "",
				uri: open[2],
				meta: {},
				childCount: 0,
				explicitlyUnnumbered: directivesBefore(lines, i).explicitlyUnnumbered,
			});
			continue;
		}

		const close = line.match(CLOSE_SUBTREE);
		if (close) {
			items.push({
				line: i,
				kind: "close",
				level: Number(close[1]),
				title: "",
				meta: {},
				childCount: 0,
				explicitlyUnnumbered: false,
			});
		}
	}

	return items;
}

/** Embeds, resolved against the notes they address. */
function embedItems(
	app: App,
	file: TFile,
	embeds: EmbedLike[],
	lines: string[] | undefined,
	forest: Forest,
): Item[] {
	const items: Item[] = [];

	for (const embed of embeds) {
		const line = embed.position.start.line;
		const hash = embed.link.indexOf("#");
		const linkPath = hash < 0 ? embed.link : embed.link.slice(0, hash);
		const fragment = hash < 0 ? "" : embed.link.slice(hash + 1);

		// `![[#^id]]` addresses this document.
		const target = linkPath.length === 0 ? file : forest.resolve(linkPath, file);
		// Image and PDF embeds are ordinary media, not transclusions.
		if (!target || target.extension !== "md") continue;

		const explicitlyUnnumbered = directivesBefore(lines, line).explicitlyUnnumbered;

		if (fragment.length === 0) {
			const targetCache = app.metadataCache.getFileCache(target);
			const targetHeadings = targetCache?.headings ?? [];
			const targetTitle =
				targetHeadings.length > 0 && targetHeadings[0].level === 1
					? targetHeadings[0].heading
					: fileStem(target);

			items.push({
				line,
				kind: "embed",
				level: 0, // resolved from the enclosing subtree in assemble()
				title: targetTitle,
				uri: forest.identityOf(target),
				meta: readMeta(targetCache?.frontmatter as Record<string, unknown> | undefined),
				childCount: countRootChildren(app, target),
				explicitlyUnnumbered,
				link: embed.link,
			});
			continue;
		}

		// A `#…` embed addresses a subtree, so it must not borrow the target
		// document's title, front matter or address the way a whole-tree
		// transclusion does.
		const source = forest.sourceOf(target);
		const node = resolveFragment(app, target, fragment, source, forest);
		if (!node) {
			items.push({
				line,
				kind: "embed",
				level: 0,
				title: "",
				meta: {},
				childCount: 0,
				explicitlyUnnumbered,
				link: embed.link,
				fragment,
				unresolved: true,
			});
			continue;
		}

		items.push({
			line,
			kind: "embed",
			level: 0,
			title: node.title,
			uri: node.uri,
			meta: {},
			childCount: node.children.length,
			explicitlyUnnumbered,
			link: embed.link,
			fragment,
			// Closing directives are invisible without the target's own text, so
			// the range would be a guess. Leave Obsidian's rendering in place
			// until the read lands.
			target:
				source === undefined
					? undefined
					: { path: target.path, start: node.startLine + 1, end: node.endLine },
		});
	}

	return items;
}

/**
 * Resolve `#^id` or `#Heading` against the target's outline.
 *
 * A block id is only accepted when the anchor it marks actually sits inside the
 * subtree of the same name. The two are different objects that merely share a
 * spelling — `^aside` names a block for Obsidian, `<!-- h2:aside -->` names a
 * subtree for tree-md — and an anchor placed anywhere else means the vault and
 * the compiled forest disagree about what is being transcluded.
 */
function resolveFragment(
	app: App,
	target: TFile,
	fragment: string,
	source: string | undefined,
	forest: Forest,
): ForesterNode | null {
	// `#Heading` names a section, and a section has no address unless the heading
	// was given one. Resolving it would make the title the address, which is the
	// brittleness identities exist to remove: retitle and every link breaks.
	if (!fragment.startsWith("^")) return null;

	const outline = buildOutline(app, target, source, forest);
	if (!outline) return null;

	{
		const id = fragment.slice(1);
		const node = outline.byId.get(id);
		if (!node) return null;

		// Read the anchor out of the text we already hold rather than out of the
		// metadata cache, which indexes block ids on its own schedule: a cache
		// that has not caught up yet is indistinguishable from a missing anchor.
		const anchor =
			anchorLine(source, id) ??
			app.metadataCache.getFileCache(target)?.blocks?.[id]?.position.start.line;
		if (anchor === undefined) return null;
		if (anchor < node.startLine || anchor >= node.endLine) return null;

		return node;
	}
}

/** The line carrying `^id`, which Obsidian only accepts at the end of a block. */
function anchorLine(source: string | undefined, id: string): number | undefined {
	if (source === undefined) return undefined;

	const marker = "^" + id;
	const lines = source.split("\n");

	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].replace(/[ \t]+$/, "");
		if (!line.endsWith(marker)) continue;
		const before = line.slice(0, line.length - marker.length);
		if (before.length === 0 || /[ \t]$/.test(before)) return i;
	}

	return undefined;
}

function documentRoot(
	file: TFile,
	frontmatter: Record<string, unknown> | undefined,
	headings: HeadingLike[],
	forest: Forest,
): ForesterNode {
	// A leading `#` is the root `\title`, exactly as tree-md treats it. The title
	// falls back to the file name; the address does not — that is the `id`.
	const hasTitle = headings.length > 0 && headings[0].level === 1;
	return emptyNode({
		kind: "root",
		level: 1,
		title: hasTitle ? headings[0].heading : fileStem(file),
		uri: forest.identityOf(file),
		meta: readMeta(frontmatter),
		line: hasTitle ? headings[0].position.start.line : -1,
		startLine: 0,
	});
}

/**
 * Walk the items with one level stack, the way tree-md builds its outline: a
 * heading or an opening directive at level N first closes everything at level N
 * or deeper, and `<!-- /hN -->` closes without opening anything.
 */
function assemble(root: ForesterNode, items: Item[], lastLine: number): DocumentTree {
	items.sort((a, b) => a.line - b.line);

	const stack: ForesterNode[] = [root];
	const byLine = new Map<number, ForesterNode>();
	const byId = new Map<string, ForesterNode>();

	const closeTo = (level: number, line: number): void => {
		while (stack.length > 1 && stack[stack.length - 1].level >= level) {
			const closed = stack.pop();
			if (closed) closed.endLine = line;
		}
	};

	for (const item of items) {
		if (item.kind === "close") {
			closeTo(item.level, item.line);
			continue;
		}
		if (item.kind !== "embed") closeTo(item.level, item.line);

		const parent = stack[stack.length - 1];
		const node = emptyNode({
			kind: item.kind,
			level: item.kind === "embed" ? parent.level + 1 : item.level,
			title: item.title,
			uri: item.uri,
			meta: item.meta,
			line: item.line,
			startLine: item.line,
			endLine: lastLine,
			childCount: item.childCount,
			explicitlyUnnumbered: item.explicitlyUnnumbered || parent.explicitlyUnnumbered,
			link: item.link,
			fragment: item.fragment,
			target: item.target,
			unresolved: item.unresolved,
			conflict: item.conflict,
		});

		parent.children.push(node);
		byLine.set(item.line, node);

		if (item.kind === "embed") {
			node.endLine = item.line + 1;
		} else {
			if (item.uri !== undefined) byId.set(item.uri, node);
			stack.push(node);
		}
	}

	closeTo(2, lastLine);
	root.endLine = lastLine;

	assignNumbers(root);
	return { root, byLine, byId };
}

/**
 * Structure only — headings and directives, never embeds. That is what makes it
 * safe to call while resolving a `#…` embed, which would otherwise be able to
 * cycle back to the document it started from.
 */
export function buildOutline(
	app: App,
	file: TFile,
	text?: string,
	forest: Forest = metadataForest(app),
): DocumentTree | null {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return null;

	const lines = text?.split("\n");
	const headings = (cache.headings ?? []) as HeadingLike[];
	const hasTitle = headings.length > 0 && headings[0].level === 1;
	const root = documentRoot(
		file,
		cache.frontmatter as Record<string, unknown> | undefined,
		headings,
		forest,
	);

	return assemble(
		root,
		structureItems(hasTitle ? headings.slice(1) : headings, lines),
		endOfFile(lines),
	);
}

/**
 * Build the Forester tree for `file`. `text` is the raw document when
 * available; it is needed to read every HTML-comment directive, since the
 * metadata cache drops comments. `sourceOf` supplies the same for the notes
 * this one transcludes a subtree of.
 */
export function buildDocumentTree(
	app: App,
	file: TFile,
	text?: string,
	forest: Forest = metadataForest(app),
): DocumentTree | null {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return null;

	const lines = text?.split("\n");
	const headings = (cache.headings ?? []) as HeadingLike[];
	const hasTitle = headings.length > 0 && headings[0].level === 1;
	const root = documentRoot(
		file,
		cache.frontmatter as Record<string, unknown> | undefined,
		headings,
		forest,
	);

	const items = structureItems(hasTitle ? headings.slice(1) : headings, lines);
	items.push(...embedItems(app, file, cache.embeds ?? [], lines, forest));

	return assemble(root, items, endOfFile(lines));
}

/** Ranges are only meaningful when the text was there to measure them against. */
function endOfFile(lines: string[] | undefined): number {
	return lines?.length ?? Number.MAX_SAFE_INTEGER;
}

/**
 * Port of `tree.xsl` mode="tree-taxon-with-number".
 *
 *   implicitly-unnumbered = count(../f:tree) = 1 and not(count(f:mainmatter/f:tree) > 1)
 *   should-number         = not(in-backmatter) and not(root) and not(explicit) and not(implicit)
 *
 * The dotted path itself comes from `xsl:number level="multiple"`, which counts
 * *every* sibling tree — including ones the implicit rule leaves unnumbered.
 * So a node can carry the path `1.2` while its parent prints no number at all.
 */
function assignNumbers(root: ForesterNode): void {
	const walk = (node: ForesterNode, prefix: string[]): void => {
		const siblings = node.children.filter((c) => !c.explicitlyUnnumbered);

		siblings.forEach((child, i) => {
			const path = [...prefix, String(i + 1)];
			child.index = i + 1;
			child.localPath = path.join(".");

			const ownChildren = Math.max(child.children.length, child.childCount);
			const implicitlyUnnumbered = node.children.length === 1 && !(ownChildren > 1);

			child.shouldNumber = !child.explicitlyUnnumbered && !implicitlyUnnumbered;
			walk(child, path);
		});
	};
	walk(root, []);
}

/**
 * Port of the `f:taxon` + number prefix emitted into every `<h1>`, including
 * the non-breaking spaces. Produces e.g. `Note\u00a01.2.\u00a0`.
 */
export function taxonWithNumber(taxon: string | undefined, numberPath: string): string {
	const t = taxon ?? "";
	let out = "";

	if (t.length > 0) {
		out += t;
		if (numberPath.length > 0) out += " ";
	}
	out += numberPath;
	if (t.length > 0 || numberPath.length > 0) out += ". ";

	return out;
}

const MONTHS = [
	"January", "February", "March", "April", "May", "June",
	"July", "August", "September", "October", "November", "December",
];

/** Port of `metadata.xsl` mode="date-inner": `August\u00a04,\u00a02026`. */
export function formatDate(raw: string): string {
	const match = raw.match(/^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/);
	if (!match) return raw;

	const [, year, month, day] = match;
	let out = "";
	if (month) {
		const name = MONTHS[Number(month) - 1];
		if (name) out += name;
	}
	if (day) out += " " + String(Number(day));
	if (month) out += ", ";
	out += year;

	return out;
}
