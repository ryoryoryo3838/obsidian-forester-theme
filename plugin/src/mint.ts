/**
 * Minting an address.
 *
 * A tree that states no `id` is given one. `tree-md build` does this too, from
 * the same `[id]` policy — so the two have to agree on the scheme, and the
 * settings here are a copy of that TOML table rather than a second design. A
 * forest should have one scheme, not one per tool; only the writing moves.
 *
 * The plugin needs its own copy because an address has to exist *while editing*
 * — you cannot link to a tree by an id that only appears after a build — and
 * because `tree-md` does not run on a phone.
 *
 * The scheme follows the convention Forester documents for its own forests: a
 * base-36 number, zero-padded to four digits. `269` is `007H`, which is a real
 * published address. The point of a number is that it says nothing, so nothing
 * about the tree can make you want to change it.
 */

import { BLOCK_ANCHOR, IDENTITY, MINT_REQUEST, subtreeSpans } from "./forest";

export interface AddressPolicy {
	/** Digits, most significant first; `alphabet[0]` is the padding digit. */
	alphabet: string;
	/** Minimum digits. A larger number simply takes more. */
	width: number;
	/**
	 * `random` by default, and it matters. Addresses are minted from more than
	 * one place — tree-md on the desktop, this plugin on the desktop, this plugin
	 * on a phone — and two of them offline would hand out the same next number.
	 * 36^4 is about 1.7 million, so drawing is effectively free of collisions.
	 */
	scheme: "random" | "sequential";
	prefix: string;
}

export const DEFAULT_POLICY: AddressPolicy = {
	alphabet: "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
	width: 4,
	scheme: "random",
	prefix: "",
};

/** Positional notation in `alphabet`, zero-padded to `width`. */
export function encode(value: number, policy: AddressPolicy): string {
	const base = policy.alphabet.length;
	if (base < 2) throw new Error("an alphabet needs at least two digits");
	if (!Number.isInteger(value) || value < 0) throw new Error("value must be a natural number");

	let digits = "";
	let rest = value;
	do {
		digits = policy.alphabet[rest % base] + digits;
		rest = Math.floor(rest / base);
	} while (rest > 0);

	return policy.prefix + digits.padStart(policy.width, policy.alphabet[0]);
}

/** How many values `width` digits hold; a number past it simply grows. */
export function span(policy: AddressPolicy): number {
	return policy.alphabet.length ** policy.width;
}

/**
 * An address no tree in the forest already answers to.
 *
 * `taken` is every identity in the vault — note ids and subtree ids alike —
 * because they share one namespace. An address that is written is never minted
 * over, so this only ever adds.
 */
export function mint(
	taken: ReadonlySet<string>,
	policy: AddressPolicy = DEFAULT_POLICY,
	random: () => number = Math.random,
): string {
	const limit = span(policy);

	if (policy.scheme === "sequential") {
		for (let value = 0; ; value++) {
			const address = encode(value, policy);
			if (!taken.has(address)) return address;
		}
	}

	// Draw, then fall back to a scan. The scan is what makes this terminate on a
	// forest that has somehow filled its space, rather than spinning.
	for (let attempt = 0; attempt < 64; attempt++) {
		const address = encode(Math.floor(random() * limit), policy);
		if (!taken.has(address)) return address;
	}
	for (let value = 0; ; value++) {
		const address = encode(value, policy);
		if (!taken.has(address)) return address;
	}
}

/** A policy that could mint something illegal is rejected before it is used. */
export function checkPolicy(policy: AddressPolicy): string | null {
	if (policy.alphabet.length < 2) return "the alphabet needs at least two digits";
	if (new Set(policy.alphabet).size !== policy.alphabet.length) {
		return "the alphabet repeats a digit";
	}
	if (!Number.isInteger(policy.width) || policy.width < 1) {
		return "width must be a positive whole number";
	}

	// Every address the policy can produce has to be a legal identity, and the
	// widest and narrowest cases are enough to prove it: the first character
	// comes from the prefix or the padding digit, the rest from the alphabet.
	const sample = policy.prefix + policy.alphabet;
	if (!IDENTITY.test(sample) || !IDENTITY.test(encode(0, policy))) {
		return "this alphabet or prefix can mint something that is not an identity";
	}

	return null;
}

