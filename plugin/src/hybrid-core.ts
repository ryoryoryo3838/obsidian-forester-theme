// The ESM browser build avoids yaml's Node-only `require(process)` in a bundled ESM artifact.
// @ts-expect-error yaml publishes this ESM entry without declarations; its public API is typed below.
import { parseDocument as browserParseDocument } from '../node_modules/yaml/browser/index.js';
import type { parseDocument as YamlParseDocument } from 'yaml';
const parseDocument = browserParseDocument as typeof YamlParseDocument;
import type { HybridDiagnostic, HybridDocument, HybridIndex, HybridOptions, HybridRaw, HybridResolution, HybridSavePlan, HybridTree, SourceRange } from './hybrid-types';
import { encodeWikilinkLabel } from './hybrid-literal-label';

// Preserve option-only reservations without extending the shared document contract.
const reservations = new WeakMap<HybridDocument, readonly string[]>();
const headingName = (tree: HybridTree): string | null => tree.headingTitle !== undefined ? tree.headingTitle : tree.meta.title;

const has = (object: Record<string, unknown>, key: string): boolean => Object.prototype.hasOwnProperty.call(object, key);
const inFolders = (path: string, folders: string[]): boolean => folders.some(folder => {
  const prefix = folder.replace(/^\/+|\/+$/g, '');
  return (folder === '/' || (prefix !== '' && path.startsWith(`${prefix}/`)));
});
const isMapping = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

function readYamlMapping(source: string, allowEmpty = false): Record<string, unknown> {
  const parsed = parseDocument(source, { schema: 'core' });
  if (parsed.errors.length) throw new Error(parsed.errors.map(error => error.message).join('; '));
  // toJS can throw for unresolved/excessive aliases even when parsed.errors is empty.
  const value: unknown = parsed.toJS({ maxAliasCount: 100 });
  if (value === null && allowEmpty) return {};
  if (!isMapping(value)) throw new Error('Metadata must be a YAML mapping');
  return value;
}

function frontmatter(source: string, path: string, diagnostics: HybridDiagnostic[]): { value: Record<string, unknown>; range?: SourceRange } {
  // Check only the prefix before looking for a closing line. Ordinary bodies
  // must not be split/normalized just to ask whether the dialect is active.
  const opening = source.startsWith('---\n') ? 4 : source.startsWith('---\r\n') ? 5 :
    source === '---' || source === '---\r' ? source.length : 0;
  if (!opening) return { value: {} };
  // LF anchors preserve the existing frontmatter grammar, including CRLF;
  // multiline ^/$ would incorrectly accept a delimiter beside a bare CR.
  const closing = /\n(?:---|\.\.\.)\r?(?:\n|$)/g;
  closing.lastIndex = opening - 1;
  const match = closing.exec(source);
  const range = { from: 0, to: match ? match.index + match[0].length : source.length };
  const fail = (message: string) => diagnostics.push({ code: 'invalid-frontmatter', message, path, line: 0, severity: 'error' });
  if (!match) { fail('Unclosed YAML frontmatter'); return { value: {}, range }; }
  try {
    const value = readYamlMapping(source.slice(opening, match.index).replace(/\r(?=\n|$)/g, ''), true);
    return { value, range };
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return { value: {}, range };
  }
}

function modeEnabled(path: string, values: Record<string, unknown>, options: HybridOptions, diagnostics: HybridDiagnostic[], legacy: boolean): boolean {
  if (!has(values, 'forester-mode')) return inFolders(path, options.folders);
  const mode = values['forester-mode'];
  if (mode === false) return false;
  if (mode === true || mode === 'hybrid-v1' || (legacy && mode === 'hybrid-v0')) return true;
  diagnostics.push({ code: 'invalid-mode', message: 'forester-mode must be hybrid-v1, hybrid-v0, true or false', path, line: 0, severity: 'error' });
  return false;
}

/** Cheap adapter gate; hybrid-v0 remains a pure-parser compatibility dialect. */
export function hybridModeEnabled(path: string, source: string, options: HybridOptions): boolean {
  const diagnostics: HybridDiagnostic[] = [];
  const fm = frontmatter(source, path, diagnostics);
  return diagnostics.length === 0 && modeEnabled(path, fm.value, options, diagnostics, false);
}

interface SourceLine { text: string; from: number; end: number; line: number; }
function sourceLineCount(source: string): number {
  let count = 0, from = 0;
  while (from < source.length) {
    count++;
    const newline = source.indexOf('\n', from);
    if (newline < 0) break;
    from = newline + 1;
  }
  return count;
}

function sourceLines(source: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;
  while (from < source.length) {
    const newline = source.indexOf('\n', from);
    const end = newline < 0 ? source.length : newline + 1;
    lines.push({ text: source.slice(from, newline < 0 ? end : newline).replace(/\r$/, ''), from, end, line: lines.length });
    from = end;
  }
  return lines;
}

const overlaps = (ranges: SourceRange[], from: number, to: number): boolean => ranges.some(range => range.from < to && from < range.to);
function maskSpan(source: string, from: number, to: number, ranges: SourceRange[]): string {
  let text = source.slice(from, to);
  for (const range of ranges) {
    const left = Math.max(from, range.from), right = Math.min(to, range.to);
    if (left < right) text = text.slice(0, left - from) + ' '.repeat(right - left) + text.slice(right - from);
  }
  return text;
}
function escaped(source: string, offset: number): boolean {
  let backslashes = 0;
  for (let i = offset - 1; i >= 0 && source[i] === '\\'; i--) backslashes++;
  return backslashes % 2 === 1;
}

