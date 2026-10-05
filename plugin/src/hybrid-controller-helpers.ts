import type { HybridDocument, HybridTree } from './hybrid-types';

/** A placement route, not an identity: repeated transclusions have distinct routes. */
export function treeOccurrence(doc: HybridDocument, tree: HybridTree, root = doc.root, base = root.key): string {
  const chain: HybridTree[] = [];
  for (let node: HybridTree | undefined = tree; node && node !== root;) {
    chain.unshift(node);
    node = doc.trees.find(candidate => candidate.key === node!.parentKey);
  }
  return base + chain.map(node => `/tree:${node.key}`).join('');
}

export function embedOccurrence(doc: HybridDocument, from: number, root = doc.root, base = root.key): string {
  const owner = doc.trees.filter(tree => tree.from <= from && from < tree.to).sort((a, b) => b.level - a.level)[0] ?? root;
  return `${treeOccurrence(doc, owner, root, base)}/embed:${doc.path}:${from}`;
}

/** Activation is a path policy, not evidence that body protection was parsed. */
export function syntaxReady(document: HybridDocument | undefined): document is HybridDocument {
  return !!document?.enabled && !document.diagnostics.some(diagnostic => diagnostic.code === 'invalid-frontmatter');
}
