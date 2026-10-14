import type { HybridDiagnostic } from './hybrid-types';
/** Public wire types: no local keys, paths, offsets, aliases or authorization fields. */
export type PublicAttribution = { kind: 'literal'; value: string } | { kind: 'tree'; id: string };
export interface PublicForestTree {
  id?: string;
  title: string;
  taxon?: string;
  authors: PublicAttribution[];
  dates: string[];
  contributors: PublicAttribution[];
  properties: Record<string, string[]>;
  citationAuthors: string[];
  publicationYear?: string;
  content: PublicForestNode[];
}
export type PublicForestNode = { kind: 'markdown'; text: string }
  | { kind: 'subtree'; tree: PublicForestTree }
  | { kind: 'transclude'; id: string; header: boolean; toc: boolean }
  // Closed, source-free link: /_unavailable/, default literal label [非公開].
  // Optional label requires independent semantic public-title authorization.
  | { kind: 'unavailable'; label?: string };
export interface PublicForest { schema: 'forester-public-v2'; trees: PublicForestTree[]; assets: []; }
export interface PublicForestProjection { forest: PublicForest; diagnostics: HybridDiagnostic[]; }