function scanRaw(source: string, from: number): HybridRaw {
  const codeFrom = from + 2;
  let cursor = codeFrom, depth = 1;
  while (cursor < source.length) {
    if (source[cursor] === '%') {
      const newline = source.indexOf('\n', cursor + 1);
      cursor = newline < 0 ? source.length : newline + 1;
      continue;
    }
    if (source[cursor] === '\\') {
      if (/^\\startverb\b/.test(source.slice(cursor))) {
        const start = cursor + '\\startverb'.length;
        const stop = /\\stopverb\b/.exec(source.slice(start));
        cursor = stop ? start + stop.index + stop[0].length : source.length;
        continue;
      }
      const verb = /^\\verb([^\w\s])/.exec(source.slice(cursor));
      if (verb) {
        const close = source.indexOf(verb[1], cursor + verb[0].length);
        cursor = close < 0 ? source.length : close + 1;
        continue;
      }
      if ('{}%\\'.includes(source[cursor + 1] ?? '')) { cursor += 2; continue; }
      cursor++; continue;
    }
    if (source[cursor] === '{') depth++;
    if (source[cursor] === '}' && --depth === 0) return { from, to: cursor + 1, codeFrom, codeTo: cursor, code: source.slice(codeFrom, cursor) };
    cursor++;
  }
  return { from, to: source.length, codeFrom, codeTo: source.length, code: source.slice(codeFrom), error: 'Unclosed raw Forester region or verbatim literal' };
}

/** Inline guards stop at real paragraphs/blocks, including every thematic-break marker. */
function inlineParagraphEnd(source: string, from: number, to = source.length): number {
  // CommonMark thematic breaks: <=3 leading spaces, >=3 identical *, _ or -,
  // with arbitrary spaces/tabs between/after markers, and no other characters.
  // Bare CR is also a line ending, but CRLF is indivisible: the negative
  // lookahead prevents one CRLF from backtracking into two blank-line endings.
  // Search the original string at an offset, not a normalized remaining suffix.
  const bounded = to < source.length;
  const text = bounded ? source.slice(from, to) : source;
  const offset = bounded ? from : 0;
  const matcher = /(?:\r\n|\r(?!\n)|\n)[ \t]*(?:\r\n|\r(?!\n)|\n)|(?:\r\n|\r(?!\n)|\n) {0,3}(?:(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})(?=\r\n|\r(?!\n)|\n|$)|`{3,}|~{3,}|#{1,6}(?:\s|$)|>|<|(?:[-+*]|\d+[.)])[ \t]|[-=]{2,}(?:\s|$))/g;
  matcher.lastIndex = from - offset;
  const boundary = matcher.exec(text);
  return boundary ? offset + boundary.index : to;
}

function backtickRunEnd(source: string, from: number): number {
  let end = from;
  while (source[end] === '`') end++;
  return end;
}

/** Inline code may cross soft line breaks, but never a paragraph or block boundary. */
export function inlineCodeEnd(source: string, from: number): number {
  return codeSpanEnd(source, from);
}

interface InlineScanContext {
  paragraphEnd(from: number): number;
  nextCodeEnd(from: number, openingEnd: number): number;
}

function codeSpanEnd(source: string, from: number, context?: InlineScanContext): number {
  if (source[from] !== '`') return -1;
  const openingEnd = backtickRunEnd(source, from);
  let search = openingEnd;
  const length = openingEnd - from;
  const limit = context ? context.paragraphEnd(search) : source.length;
  if (context) {
    const end = context.nextCodeEnd(from, openingEnd);
    return end >= 0 && end - length < limit ? end : -1;
  }
  while ((search = source.indexOf('`', search)) >= 0 && search < limit) {
    const end = backtickRunEnd(source, search);
    if (end - search === length) {
      // Standalone/public callers only need to inspect the candidate span.
      // Include its closing backticks so an artificial EOF cannot create a block.
      return search < inlineParagraphEnd(source, openingEnd, end) ? end : -1;
    }
    search = end;
  }
  return -1;
}

