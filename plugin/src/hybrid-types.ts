/** Shared contract for the opt-in hybrid language, separate from the legacy tree-md mode. */
export interface HybridOptions { folders: string[]; publicFolders: string[]; reservedIds: string[]; }
export const DEFAULT_HYBRID: HybridOptions = { folders: [], publicFolders: [], reservedIds: [] };
export interface HybridDiagnostic { code: string; message: string; path: string; line?: number; severity: "error" | "warning"; }
export interface SourceRange { from: number; to: number; }
export interface HybridMeta {
  title: string; taxon?: string; authors: string[]; dates: string[];
  /** Native contributor attributions are local to the declaring tree. */
  contributors?: string[];
  /** Recognized native metadata values are local, separate from publication citations. */
  properties?: Record<string, string[]>;
  /** Filename fallback is local-only; absent provenance preserves legacy structured fixtures. */
  titleSource?: 'filename' | 'heading' | 'metadata';
  citationAuthors: string[]; publicationYear?: string;
  /** These bibliographic fields were explicitly declared on this tree, not inherited. */
  citationAuthorsDeclared?: boolean; publicationYearDeclared?: boolean;
  publish: boolean; publicTitle: boolean;
}
export interface HybridTree {
  key: string; id?: string; path: string; parentKey?: string; level: number;
  /** Original Markdown heading; null means no heading (independent of semantic title). */
  headingTitle?: string | null;
  line: number; endLine: number; from: number; to: number; contentFrom: number;
  meta: HybridMeta; metadataRanges: SourceRange[]; children: HybridTree[]; number: string;
}
export interface HybridRaw extends SourceRange { codeFrom: number; codeTo: number; code: string; error?: string; }
export interface HybridDocument {
  path: string; source: string; enabled: boolean; frontmatter: Record<string, unknown>;
  root: HybridTree; trees: HybridTree[]; protectedRanges: SourceRange[]; raw: HybridRaw[];
  diagnostics: HybridDiagnostic[];
}
/** IDs are indexed by lowercase keys; tree.id always preserves the spelling in source. */
export interface HybridIndex { documents: Map<string, HybridDocument>; ids: Map<string, HybridTree[]>; diagnostics: HybridDiagnostic[]; }
export type HybridResolution = { status: "resolved"; tree: HybridTree; document: HybridDocument } | { status: "missing" | "ambiguous"; message: string };
export interface HybridEdit { path: string; before: string; after: string; }
export interface HybridSavePlan { edits: HybridEdit[]; diagnostics: HybridDiagnostic[]; }
export interface PublicTree { id: string; title: string; taxon?: string; body: string; citationAuthors: string[]; publicationYear?: string; }
export interface PublicProjection { trees: PublicTree[]; diagnostics: HybridDiagnostic[]; }
