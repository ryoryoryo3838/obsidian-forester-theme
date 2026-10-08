import type { HybridDocument, HybridIndex, HybridResolution, HybridTree, SourceRange } from './hybrid-types';

export interface HybridTreeRelations {
  backlinks: HybridTree[];
  related: HybridTree[];
  references: HybridTree[];
}

interface WikiOccurrence extends SourceRange { target: string; embed: boolean; }

/** Union the parser's masks without mutating the document's ranges. */
function relationGuards(document: HybridDocument): SourceRange[] {
  const ranges = [...document.protectedRanges];
  for (const tree of document.trees) for (const range of tree.metadataRanges) ranges.push(range);
  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const guards: SourceRange[] = [];
  for (const range of ranges) {
    if (range.to <= range.from) continue;
    const last = guards[guards.length - 1];
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to);
    else guards.push({ from: range.from, to: range.to });
  }
  return guards;
}

/**
 * One monotone source pass. Consume whole wikilinks, including inert labels,
 * before considering another opener. Never decode entities or Markdown escapes
 * in targets: the injected resolver is the only authority on target identity.
 */
function* wikilinks(source: string, guards: SourceRange[]): Generator<WikiOccurrence> {
  let cursor = 0, guardAt = 0, slashes = 0, lineTo = -1;
  const lineBreak = /[\r\n]/g;
  // Recovery, not multiline link support: an unterminated alias remains inert
  // through soft line breaks, but cannot consume the next paragraph/block.
  const aliasBoundary = /(?:[ \t]*(?=[\r\n]|$)| {0,3}(?:#{1,6}(?=[ \t\r\n]|$)|`{3,}|~{3,}|>|<|(?:[-+*]|\d+[.)])[ \t]|(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})(?=[\r\n]|$))| {4}|\t)/y;
  while (cursor < source.length) {
    while (guardAt < guards.length && guards[guardAt].to <= cursor) guardAt++;
    const guard = guards[guardAt];
    if (guard && guard.from <= cursor) { cursor = guard.to; slashes = 0; continue; }
    if (source[cursor] === '\\') { slashes ^= 1; cursor++; continue; }
    const escaped = slashes === 1;
    slashes = 0;
    const embed = source[cursor] === '!' && source.startsWith('[[', cursor + 1);
    if (!embed && !source.startsWith('[[', cursor)) { cursor++; continue; }
    const from = cursor, targetFrom = from + (embed ? 3 : 2);
    // Cache one boundary per physical line; a masked alias must not jump over
    // a newline and accidentally turn a malformed multiline link into a fact.
    if (from >= lineTo) { lineBreak.lastIndex = from; lineTo = lineBreak.exec(source)?.index ?? source.length; }
    let at = targetFrom, targetTo = -1, depth = 1, innerSlashes = 0, nestedTarget = false, closed = false, multiline = false;
    let maskedTarget = !!guard && guard.from < targetFrom;
    while (at < source.length) {
      while (guardAt < guards.length && guards[guardAt].to <= at) guardAt++;
      const span = guards[guardAt];
      if (at === lineTo) {
        if (targetTo < 0) break;
        multiline = true;
        const next = at + (source.startsWith('\r\n', at) ? 2 : 1);
        aliasBoundary.lastIndex = next;
        at = next; innerSlashes = 0;
        // A boundary inside a continuing code/comment/raw mask is payload,
        // not a new block; do not let recovery escape that parser-owned mask.
        if (!(span && span.from <= lineTo && span.to > next) && aliasBoundary.test(source)) break;
        lineBreak.lastIndex = next; lineTo = lineBreak.exec(source)?.index ?? source.length;
        continue;
      }
      if (span && span.from <= at) {
        if (targetTo < 0) maskedTarget = true;
        // Masks in the alias are inert: even literal [[ / ]] in code, math,
        // comments or raw Forester cannot open/close the surrounding link.
        at = Math.min(span.to, lineTo); innerSlashes = 0; continue;
      }
      if (source[at] === '\\') { innerSlashes ^= 1; at++; continue; }
      const innerEscaped = innerSlashes === 1;
      innerSlashes = 0;
      const visiblePair = !span || span.from >= at + 2;
      if (!innerEscaped && visiblePair && source.startsWith('[[', at)) {
        if (depth === 1 && targetTo < 0) nestedTarget = true;
        depth++; at += 2; continue;
      }
      if (!innerEscaped && visiblePair && source.startsWith(']]', at)) {
        depth--;
        if (depth === 0) { if (targetTo < 0) targetTo = at; closed = true; at += 2; break; }
        at += 2; continue;
      }
      if (!innerEscaped && depth === 1 && targetTo < 0 && source[at] === '|') targetTo = at;
      at++;
    }
    cursor = at;
    // Escaped/malformed openers still consume their payload. In particular an
    // escaped embed must not be retried as an active normal link at its '['.
    if (escaped || !closed || multiline || nestedTarget || maskedTarget || targetTo <= targetFrom) continue;
    yield { from, to: cursor, target: source.slice(targetFrom, targetTo), embed };
  }
}

/**
 * A pure, immutable-input graph snapshot; rebuild it when the index changes.
 *
 * Native fixed 6.0-dev semantics:
 * - Builtin_queries.ml:40-68: Backlinks invert direct links-to; Related keeps
 *   direct outbound links-to except targets with the exact taxon "Reference".
 * - Builtin_relation.ml:29-49: References selects Reference targets linked from
 *   the current node or its reflexive-transitive transcludes closure.
 * - compiler/Analyse.ml:50-60,67-76,169-184: a Link emits links-to; a full
 *   Transclude and a named Section emit transcludes, NOT links-to. There is no
 *   transcludes => links-to axiom, so embeds/containment never add backlinks.
 *
 * Parser-backed Markdown mapping: enabled, error-free document trees are vertices;
 * visible normal wikilinks (including {ref:[[...]]}) are links-to; ![[...]] and structural
 * parentKey edges are transcludes. Use the narrowest original tree range for
 * each occurrence, not an ancestor's inclusive body or expanded embed output.
 * Hybrid anonymous sections also have internal vertices/containment edges; this
 * deliberate adaptation aggregates nested references before IDs are assigned.
 * Metadata/attribution strings and raw Forester are not evaluated as body facts.
 * Only the injected shared resolver decides ID/file/block/heading identity.
 *
 * Each eligible source is scanned once; guards/tree ranges are sorted once.
 * Missing/ambiguous results are cached per (defining path, exact target) during
 * construction. A first References query visits each reachable node/edge at
 * most once (iterative, cycle-safe); later queries copy cached result arrays.
 * Cache only queried known trees, not all-pairs closures or unknown keys. No
 * arbitrary depth/result cap silently drops relations; worst-case cache size is
 * the sum of queried result sizes. Resolver cost is owned by the caller. No IO,
 * parsing, rendering, HTML/Markdown evaluation or source retention is added.
 * Returned tree objects are the original model nodes; treat them as immutable.
 * Results sort by literal path, numeric source offset, level, then unique key.
 */
function* prepareTreeRelations(
  index: HybridIndex,
  resolve: (target: string, fromPath: string) => HybridResolution,
): Generator<void, { forTree(key: string): HybridTreeRelations }> {
  const trees = new Map<string, HybridTree>();
  const links = new Map<string, Set<string>>();
  const inverse = new Map<string, Set<string>>();
  const transcludes = new Map<string, Set<string>>();
  const add = (edges: Map<string, Set<string>>, from: string, to: string): void => {
    let targets = edges.get(from);
    if (!targets) { targets = new Set(); edges.set(from, targets); }
    targets.add(to);
  };
  // Activation is path-only. Semantic errors can leave body guards incomplete;
  // refuse the entire document as both a fact source and a relation target.
  const documents = [...index.documents.values()].filter(document => document.enabled &&
    !document.diagnostics.some(diagnostic => diagnostic.severity === 'error'));
  for (const document of documents) {
    for (const tree of document.trees) trees.set(tree.key, tree);
    yield;
  }
  for (const tree of trees.values()) {
    if (tree.parentKey && trees.has(tree.parentKey)) add(transcludes, tree.parentKey, tree.key);
    yield;
  }
  for (const document of documents) {
    // Parser ranges are laminar. A monotone interval stack assigns each
    // occurrence to its narrowest tree without rescanning all trees per link.
    const ordered = [...document.trees].sort((a, b) => a.from - b.from || b.to - a.to || a.level - b.level);
    const owners: HybridTree[] = [];
    let treeAt = 0;
    const guards = relationGuards(document);
    const targets = new Map<string, HybridResolution>();
    for (const occurrence of wikilinks(document.source, guards)) {
      yield;
      while (owners.length && owners[owners.length - 1].to <= occurrence.from) owners.pop();
      while (treeAt < ordered.length && ordered[treeAt].from <= occurrence.from) {
        const tree = ordered[treeAt++];
        if (tree.to > occurrence.from) owners.push(tree);
      }
      const owner = owners[owners.length - 1];
      if (!owner || owner.to < occurrence.to) continue;
      let result = targets.get(occurrence.target);
      if (!result) { result = resolve(occurrence.target, document.path); targets.set(occurrence.target, result); }
      if (result.status !== 'resolved' || !result.document.enabled) continue;
      // Only accept nodes from this exact enabled snapshot, not an adapter's
      // foreign/disabled document or a same-key tree from a different index.
      if (trees.get(result.tree.key) !== result.tree || result.tree.path !== result.document.path ||
        index.documents.get(result.tree.path) !== result.document) continue;
      if (occurrence.embed) add(transcludes, owner.key, result.tree.key);
      else {
        add(links, owner.key, result.tree.key);
        add(inverse, result.tree.key, owner.key);
      }
    }
    yield;
  }
  const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
  const list = (keys: Iterable<string> = []): HybridTree[] => [...keys].map(key => trees.get(key)!)
    .sort((a, b) => compare(a.path, b.path) || a.from - b.from || a.level - b.level || compare(a.key, b.key));
  const isReference = (key: string): boolean => trees.get(key)!.meta.taxon === 'Reference';
  const references = (key: string): HybridTree[] => {
    const seen = new Set([key]), pending = [key], found = new Set<string>();
    while (pending.length) {
      const current = pending.pop()!;
      for (const target of links.get(current) ?? []) if (isReference(target)) found.add(target);
      for (const target of transcludes.get(current) ?? []) {
        if (!seen.has(target)) { seen.add(target); pending.push(target); }
      }
    }
    return list(found);
  };
  const queries = new Map<string, HybridTreeRelations>();
  return {
    forTree(key) {
      if (!trees.has(key)) return { backlinks: [], related: [], references: [] };
      let result = queries.get(key);
      if (!result) {
        const outgoing = [...(links.get(key) ?? [])];
        result = {
          backlinks: list(inverse.get(key)),
          related: list(outgoing.filter(target => !isReference(target))),
          references: references(key),
        };
        queries.set(key, result);
      }
      // Retain the original tree objects, but never expose our cached arrays.
      return {
        backlinks: result.backlinks.slice(),
        related: result.related.slice(),
        references: result.references.slice(),
      };
    },
  };
}

/** Synchronous pure API: the same fact extraction/query implementation. */
export function createTreeRelations(index: HybridIndex, resolve: (target: string, fromPath: string) => HybridResolution): { forTree(key: string): HybridTreeRelations } {
  const work = prepareTreeRelations(index, resolve);
  let step = work.next();
  while (!step.done) step = work.next();
  return step.value;
}

/** Adapter-owned scheduling; obsolete work never publishes a partial graph. */
export async function createTreeRelationsAsync(index: HybridIndex, resolve: (target: string, fromPath: string) => HybridResolution,
    control: { current(): boolean; yield(): Promise<void> }): Promise<ReturnType<typeof createTreeRelations> | undefined> {
  const work = prepareTreeRelations(index, resolve);
  let count = 0, start = performance.now();
  while (control.current()) {
    const step = work.next();
    if (step.done) return control.current() ? step.value : undefined;
    if (++count >= 32 || performance.now() - start >= 8) {
      await control.yield(); count = 0; start = performance.now();
    }
  }
  work.return(undefined as never);
  return undefined;
}
