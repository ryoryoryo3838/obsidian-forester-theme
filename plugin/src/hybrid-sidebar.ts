import { ItemView, Notice, type Plugin, type WorkspaceLeaf } from 'obsidian';
import type { HybridDocument, HybridTree } from './hybrid-types';

/** Placement identity is separate from the definition's public ID. */
export interface SidebarOutlineEntry {
  title: string;
  number: string;
  target: string;
  children: SidebarOutlineEntry[];
  sourceKey?: string;
  occurrenceKey?: string;
  tree?: HybridTree;
}

/** The controller owns context, graph resolution and local-page navigation. */
export interface HybridSidebarHost {
  current(): { document: HybridDocument; tree: HybridTree } | null;
  outline(document: HybridDocument, tree: HybridTree): SidebarOutlineEntry[];
  relations(tree: HybridTree): { backlinks: HybridTree[]; related: HybridTree[]; references: HybridTree[] };
  openTree(tree: HybridTree, newLeaf: boolean): Promise<void>;
  focusOccurrence(entry: SidebarOutlineEntry): Promise<void>;
  subscribe(update: () => void): () => void;
}

const VIEWS = [
  { type: 'forester-toc', title: 'Forester TOC', icon: 'list-tree' },
  { type: 'forester-backlinks', title: 'Forester Backlinks', icon: 'links' },
  { type: 'forester-related', title: 'Forester Related', icon: 'network' },
  { type: 'forester-references', title: 'Forester References', icon: 'book-open' },
] as const;
type SidebarSpec = typeof VIEWS[number];
type RelationKind = keyof ReturnType<HybridSidebarHost['relations']>;

function placementKey(entry: SidebarOutlineEntry): string | null {
  return entry.occurrenceKey ? `occurrence:${entry.occurrenceKey}` : entry.sourceKey ? `source:${entry.sourceKey}` : null;
}

function reportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  new Notice(`Forester sidebar: ${message}`);
  return message;
}

interface SidebarSnapshot {
  current: ReturnType<HybridSidebarHost['current']>;
  outline: SidebarOutlineEntry[];
  relations: ReturnType<HybridSidebarHost['relations']>;
}

/** One refresh/subscription for the open tabs, not a graph walk per tab per edit. */
class SidebarUpdates {
  private readonly views = new Set<HybridSidebarView>();
  private unsubscribe: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  constructor(readonly host: HybridSidebarHost) {}
  add(view: HybridSidebarView): void {
    if (this.disposed) return;
    this.views.add(view);
    if (!this.unsubscribe) {
      try { this.unsubscribe = this.host.subscribe(() => this.schedule()); }
      catch (error) {
        const message = reportError(error);
        for (const openView of this.views) openView.renderError(message);
        return;
      }
    }
    this.schedule();
  }
  remove(view: HybridSidebarView): void {
    this.views.delete(view);
    if (!this.views.size) this.disconnect();
  }
  dispose(): void {
    this.disposed = true;
    this.disconnect();
    for (const view of this.views) view.disposeRender();
    this.views.clear();
  }
  private disconnect(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const release = this.unsubscribe;
    this.unsubscribe = null;
    try { release?.(); }
    catch (error) { reportError(error); }
  }
  private schedule(): void {
    if (!this.views.size || this.timer !== null) return;
    this.timer = setTimeout(() => { this.timer = null; this.refresh(); }, 40);
  }
  private refresh(): void {
    try {
      const current = this.host.current();
      const enabled = current?.document.enabled;
      const snapshot: SidebarSnapshot = {
        current,
        outline: enabled && [...this.views].some(view => view.getViewType() === 'forester-toc')
          ? this.host.outline(current.document, current.tree) : [],
        relations: enabled && [...this.views].some(view => view.getViewType() !== 'forester-toc')
          ? this.host.relations(current.tree) : { backlinks: [], related: [], references: [] },
      };
      for (const view of this.views) view.render(snapshot);
    } catch (error) {
      const message = reportError(error);
      for (const view of this.views) view.renderError(message);
    }
  }
}

