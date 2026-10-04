import type { HybridDiagnostic, HybridDocument, HybridIndex, HybridTree, PublicProjection, PublicTree, SourceRange } from './hybrid-types';
import { inlineCodeEnd, resolveHybrid } from './hybrid-core';
import { decodeWikilinkLabel, encodeWikilinkLabel } from './hybrid-literal-label';

function error(code: string, message: string): HybridDiagnostic {
  return { code, message, path: '', severity: 'error' };
}

function visibleBody(document: HybridDocument, tree: HybridTree): string {
  const omissions: SourceRange[] = document.trees
    .filter(child => child !== tree && !child.meta.publish && child.from >= tree.contentFrom && child.to <= tree.to)
    .map(child => ({ from: child.from, to: child.to }));
  for (const node of document.trees) {
    for (const range of node.metadataRanges) {
      if (range.from >= tree.contentFrom && range.to <= tree.to) omissions.push(range);
    }
  }
  omissions.sort((a, b) => a.from - b.from);
  let cursor = tree.contentFrom;
  let body = '';
  for (const range of omissions) {
    body += document.source.slice(cursor, Math.max(cursor, range.from));
    cursor = Math.max(cursor, range.to);
  }
  return body + document.source.slice(cursor, tree.to);
}

function escapedAt(text: string, offset: number): boolean {
  let slashes = 0;
  while (offset > 0 && text[--offset] === '\\') slashes++;
  return slashes % 2 === 1;
}

/** Literal code is retained, never evaluated. Comments are stripped before validating live text. */
function markdown(text: string, live: (text: string) => string): string {
  let result = '';
  let pending = '';
  let cursor = 0;
  let listContext = false;
  const literal = (end: number) => {
    result += live(pending) + text.slice(cursor, end);
    pending = '';
    cursor = end;
  };
  while (cursor < text.length) {
    if (cursor === 0 || text[cursor - 1] === '\n') {
      const line = text.slice(cursor).match(/^[^\n]*(?:\n|$)/)![0];
      if (/^ {0,3}(?:[-+*]|\d+[.)])\s/.test(line)) listContext = true;
      else if (/^\S/.test(line) && line.trim()) listContext = false;
      const fence = line.match(/^ {0,3}(`{3,}|~{3,})([^\n]*)(?:\n|$)/);
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) {
        const start = cursor + line.length;
        const close = new RegExp(`^ {0,3}${fence[1][0]}{${fence[1].length},}[ \\t]*\\r?$`, 'm').exec(text.slice(start));
        const closingEnd = close ? text.indexOf('\n', start + close.index) : -1;
        literal(close ? (closingEnd < 0 ? text.length : closingEnd + 1) : text.length);
        continue;
      }
      const previous = cursor === 0 ? '' : text.slice(text.lastIndexOf('\n', cursor - 2) + 1, cursor - 1);
      if (!listContext && !previous.trim() && /^(?: {4}|\t)/.test(line)) {
        let end = cursor;
        while (end < text.length) {
          const next = text.slice(end).match(/^[^\n]*(?:\n|$)/)![0];
          if (next.trim() && !/^(?: {4}|\t)/.test(next)) break;
          end += next.length;
        }
        literal(end);
        continue;
      }
    }
    const comment = text.startsWith('<!--', cursor) ? ['<!--', '-->'] : text.startsWith('%%', cursor) ? ['%%', '%%'] : undefined;
    if (comment) {
      const end = text.indexOf(comment[1], cursor + comment[0].length);
      cursor = end < 0 ? text.length : end + comment[1].length;
      continue;
    }
    if (text[cursor] === '`' && !escapedAt(text, cursor)) {
      const opening = text.slice(cursor).match(/^`+/)![0];
      const closing = inlineCodeEnd(text, cursor);
      if (closing >= 0) { literal(closing); continue; }
      pending += opening;
      cursor += opening.length;
      continue;
    }
    pending += text[cursor++];
  }
  return (result + live(pending)).replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
}

function plainText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/[\\`*_{}\[\]()!#<>~|]/g, '\\$&');
}

/** Explicit declarations belong to their tree; unknown same-value inheritance stays conservative. */
function publicBibliography(document: HybridDocument, tree: HybridTree): Pick<PublicTree, 'citationAuthors' | 'publicationYear'> {
  const byKey = new Map(document.trees.map(node => [node.key, node]));
  const visibleOrigin = (author?: string): boolean => {
    let current = tree;
    const visited = new Set<string>();
    while (!visited.has(current.key)) {
      visited.add(current.key);
      const declared = author !== undefined ? current.meta.citationAuthorsDeclared : current.meta.publicationYearDeclared;
      if (declared) return current.meta.publish;
      const parent = current.parentKey ? byKey.get(current.parentKey) : undefined;
      const equal = parent && (author !== undefined ? parent.meta.citationAuthors.includes(author) :
        current.meta.publicationYear === parent.meta.publicationYear);
      if (!parent || !equal) return current.meta.publish;
      current = parent;
    }
    return false;
  };
  return { citationAuthors: tree.meta.citationAuthors.filter(author => visibleOrigin(author)),
    ...(tree.meta.publicationYear !== undefined && visibleOrigin() ? { publicationYear: tree.meta.publicationYear } : {}) };
}

function safeExternalUrl(value: string): boolean {
  if (/[\s\\<>\u0000-\u001f\u007f]/.test(value)) return false;
  try {
    const url = new URL(value);
    return !url.username && !url.password &&
      ((['http:', 'https:'].includes(url.protocol) && !!url.hostname) ||
        (url.protocol === 'mailto:' && !!url.pathname));
  } catch { return false; }
}

/** Only explicit safe schemes are accepted; entities/encoded schemes do not gain permission. */
const INLINE_LINK = /\[([^\]\n]*)\]\(\s*(<[^>\n]*>|[^)\s]*)(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'))?[ \t]*\)/g;
const REFERENCES = /\{ref:\s*\[\[([^\]\n]+)\]\]\s*\}|(!?)\[\[([^\]\n]+)\]\]/g;
const LINKS = new RegExp(`${REFERENCES.source}|${INLINE_LINK.source}`, 'g');

function localDestination(value: string): boolean {
  return !!value && !/[:%&\\<>\u0000-\u001f\u007f]/.test(value);
}

function inspectUrls(active: string, diagnostics: HybridDiagnostic[]): string {
  const check = (destination: string) => {
    if (!safeExternalUrl(destination)) diagnostics.push(error('unsafe-url', '安全な公開URLを確認できません。'));
  };
  let remainder = active.replace(INLINE_LINK, (_literal, _label: string, destination: string) => {
    const value = destination.replace(/^<|>$/g, '');
    if (!localDestination(value)) check(value);
    return '';
  });
  remainder = remainder.replace(/^ {0,3}\[[^\]\n]+\]:[ \t]*(<[^>\n]*>|\S+)/gm,
    (_literal, destination: string) => { check(destination.replace(/^<|>$/g, '')); return ''; });
  if (/\]\s*\(|^ {0,3}\[[^\]\n]+\]:/m.test(remainder)) {
    diagnostics.push(error('unsafe-url', '安全な公開URLを確認できません。'));
  }
  return active.replace(INLINE_LINK, (_literal, label: string) => label)
    .replace(/<([A-Za-z][A-Za-z0-9+.-]*:[^<>\n]*)>/g,
      (_literal, destination: string) => { check(destination); return ''; });
}

