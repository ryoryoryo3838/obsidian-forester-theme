/**
 * Runs the shared identity fixtures against the plugin's own rules.
 *
 * The fixtures in test/fixtures/identity.json are the contract between this
 * plugin and tree-md: the vault and the published site have to give a tree the
 * same address, so the two implementations have to agree, and changing a rule
 * in one place has to fail the other. Run with `npm test`.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { IDENTITY, BLOCK_ANCHOR, identityOf, fileStem } from "./build/forest.mjs";
import { encode, mint, checkPolicy, DEFAULT_POLICY } from "./build/mint.mjs";

const fixtures = JSON.parse(
	readFileSync(fileURLToPath(new URL("./fixtures/identity.json", import.meta.url)), "utf8"),
);

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

/** A vault built from the fixture notes, as Obsidian would present it. */
const files = fixtures.notes.map((note) => {
	const name = note.path.slice(note.path.lastIndexOf("/") + 1);
	return {
		path: note.path,
		basename: name.replace(/\.md$/, ""),
		extension: "md",
		frontmatter: note.frontmatter,
		expected: note,
	};
});

const app = {
	metadataCache: {
		getFileCache: (file) => ({ frontmatter: file.frontmatter }),
		getFirstLinkpathDest: (link) =>
			files.find((f) => f.basename === link || fileStem(f) === link) ?? null,
	},
};

/** The ladder, in tree-md's order: identity first, then file name. */
function resolve(target) {
	const bare = target.replace(/\.tree$/, "");
	return (
		files.find((f) => identityOf(app, f) === target) ??
		files.find((f) => identityOf(app, f) === bare) ??
		files.find((f) => fileStem(f) === target) ??
		files.find((f) => fileStem(f) === bare) ??
		null
	);
}

check("a tree's identity is its id, and its file name otherwise", () => {
	for (const file of files) {
		assert.equal(identityOf(app, file), file.expected.identity, file.expected.why);
		assert.equal(fileStem(file), file.expected.stem, file.path);
	}
});

check("resolution climbs the ladder, identities before file names", () => {
	for (const { target, identity, step } of fixtures.resolution) {
		const found = resolve(target);
		assert.equal(
			found === null ? null : identityOf(app, found),
			identity,
			`[[${target}]] via ${step}`,
		);
	}
});

check("the identity grammar accepts and rejects what tree-md does", () => {
	const pattern = new RegExp(fixtures.identityGrammar.pattern);
	assert.equal(pattern.source, IDENTITY.source, "the plugin's grammar is the fixture's");

	for (const accepted of fixtures.identityGrammar.accepts) {
		assert.ok(IDENTITY.test(accepted), `should accept ${JSON.stringify(accepted)}`);
	}
	for (const rejected of fixtures.identityGrammar.rejects) {
		assert.ok(!IDENTITY.test(rejected), `should reject ${JSON.stringify(rejected)}`);
	}
});

check("an address encodes the way Forester's own addresses do", () => {
	const policy = { ...DEFAULT_POLICY, ...fixtures.addresses.policy };
	assert.equal(checkPolicy(policy), null, "the fixture policy is usable");

	for (const [value, address] of fixtures.addresses.encodes) {
		assert.equal(encode(value, policy), address, `${value}`);
	}
});

check("an address that is written is never minted over", () => {
	const taken = new Set(["0000", "0001", "0002"]);
	// Sequential is the only scheme with a predictable answer to assert on.
	const address = mint(taken, { ...DEFAULT_POLICY, scheme: "sequential" });
	assert.equal(address, "0003");
	assert.ok(!taken.has(address));
});

check("minting draws from the whole space and stays inside the grammar", () => {
	const taken = new Set();
	let draw = 0;
	// A generator that would collide on its first several draws, to check the
	// fallback: several minting points offline is exactly this case.
	const random = () => [0, 0, 0, 0.5][Math.min(draw++, 3)];

	taken.add(encode(0, DEFAULT_POLICY));
	const address = mint(taken, DEFAULT_POLICY, random);

	assert.ok(!taken.has(address), "not one already taken");
	assert.ok(IDENTITY.test(address), `${address} is an identity`);
	assert.equal(address.length, DEFAULT_POLICY.width);
});

check("a policy that could mint an illegal identity is rejected", () => {
	assert.equal(checkPolicy(DEFAULT_POLICY), null);
	assert.ok(checkPolicy({ ...DEFAULT_POLICY, prefix: "-" }), "a leading dash is not an identity");
	assert.ok(checkPolicy({ ...DEFAULT_POLICY, alphabet: "01/" }), "a slash is not an identity");
	assert.ok(checkPolicy({ ...DEFAULT_POLICY, alphabet: "001" }), "a repeated digit");
	assert.ok(checkPolicy({ ...DEFAULT_POLICY, width: 0 }), "width must be positive");
});

check("an anchor is only a token ending a block", () => {
	for (const [line, without, id] of fixtures.anchors.stripped) {
		const match = line.match(BLOCK_ANCHOR);
		assert.ok(match, `should anchor: ${line}`);
		assert.equal(match[1], id, line);
		assert.equal(line.replace(BLOCK_ANCHOR, ""), without, line);
	}
	for (const line of fixtures.anchors.kept) {
		assert.equal(line.match(BLOCK_ANCHOR), null, `should keep its caret: ${line}`);
	}
});

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\nall identity checks passed");