class HybridSidebarView extends ItemView {
  private readonly listeners: Array<() => void> = [];
  private readonly expanded = new Map<string, boolean>();
  private contextKey = '';
  constructor(leaf: WorkspaceLeaf, private readonly spec: SidebarSpec, private readonly updates: SidebarUpdates) { super(leaf); }
  getViewType(): string { return this.spec.type; }
  getDisplayText(): string { return this.spec.title; }
  getIcon(): string { return this.spec.icon; }
  async onOpen(): Promise<void> { this.updates.add(this); }
  async onClose(): Promise<void> { this.updates.remove(this); this.disposeRender(); }
  disposeRender(): void { this.clear(); this.expanded.clear(); }
  private clear(): void {
    for (const details of Array.from(this.contentEl.querySelectorAll('details[data-outline-key]'))) {
      this.expanded.set(details.getAttribute('data-outline-key')!, details.hasAttribute('open'));
    }
    for (const remove of this.listeners.splice(0)) remove();
    this.contentEl.replaceChildren();
  }
  private click(el: HTMLElement, action: (event: MouseEvent) => void | Promise<void>): void {
    const listener = (event: MouseEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      try { void Promise.resolve(action(event)).catch(reportError); }
      catch (error) { reportError(error); }
    };
    el.addEventListener('click', listener);
    this.listeners.push(() => el.removeEventListener('click', listener));
  }
  renderError(message: string): void {
    this.clear();
    this.contentEl.classList.add('hybrid-sidebar');
    this.contentEl.setAttribute('data-forester-sidebar', this.spec.type);
    this.contentEl.createEl('h2', { text: this.spec.title });
    this.contentEl.createEl('p', { cls: 'hybrid-sidebar-error', text: `Unable to update this sidebar: ${message}` });
  }
  render(snapshot: SidebarSnapshot): void {
    const el = this.contentEl;
    this.clear();
    el.classList.add('hybrid-sidebar');
    el.setAttribute('data-forester-sidebar', this.spec.type);
    el.createEl('h2', { text: this.spec.title });
    const current = snapshot.current;
    const contextKey = current ? `${current.document.path}\n${current.tree.key}` : '';
    if (this.contextKey !== contextKey) { this.expanded.clear(); this.contextKey = contextKey; }
    if (!current) { this.empty('No active Markdown tree. Open a Markdown note to view Forester information.'); return; }
    if (!current.document.enabled) { this.empty('This Markdown note is excluded or Forester is disabled.'); return; }
    el.createEl('p', { cls: 'hybrid-sidebar-context', text: [current.tree.meta.title, current.tree.id].filter(Boolean).join(' · ') });
    if (this.spec.type === 'forester-toc' && snapshot.outline.length) { this.renderOutline(snapshot.outline); return; }
    if (this.spec.type !== 'forester-toc') {
      const kind = this.spec.type.slice('forester-'.length) as RelationKind;
      if (snapshot.relations[kind].length) { this.renderRelations(kind, snapshot.relations[kind]); return; }
    }
    const messages = {
      'forester-toc': 'No sections in the table of contents (entries may be excluded).',
      'forester-backlinks': 'No backlinks for this tree.',
      'forester-related': 'No related trees for this tree.',
      'forester-references': 'No references for this tree.',
    };
    this.empty(messages[this.spec.type]);
  }
  private renderOutline(entries: SidebarOutlineEntry[]): void {
    const counts = new Map<string, number>();
    const count = (items: SidebarOutlineEntry[]): void => {
      for (const entry of items) {
        const key = placementKey(entry);
        if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
        count(entry.children);
      }
    };
    count(entries);
    this.outlineList(this.contentEl, entries, '', counts);
  }
  private outlineList(container: HTMLElement, entries: SidebarOutlineEntry[], prefix: string, counts: Map<string, number>): void {
    const list = container.createEl('ul', { cls: 'hybrid-sidebar-toc' });
    entries.forEach((entry, index) => {
      const row = list.createEl('li', { cls: 'hybrid-sidebar-toc-entry' });
      if (entry.occurrenceKey) row.setAttribute('data-occurrence-key', entry.occurrenceKey);
      if (entry.sourceKey) row.setAttribute('data-source-key', entry.sourceKey);
      const path = `${prefix}/${index}`;
      const details = entry.children.length ? row.createEl('details') : null;
      if (details) {
        const key = entry.occurrenceKey ?? entry.sourceKey ?? path;
        details.setAttribute('data-outline-key', key);
        if (this.expanded.get(key) !== false) details.setAttribute('open', '');
      }
      const header = details ? details.createEl('summary', { cls: 'hybrid-sidebar-row' }) : row.createEl('div', { cls: 'hybrid-sidebar-row' });
      if (entry.tree?.meta.taxon) header.createEl('span', { cls: 'hybrid-sidebar-taxon', text: entry.tree.meta.taxon });
      header.createEl('span', { cls: 'hybrid-sidebar-number', text: entry.number });
      const heading = header.createEl('button', { cls: 'hybrid-sidebar-heading', text: entry.title, attr: { type: 'button' } });
      const key = placementKey(entry);
      if (key && counts.get(key) === 1) {
        this.click(heading, () => { this.unfold(heading); return this.updates.host.focusOccurrence(entry); });
      } else {
        const message = key ? 'Ambiguous local placement; navigation is disabled.' : 'Local placement unavailable; navigation is disabled.';
        heading.setAttribute('disabled', '');
        heading.setAttribute('title', message);
        row.createEl('span', { cls: 'hybrid-sidebar-unavailable', text: message });
      }
      const definition = entry.tree;
      if (definition?.id) {
        const route = header.createEl('button', { cls: 'hybrid-sidebar-route', text: '■',
          attr: { type: 'button', 'aria-label': `Open definition: ${entry.title} [${definition.id}]` } });
        this.click(route, event => this.updates.host.openTree(definition, !!(event.ctrlKey || event.metaKey)));
      }
      if (details) this.outlineList(details, entry.children, path, counts);
    });
  }
  private unfold(heading: HTMLElement): void {
    for (let parent = heading.parentElement; parent && parent !== this.contentEl; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.setAttribute('open', '');
    }
  }
  private renderRelations(kind: RelationKind, trees: HybridTree[]): void {
    const list = this.contentEl.createEl('ul', { cls: 'hybrid-sidebar-relations', attr: { 'data-relation': kind } });
    for (const tree of trees) {
      const row = list.createEl('li', { cls: 'hybrid-sidebar-relation-entry', attr: { 'data-tree-key': tree.key } });
      if (tree.id) row.setAttribute('data-tree-id', tree.id);
      const header = row.createEl('div', { cls: 'hybrid-sidebar-row' });
      if (tree.meta.taxon) header.createEl('span', { cls: 'hybrid-sidebar-taxon', text: tree.meta.taxon });
      const heading = header.createEl('button', { cls: 'hybrid-sidebar-heading', text: tree.meta.title, attr: { type: 'button' } });
      if (tree.path) this.click(heading, event => this.updates.host.openTree(tree, !!(event.ctrlKey || event.metaKey)));
      else {
        heading.setAttribute('disabled', '');
        heading.setAttribute('title', 'Source tree unavailable; navigation is disabled.');
        row.createEl('span', { cls: 'hybrid-sidebar-unavailable', text: 'Source tree unavailable; navigation is disabled.' });
      }
      if (tree.id) header.createEl('span', { cls: 'hybrid-sidebar-id', text: tree.id });
      const metadata = [tree.meta.authors.length ? `Authors: ${tree.meta.authors.join(', ')}` : '',
        tree.meta.dates.length ? `Dates: ${tree.meta.dates.join(', ')}` : ''].filter(Boolean);
      if (metadata.length) row.createEl('div', { cls: 'hybrid-sidebar-metadata', text: metadata.join(' · ') });
      if (kind === 'references') {
        const citation = [tree.meta.citationAuthors.length ? `Citation authors: ${tree.meta.citationAuthors.join(', ')}` : '',
          tree.meta.publicationYear ? `Publication year: ${tree.meta.publicationYear}` : ''].filter(Boolean);
        row.createEl('div', { cls: 'hybrid-sidebar-bibliography', text: citation.length ? citation.join(' · ') : 'Bibliographic metadata not set.' });
      }
    }
  }
  private empty(message: string): void { this.contentEl.createEl('p', { cls: 'hybrid-sidebar-empty', text: message }); }
}

