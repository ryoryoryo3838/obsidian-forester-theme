import type { HybridDiagnostic, HybridDocument, HybridIndex, HybridTree, SourceRange } from './hybrid-types';
import type { PublicAttribution, PublicForestProjection, PublicForestTree } from './hybrid-public-forest-types';
import { resolveHybrid } from './hybrid-core';
import { error, LINKS, markdown, publicBibliography, publicIndexDiagnostics, referenceText, safeExternalUrl, safeLive } from './hybrid-public';

function chunk(document: HybridDocument, tree: HybridTree, index: HybridIndex, diagnostics: HybridDiagnostic[], source: string): PublicForestTree['content'] {
  const content: PublicForestTree['content'] = [];
  // Keep physical offsets across scanner callbacks: an inline literal is content,
  // not an artificial end of line. Comments cannot join formerly separate tokens.
  const parts: { text: string; from: number; literal: boolean }[] = [];
  const comments: SourceRange[] = [];
  const controls: { from: number; letters: string }[] = [];
  let offset = 0;
  const part = (text: string, literal: boolean) => {
    parts.push({ text, from: offset, literal }); offset += text.length; return '';
  };
  markdown(source, text => part(text, false), {
    literal: text => part(text, true),
    comment: (text, from) => {
      const control = /^%%([^\s%]+)%%$/.exec(text);
      if (control) controls.push({ from, letters: control[1] });
      const before = source.slice(source.lastIndexOf('\n', from - 1) + 1, from);
      if (/^%%[a-z]+%%$/.test(text) && /^ {0,3}!\[\[[^\]\n]+\]\][ \t]*$/.test(before)) return text;
      comments.push({ from, to: from + text.length });
      return text.replace(/[^\r\n]/g, ' ');
    },
  });
  const physical = parts.map(p => {
    if (!p.literal) return p.text;
    const block = (p.from === 0 || source[p.from - 1] === '\n') && /^(?: {0,3}(?:`{3,}|~{3,})| {4}|\t)/.test(p.text);
    return p.text.replace(/[^\r\n]/g, block ? ' ' : 'x');
  }).join('');
  const lines = physical.split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (lines[i - 1].trim() && /^ {0,3}(?:=+|-+)[ \t]*\r?$/.test(lines[i])) {
      diagnostics.push(error('unsupported-tree-declaration', '構造化されていない見出しは公開できません。'));
      return content;
    }
  }
  const placements = new RegExp(LINKS.source, 'g');
  let placement: RegExpExecArray | null;
  while ((placement = placements.exec(physical))) if (placement[2]) {
    const from = physical.lastIndexOf('\n', placement.index - 1) + 1;
    const newline = physical.indexOf('\n', placements.lastIndex);
    const to = newline < 0 ? physical.length : newline;
    const flags = controls.filter(control => control.from >= placements.lastIndex && control.from < to);
    // Validate the original complete line, not a comment-masked prefix/suffix.
    // Prefix/intervening comments and multiple controls are outside public-v2's
    // block-only grammar; trailing ordinary comments are not display controls.
    if (!/^ {0,3}$/.test(source.slice(from, placement.index)) || flags.length > 1 ||
        flags.some(flag => !/^[ \t]*$/.test(source.slice(placements.lastIndex, flag.from)))) {
      diagnostics.push(error('unsupported-transclusion-placement', 'この埋め込み位置は公開未対応です。'));
      return content;
    }
    if (flags.some(flag => /[^ht]/.test(flag.letters))) {
      diagnostics.push(error('unsupported-transclusion-flags', '未対応の埋め込みフラグです。'));
      return content;
    }
    if (!/^[ \t]*$/.test(physical.slice(from, placement.index)) ||
        !/^[ \t]*(?:%%[a-z]+%%)?[ \t]*\r?$/.test(physical.slice(placements.lastIndex, to))) {
      diagnostics.push(error('unsupported-transclusion-placement', 'この埋め込み位置は公開未対応です。'));
      return content;
    }
  }
  const visible = (text: string, from: number, start: number, end: number) => {
    let value = '', cursor = start;
    for (const range of comments) {
      const a = Math.max(start, range.from - from), b = Math.min(end, range.to - from);
      if (a >= b) continue;
      value += text.slice(cursor, a);
      const newlines = text.slice(a, b).replace(/[^\r\n]/g, '');
      value += newlines || (/\S/.test(text[a - 1] ?? '') && /\S/.test(text[b] ?? '') ? ' ' : '');
      cursor = b;
    }
    return value + text.slice(cursor, end);
  };
  const reference = (value: string, citation = false) => {
    const resolved = resolveHybrid(index, value.split('|')[0], document.path);
    if (resolved.status === 'resolved' && resolved.document.enabled && !resolved.tree.meta.publish && resolved.tree.meta.publicTitle)
      literalMetadata(resolved.tree.meta.title, diagnostics);
    return referenceText(document, index, diagnostics, [], value, false, citation);
  };
  let pending = '';
  const flush = () => {
    const text = pending.replace(/^(?:[ \t]*\r?\n)+/, '').replace(/\s+$/, '');
    if (text) content.push({ kind: 'markdown', text });
    pending = '';
  };
  for (const { text: active, from, literal: isLiteral } of parts) {
    if (isLiteral) { pending += active; continue; }
    if (!safeLive(active, diagnostics)) continue;
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/m.test(active)) {
      diagnostics.push(error('unsupported-tree-declaration', '構造化されていない見出しは公開できません。')); continue;
    }
    const tokens = new RegExp(LINKS.source, 'g');
    let cursor = 0;
    let match: RegExpExecArray | null;
    while ((match = tokens.exec(active))) {
      pending += visible(active, from, cursor, match.index);
      const [literal, citation, embed, target, label, destination] = match;
      cursor = tokens.lastIndex;
      if (embed) {
        const endOfLine = active.indexOf('\n', cursor);
        const end = endOfLine < 0 ? active.length : endOfLine;
        const prefix = pending.slice(pending.lastIndexOf('\n') + 1);
        const suffix = active.slice(cursor, end).replace(/\r$/, '');
        const flags = /^[ \t]*(?:%%([a-z]+)%%)?[ \t]*$/.exec(suffix);
        if (!/^ {0,3}$/.test(prefix) || !flags) {
          diagnostics.push(error('unsupported-transclusion-placement', 'この埋め込み位置は公開未対応です。')); continue;
        }
        const letters = flags[1] ?? '';
        if (/[^ht]/.test(letters)) diagnostics.push(error('unsupported-transclusion-flags', '未対応の埋め込みフラグです。'));
        const resolved = resolveHybrid(index, target.split('|')[0], document.path);
        if (resolved.status !== 'resolved' || !resolved.tree.id) diagnostics.push(error('unresolved-reference', '公開参照先を一意に確認できません。'));
        else if (!resolved.document.enabled || !resolved.tree.meta.publish) diagnostics.push(error('private-embed', '非公開ツリーは埋め込めません。'));
        else {
          flush();
          content.push({ kind: 'transclude', id: resolved.tree.id, header: !letters.includes('h'), toc: !letters.includes('t') });
        }
        cursor = endOfLine < 0 ? end : end + 1;
        tokens.lastIndex = cursor;
        continue;
      }
      if (destination !== undefined) {
        const value = destination.replace(/^<|>$/g, '');
        pending += safeExternalUrl(value) ? literal : reference(`${value}|${label}`);
      } else {
        pending += reference(citation ?? target, citation !== undefined);
      }
    }
    pending += visible(active, from, cursor, active.length);
  }
  flush();
  return content;
}

const propertyKeys = ['position', 'institution', 'venue', 'source', 'doi', 'orcid', 'external', 'slides', 'video', 'bibtex', 'author'];

function literalMetadata(value: string, diagnostics: HybridDiagnostic[]): void {
  if (/<!--|%%|\[\[|\u0000/.test(value)) diagnostics.push(error('unsupported-public-metadata', 'メタデータに未対応のローカル構文があります。'));
}

function metadata(document: HybridDocument, tree: HybridTree, index: HybridIndex, diagnostics: HybridDiagnostic[], topLevel: boolean):
  Pick<PublicForestTree, 'authors' | 'dates' | 'contributors' | 'properties'> {
  const byKey = new Map(document.trees.map(t => [t.key, t]));
  const local = (node: HybridTree, key: 'authors' | 'dates'): string[] => {
    const parent = node.parentKey ? byKey.get(node.parentKey) : undefined;
    const inherited = parent?.meta[key] ?? [];
    if (inherited.some((value, i) => node.meta[key][i] !== value)) {
      diagnostics.push(error('invalid-metadata-lineage', 'メタデータの宣言元を確認できません。'));
      return [];
    }
    return node.meta[key].slice(inherited.length);
  };
  const lineage: HybridTree[] = [tree];
  if (topLevel) {
    let node = tree;
    while (node.parentKey) { node = byKey.get(node.parentKey)!; lineage.unshift(node); }
  }
  const attribute = (values: string[]): PublicAttribution[] => {
    const result: PublicAttribution[] = [];
    for (const value of values) {
      const link = /^\[\[([^\]\n]+)\]\]$/.exec(value.trim());
      if (!link) {
        if (/\[\[|\]\(/.test(value)) diagnostics.push(error('unsupported-public-metadata', '未対応のメタデータ参照です。'));
        else { literalMetadata(value, diagnostics); result.push({ kind: 'literal', value }); }
        continue;
      }
      const resolved = resolveHybrid(index, link[1].split('|')[0], document.path);
      if (resolved.status !== 'resolved') { diagnostics.push(error('unresolved-attribution', '帰属先を一意に確認できません。')); continue; }
      const target = resolved.tree;
      if (resolved.document.enabled && target.meta.publish && target.id) result.push({ kind: 'tree', id: target.id });
      else if (resolved.document.enabled && target.meta.publish) diagnostics.push(error('unaddressed-public-attribution', '公開帰属先には明示的なIDが必要です。'));
      else if (resolved.document.enabled && target.meta.publicTitle && target.meta.titleSource !== 'filename') {
        literalMetadata(target.meta.title, diagnostics);
        result.push({ kind: 'literal', value: `${target.meta.title} 🔒` });
      }
    }
    return result;
  };
  const authors: string[] = [];
  const dates: string[] = [];
  for (const node of lineage) if (node.meta.publish) { authors.push(...local(node, 'authors')); dates.push(...local(node, 'dates')); }
  for (const date of dates) {
    if (/\[\[/.test(date)) diagnostics.push(error('unsupported-date-link', 'リンク形式の日付導出は未対応です。'));
    else if (!/^(?!0000)\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date + 'T00:00:00Z')) ||
      new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) diagnostics.push(error('invalid-public-date', '公開日付は有効なISO日付である必要があります。'));
  }
  const properties: Record<string, string[]> = {};
  for (const key of propertyKeys) if (Object.prototype.hasOwnProperty.call(tree.meta.properties ?? {}, key)) {
    properties[key] = [...tree.meta.properties![key]];
    for (const value of properties[key]) {
      literalMetadata(value, diagnostics);
      if (/\[\[|\]\(/.test(value)) diagnostics.push(error('unsupported-public-metadata', '未対応のメタデータ参照です。'));
      if ((['external', 'slides', 'video'].includes(key) || /^[A-Za-z][\w+.-]*:|^\/\//.test(value)) && !safeExternalUrl(value))
        diagnostics.push(error('unsafe-public-property', '安全な公開プロパティを確認できません。'));
    }
  }
  return { authors: attribute(authors), dates, contributors: attribute(tree.meta.contributors ?? []), properties };
}

/** Validate the public-only dependency graph, including anonymous containment edges. */
function validateGraph(trees: PublicForestTree[], diagnostics: HybridDiagnostic[]): void {
  const all: PublicForestTree[] = [];
  const ids = new Map<string, PublicForestTree>();
  const collect = (tree: PublicForestTree) => {
    all.push(tree);
    if (tree.id) ids.set(tree.id, tree);
    for (const node of tree.content) if (node.kind === 'subtree') collect(node.tree);
  };
  trees.forEach(collect);
  const graph = new Map<PublicForestTree, PublicForestTree[]>();
  for (const tree of all) {
    const edges: PublicForestTree[] = [];
    for (const node of tree.content) {
      if (node.kind === 'subtree') edges.push(node.tree);
      else if (node.kind === 'transclude') {
        const target = ids.get(node.id);
        if (target) edges.push(target);
        else diagnostics.push(error('unresolved-reference', '公開参照先の定義がありません。'));
      }
    }
    graph.set(tree, edges);
  }
  const colors = new Map<PublicForestTree, number>();
  for (const tree of all) {
    if (colors.has(tree)) continue;
    const stack: { tree: PublicForestTree; cursor: number }[] = [{ tree, cursor: 0 }];
    colors.set(tree, 1);
    while (stack.length) {
      const frame = stack[stack.length - 1];
      const edges = graph.get(frame.tree)!;
      if (frame.cursor === edges.length) { colors.set(frame.tree, 2); stack.pop(); continue; }
      const child = edges[frame.cursor++];
      if (colors.get(child) === 1) { diagnostics.push(error('forest-cycle', '包含と埋め込みの循環は公開できません。')); return; }
      if (!colors.has(child)) { colors.set(child, 1); stack.push({ tree: child, cursor: 0 }); }
    }
  }
}

/** The index, never link reachability, supplies publication authority. */
export function projectPublicForest(index: HybridIndex): PublicForestProjection {
  const diagnostics = publicIndexDiagnostics(index);
  const trees: PublicForestTree[] = [];
  if (!diagnostics.length) for (const document of index.documents.values()) {
    if (!document.enabled) continue;
    const byKey = new Map(document.trees.map(tree => [tree.key, tree]));
    for (const tree of document.trees) {
      if (!tree.meta.publish || (tree.parentKey && byKey.get(tree.parentKey)?.meta.publish)) continue;
      if (!tree.id) { diagnostics.push(error('unaddressed-public-tree', '公開する独立ツリーには明示的なIDが必要です。')); continue; }
      const build = (node: HybridTree, topLevel = false): PublicForestTree => {
        if (node.meta.titleSource === 'filename') diagnostics.push(error('implicit-public-title', '公開タイトルには明示的なタイトルが必要です。'));
        const bibliography = publicBibliography(document, node);
        for (const value of [node.meta.title, node.meta.taxon ?? '', ...bibliography.citationAuthors, bibliography.publicationYear ?? '']) literalMetadata(value, diagnostics);
        if ([...bibliography.citationAuthors, bibliography.publicationYear ?? ''].some(value => /\[\[|\]\(/.test(value)))
          diagnostics.push(error('unsupported-public-metadata', '未対応の文献メタデータ参照です。'));
        const content: PublicForestTree['content'] = [];
        const append = (from: number, to: number) => {
          let cursor = from;
          let source = '';
          const ranges = document.trees.reduce((all, t) => all.concat(t.metadataRanges), [] as SourceRange[])
            .filter(r => r.from < to && r.to > from).sort((a, b) => a.from - b.from);
          for (const range of ranges) {
            source += document.source.slice(cursor, Math.max(cursor, range.from));
            cursor = Math.min(to, Math.max(cursor, range.to));
          }
          source += document.source.slice(cursor, to);
          content.push(...chunk(document, node, index, diagnostics, source));
        };
        let cursor = node.contentFrom;
        for (const child of [...node.children].sort((a, b) => a.from - b.from)) {
          append(cursor, child.from);
          if (child.meta.publish) content.push({ kind: 'subtree', tree: build(child) });
          cursor = child.to; // Omit the entire private child; its public islands are separate roots.
        }
        append(cursor, node.to);
        return { ...(node.id !== undefined ? { id: node.id } : {}), title: node.meta.title,
          ...(node.meta.taxon !== undefined ? { taxon: node.meta.taxon } : {}),
          ...metadata(document, node, index, diagnostics, topLevel), ...bibliography, content };
      };
      trees.push(build(tree, true));
    }
  }
  if (!diagnostics.length) validateGraph(trees, diagnostics);
  trees.sort((a, b) => a.id! < b.id! ? -1 : a.id! > b.id! ? 1 : 0);
  return { forest: { schema: 'forester-public-v2', trees: diagnostics.length ? [] : trees, assets: [] }, diagnostics };
}
