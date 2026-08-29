/**
 * The passes a save runs over a note's text. They rewrite the user's files, so
 * each one is checked for what it does *and* for what it must not do: never
 * move an address, never duplicate an anchor, never touch a code fence.
 */

import assert from "node:assert/strict";

import {
	anchorNamedSubtrees,
	anchorHeading,
	checkDirectives,
	headingRefs,
	fulfilRequests,
	preferHeadingAnchors,
	retargetHeadingRefs,
} from "./build/mint.mjs";

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

/** A draw that hands out predictable addresses, so the result can be asserted. */
const counter = () => {
	let n = 0;
	return () => `000${n++}`;
};

const FENCE = "```";

check("<!-- hN --> is a request, and is answered in place", () => {
	const lines = ["# Root", "", "<!-- h2 -->", "", "Body."];
	assert.equal(fulfilRequests(lines, counter()), 1);
	assert.deepEqual(lines, ["# Root", "", "<!-- h2:0000 -->", "", "Body."]);
});

check("<!-- id --> is a request too, and a named subtree is not", () => {
	const lines = [
		"<!-- id -->", //         0
		"## Heading", //          1
		"", //                    2
		"<!-- h2:written -->", // 3
		"", //                    4
		"<!-- h3 -->", //         5
	];
	assert.equal(fulfilRequests(lines, counter()), 2);
	assert.equal(lines[0], "<!-- id: 0000 -->");
	assert.equal(lines[3], "<!-- h2:written -->", "an address that is written is never minted over");
	assert.equal(lines[5], "<!-- h3:0001 -->");
});

check("a request inside a code fence is text", () => {
	const lines = ["# Root", "", FENCE, "<!-- h2 -->", FENCE, "", "<!-- h2 -->"];
	assert.equal(fulfilRequests(lines, counter()), 1);
	assert.equal(lines[3], "<!-- h2 -->", "untouched inside the fence");
	assert.equal(lines[6], "<!-- h2:0000 -->");
});

check("a named untitled subtree gets an anchor on the first block of its body", () => {
	const lines = ["# Root", "", "<!-- h2:aside -->", "", "Body.", "", "More."];
	assert.equal(anchorNamedSubtrees(lines), 1);
	assert.equal(lines[4], "Body. ^aside");
	assert.equal(lines[6], "More.", "only the first block carries it");
});

check("minting before the body exists settles on a later save", () => {
	// Saving mid-edit is the normal case: the address is minted, there is nothing
	// to anchor yet, and the anchor lands as soon as a block appears.
	const lines = ["# Root", "", "<!-- h2:aside -->", ""];
	assert.equal(anchorNamedSubtrees(lines), 0, "nothing to anchor yet");

	lines.push("Body written later.");
	assert.equal(anchorNamedSubtrees(lines), 1);
	assert.equal(lines[4], "Body written later. ^aside");

	assert.equal(anchorNamedSubtrees(lines), 0, "and it is idempotent");
});

check("an anchor is never duplicated, even when it sits outside its subtree", () => {
	// A `<!-- /h2 -->` inserted above the anchored block leaves the anchor
	// outside. Adding a second one would give Obsidian two blocks with one id,
	// which is worse than an address it cannot reach.
	const lines = [
		"# Root", //             0
		"", //                   1
		"<!-- h2:aside -->", //  2
		"", //                   3
		"<!-- /h2 -->", //       4
		"", //                   5
		"Outside. ^aside", //    6
	];
	assert.equal(anchorNamedSubtrees(lines), 0);
	assert.deepEqual(lines[6], "Outside. ^aside");
});

check("a titled subtree is left alone: its heading carries its own anchor", () => {
	const lines = ["# Root", "", "## Section ^sec", "", "Body."];
	assert.equal(anchorNamedSubtrees(lines), 0);
	assert.equal(lines[4], "Body.");
});

