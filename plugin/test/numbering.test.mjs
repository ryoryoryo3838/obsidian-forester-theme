/**
 * Checks the numbering port in src/forest.ts against the rules in
 * site/theme/tree.xsl. Run with `npm test` (bundles forest.ts first).
 */

import assert from "node:assert/strict";
import {
	buildDocumentTree,
	subtreeSpans,
	identityOf,
	fileStem,
	taxonWithNumber,
	formatDate,
} from "./build/forest.mjs";

const NBSP = String.fromCharCode(160);

/** Minimal stand-in for the pieces of the Obsidian API forest.ts touches. */
function makeApp(docs) {
	const files = new Map();
	for (const [name, doc] of Object.entries(docs)) {
		files.set(name, {
			path: `${name}.md`,
			basename: name,
			extension: "md",
			doc,
		});
	}

	const cacheOf = (file) => ({
		frontmatter: file.doc.frontmatter,
		headings: (file.doc.headings ?? []).map(([level, heading, line]) => ({
			level,
			heading,
			position: { start: { line }, end: { line } },
		})),
		embeds: (file.doc.embeds ?? []).map(([link, line]) => ({
			link,
			position: { start: { line }, end: { line } },
		})),
		blocks: Object.fromEntries(
			Object.entries(file.doc.blocks ?? {}).map(([id, line]) => [
				id,
				{ position: { start: { line }, end: { line } } },
			]),
		),
	});

	const app = {
		metadataCache: {
			getFileCache: (file) => cacheOf(file),
			getFirstLinkpathDest: (link) => files.get(link) ?? null,
		},
	};

	return {
		app,
		file: (name) => files.get(name),
		/**
		 * What the plugin hands to buildDocumentTree: the vault-wide knowledge a
		 * single document's metadata cache cannot supply.
		 */
		forest: {
			sourceOf: (file) => file.doc.text,
			identityOf: (file) => identityOf(app, file),
			// The ladder: identity, identity without `.tree`, file name, file name
			// without `.tree`.
			resolve: (target) => {
				const bare = target.replace(/\.tree$/, "");
				const byIdentity = [...files.values()].find(
					(f) => identityOf(app, f) === target || identityOf(app, f) === bare,
				);
				return byIdentity ?? files.get(target) ?? files.get(bare) ?? null;
			},
		},
	};
}

/**
 * A document written as real Markdown, indexed the way Obsidian's metadata
 * cache would index it — headings, standalone embeds and `^id` anchors. HTML
 * comments are deliberately absent, because the cache drops them.
 */
