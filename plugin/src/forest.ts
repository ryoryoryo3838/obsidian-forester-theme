/**
 * A faithful port of the tree model that `site/theme/tree.xsl` walks over.
 *
 * Forester renders one page as a single root `f:tree` whose `f:mainmatter`
 * holds nested `f:tree` elements. `tree-md` produces exactly that shape from
 * Markdown: the leading `#` becomes the root `\title`, every `##`..`######`
 * becomes a nested `\subtree`, and a standalone `![[id]]` becomes a
 * `\transclude{id}` which splices the target tree in as a sibling subtree.
 *
 * This module rebuilds the same tree from Obsidian's metadata cache so that
 * taxon prefixes and `1.1`-style numbers agree with the published site.
 */

import type { App, TFile } from "obsidian";

export type NodeKind = "root" | "heading" | "embed";

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

export interface ForesterNode {
	kind: NodeKind;
	/** Markdown heading level; 1 for the root, 0 for embeds (depth comes from the parent). */
	level: number;
	title: string;
	/** Forester `display-uri`; only addressable trees get a `[slug]`. */
	uri?: string;
	meta: NodeMeta;
	/** Zero-based source line of the heading or embed. */
	line: number;
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
}

/** `foo.tree.md` and `foo.md` both address the tree `foo`. */
export function treeIdOf(file: TFile): string {
	return file.basename.replace(/\.tree$/, "");
}

function emptyNode(partial: Partial<ForesterNode>): ForesterNode {
	return {
		kind: "heading",
		level: 2,
		title: "",
		meta: {},
		line: 0,
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
const SUBTREE_DIRECTIVE = /^<!--\s*subtree:\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*-->\s*$/;
const NUMBERED_DIRECTIVE = /^<!--\s*forester:\s*numbered\s*=\s*false\s*-->\s*$/;

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

interface Item {
	line: number;
	kind: "heading" | "embed";
	level: number;
	title: string;
	uri?: string;
	meta: NodeMeta;
	childCount: number;
	explicitlyUnnumbered: boolean;
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
}

/**
 * Build the Forester tree for `file`. `text` is the raw document when
 * available; it is only needed to read `<!-- subtree: ID -->` directives.
 */
export function buildDocumentTree(app: App, file: TFile, text?: string): DocumentTree | null {
	const cache = app.metadataCache.getFileCache(file);
	if (!cache) return null;

	const lines = text?.split("\n");
	const headings = cache.headings ?? [];
	const embeds = cache.embeds ?? [];

	// A leading `#` is the root `\title`, exactly as tree-md treats it.
	const hasTitleHeading = headings.length > 0 && headings[0].level === 1;
	const titleHeading = hasTitleHeading ? headings[0] : undefined;
	const bodyHeadings = hasTitleHeading ? headings.slice(1) : headings;

	const root = emptyNode({
		kind: "root",
		level: 1,
		title: titleHeading?.heading ?? treeIdOf(file),
		uri: treeIdOf(file),
		meta: readMeta(cache.frontmatter as Record<string, unknown> | undefined),
		line: titleHeading?.position.start.line ?? -1,
	});

	const items: Item[] = [];

	for (const heading of bodyHeadings) {
		const line = heading.position.start.line;
		const directives = directivesBefore(lines, line);
		items.push({
			line,
			kind: "heading",
			level: heading.level,
			title: heading.heading,
			uri: directives.uri,
			meta: {},
			childCount: 0,
			explicitlyUnnumbered: directives.explicitlyUnnumbered,
		});
	}

	for (const embed of embeds) {
		const line = embed.position.start.line;
		const target = app.metadataCache.getFirstLinkpathDest(
			embed.link.split("#")[0],
			file.path,
		);
		// Image and PDF embeds are ordinary media, not transclusions.
		if (!target || target.extension !== "md") continue;

		const targetCache = app.metadataCache.getFileCache(target);
		const targetHeadings = targetCache?.headings ?? [];
		const targetTitle =
			targetHeadings.length > 0 && targetHeadings[0].level === 1
				? targetHeadings[0].heading
				: treeIdOf(target);

		items.push({
			line,
			kind: "embed",
			level: 0, // resolved from the enclosing heading below
			title: targetTitle,
			uri: treeIdOf(target),
			meta: readMeta(targetCache?.frontmatter as Record<string, unknown> | undefined),
			childCount: countRootChildren(app, target),
			explicitlyUnnumbered: directivesBefore(lines, line).explicitlyUnnumbered,
		});
	}

	items.sort((a, b) => a.line - b.line);

	// Stack-based nesting by heading level; embeds attach to the open heading.
	const stack: ForesterNode[] = [root];
	const byLine = new Map<number, ForesterNode>();

	for (const item of items) {
		if (item.kind === "heading") {
			while (stack.length > 1 && stack[stack.length - 1].level >= item.level) stack.pop();
		}
		const parent = stack[stack.length - 1];
		const node = emptyNode({
			kind: item.kind,
			level: item.kind === "heading" ? item.level : parent.level + 1,
			title: item.title,
			uri: item.uri,
			meta: item.meta,
			line: item.line,
			childCount: item.childCount,
			explicitlyUnnumbered: item.explicitlyUnnumbered || parent.explicitlyUnnumbered,
		});
		parent.children.push(node);
		byLine.set(item.line, node);
		if (item.kind === "heading") stack.push(node);
	}

	assignNumbers(root);
	return { root, byLine };
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
		if (numberPath.length > 0) out += "\u00a0";
	}
	out += numberPath;
	if (t.length > 0 || numberPath.length > 0) out += ".\u00a0";

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
	if (day) out += "\u00a0" + String(Number(day));
	if (month) out += ",\u00a0";
	out += year;

	return out;
}