/** Register isolated tabs, without changing the workspace layout on plugin load. */
export function registerHybridSidebar(plugin: Plugin, host: HybridSidebarHost): void {
  const updates = new SidebarUpdates(host);
  let alive = true;
  // Track only leaves created by pending opens; completed/existing leaves are
  // closed by Obsidian. A user may repurpose even a pending leaf meanwhile.
  const openingLeaves = new Map<WorkspaceLeaf, SidebarSpec['type']>();
  const detachOpening = (leaf: WorkspaceLeaf, type: SidebarSpec['type']): void => {
    try {
      const currentType = leaf.getViewState().type;
      if (currentType === type || currentType === 'empty') leaf.detach();
    } catch (error) { reportError(error); }
  };
  plugin.register(() => {
    alive = false;
    updates.dispose();
    for (const [leaf, type] of openingLeaves) detachOpening(leaf, type);
  });
  for (const spec of VIEWS) {
    // Obsidian's base View constructor calls these virtual methods during
    // super(leaf), before HybridSidebarView's parameter properties exist.
    // Closure-bound identities are available throughout native construction.
    class SidebarView extends HybridSidebarView {
      getViewType(): string { return spec.type; }
      getDisplayText(): string { return spec.title; }
      getIcon(): string { return spec.icon; }
    }
    plugin.registerView(spec.type, leaf => new SidebarView(leaf, spec, updates));
    let pending: Promise<void> | null = null;
    const open = async (): Promise<void> => {
      if (!alive) return;
      let created: WorkspaceLeaf | null = null;
      try {
        const workspace = plugin.app.workspace;
        const existing = workspace.getLeavesOfType(spec.type)[0];
        const leaf = existing ?? workspace.getRightLeaf(false);
        if (!leaf) throw new Error('Right sidebar is unavailable.');
        if (!existing) {
          created = leaf;
          openingLeaves.set(leaf, spec.type);
          await leaf.setViewState({ type: spec.type, active: true });
        }
        if (!alive) return;
        await workspace.revealLeaf(leaf);
      } catch (error) { reportError(error); }
      finally {
        if (created) {
          // setViewState/revealLeaf can finish after unload's detach phase.
          if (!alive) detachOpening(created, spec.type);
          openingLeaves.delete(created);
        }
      }
    };
    plugin.addCommand({ id: `open-${spec.type}`, name: `Open ${spec.title}`, callback: () => {
      if (!pending) pending = open().finally(() => { pending = null; });
      return pending;
    } });
  }
}