// ── the passes a save runs over a note's text ────────────────────────────────
//
// Pure text in, pure text out, so they can be checked without an app. Each
// returns how many changes it made; none of them ever removes an address.

const OPEN_UNNAMED = /^<!--\s*(h[2-6])\s*-->$/;
const CODE_FENCE = /^\s{0,3}(?:```|~~~)/;
const WIKI_REF = /!?\[\[([^[\]]+)\]\]/g;

/**
 * Fill in the addresses a note's body asks for.
 *
 * `<!-- id -->` is a request in tree-md's sense. `<!-- hN -->` is one here as
 * well: an untitled subtree is the only construct with nothing to fall back on,
 * so writing it is asking for an address, and giving it one moves nothing —
 * there was none to move.
 */
export function fulfilRequests(lines: string[], draw: () => string): number {
	let minted = 0;
	let fenced = false;

	for (let i = 0; i < lines.length; i++) {
		if (CODE_FENCE.test(lines[i])) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		const line = lines[i].replace(/[ \t]+$/, "");

		if (MINT_REQUEST.test(line)) {
			lines[i] = `<!-- id: ${draw()} -->`;
			minted++;
			continue;
		}

		const untitled = line.match(OPEN_UNNAMED);
		if (untitled) {
			lines[i] = `<!-- ${untitled[1]}:${draw()} -->`;
			minted++;
		}
	}

	return minted;
}

/**
 * Give a named untitled subtree an anchor inside it, so Obsidian can address it.
 *
 * A directive names the subtree for tree-md, but Obsidian reaches a subtree only
 * through an anchor: without one the address is write-only from this side. The
 * body is often not written when the address is minted — saving mid-edit is the
 * normal case — so this runs on every save and settles as soon as there is a
 * block to carry it.
 *
 * Nothing is moved and nothing is duplicated. A subtree whose anchor sits
 * somewhere else in the note is left alone: a second copy would give Obsidian
 * two blocks with one id, which is worse than an address it cannot reach. That
 * case — an anchor left outside its subtree by a `<!-- /hN -->` inserted above
 * it — shows up as the embed simply not resolving.
 */
export function anchorNamedSubtrees(lines: string[]): number {
	let placed = 0;

	for (const span of subtreeSpans(lines.join("\n"))) {
		if (span.titled || span.id === undefined) continue;

		const id = span.id;
		const carries = (line: string): boolean =>
			line.replace(/[ \t]+$/, "").match(BLOCK_ANCHOR)?.[1] === id;
		if (lines.some(carries)) continue;

		for (let i = span.start; i < span.end; i++) {
			const line = lines[i].replace(/[ \t]+$/, "");
			if (line.length === 0) continue;
			// The body is another subtree's before it is any of its own.
			if (/^#{1,6}[ \t]/.test(line) || /^<!--\s*\/?h[2-6]/.test(line)) break;
			lines[i] = `${line} ^${id}`;
			placed++;
			break;
		}
	}

	return placed;
}

/**
 * Rewrite `#Heading` references to what the heading actually names.
 *
 * Obsidian autocompletes `![[note#Heading]]`, so it gets written by habit — and
 * tree-md rejects it, because a section title is not an address and making it
 * one is what breaks every reference the moment the section is retitled.
 *
 * `retarget` is handed the reference's path and heading and returns the target
 * to write in its place — an address for a subtree, the bare note for its `#`
 * title, which is the root tree itself and not a section of it — or null to
 * leave the reference as written. The alias is kept either way.
 */
export function retargetHeadingRefs(
	lines: string[],
	retarget: (path: string, heading: string) => string | null,
): number {
	let fixed = 0;
	let fenced = false;

	for (let i = 0; i < lines.length; i++) {
		if (CODE_FENCE.test(lines[i])) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		lines[i] = lines[i].replace(WIKI_REF, (whole, body: string) => {
			const pipe = body.indexOf("|");
			const target = pipe < 0 ? body : body.slice(0, pipe);
			const alias = pipe < 0 ? "" : body.slice(pipe);

			const hash = target.indexOf("#");
			if (hash < 0) return whole;

			const path = target.slice(0, hash);
			const fragment = target.slice(hash + 1);
			// Already an address, or `[[note#]]`, which addresses nothing.
			if (fragment.startsWith("^") || fragment.trim().length === 0) return whole;

			// Obsidian spells a nested heading `A#B`; the last segment is the one.
			const heading = fragment.split("#").pop()?.trim() ?? "";
			const replacement = retarget(path, heading);
			if (replacement === null || replacement === target) return whole;

			fixed++;
			return `${whole.startsWith("!") ? "!" : ""}[[${replacement}${alias}]]`;
		});
	}

	return fixed;
}

const NAME_DIRECTIVE = /^<!--\s*(?:subtree|id)\s*(?::\s*([A-Za-z0-9][A-Za-z0-9._-]*))?\s*-->$/;
/** `<!-- hN -->` and `<!-- hN:ID -->`, whose level decides what it can contain. */
const OPEN_DIRECTIVE = /^<!--\s*h([2-6])\s*(?::\s*([A-Za-z0-9][A-Za-z0-9._-]*))?\s*-->$/;
const HEADING = /^(#{2,6})[ \t]+(\S.*?)[ \t]*$/;

/**
 * Move a heading's name onto the heading itself.
 *
 * `<!-- subtree: X -->` and `<!-- id: X -->` name the heading below them, and
 * `## Heading ^X` names it too — the same subtree, the same address, three
 * spellings. Only the last one Obsidian can address: `![[note#^X]]` needs an
 * anchor, and a directive is not one. So the directive is replaced rather than
 * joined by an anchor, because naming a subtree twice is an error even when the
 * two agree.
 *
 * A bare `<!-- id -->` is a request, and gets the same treatment: the address
 * goes straight onto the heading.
 */
export function preferHeadingAnchors(lines: string[], draw: () => string): number {
	const drop = new Set<number>();
	let moved = 0;
	let fenced = false;

	for (let i = 0; i < lines.length; i++) {
		if (CODE_FENCE.test(lines[i])) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		const line = lines[i].replace(/[ \t]+$/, "");
		const naming = line.match(NAME_DIRECTIVE);
		const opening = naming ? null : line.match(OPEN_DIRECTIVE);
		if (!naming && !opening) continue;

		// The heading it names, across any blank lines between them — which go
		// with it, so that removing the directive leaves the text as if it had
		// never been written.
		let target = -1;
		const between: number[] = [];
		for (let j = i + 1; j < lines.length; j++) {
			if (lines[j].trim().length === 0) {
				between.push(j);
				continue;
			}
			target = j;
			break;
		}
		const heading = target < 0 ? null : lines[target].replace(/[ \t]+$/, "").match(HEADING);
		// An orphan names nothing. Left as written, and reported.
		if (!heading) continue;

		// `<!-- h2:X -->` immediately above a level-2 heading opens an untitled
		// subtree that the heading closes before anything can go in it — which
		// tree-md refuses, and which nobody means. The name was meant for the
		// heading, so that is where it goes.
		if (opening && heading[1].length > Number(opening[1])) continue;

		const carried = heading[2].match(BLOCK_ANCHOR)?.[1];
		const id = (naming ? naming[1] : opening?.[2]) ?? carried ?? draw();

		// Already anchored, and with the same name: the directive is the copy.
		if (carried !== undefined) {
			if (carried !== id) continue; // named twice, and differently: reported
			drop.add(i);
			for (const blank of between) drop.add(blank);
			moved++;
			continue;
		}

		lines[target] = `${heading[1]} ${heading[2]} ^${id}`;
		drop.add(i);
		for (const blank of between) drop.add(blank);
		moved++;
	}

	if (drop.size > 0) {
		const kept = lines.filter((_, i) => !drop.has(i));
		lines.length = 0;
		lines.push(...kept);
	}

	return moved;
}

/**
 * What a note says that tree-md will not accept. Reported rather than repaired:
 * each of these is a sentence whose meaning cannot be guessed at, and writing a
 * guess into someone's file is worse than telling them.
 */
export function checkDirectives(lines: string[]): string[] {
	const problems: string[] = [];
	let fenced = false;

	for (let i = 0; i < lines.length; i++) {
		if (CODE_FENCE.test(lines[i])) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		const line = lines[i].replace(/[ \t]+$/, "");
		const comment = line.match(/^<!--\s*(\S+)([\s\S]*?)-->$/);
		if (!comment) continue;

		const word = comment[1].replace(/:$/, "");
		const closing = word.startsWith("/");
		const name = closing ? word.slice(1) : word;

		if (name === "subtree" || name === "id") {
			if (closing) {
				problems.push(
					`line ${i + 1}: <!-- /${name} --> does not close anything — a subtree is closed by <!-- /hN -->`,
				);
				continue;
			}
			// A naming directive that reached here named nothing: preferHeadingAnchors
			// consumes every one that found its heading.
			problems.push(`line ${i + 1}: <!-- ${name}: … --> is not followed by a heading`);
			continue;
		}

		if (/^[hH]\d+$/.test(name)) {
			const level = Number(name.slice(1));
			if (name[0] === "H") {
				problems.push(`line ${i + 1}: write the level in lowercase, h2 to h6`);
			} else if (level < 2 || level > 6) {
				problems.push(`line ${i + 1}: subtree levels are h2 to h6 (found h${level})`);
			}
		}
	}

	for (const span of subtreeSpans(lines.join("\n"))) {
		if (span.titled) continue;
		const empty = lines.slice(span.start, span.end).every((line) => line.trim().length === 0);
		if (empty) {
			problems.push(
				`line ${span.line + 1}: this untitled subtree has no content — a heading at the same level closes it straight away`,
			);
		}
	}

	return problems;
}


/** The `#Heading` references a note makes, in source order. */
export function headingRefs(lines: string[]): Array<{ path: string; heading: string }> {
	const refs: Array<{ path: string; heading: string }> = [];
	let fenced = false;

	for (const raw of lines) {
		if (CODE_FENCE.test(raw)) {
			fenced = !fenced;
			continue;
		}
		if (fenced) continue;

		for (const match of raw.matchAll(WIKI_REF)) {
			const body = match[1];
			const pipe = body.indexOf("|");
			const target = pipe < 0 ? body : body.slice(0, pipe);

			const hash = target.indexOf("#");
			if (hash < 0) continue;

			const fragment = target.slice(hash + 1);
			if (fragment.startsWith("^") || fragment.trim().length === 0) continue;

			const heading = fragment.split("#").pop()?.trim() ?? "";
			if (heading.length > 0) refs.push({ path: target.slice(0, hash), heading });
		}
	}

	return refs;
}

/**
 * Put `^id` on a heading, so that something can point at it.
 *
 * Used when a reference asks for a section that has no address: the reference is
 * the request, and the only place an address can go is the heading itself.
 */
export function anchorHeading(lines: string[], heading: string, id: string): boolean {
	const wanted = heading.trim().toLowerCase();

	for (let i = 0; i < lines.length; i++) {
		const match = lines[i].replace(/[ \t]+$/, "").match(HEADING);
		if (!match) continue;
		if (BLOCK_ANCHOR.test(match[2])) continue;
		if (match[2].trim().toLowerCase() !== wanted) continue;

		lines[i] = `${match[1]} ${match[2]} ^${id}`;
		return true;
	}

	return false;
}