/** Conservative Markdown guards shared by parsing and save planning. */
function scanProtected(source: string, lines: SourceLine[], front?: SourceRange, raw?: HybridRaw[], diagnostics?: HybridDiagnostic[], path = ''): SourceRange[] {
  const ranges: SourceRange[] = front ? [front] : [];
  const lineByOffset = new Map(lines.map(line => [line.from, line]));
  // Closing-delimiter lookups may jump ahead of the main cursor. A local
  // parity table makes both forward and out-of-order escape checks constant
  // time, including long runs of backslashes; it dies with this scan.
  const escapeFlags = new Uint8Array(source.length);
  let parity = 0;
  for (let i = 0; i < source.length; i++) {
    escapeFlags[i] = parity;
    parity = source[i] === '\\' ? parity ^ 1 : 0;
  }
  const escapedAt = (offset: number): boolean => escapeFlags[offset] === 1;
  // The scanner advances monotonically. Reuse the next block boundary until
  // it is passed; no global source cache (or retained private body) is needed.
  let boundaryFrom = -1, boundaryEnd = -1;
  const paragraphEnd = (from: number): number => {
    if (from < boundaryFrom || from > boundaryEnd) {
      boundaryFrom = from;
      boundaryEnd = inlineParagraphEnd(source, from);
    }
    return boundaryEnd;
  };
  // Index each backtick run once, grouped by length. Per-length cursors only
  // move forward, including a suffix opener inside an escaped opening run.
  let codeRuns: Map<number, number[]> | undefined;
  const codePositions = new Map<number, number>();
  const nextCodeEnd = (from: number, openingEnd: number): number => {
    if (!codeRuns) {
      codeRuns = new Map();
      let start = source.indexOf('`');
      while (start >= 0) {
        const end = backtickRunEnd(source, start);
        const length = end - start;
        const runs = codeRuns.get(length) ?? [];
        runs.push(end);
        codeRuns.set(length, runs);
        start = source.indexOf('`', end);
      }
    }
    const length = openingEnd - from;
    const runs = codeRuns.get(length);
    if (!runs) return -1;
    let position = codePositions.get(length) ?? 0;
    while (position < runs.length && runs[position] <= openingEnd) position++;
    codePositions.set(length, position);
    return runs[position] ?? -1;
  };
  const inlineContext: InlineScanContext = { paragraphEnd, nextCodeEnd };
  const protect = (from: number, to: number) => { ranges.push({ from, to }); return to; };
  // Cache the next unescaped closer (including a missing one). Starts advance
  // monotonically for each of the four math tokens even after a boundary
  // rejects a candidate, so a missing closer is never searched through again.
  const delimiterCache = new Map<string, { from: number; close: number }>();
  const delimiterEnd = (token: string, start: number): number => {
    const cached = delimiterCache.get(token);
    if (cached && start >= cached.from && (cached.close < 0 || start <= cached.close)) return cached.close;
    let close = source.indexOf(token, start);
    while (close >= 0 && escapedAt(close)) close = source.indexOf(token, close + token.length);
    delimiterCache.set(token, { from: start, close });
    return close;
  };
  let cursor = front?.to ?? 0;
  while (cursor < source.length) {
    const line = lineByOffset.get(cursor);
    if (line) {
      const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        const token = fence[1][0], length = fence[1].length;
        let closing = line.line + 1;
        const endFence = new RegExp(`^ {0,3}${token === '`' ? '`' : '~'}{${length},}[ \\t]*$`);
        while (closing < lines.length && !endFence.test(lines[closing].text)) closing++;
        cursor = protect(cursor, closing < lines.length ? lines[closing].end : source.length);
        continue;
      }
      if (/^ {0,3}>/.test(line.text)) {
        let last = line.line;
        while (last + 1 < lines.length) {
          const next = lines[last + 1].text;
          if (/^ {0,3}>/.test(next)) { last++; continue; }
          // Lazy paragraph continuation belongs to the quote until a blank or a new block.
          if (!next.trim() || /^ {0,3}(?:#{1,6}(?:\s|$)|`{3,}|~{3,}|\$\$|[-+*]\s|\d+[.)]\s|(?:-{3,}|_{3,}|\*{3,})\s*$)/.test(next)) break;
          last++;
        }
        cursor = protect(cursor, lines[last].end); continue;
      }
      if (/^(?: {4}|\t)/.test(line.text)) { cursor = protect(cursor, line.end); continue; }
    }
    if (!escapedAt(cursor) && (source.startsWith('%%', cursor) || source.startsWith('<!--', cursor))) {
      const html = source.startsWith('<!--', cursor);
      const opening = html ? 4 : 2, token = html ? '-->' : '%%';
      const close = source.indexOf(token, cursor + opening);
      cursor = protect(cursor, close < 0 ? source.length : close + token.length);
      continue;
    }
    if (source[cursor] === '`' && !escapedAt(cursor)) {
      const runEnd = backtickRunEnd(source, cursor);
      const end = codeSpanEnd(source, cursor, inlineContext);
      if (end >= 0) { cursor = protect(cursor, end); continue; }
      cursor = runEnd; continue;
    }
    const math = !escapedAt(cursor) && (source.startsWith('$$', cursor) ? '$$' : source.startsWith('\\[', cursor) ? '\\[' : source.startsWith('\\(', cursor) ? '\\(' : source[cursor] === '$' ? '$' : undefined);
    if (math) {
      const token = math === '\\[' ? '\\]' : math === '\\(' ? '\\)' : math;
      let close = delimiterEnd(token, cursor + math.length);
      const inline = math === '$' || math === '\\(';
      if (inline) {
        // Code and inline math share the same paragraph/block boundary semantics.
        if (close >= paragraphEnd(cursor + math.length)) close = -1;
      }
      if (close < 0 && !inline) diagnostics?.push({code:'unclosed-math',message:'Unclosed block math region',path,line:line?.line,severity:'error'});
      if (close >= 0 || !inline) { cursor = protect(cursor, close < 0 ? source.length : close + token.length); continue; }
    }
    if (raw && source.startsWith('\\{', cursor) && !escapedAt(cursor)) {
      const region = scanRaw(source, cursor);
      raw.push(region);
      cursor = protect(cursor, region.to);
      continue;
    }
    cursor++;
  }
  return ranges;
}

function applyMetadata(tree: HybridTree, values: Record<string, unknown>, diagnostics: HybridDiagnostic[]): void {
  const list = (key: string, numbers = false): string[] | undefined => {
    if (!has(values, key)) return [];
    const value = values[key];
    const entries = Array.isArray(value) ? value : [value];
    if (entries.every(entry => typeof entry === 'string' || (numbers && typeof entry === 'number' && Number.isFinite(entry)))) return entries.map(String);
    diagnostics.push({ code: 'invalid-metadata', message: `${key} must be a string or list of strings`, path: tree.path, line: tree.line, severity: 'error' });
    return undefined;
  };
  for (const key of ['publish', 'public-title'] as const) {
    if (!has(values, key)) continue;
    const property = key === 'publish' ? 'publish' : 'publicTitle';
    if (typeof values[key] === 'boolean') tree.meta[property] = values[key] as boolean;
    else {
      tree.meta[property] = false;
      diagnostics.push({ code: 'invalid-metadata', message: `${key} must be a boolean, not a string or another YAML type`, path: tree.path, line: tree.line, severity: 'error' });
    }
  }
  tree.meta.authors = [...tree.meta.authors, ...(list('authors') ?? [])];
  tree.meta.dates = [...tree.meta.dates, ...(list('dates', true) ?? [])];
  if (has(values, 'contributors')) {
    const contributors = list('contributors');
    if (contributors) tree.meta.contributors = [...(tree.meta.contributors ?? []), ...contributors];
  }
  for (const key of ['position', 'institution', 'venue', 'source', 'doi', 'orcid', 'external', 'slides', 'video', 'bibtex', 'author']) {
    if (!has(values, key)) continue;
    // Native `author: false` controls display, not author attribution or inheritance.
    const entries = key === 'author' && typeof values[key] === 'boolean' ? [String(values[key])] : list(key);
    if (!entries) continue;
    const properties = tree.meta.properties ?? (tree.meta.properties = {});
    properties[key] = [...(properties[key] ?? []), ...entries];
  }
  if (has(values, 'citation-authors')) {
    tree.meta.citationAuthors = list('citation-authors') ?? [];
    tree.meta.citationAuthorsDeclared = true;
  }
  for (const key of ['title', 'taxon'] as const) {
    if (!has(values, key)) continue;
    if (typeof values[key] === 'string' && (values[key] as string).trim()) {
      tree.meta[key] = values[key] as string;
      if (key === 'title') tree.meta.titleSource = 'metadata';
    } else diagnostics.push({ code: 'invalid-metadata', message: `${key} must be a nonempty string`, path: tree.path, line: tree.line, severity: 'error' });
  }
  const year = values['publication-year'];
  if (has(values, 'publication-year')) {
    if (typeof year === 'string' || (typeof year === 'number' && Number.isFinite(year))) {
      tree.meta.publicationYear = String(year);
      tree.meta.publicationYearDeclared = true;
    } else diagnostics.push({ code: 'invalid-metadata', message: 'publication-year must be a string or finite number', path: tree.path, line: tree.line, severity: 'error' });
  }
  if (diagnostics.some(d => d.path === tree.path && d.line === tree.line && d.severity === 'error' && (d.code === 'invalid-metadata' || d.code === 'invalid-frontmatter'))) {
    tree.meta.publish = false;
    tree.meta.publicTitle = false;
  }
}

const taxonAliases = new Map([['ref', 'Reference'], ['reference', 'Reference'], ['person', 'Person']]);
const knownTaxon = (tag: string): string | undefined => taxonAliases.get(tag.toLowerCase());
const tagLine = /^(#[\p{L}\p{N}_/-]+)(?:[ \t]+#[\p{L}\p{N}_/-]+)*[ \t]*$/u;

function headingTaxon(title: string, safeTitle: string, path: string, line: number, diagnostics: HybridDiagnostic[]): { title: string; taxon?: string } {
  const tags: { tag: string; from: number; to: number }[] = [];
  const matcher = /(?:^|\s)#([\p{L}\p{N}_/-]+)(?=\s|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(safeTitle))) if (knownTaxon(match[1])) tags.push({ tag: match[1], from: match.index, to: matcher.lastIndex });
  if (tags.length === 1) {
    const tag = tags[0];
    return { title: (title.slice(0, tag.from) + title.slice(tag.to)).trim(), taxon: knownTaxon(tag.tag) };
  }
  if (tags.length > 1) diagnostics.push({ code: 'ambiguous-taxon', message: 'Heading has multiple taxon tags', path, line, severity: 'warning' });
  return { title };
}

function consumeMetadata(tree: HybridTree, source: string, diagnostics: HybridDiagnostic[]): void {
  let cursor = tree.contentFrom;
  let tagConsumed = false;
  while (cursor < source.length) {
    const whitespace = /^(?:[ \t]*\r?\n)*/.exec(source.slice(cursor))![0];
    const start = cursor + whitespace.length;
    const newline = source.indexOf('\n', start);
    const endOfLine = newline < 0 ? source.length : newline + 1;
    const line = start < source.length ? { text: source.slice(start, newline < 0 ? endOfLine : newline).replace(/\r$/, ''), end: endOfLine - start } : undefined;
    if (!tagConsumed && line && /^ {0,3}#/.test(line.text) && tagLine.test(line.text.trim())) {
      const tags = line.text.trim().split(/[ \t]+/);
      if (tags.length !== 1) {
        diagnostics.push({ code: 'ambiguous-taxon', message: 'A dedicated taxon line must contain exactly one tag', path: tree.path, line: tree.line, severity: 'warning' });
        return;
      }
      tagConsumed = true;
      const taxon = tags[0].slice(1);
      tree.meta.taxon = knownTaxon(taxon) ?? taxon;
      tree.metadataRanges.push({ from: start, to: start + line.end });
      cursor = start + line.end;
      cursor += /^(?:[ \t]*\r?\n)*/.exec(source.slice(cursor))![0].length;
      tree.contentFrom = cursor;
      continue;
    }
    const opening = /^ {0,3}%%/.exec(source.slice(start));
    if (!opening) { tree.contentFrom = cursor; return; }
    const content = start + opening[0].length;
    const close = source.indexOf('%%', content);
    let yaml = source.slice(content, close < 0 ? source.length : close).trim();
    if (!/^(?:forester(?:\s|$)|[\w-]+\s*:|\{)/.test(yaml)) return;
    if (close < 0) {
      diagnostics.push({ code: 'invalid-metadata', message: 'Unclosed Forester metadata comment', path: tree.path, line: tree.line, severity: 'error' });
      tree.meta.publish = false;
      tree.meta.publicTitle = false;
      tree.metadataRanges.push({ from: start, to: source.length });
      tree.contentFrom = source.length;
      return;
    }
    yaml = yaml.replace(/^forester(?:\s+|$)/, '').trim();
    if (!yaml.includes('\n') && /,\s*[\w-]+\s*:/.test(yaml) && !yaml.startsWith('{')) yaml = `{${yaml}}`;
    try {
      applyMetadata(tree, readYamlMapping(yaml), diagnostics);
    } catch (error) {
      diagnostics.push({ code: 'invalid-metadata', message: error instanceof Error ? error.message : String(error), path: tree.path, line: tree.line, severity: 'error' });
      tree.meta.publish = false;
      tree.meta.publicTitle = false;
    }
    let end = close + 2;
    const ending = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(end));
    if (ending) end += ending[0].length;
    tree.metadataRanges.push({ from: start, to: end });
    cursor = end;
    const blanks = /^(?:[ \t]*\r?\n)*/.exec(source.slice(cursor))![0];
    cursor += blanks.length;
    tree.contentFrom = cursor;
  }
}

/** Parse the opt-in dialect without changing the source. Disabled notes remain ordinary Markdown. */
export function parseHybrid(path: string, source: string, options: HybridOptions): HybridDocument {
  const diagnostics: HybridDiagnostic[] = [];
  const fm = frontmatter(source, path, diagnostics);
  const enabled = diagnostics.length === 0 && modeEnabled(path, fm.value, options, diagnostics, true);
  const lines = enabled ? sourceLines(source) : [];
  const raw: HybridRaw[] = [];
  const protectedRanges = enabled ? scanProtected(source, lines, fm.range, raw, diagnostics, path) : fm.range ? [fm.range] : [];
  for (const region of raw) if (region.error) diagnostics.push({ code: 'unclosed-raw', message: region.error, path, line: lines.find(line => line.from <= region.from && region.from < line.end)?.line, severity: 'error' });
  const root: HybridTree = {
    key: `${path}:root`, path, level: 1, line: 0, headingTitle: null,
    endLine: enabled ? lines.length : sourceLineCount(source), from: 0, to: source.length, contentFrom: 0,
    meta: { title: path.split('/').pop()!.replace(/\.md$/i, ''), titleSource: 'filename', authors: [], dates: [], citationAuthors: [], publish: false, publicTitle: false },
    metadataRanges: [], children: [], number: '',
  };
  if (enabled) {
    if (has(fm.value, 'id')) diagnostics.push({ code: 'legacy-id', message: 'Legacy id is not a root identity; use forester-id', path, line: 0, severity: 'warning' });
    if (has(fm.value, 'forester-id')) {
      const id = fm.value['forester-id'];
      if (typeof id === 'string' && /^[A-Za-z0-9-]+$/.test(id)) root.id = id;
      else diagnostics.push({ code: 'invalid-id', message: 'forester-id must be a nonempty string of letters, digits or hyphens', path, line: 0, severity: 'error' });
    }
    root.meta.publish = inFolders(path, options.publicFolders);
    root.contentFrom = fm.range?.to ?? 0;
    root.metadataRanges = fm.range ? [fm.range] : [];
    const h1 = lines.find(line => line.from >= root.contentFrom && /^ {0,3}#[ \t]+/.test(line.text) && !overlaps(protectedRanges, line.from, line.from + line.text.indexOf('#') + 1));
    if (h1) {
      const title = h1.text.replace(/^ {0,3}#[ \t]+/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      const from = h1.from + h1.text.indexOf(title, 1);
      const classified = headingTaxon(title, maskSpan(source, from, from + title.length, protectedRanges), path, h1.line, diagnostics);
      root.meta.title = classified.title;
      root.meta.titleSource = 'heading';
      root.meta.taxon = classified.taxon;
      root.headingTitle = root.meta.title;
    }
    const fallbackTitle = root.meta.title;
    const fallbackTitleSource = root.meta.titleSource;
    applyMetadata(root, fm.value, diagnostics);
    consumeMetadata(root, source, diagnostics);
    if (h1 && source.slice(root.contentFrom, h1.from).trim() === '' && root.contentFrom <= h1.from) {
      root.contentFrom = h1.end;
      consumeMetadata(root, source, diagnostics);
    }
    root.meta.title = typeof fm.value.title === 'string' && fm.value.title.trim() ? fm.value.title : fallbackTitle;
    root.meta.titleSource = typeof fm.value.title === 'string' && fm.value.title.trim() ? 'metadata' : fallbackTitleSource;
  }
  const trees = [root];
  if (enabled) {
    const stack = [root];
    for (const line of lines) {
      if (line.from < (fm.range?.to ?? 0)) continue;
      const heading = /^ {0,3}(#{1,6})(?:[ \t]+(.*?)|[ \t]*)$/.exec(line.text);
      if (!heading || overlaps(protectedRanges, line.from, line.from + line.text.indexOf('#') + heading[1].length)) continue;
      const level = heading[1].length;
      while (stack.length > 1 && stack[stack.length - 1].level >= level) {
        const ended = stack.pop()!;
        ended.to = line.from;
        ended.endLine = line.line;
      }
      if (level === 1) continue;
      let title = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '').trim();
      const titleFrom = line.from + line.text.indexOf(title, level);
      let safeTitle = maskSpan(source, titleFrom, titleFrom + title.length, protectedRanges);
      let anchor = /(?:^|\s)\^([A-Za-z0-9-]+)$/.exec(safeTitle);
      const carets = (safeTitle.match(/(?:^|\s)\^/g) ?? []).length;
      if (carets && (carets !== 1 || !anchor)) {
        diagnostics.push({ code: 'invalid-id', message: 'Heading must have at most one valid final native caret ID', path, line: line.line, severity: 'error' });
        anchor = null;
      }
      const id = anchor?.[1];
      if (anchor) { title = title.slice(0, anchor.index).trim(); safeTitle = safeTitle.slice(0, title.length); }
      const classified = headingTaxon(title, safeTitle, path, line.line, diagnostics);
      title = classified.title;
      const taxon = classified.taxon;
      const parent = stack[stack.length - 1];
      const child: HybridTree = {
        key: `${path}:${line.from}`, id, path, parentKey: parent.key, level, line: line.line, headingTitle: title,
        endLine: lines.length, from: line.from, to: source.length, contentFrom: line.end,
        meta: { title, titleSource: 'heading', taxon, authors: [...parent.meta.authors], dates: [...parent.meta.dates], citationAuthors: [], publish: parent.meta.publish, publicTitle: false }, metadataRanges: [], children: [],
        number: [parent.number, String(parent.children.length + 1)].filter(Boolean).join('.'),
      };
      consumeMetadata(child, source, diagnostics);
      parent.children.push(child);
      trees.push(child);
      stack.push(child);
    }
  }
  const document: HybridDocument = { path, source, enabled, frontmatter: fm.value, root, trees, protectedRanges, raw, diagnostics };
  reservations.set(document, [...options.reservedIds]);
  return document;
}

const stem = (path: string): string => path.split('/').pop()!.replace(/\.md$/i, '');
function aliases(document: HybridDocument): string[] {
  const value = document.frontmatter.aliases;
  return (Array.isArray(value) ? value : typeof value === 'string' ? [value] : []).filter((item): item is string => typeof item === 'string');
}

/** Keep all conflicting identities; consumers must not choose the first match. Keys are lowercase. */
export function indexHybrid(documents: Iterable<HybridDocument>): HybridIndex {
  const indexed = new Map<string, HybridDocument>();
  for (const document of documents) indexed.set(document.path, document);
  const ids = new Map<string, HybridTree[]>();
  const diagnostics: HybridDiagnostic[] = [];
  for (const document of indexed.values()) {
    diagnostics.push(...document.diagnostics);
    if (!document.enabled) continue;
    for (const tree of document.trees) {
      if (!tree.id) continue;
      const key = tree.id.toLowerCase();
      const matches = ids.get(key) ?? [];
      matches.push(tree);
      ids.set(key, matches);
    }
  }
  for (const [id, matches] of ids) if (matches.length > 1) {
    for (const tree of matches) diagnostics.push({ code: 'duplicate-id', message: `Identity ${id} is not globally unique`, path: tree.path, line: tree.line, severity: 'error' });
  }
  for (const document of indexed.values()) {
    for (const [name, code] of [[stem(document.path), 'file-id-collision'], ...aliases(document).map(alias => [alias, 'alias-id-collision'])]) {
      if (ids.has(name.toLowerCase())) diagnostics.push({ code, message: `File name or alias ${name} collides with a tree identity`, path: document.path, severity: 'warning' });
    }
  }
  return { documents: indexed, ids, diagnostics };
}

function resolution(index: HybridIndex, trees: HybridTree[], target: string): HybridResolution {
  const unique = [...new Map(trees.map(tree => [tree.key, tree])).values()];
  if (!unique.length) return { status: 'missing', message: `Target not found: ${target}` };
  if (unique.length > 1) return { status: 'ambiguous', message: `Target has multiple matches: ${target}` };
  const tree = unique[0];
  return { status: 'resolved', tree, document: index.documents.get(tree.path)! };
}

function normalizedPath(path: string): string {
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}
function fileMatches(index: HybridIndex, file: string, fromPath: string): HybridDocument[] {
  const directory = fromPath.split('/').slice(0, -1).join('/');
  const relative = file.startsWith('./') || file.startsWith('../');
  const wanted = normalizedPath(relative ? `${directory}/${file}` : file).replace(/\.md$/i, '').toLowerCase();
  const documents = [...index.documents.values()];
  const exact = documents.filter(document => document.path.replace(/\.md$/i, '').toLowerCase() === wanted);
  if ((exact.length && (relative || file.includes('/') || /\.md$/i.test(file))) || relative || file.includes('/')) return exact;
  if (/\.md$/i.test(file)) {
    const local = normalizedPath(`${directory}/${file}`).replace(/\.md$/i, '').toLowerCase();
    const nearby = documents.filter(document => document.path.replace(/\.md$/i, '').toLowerCase() === local);
    if (nearby.length) return nearby;
  }
  return documents.filter(document => [stem(document.path), ...aliases(document)].some(name => name.toLowerCase() === wanted));
}

/** Resolve file paths/anchors before bare names; preserve duplicate heading and ID ambiguity. */
export function resolveHybrid(index: HybridIndex, target: string, fromPath: string): HybridResolution {
  const hash = target.indexOf('#');
  if (hash >= 0) {
    const file = target.slice(0, hash), anchor = target.slice(hash + 1);
    const documents = file ? fileMatches(index, file, fromPath) : [index.documents.get(fromPath)].filter((doc): doc is HybridDocument => !!doc);
    if (documents.length !== 1) return { status: documents.length ? 'ambiguous' : 'missing', message: `File is not unique or missing: ${file || fromPath}` };
    const document = documents[0];
    if (anchor.startsWith('^')) {
      const id = anchor.slice(1);
      if (!/^[A-Za-z0-9-]+$/.test(id)) return { status: 'missing', message: 'Invalid block identity' };
      const global = index.ids.get(id.toLowerCase()) ?? [];
      if (global.length > 1) return { status: 'ambiguous', message: `Duplicate global identity: ${id}` };
      return resolution(index, global.filter(tree => tree.path === document.path), target);
    }
    const segments = anchor.split('#').map(segment => segment.toLowerCase());
    const byKey = new Map(document.trees.map(tree => [tree.key, tree]));
    const candidates = document.trees.filter(tree => {
      if (headingName(tree) === null) return false;
      const titles: string[] = [];
      let ancestor: HybridTree | undefined = tree;
      while (ancestor) {
        const name = headingName(ancestor);
        if (name !== null) titles.unshift(name.toLowerCase());
        ancestor = ancestor.parentKey ? byKey.get(ancestor.parentKey) : undefined;
      }
      return segments.every((segment, i) => segment !== '' && segment === titles[titles.length - segments.length + i]);
    });
    return resolution(index, candidates, target);
  }
  if (target.includes('/') || /\.md$/i.test(target)) return resolution(index, fileMatches(index, target, fromPath).map(document => document.root), target);
  const key = target.toLowerCase();
  const candidates = [...(index.ids.get(key) ?? [])];
  for (const document of index.documents.values()) {
    if ([stem(document.path), ...aliases(document)].some(name => name.toLowerCase() === key)) candidates.push(document.root);
  }
  return resolution(index, candidates, target);
}

/** Portable secure randomness: never fall back to Math.random on desktop or mobile. */
function secureRandom(): number {
  if (!globalThis.crypto?.getRandomValues) throw new Error('Secure crypto.getRandomValues is unavailable');
  return globalThis.crypto.getRandomValues(new Uint32Array(1))[0] / 0x100000000;
}

export function drawHybridId(taken: Iterable<string>, reserved: Iterable<string> = [], random: () => number = secureRandom): string {
  const occupied = new Set([...taken, ...reserved].map(id => id.toLowerCase()));
  for (let attempt = 0; attempt < 1024; attempt++) {
    const sample = random();
    if (!Number.isFinite(sample) || sample < 0 || sample >= 1) throw new Error('Invalid random RNG output: expected a finite value in [0, 1)');
    const number = 0x111111 + Math.floor(sample * (0xFFFFFF - 0x111111 + 1));
    const id = number.toString(16).toUpperCase().padStart(6, '0');
    if (!/^\d{6}$/.test(id) && !occupied.has(id.toLowerCase())) return id;
  }
  throw new Error('Unable to draw an available ID after 1024 attempts (RNG or namespace exhaustion)');
}

interface TextChange extends SourceRange { text: string; }
function rootIdChange(source: string, id: string): TextChange {
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  // Six-hex IDs such as 1E0000 are YAML scientific notation unless quoted.
  const scalar = /^[0-9]+E[0-9]+$/.test(id) ? JSON.stringify(id) : id;
  const opening = /^---\r?\n/.exec(source);
  if (opening) return { from: opening[0].length, to: opening[0].length, text: `forester-id: ${scalar}${newline}` };
  return { from: 0, to: 0, text: `---${newline}forester-id: ${scalar}${newline}---${newline}` };
}

/** Pure snapshots only: the caller owns compare-and-swap, writes and target autosave. */
export function planHybridSave(index: HybridIndex, fromPath: string, draw?: () => string): HybridSavePlan {
  const document = index.documents.get(fromPath);
  if (!document) return { edits: [], diagnostics: [] };
  const diagnostics = index.diagnostics.filter(d => d.path === fromPath && d.severity === 'error');
  if (diagnostics.length || !document.enabled) return { edits: [], diagnostics };
  const changes = new Map<string, TextChange[]>();
  const lineCache = new Map<HybridDocument, SourceLine[]>();
  const linesOf = (doc: HybridDocument): SourceLine[] => {
    let lines = lineCache.get(doc);
    if (!lines) { lines = sourceLines(doc.source); lineCache.set(doc, lines); }
    return lines;
  };
  const minted = new Map<string, string>();
  const occupied = new Set(index.ids.keys());
  for (const doc of index.documents.values()) {
    for (const name of [stem(doc.path), ...aliases(doc), ...(reservations.get(doc) ?? [])]) occupied.add(name.toLowerCase());
  }
  const allocate = (): string => {
    for (let attempt = 0; attempt < 1024; attempt++) {
      const id = draw ? draw() : drawHybridId(occupied);
      if (typeof id !== 'string' || !/^[0-9A-F]{6}$/.test(id) || /^\d{6}$/.test(id) || parseInt(id, 16) < 0x111111) throw new Error('ID allocator must return uppercase nondecimal six-hex ID in 111111..FFFFFF');
      if (occupied.has(id.toLowerCase())) continue;
      occupied.add(id.toLowerCase());
      return id;
    }
    throw new Error('ID allocator exhausted 1024 attempts');
  };
  const change = (doc: HybridDocument, edit: TextChange) => {
    const edits = changes.get(doc.path) ?? [];
    edits.push(edit); changes.set(doc.path, edits);
  };
  const ensureRoot = (doc: HybridDocument): string => {
    const existing = doc.root.id ?? minted.get(doc.root.key);
    if (existing) return existing;
    const id = allocate();
    minted.set(doc.root.key, id);
    change(doc, rootIdChange(doc.source, id));
    return id;
  };
  const ensureTree = (tree: HybridTree, doc: HybridDocument): string => {
    if (tree === doc.root) return ensureRoot(doc);
    ensureRoot(doc);
    const existing = tree.id ?? minted.get(tree.key);
    if (existing) return existing;
    const id = allocate();
    minted.set(tree.key, id);
    const line = linesOf(doc)[tree.line];
    const suffix = /[ \t]+#+[ \t]*$/.exec(line.text);
    const from = line.from + (suffix ? suffix.index : line.text.replace(/[ \t]+$/, '').length);
    change(doc, { from, to: from, text: ` ^${id}` });
    return id;
  };
  const references: { target: string; hash: number; from: number; labelAt?: number; tree: HybridTree; document: HybridDocument }[] = [];
  const links = /!?\[\[([^\]\r\n]+)\]\]/g;
  let match: RegExpExecArray | null;
  while ((match = links.exec(document.source))) {
    if (overlaps(document.protectedRanges, match.index, links.lastIndex) || escaped(document.source, match.index)) continue;
    const target = match[1].split('|')[0];
    const hash = target.indexOf('#');
    const fixesHeading = hash >= 0 && target[hash + 1] !== '^';
    const needsLabel = !match[0].startsWith('!') && !match[1].includes('|');
    if (!fixesHeading && !needsLabel) continue;
    const resolved = resolveHybrid(index, target, fromPath);
    if (resolved.status !== 'resolved') {
      if (fixesHeading || resolved.status === 'ambiguous') diagnostics.push({ code: resolved.status === 'ambiguous' ? 'ambiguous-reference' : 'missing-reference', message: resolved.message, path: fromPath, line: linesOf(document).find(line => line.from <= match!.index && match!.index < line.end)?.line, severity: 'warning' });
      continue;
    }
    if (!resolved.document.enabled) continue;
    const from = match.index + (match[0].startsWith('!') ? 3 : 2);
    references.push({ target, hash: fixesHeading ? hash : -1, from, labelAt: needsLabel ? from + target.length : undefined, tree: resolved.tree, document: resolved.document });
  }
  const touched = new Set(references.map(reference => reference.document.path));
  for (const diagnostic of index.diagnostics) if (touched.has(diagnostic.path) && diagnostic.path !== fromPath && diagnostic.severity === 'error') diagnostics.push(diagnostic);
  if (diagnostics.some(d => d.severity === 'error')) return { edits: [], diagnostics };
  try {
    ensureRoot(document);
    // Explicit publication under a private parent requires a stable independent route.
    for (const tree of document.trees) {
      const parent = tree.parentKey ? document.trees.find(candidate => candidate.key === tree.parentKey) : undefined;
      if (tree !== document.root && tree.meta.publish && !parent?.meta.publish) ensureTree(tree, document);
    }
    for (const reference of references) {
      if (reference.hash >= 0) {
        const id = ensureTree(reference.tree, reference.document);
        change(document, { from: reference.from, to: reference.from + reference.target.length, text: `${reference.target.slice(0, reference.hash)}#^${id}` });
      }
      if (reference.labelAt !== undefined && reference.tree.meta.title.trim()) {
        // Generated titles are literal text, not new code/math/comments/raw regions.
        const label = encodeWikilinkLabel(reference.tree.meta.title.trim().replace(/[\r\n]+/g, ' '));
        change(document, { from: reference.labelAt, to: reference.labelAt, text: `|${label}` });
      }
    }
  } catch (error) {
    diagnostics.push({ code: 'id-allocation-failed', message: error instanceof Error ? error.message : String(error), path: fromPath, severity: 'error' });
    return { edits: [], diagnostics };
  }
  const edits = [...changes].map(([path, edits]) => {
    const before = index.documents.get(path)!.source;
    let after = before;
    for (const edit of [...edits].sort((a, b) => b.from - a.from || b.to - a.to)) after = after.slice(0, edit.from) + edit.text + after.slice(edit.to);
    return { path, before, after };
  }).filter(edit => edit.before !== edit.after);
  return { edits, diagnostics };
}