check("#Heading references are rewritten to the address the heading carries", () => {
	const addresses = { "research.tree|研究関心": "research-interest" };
	const addressOf = (path, heading) => {
		const id = addresses[`${path}|${heading}`];
		return id === undefined ? null : `${path}#^${id}`;
	};

	const lines = [
		"![[research.tree#研究関心]]",
		"[[research.tree#研究関心|その話]]",
		"[[research.tree#不明]]",
		"![[research.tree#^research-interest]]",
		"![[research.tree]]",
	];

	assert.equal(retargetHeadingRefs(lines, addressOf), 2);
	assert.deepEqual(lines, [
		"![[research.tree#^research-interest]]",
		"[[research.tree#^research-interest|その話]]",
		"[[research.tree#不明]]",
		"![[research.tree#^research-interest]]",
		"![[research.tree]]",
	]);
});

check("a reference to a note's `#` title is the note itself", () => {
	// The `#` heading is the root \title — the tree, not a section of it — so the
	// long way round is simply written the short way.
	const lines = [
		"![[research.tree#研究]]",
		"[[research.tree#研究|あの木]]",
		"![[research.tree#研究関心]]",
	];

	const retarget = (path, heading) => {
		if (heading === "研究") return path; // the root title
		if (heading === "研究関心") return `${path}#^0002`;
		return null;
	};

	assert.equal(retargetHeadingRefs(lines, retarget), 3);
	assert.deepEqual(lines, [
		"![[research.tree]]",
		"[[research.tree|あの木]]",
		"![[research.tree#^0002]]",
	]);
});

check("a nested heading path is addressed by its last segment", () => {
	const lines = ["![[notes#Outer#Inner]]"];
	assert.equal(
		retargetHeadingRefs(lines, (path, heading) =>
			heading === "Inner" ? `${path}#^0073` : null,
		),
		1,
	);
	assert.equal(lines[0], "![[notes#^0073]]");
});

check("a reference inside a code fence is left as written", () => {
	const lines = [FENCE, "![[notes#Section]]", FENCE, "![[notes#Section]]"];
	assert.equal(retargetHeadingRefs(lines, (path) => `${path}#^0073`), 1);
	assert.equal(lines[1], "![[notes#Section]]");
	assert.equal(lines[3], "![[notes#^0073]]");
});

check("a heading's name is moved onto the heading, which is what Obsidian can address", () => {
	const lines = [
		"# 研究", //             0
		"", //                   1
		"<!-- id: 0000 -->", //  2
		"## 研究関心", //         3
		"", //                   4
		"- body", //             5
	];
	assert.equal(preferHeadingAnchors(lines, counter()), 1);
	assert.deepEqual(lines, ["# 研究", "", "## 研究関心 ^0000", "", "- body"]);
});

check("<!-- subtree: X --> is moved the same way, across blank lines", () => {
	const lines = ["<!-- subtree: sec -->", "", "## Heading", "", "Body."];
	assert.equal(preferHeadingAnchors(lines, counter()), 1);
	assert.deepEqual(lines, ["## Heading ^sec", "", "Body."]);
});

check("a bare <!-- id --> above a heading is answered on the heading", () => {
	const lines = ["<!-- id -->", "## Heading"];
	assert.equal(preferHeadingAnchors(lines, counter()), 1);
	assert.deepEqual(lines, ["## Heading ^0000"]);
});

check("a directive duplicating the anchor already there is simply dropped", () => {
	const lines = ["<!-- id: sec -->", "## Heading ^sec", "", "Body."];
	assert.equal(preferHeadingAnchors(lines, counter()), 1);
	assert.deepEqual(lines, ["## Heading ^sec", "", "Body."]);
});

check("a directive naming a heading differently is left for the author", () => {
	const lines = ["<!-- id: one -->", "## Heading ^two"];
	assert.equal(preferHeadingAnchors(lines, counter()), 0, "named twice, and differently");
	assert.deepEqual(lines, ["<!-- id: one -->", "## Heading ^two"]);
});

check("an orphan directive is left alone and reported", () => {
	const lines = ["<!-- id: 0002 -->", "A paragraph, not a heading."];
	assert.equal(preferHeadingAnchors(lines, counter()), 0);
	assert.deepEqual(checkDirectives(lines), [
		"line 1: <!-- id: … --> is not followed by a heading",
	]);
});

check("<!-- /id --> is reported: a subtree is closed by <!-- /hN -->", () => {
	// Written by hand as the partner of `<!-- id -->`, which is the mistake the
	// grammar invites: `id` names a heading, and only `hN` opens and closes.
	const lines = ["<!-- /id -->", "<!-- /subtree -->", "<!-- /h2 -->"];
	assert.deepEqual(checkDirectives(lines), [
		"line 1: <!-- /id --> does not close anything — a subtree is closed by <!-- /hN -->",
		"line 2: <!-- /subtree --> does not close anything — a subtree is closed by <!-- /hN -->",
	]);
});

