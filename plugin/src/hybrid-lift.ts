import { resolveHybrid } from './hybrid-core';
import type { HybridDocument, HybridIndex, HybridTree, SourceRange } from './hybrid-types';

/**
 * v0.6 "return to parent": a heading's extent is implicit, so text after a
 * child always belongs to that child. To continue the parent after it, the
 * child moves to its own note and its place becomes an embed of that note.
 * Pure planning only; the caller performs the file and editor writes.
 */
export interface LiftEdit { from: number; to: number; text: string; }
export interface LiftPlan {
  /** The new note's full text: the section, promoted so its heading is the H1. */
  noteSource: string;
  /** Edits to the source note, against its current text, in ascending order. */
  sourceEdits: LiftEdit[];
  /** Where the caret goes in the edited source: the parent's continuation. */
  caret: number;
  /** Rewritten links in other notes that addressed the moved trees. */
  otherEdits: { path: string; before: string; after: string }[];
}

/** The innermost subtree (never the note root) whose extent holds `offset`. */
export function liftTarget(document: HybridDocument, offset: number): HybridTree | undefined {
  return document.trees
    .filter(tree => tree !== document.root && tree.from <= offset && (offset < tree.to || (offset === tree.to && tree.to === document.source.length)))
    .sort((a, b) => b.level - a.level)[0];
}

const inside = (ranges: SourceRange[], from: number, to: number): boolean => ranges.some(range => range.from < to && from < range.to);
const links = /(!?)\[\[([^[\]|\r\n]*)((?:\|[^[\]\r\n]*)?)\]\]/g;

/** Rewrite `[[file#^id]]`-style links in `text` (offset `base` in its document) with `retarget`. */
function rewriteLinks(text: string, base: number, guarded: SourceRange[], retarget: (target: string) => string | undefined): string {
  return text.replace(links, (whole, bang: string, target: string, rest: string, at: number) => {
    if (inside(guarded, base + at, base + at + whole.length)) return whole;
    const next = retarget(target);
    return next === undefined ? whole : `${bang}[[${next}${rest}]]`;
  });
}

export function planLift(index: HybridIndex, document: HybridDocument, tree: HybridTree, noteName: string): LiftPlan {
  const source = document.source;
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  const guarded = [...document.protectedRanges];
  const sourceName = document.path.replace(/\.md$/i, '');
  // Every ID that moves: the section's own and its descendants'.
  const moved = new Set(document.trees.filter(t => t.from >= tree.from && t.to <= tree.to && t.id).map(t => t.id!.toLowerCase()));
  const anchorOf = (target: string): string | undefined => /#\^([A-Za-z0-9-]+)$/.exec(target)?.[1];
  const intoNote = (id: string): string => id.toLowerCase() === tree.id?.toLowerCase() ? noteName : `${noteName}#^${id}`;
  /** Whether a link written in `from` names this source file before its #^anchor (or is local to it). */
  const viaSource = (target: string, from: string): boolean => {
    const file = target.slice(0, Math.max(0, target.indexOf('#')));
    if (!file) return from === document.path;
    const found = resolveHybrid(index, file, from);
    return found.status === 'resolved' && found.document.path === document.path;
  };
  /** Where a link to an anchored tree of this file should point once the section has moved. */
  const retarget = (target: string, from: string, inMovedSection: boolean): string | undefined => {
    const id = anchorOf(target);
    if (!id || !viaSource(target, from)) return undefined;
    // Inside the moved section a local link stays local, except to the section
    // itself: its ID becomes the note's forester-id, no longer a heading's block ID.
    if (moved.has(id.toLowerCase())) return inMovedSection && target.startsWith('#') && id.toLowerCase() !== tree.id?.toLowerCase() ? undefined : intoNote(id);
    // A local link in the moved section to a tree that stays behind now crosses notes.
    return inMovedSection && target.startsWith('#') ? `${sourceName}#^${id}` : undefined;
  };

  // The section, promoted: its heading becomes the H1 and nested headings rise
  // by the same amount. Its own ^id becomes the new note's forester-id.
  const shift = tree.level - 1;
  let offset = tree.from;
  const lines = source.slice(tree.from, tree.to).split('\n').map((line, i) => {
    const at = offset; offset += line.length + 1;
    const heading = /^( {0,3})(#{1,6})([ \t]|$)/.exec(line);
    if (!heading || inside(guarded, at, at + heading[0].length)) return line;
    let promoted = heading[1] + '#'.repeat(Math.max(1, heading[2].length - shift)) + line.slice(heading[1].length + heading[2].length);
    if (i === 0 && tree.id) promoted = promoted.replace(new RegExp(`[ \\t]+\\^${tree.id}(\\r?)$`), '$1');
    return promoted;
  });
  let section = lines.join('\n');
  section = rewriteLinks(section, tree.from, guarded, target => retarget(target, document.path, true));
  if (!section.endsWith('\n')) section += eol;
  const noteSource = (tree.id ? `---${eol}forester-id: ${JSON.stringify(tree.id)}${eol}---${eol}` : '') + section;

  // The source: links elsewhere in it to the moved trees follow them, and the
  // section's place becomes the embed, followed by a line for the parent.
  const sourceEdits: LiftEdit[] = [];
  const editLinks = (from: number, to: number) => {
    const before = source.slice(from, to), after = rewriteLinks(before, from, guarded, target => retarget(target, document.path, false));
    if (after !== before) sourceEdits.push({ from, to, text: after });
  };
  editLinks(0, tree.from);
  const embed = `![[${noteName}]]`;
  const blank = tree.to < source.length ? eol + eol : eol;
  sourceEdits.push({ from: tree.from, to: tree.to, text: embed + blank });
  editLinks(tree.to, source.length);
  // The caret lands on the line after the embed, shifted by edits before the section.
  const before = sourceEdits.filter(edit => edit.to <= tree.from).reduce((sum, edit) => sum + edit.text.length - (edit.to - edit.from), 0);
  const caret = tree.from + before + embed.length + eol.length;

  // Other notes: links that reach a moved tree through this file follow it.
  // A bare [[id]] still resolves by ID and needs no change.
  const otherEdits: LiftPlan['otherEdits'] = [];
  for (const other of index.documents.values()) {
    if (other.path === document.path || !other.enabled) continue;
    const after = rewriteLinks(other.source, 0, other.protectedRanges, target => retarget(target, other.path, false));
    if (after !== other.source) otherEdits.push({ path: other.path, before: other.source, after });
  }
  return { noteSource, sourceEdits, caret, otherEdits };
}