function doc(lines, frontmatter) {
	const headings = [];
	const embeds = [];
	const blocks = {};

	lines.forEach((line, i) => {
		const heading = line.match(/^(#{1,6})\s+(.*?)\s*$/);
		if (heading) headings.push([heading[1].length, heading[2], i]);

		const embed = line.match(/^!\[\[([^\]]+)\]\]\s*$/);
		if (embed) embeds.push([embed[1], i]);

		const block = line.match(/\s\^([A-Za-z0-9][A-Za-z0-9._-]*)\s*$/);
		if (block) blocks[block[1]] = i;
	});

	return { text: lines.join("\n"), frontmatter, headings, embeds, blocks };
}

/** Mirrors site/contents: index transcludes aboutme, research and test. */
const forest = makeApp({
	index: {
		headings: [[1, "HOME", 0]],
		embeds: [
			["aboutme", 4],
			["research", 6],
			["test", 8],
		],
	},
	aboutme: {
		frontmatter: { taxon: "Person", date: "2026-08-02", authors: ["[[清宮亮太郎]]"] },
		headings: [[1, "清宮亮太郎", 11]],
		embeds: [["research-interest", 21]],
	},
	research: {
		frontmatter: { taxon: "Research" },
		headings: [
			[1, "研究", 4],
			[2, "卒業研究", 11],
		],
		embeds: [["research-interest", 8]],
	},
	"research-interest": {
		headings: [[1, "関心", 0]],
	},
	test: {
		frontmatter: { taxon: "Diary", date: "2026-08-04" },
		headings: [
			[1, "Test article derived from md", 7],
			[2, "Section 1", 11],
		],
		embeds: [["aboutme", 13]],
	},
});

const flatten = (node, out = []) => {
	for (const child of node.children) {
		out.push(child);
		flatten(child, out);
	}
	return out;
};

let failures = 0;
const check = (name, fn) => {
	try {
		fn();
		console.log(`ok   ${name}`);
	} catch (error) {
		failures++;
		console.log(`FAIL ${name}\n     ${error.message}`);
	}
};

check("root title comes from the leading H1", () => {
	const tree = buildDocumentTree(forest.app, forest.file("index"));
	assert.equal(tree.root.title, "HOME");
	assert.equal(tree.root.uri, "index");
});

check("three sibling transclusions are numbered 1, 2, 3", () => {
	const tree = buildDocumentTree(forest.app, forest.file("index"));
	const kids = tree.root.children;
	assert.deepEqual(
		kids.map((k) => [k.uri, k.localPath, k.shouldNumber]),
		[
			["aboutme", "1", true],
			["research", "2", true],
			["test", "3", true],
		],
	);
});

check("transcluded titles and taxa come from the target's front matter", () => {
	const tree = buildDocumentTree(forest.app, forest.file("index"));
	const aboutme = tree.root.children[0];
	assert.equal(aboutme.title, "清宮亮太郎");
	assert.equal(aboutme.meta.taxon, "Person");
	assert.deepEqual(aboutme.meta.authors, ["清宮亮太郎"]);
});

check("a lone subtree with a lone child is implicitly unnumbered", () => {
	// tree.xsl: implicitly-unnumbered =
	//   count(../f:tree) = 1 and not(count(f:mainmatter/f:tree) > 1)
	const tree = buildDocumentTree(forest.app, forest.file("test"));
	const section = tree.root.children[0];
	assert.equal(section.title, "Section 1");
	assert.equal(section.localPath, "1", "still carries a path");
	assert.equal(section.shouldNumber, false, "but prints no number");
});

check("a heading and a transclusion share one numbering sequence", () => {
	const tree = buildDocumentTree(forest.app, forest.file("research"));
	assert.deepEqual(
		tree.root.children.map((k) => [k.kind, k.localPath, k.shouldNumber]),
		[
			["embed", "1", true],
			["heading", "2", true],
		],
	);
});

check("<!-- subtree: ID --> gives a heading its address", () => {
	const text = [
		"---",
		"taxon: Research",
		"---",
		"",
		"# 研究",
		"",
		"body",
		"",
		"![[research-interest]]",
		"",
		"<!-- subtree: grad-researh -->",
		"## 卒業研究",
	].join("\n");
	const tree = buildDocumentTree(forest.app, forest.file("research"), text);
	const heading = flatten(tree.root).find((n) => n.kind === "heading");
	assert.equal(heading.uri, "grad-researh");
});

check("taxonWithNumber reproduces the XSL spacing", () => {
	assert.equal(taxonWithNumber("Note", "1.2"), `Note${NBSP}1.2.${NBSP}`);
	assert.equal(taxonWithNumber("Note", ""), `Note.${NBSP}`);
	assert.equal(taxonWithNumber(undefined, "1.2"), `1.2.${NBSP}`);
	assert.equal(taxonWithNumber(undefined, ""), "");
});

check("formatDate reproduces metadata.xsl date-inner", () => {
	assert.equal(formatDate("2026-08-04"), `August${NBSP}4,${NBSP}2026`);
	assert.equal(formatDate("2026-08"), `August,${NBSP}2026`);
	assert.equal(formatDate("2026"), "2026");
});

check("promoted top-level meta keys read the same as meta: entries", () => {
	const forest = makeApp({
		profile: {
			frontmatter: {
				taxon: "Person",
				authors: ["[[miya]]"],
				contributors: ["Ada Lovelace"],
				institution: "[Tsukuba](https://example.test/)",
				orcid: "0009-0000-4771-5212",
				meta: { external: "https://example.test/" },
			},
			headings: [[1, "miya", 0]],
		},
	});
	const tree = buildDocumentTree(forest.app, forest.file("profile"));

	// Emitted in tree.xsl's order, not the order they were written.
	assert.deepEqual(tree.root.meta.extra, [
		{ name: "institution", value: "[Tsukuba](https://example.test/)" },
		{ name: "orcid", value: "0009-0000-4771-5212" },
		{ name: "external", value: "https://example.test/" },
	]);
	assert.deepEqual(tree.root.meta.authors, ["miya"]);
	assert.deepEqual(tree.root.meta.contributors, ["Ada Lovelace"]);
});

check("author: false suppresses the byline", () => {
	const forest = makeApp({
		quiet: {
			frontmatter: { authors: ["[[miya]]"], author: false },
			headings: [[1, "quiet", 0]],
		},
	});
	const tree = buildDocumentTree(forest.app, forest.file("quiet"));
	assert.equal(tree.root.meta.hideAuthors, true);
	assert.deepEqual(tree.root.meta.authors, ["miya"], "still parsed, just not shown");
});

// ── subtree directives ──────────────────────────────────────────────────────

const FENCE = "```";

/** The worked example from tree-md's README, plus a host that transcludes it. */
const directives = makeApp({
	home: doc(["# HOME", "", "![[notes#^aside]]"]),
	notes: doc([
		"# Notes", //                    0
		"", //                           1
		"Intro.", //                     2
		"", //                           3
		"<!-- h2:aside -->", //          4
		"", //                           5
		"An untitled subtree. ^aside", // 6
		"", //                           7
		"<!-- h3 -->", //                8
		"", //                           9
		"Deeper.", //                    10
		"", //                           11
		"<!-- /h2 -->", //               12
		"", //                           13
		"Back in the root body.", //     14
	]),
});

const treeOf = (forest, name) =>
	buildDocumentTree(
		forest.app,
		forest.file(name),
		forest.file(name).doc.text,
		forest.forest,
	);

check("<!-- hN:ID --> opens an addressable subtree with no title", () => {
	const tree = treeOf(directives, "notes");
	const aside = tree.root.children[0];
	assert.equal(aside.kind, "subtree");
	assert.equal(aside.title, "");
	assert.equal(aside.uri, "aside");
	assert.equal(tree.byId.get("aside"), aside);
});

check("<!-- /hN --> ends the range, so the parent's body is outside it", () => {
	const tree = treeOf(directives, "notes");
	const aside = tree.root.children[0];
	// Opens on 4, closes on 12: "Back in the root body." is the root's.
	assert.deepEqual([aside.startLine, aside.endLine], [4, 12]);
	assert.deepEqual(
		aside.children.map((c) => [c.kind, c.startLine, c.endLine]),
		[["subtree", 8, 12]],
		"the nested <!-- h3 --> closes with its parent",
	);
	assert.equal(tree.root.children.length, 1, "nothing reopens after the close");
});

check("![[note#^id]] transcludes the whole subtree, not the anchored block", () => {
	const tree = treeOf(directives, "home");
	const [embed] = tree.root.children;
	assert.equal(embed.kind, "embed");
	assert.equal(embed.fragment, "^aside");
	// Obsidian would show line 6 alone; the range is the subtree's body.
	assert.deepEqual(embed.target, { path: "notes.md", start: 5, end: 12 });
});

check("a subtree transclusion borrows neither title nor address", () => {
	const tree = treeOf(directives, "home");
	const [embed] = tree.root.children;
	assert.equal(embed.title, "", "the subtree is untitled; 'Notes' is the note's");
	assert.equal(embed.uri, "aside", "not 'notes'");
});

check("a ^id anchor outside the subtree it names does not resolve", () => {
	const stray = makeApp({
		home: doc(["# HOME", "", "![[notes#^aside]]"]),
		notes: doc([
			"# Notes", //           0
			"", //                  1
			"<!-- h2:aside -->", // 2
			"", //                  3
			"Inside.", //           4
			"", //                  5
			"<!-- /h2 -->", //      6
			"", //                  7
			"Outside. ^aside", //   8
		]),
	});
	const [embed] = treeOf(stray, "home").root.children;
	assert.equal(embed.unresolved, true);
	assert.equal(embed.target, undefined);
});

check("a #heading fragment is not an address, so it does not resolve", () => {
	// A section has no Forester address unless its heading was given one, and
	// making the title the address is the brittleness identities remove: retitle
	// the section and every reference to it breaks.
	const sections = makeApp({
		home: doc(["# HOME", "", "![[early#Section]]"]),
		early: doc(["# Early", "", "## Section", "", "Body."]),
	});
	const [embed] = treeOf(sections, "home").root.children;
	assert.equal(embed.unresolved, true);
	assert.equal(embed.target, undefined);
});

check("directives inside a code fence are text", () => {
	const fenced = makeApp({
		fence: doc([
			"# Fence", //            0
			"", //                   1
			FENCE, //                2
			"<!-- h2:nope -->", //   3
			FENCE, //                4
			"", //                   5
			"<!-- h2:real -->", //   6
			"", //                   7
			"Body.", //              8
		]),
	});
	const tree = treeOf(fenced, "fence");
	assert.equal(tree.byId.has("nope"), false);
	assert.equal(tree.byId.has("real"), true);
});

check("front matter `id` is the address, and the file name only the search key", () => {
	const named = makeApp({
		home: doc(["# HOME", "", "![[information-concept]]"]),
		"information-concept": doc(["# 情報概念", "", "Body."], { id: "mlnet-7" }),
	});

	const home = treeOf(named, "home");
	assert.equal(home.root.uri, "home", "no id stated, so the file name stands");

	const [embed] = home.root.children;
	assert.equal(embed.uri, "mlnet-7", "addressed by identity, not by file name");
	assert.equal(embed.title, "情報概念", "the title is still the title");

	assert.equal(treeOf(named, "information-concept").root.uri, "mlnet-7");
});

check("<!-- id: ID --> names a heading, and naming it twice is a conflict", () => {
	const named = makeApp({
		notes: doc([
			"# Notes", //          0
			"", //                 1
			"<!-- id: sec -->", // 2
			"## Heading", //       3
			"", //                 4
			"Body.", //            5
		]),
		twice: doc([
			"# Notes", //              0
			"", //                     1
			"<!-- subtree: sec -->", // 2
			"## Heading ^sec", //      3
		]),
	});

	const [section] = treeOf(named, "notes").root.children;
	assert.equal(section.uri, "sec", "`id:` is a synonym for `subtree:`");

	const [conflicted] = treeOf(named, "twice").root.children;
	assert.equal(conflicted.conflict, "sec / ^sec", "named two ways, which tree-md rejects");
});

check("`## Title ^id` names a titled subtree, and the marker is not the title", () => {
	const anchored = makeApp({
		home: doc(["# HOME", "", "![[notes#^grad]]"]),
		notes: doc([
			"# Notes", //          0
			"", //                 1
			"## 卒業研究 ^grad", // 2
			"", //                 3
			"Body.", //            4
		]),
	});
	const tree = treeOf(anchored, "notes");
	const section = tree.root.children[0];
	assert.equal(section.kind, "heading");
	assert.equal(section.title, "卒業研究", "the anchor is Obsidian's, not the title");
	assert.equal(section.uri, "grad");

	const [embed] = treeOf(anchored, "home").root.children;
	assert.equal(embed.title, "卒業研究");
	assert.deepEqual(embed.target, { path: "notes.md", start: 3, end: 5 });
});

check("a directive-opened subtree numbers as a sibling of the headings", () => {
	const mixed = makeApp({
		mix: doc([
			"# Mix", //              0
			"", //                   1
			"## First", //           2
			"", //                   3
			"<!-- h2:second -->", // 4
			"", //                   5
			"Body.", //              6
			"", //                   7
			"## Third", //           8
		]),
	});
	const tree = treeOf(mixed, "mix");
	assert.deepEqual(
		tree.root.children.map((c) => [c.kind, c.localPath, c.shouldNumber]),
		[
			["heading", "1", true],
			["subtree", "2", true],
			["heading", "3", true],
		],
	);
});

check("without the target's text the range is left unguessed", () => {
	// The plugin has not read `notes` yet: the subtree still resolves through
	// the heading index, but the closers are invisible, so nothing is spliced.
	const tree = buildDocumentTree(
		directives.app,
		directives.file("home"),
		directives.file("home").doc.text,
	);
	const [embed] = tree.root.children;
	assert.equal(embed.unresolved, true, "a ^id needs the text to be placed at all");
	assert.equal(embed.target, undefined);
});

check("subtreeSpans reads extents from the text alone", () => {
	const spans = subtreeSpans(
		[
			"# Root", //           0
			"", //                 1
			"<!-- h2:aside -->", // 2
			"", //                 3
			"Body. ^aside", //     4
			"", //                 5
			"<!-- h3 -->", //      6
			"", //                 7
			"Deeper.", //          8
			"", //                 9
			"<!-- /h2 -->", //     10
			"", //                 11
			"## Section ^sec", //  12
			"", //                 13
			"More.", //            14
		].join("\n"),
	);

	assert.deepEqual(
		spans.map((s) => [s.id ?? null, s.titled, s.start, s.end]),
		[
			["aside", false, 3, 10],
			[null, false, 7, 10],
			["sec", true, 13, 15],
		],
	);
});

check("a subtree still open at the end of the file runs to the end", () => {
	// Saving mid-edit is the normal case: the closing directive may not be typed
	// yet, and the address minted before it is written stays correct when it is.
	const spans = subtreeSpans(["# Root", "", "<!-- h2:aside -->", "", "Body."].join("\n"));
	assert.deepEqual(spans.map((s) => [s.id, s.start, s.end]), [["aside", 3, 5]]);
});

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