check("a level tree-md refuses is reported", () => {
	assert.deepEqual(checkDirectives(["<!-- H3 -->", "<!-- h7 -->", "<!-- h1 -->"]), [
		"line 1: write the level in lowercase, h2 to h6",
		"line 2: subtree levels are h2 to h6 (found h7)",
		"line 3: subtree levels are h2 to h6 (found h1)",
	]);
});

check("<!-- hN:X --> above a same-level heading names the heading", () => {
	// It would otherwise open an untitled subtree the heading closes before
	// anything can go in it — which tree-md refuses, and which nobody means.
	const lines = ["# 研究", "", "<!-- h2:0000 -->", "## 研究関心 ", "", "- body"];
	assert.equal(preferHeadingAnchors(lines, counter()), 1);
	assert.deepEqual(lines, ["# 研究", "", "## 研究関心 ^0000", "", "- body"]);
});

check("<!-- hN --> above a deeper heading is a real subtree and is left alone", () => {
	const lines = ["<!-- h2:outer -->", "### Inner", "", "Body."];
	assert.equal(preferHeadingAnchors(lines, counter()), 0);
	assert.deepEqual(lines, ["<!-- h2:outer -->", "### Inner", "", "Body."]);
});

check("an untitled subtree with no content is reported", () => {
	assert.deepEqual(checkDirectives(["<!-- h2:0000 -->", "## Heading", "", "Body."]), [
		"line 1: this untitled subtree has no content — a heading at the same level closes it straight away",
	]);
});

check("a #Heading reference is itself a request to address that heading", () => {
	const refs = headingRefs([
		"![[research.tree#研究関心]]",
		"[[#卒業研究|その話]]",
		"![[research.tree#^already]]",
		"![[research.tree]]",
		FENCE,
		"![[fenced#Section]]",
		FENCE,
	]);
	assert.deepEqual(refs, [
		{ path: "research.tree", heading: "研究関心" },
		{ path: "", heading: "卒業研究" },
	]);
});

check("the address goes on the heading that was pointed at", () => {
	const lines = ["# 研究", "", "## 研究関心", "", "Body.", "", "## 卒業研究 ^kept"];

	assert.equal(anchorHeading(lines, "研究関心", "0073"), true);
	assert.equal(lines[2], "## 研究関心 ^0073");

	assert.equal(anchorHeading(lines, "卒業研究", "0074"), false, "it already has one");
	assert.equal(anchorHeading(lines, "見つからない", "0075"), false);
	assert.equal(lines[6], "## 卒業研究 ^kept");
});

check("the whole round trip: address the heading, then rewrite the reference", () => {
	// The two halves live in different notes, and the second reads back what the
	// first wrote. Reading a stale copy there is what leaves the reference
	// pointing at the heading after the heading has been addressed.
	const index = ["# HOME", "", "![[research.tree#研究関心]]", "", "[[research.tree#研究関心|その話]]"];
	const research = ["# 研究", "", "## 研究関心 ", "", "- body"];

	const refs = headingRefs(index);
	assert.deepEqual(refs[0], { path: "research.tree", heading: "研究関心" });

	assert.equal(anchorHeading(research, refs[0].heading, "0002"), true);
	assert.equal(research[2], "## 研究関心 ^0002");

	// The lookup has to see the note as it now is, not as it was.
	const addressOf = (path, heading) => {
		if (path !== "research.tree") return null;
		const wanted = heading.trim();
		for (const line of research) {
			const match = line.match(/^#{2,6}[ \t]+(.*?)[ \t]+\^([A-Za-z0-9][A-Za-z0-9._-]*)$/);
			if (match && match[1].trim() === wanted) return `${path}#^${match[2]}`;
		}
		return null;
	};

	assert.equal(retargetHeadingRefs(index, addressOf), 2);
	assert.deepEqual(index, [
		"# HOME",
		"",
		"![[research.tree#^0002]]",
		"",
		"[[research.tree#^0002|その話]]",
	]);
});

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall save checks passed");