function referenceText(document: HybridDocument, index: HybridIndex, diagnostics: HybridDiagnostic[],
  stack: string[], reference: string, embed = false, citation = false, budget = { remaining: 1024 }): string {
  const [destination, label] = reference.split('|');
  if (/\.[A-Za-z0-9]+(?:#.*)?$/.test(destination) && !/\.md(?:#.*)?$/i.test(destination)) {
    diagnostics.push(error('unvetted-asset', '検証済み公開マニフェストのないアセットは公開できません。'));
    return '';
  }
  const resolved = resolveHybrid(index, destination, document.path);
  const target = resolved.status === 'resolved' ? resolved.tree : undefined;
  const targetEnabled = resolved.status === 'resolved' && resolved.document.enabled;
  if (target && (!target.meta.publish || !targetEnabled)) {
    if (embed) {
      diagnostics.push(error('private-embed', '非公開ツリーは埋め込めません。'));
      return '';
    }
    if (targetEnabled && target.meta.publicTitle && target.meta.titleSource === 'filename') {
      diagnostics.push(error('implicit-public-title', '公開タイトルには明示的なタイトルまたは見出しが必要です。'));
      return '';
    }
    return targetEnabled && target.meta.publicTitle ? `${plainText(target.meta.title)} 🔒` : '[非公開]';
  }
  if (!target) {
    diagnostics.push(error('unresolved-reference', '参照先を一意に確認できないため公開できません。'));
    return '';
  }
  if (citation || embed) {
    const targetDocument = index.documents.get(target.path);
    if (embed && stack.includes(target.key)) {
      diagnostics.push(error('embed-cycle', '循環する埋め込みは公開できません。'));
      return '';
    }
    if (embed && (stack.length >= 64 || --budget.remaining < 0)) {
      diagnostics.push(error('embed-limit', '埋め込みの安全な展開上限を超えています。'));
      return '';
    }
    if (!targetDocument) {
      diagnostics.push(error('unresolved-reference', '参照先を一意に確認できないため公開できません。'));
      return '';
    }
    if (citation) {
      const bibliography = publicBibliography(targetDocument, target);
      if (!bibliography.citationAuthors.length || bibliography.citationAuthors.some(author => !author.trim()) ||
          !bibliography.publicationYear?.trim()) {
        diagnostics.push(error('missing-citation-metadata', '公開引用に必要な文献著者と出版年が不足しています。'));
        return '';
      }
      return `(${bibliography.citationAuthors.map(plainText).join(', ')}, ${plainText(bibliography.publicationYear)})`;
    }
    return `## ${plainText(target.meta.title)}\n\n${projectedBody(targetDocument, target, index, diagnostics, [...stack, target.key], budget)}`;
  }
  // Source aliases have one entity layer; semantic metadata titles have none.
  // Requote decoded labels so Markdown/comments/math cannot reactivate in output.
  const displayLabel = label === undefined ? target.meta.title : decodeWikilinkLabel(label);
  const literalLabel = encodeWikilinkLabel(displayLabel);
  return target.id ? `[[${target.id}|${literalLabel}]]` : literalLabel;
}

function safeLive(active: string, diagnostics: HybridDiagnostic[]): boolean {
  if (/\\\{|\\[A-Za-z][A-Za-z0-9-]*\s*\{/.test(active)) {
    diagnostics.push(error('unsupported-raw', '生Forester式の安全な公開は未対応です。'));
    return false;
  }
  if (/!\[(?!\[)/.test(active)) {
    diagnostics.push(error('unvetted-asset', '検証済み公開マニフェストのないアセットは公開できません。'));
    return false;
  }
  const htmlProbe = inspectUrls(active, diagnostics);
  if (/<(?:\/?[A-Za-z]|[!?])/.test(htmlProbe)) {
    diagnostics.push(error('unsafe-html', '生HTMLの安全な公開は未対応です。'));
    return false;
  }
  if (/\[\[|\{ref:/.test(active.replace(REFERENCES, ''))) {
    diagnostics.push(error('unresolved-reference', '参照先を一意に確認できないため公開できません。'));
    return false;
  }
  return true;
}

function projectedBody(document: HybridDocument, tree: HybridTree, index: HybridIndex,
  diagnostics: HybridDiagnostic[], stack: string[] = [tree.key], budget = { remaining: 1024 }): string {
  return markdown(visibleBody(document, tree), active => {
    if (!safeLive(active, diagnostics)) return '';
    // A single pass over source tokens; never reinterpret expanded bodies or escaped labels.
    return active.replace(LINKS, (literal, citation: string | undefined, embed: string | undefined,
      reference: string | undefined, label: string | undefined, destination: string | undefined) => {
      if (destination !== undefined) {
        const value = destination.replace(/^<|>$/g, '');
        return safeExternalUrl(value) ? literal : referenceText(document, index, diagnostics, stack, `${value}|${label}`, false, false, budget);
      }
      return referenceText(document, index, diagnostics, stack, citation ?? reference!, !!embed, citation !== undefined, budget);
    });
  });
}

/** Reject stale/contradictory ranges and target maps before inspecting any public content. */
function validIndex(index: HybridIndex): boolean {
  const keys = new Set<string>();
  for (const [path, document] of index.documents) {
    const known = new Set(document.trees);
    const byKey = new Map(document.trees.map(tree => [tree.key, tree]));
    if (path !== document.path || !known.has(document.root) || known.size !== document.trees.length ||
        byKey.size !== document.trees.length || document.root.parentKey !== undefined) return false;
    for (const tree of document.trees) {
      if (keys.has(tree.key) || tree.path !== document.path ||
          ![tree.from, tree.contentFrom, tree.to].every(Number.isInteger) ||
          tree.from < 0 || tree.from > tree.contentFrom || tree.contentFrom > tree.to || tree.to > document.source.length) return false;
      keys.add(tree.key);
      if (tree.metadataRanges.some(range => !Number.isInteger(range.from) || !Number.isInteger(range.to) ||
          range.from < 0 || range.from > range.to || range.to > document.source.length)) return false;
      if (tree !== document.root) {
        const parent = tree.parentKey ? byKey.get(tree.parentKey) : undefined;
        if (!parent || !parent.children.includes(tree) || tree.level <= parent.level ||
            tree.from < parent.contentFrom || tree.to > parent.to) return false;
      }
      if (tree.children.some(child => !known.has(child) || child.parentKey !== tree.key)) return false;
      if (tree.id !== undefined && (index.ids.get(tree.id.toLowerCase())?.length !== 1 || index.ids.get(tree.id.toLowerCase())![0] !== tree)) return false;
    }
  }
  for (const [id, targets] of index.ids) {
    if (targets.length !== 1 || targets[0].id?.toLowerCase() !== id || !index.documents.get(targets[0].path)?.trees.includes(targets[0])) return false;
  }
  return true;
}

/** Pure, fail-closed public projection. String metadata is plain text, not executable Markdown. */
export function projectPublic(index: HybridIndex): PublicProjection {
  // The parser partitions lines on LF; bare CR can hide private subtree metadata.
  // Preflight every source, including private/disabled reference and alias targets.
  if ([...index.documents.values()].some(document => /\r(?!\n)/.test(document.source))) {
    return { trees: [], diagnostics: [error('unsupported-line-ending', '未対応の改行を含む入力は公開できません。')] };
  }
  if (index.diagnostics.some(item => item.severity === 'error') ||
      [...index.documents.values()].some(document => document.diagnostics.some(item => item.severity === 'error'))) {
    return { trees: [], diagnostics: [error('invalid-source', '入力にエラーがあるため公開できません。')] };
  }
  if ([...index.ids.values()].some(targets => targets.length > 1)) {
    return { trees: [], diagnostics: [error('id-collision', 'IDの衝突があるため公開できません。')] };
  }
  if ([...index.documents.values()].some(document => document.trees.some(tree =>
    tree.id !== undefined && !/^[A-Za-z0-9-]+$/.test(tree.id)))) {
    return { trees: [], diagnostics: [error('invalid-id', 'IDの形式が不正なため公開できません。')] };
  }
  if (!validIndex(index)) {
    return { trees: [], diagnostics: [error('invalid-index', '入力索引の整合性を確認できないため公開できません。')] };
  }
  const trees: PublicTree[] = [];
  const diagnostics: HybridDiagnostic[] = [];
  for (const document of index.documents.values()) {
    if (!document.enabled) continue;
    const byKey = new Map(document.trees.map(tree => [tree.key, tree]));
    for (const tree of document.trees) {
      if (!tree.meta.publish) continue;
      if (tree.meta.titleSource === 'filename') {
        diagnostics.push(error('implicit-public-title', '公開タイトルには明示的なタイトルまたは見出しが必要です。'));
        continue;
      }
      if (!tree.id) {
        const parent = tree.parentKey ? byKey.get(tree.parentKey) : undefined;
        if (!parent?.meta.publish) diagnostics.push(error('unaddressed-public-tree', '公開する独立ツリーには明示的なIDが必要です。'));
        continue;
      }
      trees.push({ id: tree.id, title: tree.meta.title,
        ...(tree.meta.taxon !== undefined ? { taxon: tree.meta.taxon } : {}),
        body: projectedBody(document, tree, index, diagnostics),
        ...publicBibliography(document, tree) });
    }
  }
  if (!diagnostics.length) {
    const publicIds = new Set(trees.map(tree => tree.id));
    for (const tree of trees) {
      // Expansion can change Markdown block boundaries. Validate the actual composed output,
      // without resolving/expanding again or treating code examples as live dependencies.
      markdown(tree.body, active => {
        if (!safeLive(active, diagnostics)) return active;
        active.replace(REFERENCES, (literal, citation: string | undefined, embed: string | undefined,
          reference: string | undefined) => {
          if (citation !== undefined || embed || !publicIds.has(reference!.split('|')[0])) {
            diagnostics.push(error('unresolved-reference', '参照先を一意に確認できないため公開できません。'));
          }
          return literal;
        });
        active.replace(INLINE_LINK, (literal, _label: string, destination: string) => {
          if (!safeExternalUrl(destination.replace(/^<|>$/g, ''))) {
            diagnostics.push(error('unresolved-reference', '参照先を一意に確認できないため公開できません。'));
          }
          return literal;
        });
        return active;
      });
    }
  }
  return { trees: diagnostics.length ? [] : trees, diagnostics };
}
