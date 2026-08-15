/**
 * Checks the numbering port in src/forest.ts against the rules in
 * site/theme/tree.xsl. Run with `npm test` (bundles forest.ts first).
 */

import assert from "node:assert/strict";
import { buildDocumentTree, taxonWithNumber, formatDate } from "./build/forest.mjs";

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
	});

	return {
		app: {
			metadataCache: {
				getFileCache: (file) => cacheOf(file),
				getFirstLinkpathDest: (link) => files.get(link) ?? null,
			},
		},
		file: (name) => files.get(name),
	};
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

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall checks passed");
