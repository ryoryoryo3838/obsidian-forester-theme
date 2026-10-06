import { Component, editorInfoField, editorLivePreviewField, MarkdownRenderChild, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, TFile, type Editor, type MarkdownPostProcessorContext } from 'obsidian';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { drawHybridId, hybridModeEnabled, indexHybrid, parseHybrid, planHybridSave, resolveHybrid } from './hybrid-core';
import { createHybridEditor, hybridRefresh } from './hybrid-editor';
import { commitHybridPlan } from './hybrid-save';
import { projectPublic } from './hybrid-public';
import { citationLabel, foresterTokens, planDisplay, treeOutline, type DisplaySpan, type EmbedFlags } from './hybrid-display';
import { appendSlug, appendTaxon, renderMetadata, renderTreeHeader, type HeaderHost } from './hybrid-header';
import { treeOccurrence, embedOccurrence, syntaxReady } from './hybrid-controller-helpers';
import { createTreeRelations } from './hybrid-relations';
import { encodeWikilinkLabel } from './hybrid-literal-label';
import { registerHybridInput, type HybridInputHost } from './hybrid-input';
import { registerHybridSidebar, type SidebarOutlineEntry } from './hybrid-sidebar';
import type { HybridDiagnostic, HybridDocument, HybridIndex, HybridOptions, HybridTree, HybridSavePlan } from './hybrid-types';

interface TextPatch { from: number; to: number; text: string; }
interface ViewRevision { path: string; revision: number; enabled: boolean; }

// A timer task lets paint/input run; awaiting already-resolved IO only drains microtasks.
const scheduleTask = globalThis.setTimeout.bind(globalThis);

/** Save plans only add ID lines or change individual reference/heading lines. Keep unchanged lines intact. */
function textPatches(before: string, after: string): TextPatch[] {
  const a = before.match(/[^\n]*\n|[^\n]+$/g) ?? [], b = after.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const patches: TextPatch[] = [];
  let i = 0, j = 0, at = 0;
  while (i < a.length || j < b.length) {
    if (a[i] === b[j]) { at += a[i++].length; j++; continue; }
    let insert = -1, remove = -1;
    for (let n = 1; n <= 64; n++) {
      if (i < a.length && b[j + n] === a[i]) { insert = n; break; }
      if (j < b.length && a[i + n] === b[j]) { remove = n; break; }
    }
    if (insert > 0 || i === a.length) {
      const end = insert > 0 ? j + insert : b.length;
      patches.push({ from: at, to: at, text: b.slice(j, end).join('') }); j = end; continue;
    }
    if (remove > 0 || j === b.length) {
      const end = remove > 0 ? i + remove : a.length;
      const length = a.slice(i, end).join('').length;
      patches.push({ from: at, to: at + length, text: '' }); at += length; i = end; continue;
    }
    const left = a[i], right = b[j]; let start = 0, end = 0;
    while (start < left.length && start < right.length && left[start] === right[start]) start++;
    while (end < left.length - start && end < right.length - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++;
    patches.push({ from: at + start, to: at + left.length - end, text: right.slice(start, right.length - end) });
    at += left.length; i++; j++;
  }
  return patches;
}

/** Opt-in adapter. It does not replace the legacy save command or native link lookup. */
export class HybridController {
  private sources = new Map<string, string>();
  private sourceVersions = new Map<string, number>();
  private sourceGeneration = 0;
  private index: HybridIndex = indexHybrid([]);
  private fieldIndex: HybridIndex = this.index;
  private overlays = new Map<string, HybridIndex>();
  private overlayDocuments = new Map<string, HybridDocument>();
  private parsed = new Map<string, { document: HybridDocument; optionsKey: string }>();
  private indexOptionsKey = '';
  private refreshTask?: Promise<void>;
  private refreshRequested = false;
  private stopped = false;
  private warned = new Set<string>();
  private revision = 0;
  private slotSequence = 0;
  private lastMarkdown?: MarkdownView;
  private relationIndex?: HybridIndex;
  private relationGraph?: ReturnType<typeof createTreeRelations>;
  private listeners = new Set<() => void>();
  private listenerTimer?: ReturnType<typeof setTimeout>;
  private treePages = new WeakMap<MarkdownView, { path: string; key: string; id?: string }>();
  private settled = new Map<Editor, ReturnType<typeof setTimeout>>();
  private saveTail: Promise<void> = Promise.resolve();
  private inFlight = false;
  private observedEditors = new Map<Editor, TFile>();
  private nativeViews = new Set<EditorView>();
  private editorRevisions = new WeakMap<EditorView, ViewRevision>();
  private previewRevisions = new WeakMap<MarkdownView, ViewRevision>();
  private updatingEditors = new Set<Editor>();
  private viewCleanups = new Set<() => void>();
  private readingChildren = new Set<MarkdownRenderChild>();
  private renderedTrees = new WeakMap<HTMLElement, HybridTree>();
  private readingHeaders = new WeakMap<HTMLElement, { child: MarkdownRenderChild; headings: HTMLElement[]; nodes: Element[]; signature: string }>();
  private readingEmbeds = new Map<HTMLElement, { section: HTMLElement; child: MarkdownRenderChild; wrapper: HTMLElement; path: string; source: string; from: number; signature: string }>();
  private readingLinks = new WeakMap<HTMLElement, { child: MarkdownRenderChild; anchors: HTMLElement[]; signature: string }>();

  constructor(private plugin: Plugin, private options: () => HybridOptions, private linkSuggest: () => boolean = () => true) {}

  private configuration(): { options: HybridOptions; key: string } {
    const value = this.options();
    const options = { folders: [...value.folders], excludedFolders: [...(value.excludedFolders ?? [])], publicFolders: [...value.publicFolders], reservedIds: [...value.reservedIds] };
    return { options, key: JSON.stringify(options) };
  }

  private cachedDocument(path: string, source: string, key: string): HybridDocument | undefined {
    const indexed = this.index.documents.get(path);
    if (this.indexOptionsKey === key && indexed?.source === source) return indexed;
    const cached = this.parsed.get(path);
    return cached?.optionsKey === key && cached.document.source === source ? cached.document : undefined;
  }

  private parse(path: string, source: string, config = this.configuration()): HybridDocument {
    const cached = this.cachedDocument(path, source, config.key);
    if (cached) return cached;
    const document = parseHybrid(path, source, config.options);
    this.parsed.set(path, { document, optionsKey: config.key });
    return document;
  }

  isEnabled(path: string, source?: string): boolean {
    const text = source ?? this.sources.get(path);
    return text !== undefined && hybridModeEnabled(path, text, this.options());
  }

  private recordSource(path: string, source?: string): boolean {
    if (source !== undefined && this.sources.get(path) === source) return false;
    if (source === undefined) this.sources.delete(path); else this.sources.set(path, source);
    this.sourceVersions.set(path, ++this.sourceGeneration);
    return true;
  }

  async initialize(): Promise<void> {
    const { vault, workspace, metadataCache } = this.plugin.app;
    this.plugin.register(() => {
      this.stopped = true;
      if (this.listenerTimer !== undefined) clearTimeout(this.listenerTimer);
      this.listeners.clear(); this.lastMarkdown = undefined; this.relationIndex = undefined; this.relationGraph = undefined;
      this.refreshRequested = false;
      for (const timer of this.settled.values()) clearTimeout(timer);
      for (const cleanup of this.viewCleanups) cleanup();
      for (const child of [...this.readingChildren]) child.unload();
      this.viewCleanups.clear(); this.settled.clear(); this.observedEditors.clear(); this.nativeViews.clear();
      this.sources.clear(); this.sourceVersions.clear(); this.parsed.clear(); this.overlays.clear(); this.overlayDocuments.clear();
      this.index = { documents: new Map(), ids: new Map(), diagnostics: [] }; this.fieldIndex = this.index;
    });
    const changed = (file: TFile, source?: string): Promise<void> => {
      if (this.stopped) return Promise.resolve();
      if (!this.recordSource(file.path, source)) return this.inFlight ? Promise.resolve() : this.refreshTask ?? Promise.resolve();
      return this.inFlight ? Promise.resolve() : this.refresh();
    };
    this.plugin.registerEvent(vault.on('modify', file => file instanceof TFile ? changed(file) : this.refresh()));
    this.plugin.registerEvent(vault.on('create', file => file instanceof TFile ? changed(file) : this.refresh()));
    this.plugin.registerEvent(vault.on('rename', (file, oldPath) => {
      if (this.stopped) return Promise.resolve();
      this.recordSource(oldPath);
      return file instanceof TFile ? changed(file) : this.refresh();
    }));
    this.plugin.registerEvent(vault.on('delete', file => { if (this.stopped) return Promise.resolve(); this.recordSource(file.path); return this.refresh(); }));
    this.plugin.registerEvent(metadataCache.on('changed', (file, source) => changed(file, source)));
    const contextChanged = (): void => { this.markdownView(); this.notify(); };
    this.plugin.registerEvent(workspace.on('active-leaf-change', contextChanged));
    this.plugin.registerEvent(workspace.on('file-open', file => {
      const view = this.markdownView();
      if (file && view?.file?.path === file.path) this.treePages.delete(view);
      this.notify();
    }));
    this.plugin.registerEvent(workspace.on('editor-change', (editor, info) => {
      const timer = this.settled.get(editor); if (timer !== undefined) clearTimeout(timer);
      this.settled.delete(editor);
      if (this.stopped || this.updatingEditors.has(editor) || !info.file || info.file.extension !== 'md') return;
      const path = info.file.path; this.recordSource(path, editor.getValue());
      if (this.isEnabled(path, editor.getValue())) {
        // Obsidian continuously autosaves. A settled author, not a second Ctrl+S wrapper, is the trigger.
        this.settled.set(editor, setTimeout(() => {
          this.settled.delete(editor);
          this.enqueueSave(path, editor);
        }, 2000));
      }
      return this.inFlight ? Promise.resolve() : this.refresh();
    }));
    this.plugin.registerEditorExtension([createHybridEditor({
      document: state => {
        if (this.stopped) return null;
        this.rememberState(state);
        const info = state.field(editorInfoField, false);
        if (!state.field(editorLivePreviewField, false) || !info?.file || info.file.extension !== 'md') return null;
        const path = info.file.path, source = state.doc.toString();
        if (this.stopped || !this.isEnabled(path, source)) {
          this.overlays.delete(path); this.overlayDocuments.delete(path); this.fieldIndex = this.index;
          return null;
        }
        const document = this.parse(path, source);
        if (!syntaxReady(document)) { this.overlays.delete(path); this.overlayDocuments.delete(path); this.fieldIndex = this.index; return null; }
        this.fieldIndex = this.overlay(document);
        return document;
      },
      // document/build/resolve run synchronously. The source path may change during a recursive outline,
      // but every lookup in this build must retain the same current-document overlay.
      resolve: (target, path) => resolveHybrid(this.fieldIndex, target, path),
      renderEmbed: (el, target, flags, path) => this.renderEmbed(el, target, flags, path),
      open: (target, path) => this.open(target, path),
    }), ViewPlugin.define(view => {
      this.nativeViews.add(view); this.rememberState(view.state);
      // Capture only inside this CM view, never at document/body level or on ordinary file links.
      const click = (event: MouseEvent): void => this.previewIdClick(event, view);
      view.dom.addEventListener('click', click, true);
      const cleanup = (): void => { view.dom.removeEventListener('click', click, true); };
      this.viewCleanups.add(cleanup);
      let previous = view.state.field(editorInfoField, false)?.editor;
      return {
        update: () => {
          const next = view.state.field(editorInfoField, false)?.editor;
          if (previous && previous !== next) this.forgetEditor(previous);
          previous = next; this.rememberState(view.state);
        },
        destroy: () => { cleanup(); this.viewCleanups.delete(cleanup); this.nativeViews.delete(view); if (previous) this.forgetEditor(previous); },
      };
    })]);
    this.plugin.registerMarkdownPostProcessor((el, ctx) => this.processReading(el, ctx));
    this.plugin.registerMarkdownCodeBlockProcessor('forester', (source, el, ctx) => {
      const dom = el.ownerDocument;
      if (!this.isEnabled(ctx.sourcePath) || !syntaxReady(this.index.documents.get(ctx.sourcePath))) {
        // Preserve native output. Obsidian can also supply an empty code-block
        // holder: keep its literal code visible without any hybrid formatting.
        if (!el.hasChildNodes()) { const pre = dom.createElement('pre'), code = dom.createElement('code'); code.textContent = source; pre.append(code); el.append(pre); }
        return;
      }
      el.replaceChildren();
      if (this.isEnabled(ctx.sourcePath)) { const label = dom.createElement('span'); label.className = 'hybrid-raw-label'; label.textContent = 'Forester · 未評価'; el.append(label); }
      const pre = dom.createElement('pre'), code = dom.createElement('code'); code.className = 'language-forester';
      for (const token of foresterTokens(source)) { const span = dom.createElement('span'); span.className = `hybrid-token-${token.kind}`; span.textContent = token.text; code.append(span); }
      pre.append(code); el.append(pre);
    });
    this.markdownView();
    registerHybridInput(this.plugin, { index: () => this.currentIndex(), resolve: (target, path) => resolveHybrid(this.currentIndex(), target, path), insertTarget: (editor, file, tree, embed, replacement) => this.insertTarget(editor, file, tree, embed, replacement), linkSuggest: () => this.linkSuggest() });
    registerHybridSidebar(this.plugin, { current: () => this.current(), outline: (document, tree) => this.outline(document, tree), relations: tree => this.relations(tree), openTree: (tree, newLeaf) => this.openTree(tree, newLeaf), focusOccurrence: entry => this.focusOccurrence(entry), subscribe: update => this.subscribe(update) });
    this.plugin.addCommand({ id: 'check-hybrid-trees', name: 'Check hybrid trees', callback: () => this.checkTrees() });
    this.plugin.addCommand({ id: 'preview-public-projection', name: 'Preview public projection (local only)', callback: () => this.previewPublic() });
    await this.refresh();
  }

  refresh(): Promise<void> {
    if (this.stopped) return Promise.resolve();
    this.refreshRequested = true;
    if (this.refreshTask) return this.refreshTask;
    this.refreshTask = Promise.resolve().then(async () => {
      try {
        while (this.refreshRequested && !this.stopped) {
          this.refreshRequested = false;
          await this.rebuild();
        }
      } finally {
        this.refreshTask = undefined;
        this.refreshRequested = false;
      }
    });
    return this.refreshTask;
  }

  private async rebuild(): Promise<void> {
    if (this.stopped) return;
    const config = this.configuration();
    const vault = this.plugin.app.vault;
    let processed = 0, sliceStart = performance.now();
    const due = (): boolean => ++processed >= 32 || performance.now() - sliceStart >= 8;
    const yieldToUI = async (): Promise<void> => {
      await new Promise<void>(resolve => scheduleTask(resolve, 0));
      processed = 0; sliceStart = performance.now();
    };
    const files = vault.getMarkdownFiles();
    for (const file of files) {
      const path = file.path;
      if (!this.sources.has(path)) {
        const version = this.sourceVersions.get(path);
        let source: string;
        try { source = await vault.read(file); }
        catch (error) {
          if (this.stopped) return;
          if (this.sourceVersions.get(path) === version && file.path === path && vault.getMarkdownFiles().includes(file)) throw error;
          // The notification retired this read (e.g. rename/delete); reconcile the new membership instead.
          this.refreshRequested = true; continue;
        }
        if (this.stopped) return;
        if (typeof source !== 'string') throw new Error(`Invalid Markdown source: ${path}`);
        if (this.sourceVersions.get(path) === version && file.path === path && !this.sources.has(path)) {
          if (vault.getAbstractFileByPath(path) === file) this.recordSource(path, source);
          else if (vault.getMarkdownFiles().includes(file)) throw new Error(`Unstable file snapshot: ${path}`);
        }
        if (due()) await yieldToUI();
      } else if (performance.now() - sliceStart >= 8) {
        await yieldToUI();
      }
      if (this.stopped) return;
    }
    const paths = new Set(vault.getMarkdownFiles().map(file => file.path));
    this.sources = new Map([...this.sources].filter(([path]) => paths.has(path)));
    for (const path of this.parsed.keys()) if (!paths.has(path)) this.parsed.delete(path);
    for (const path of this.sourceVersions.keys()) if (!paths.has(path)) this.sourceVersions.delete(path);
    if ([...paths].some(path => !this.sources.has(path))) { this.refreshRequested = true; return; }
    if (this.configuration().key !== config.key) { this.refreshRequested = true; return; }
    const snapshot = new Map(this.sources), generation = this.sourceGeneration;
    const documents: HybridDocument[] = [];
    for (const [path, source] of snapshot) {
      const cached = this.cachedDocument(path, source, config.key);
      if ((!cached && (source.length >= 65536 || due())) || performance.now() - sliceStart >= 8) await yieldToUI();
      if (this.stopped) return;
      documents.push(cached ?? this.parse(path, source, config));
    }
    const latestPaths = new Set(vault.getMarkdownFiles().map(file => file.path));
    if (this.sourceGeneration !== generation || this.configuration().key !== config.key || latestPaths.size !== paths.size || [...latestPaths].some(path => !paths.has(path))) {
      // IO and cooperative yields can admit newer source/config/membership events. Never publish the old slice.
      this.refreshRequested = true; return;
    }
    const previous = this.index;
    if (config.key !== this.indexOptionsKey || documents.length !== this.index.documents.size || documents.some(doc => this.index.documents.get(doc.path) !== doc)) {
      this.index = indexHybrid(documents);
      this.indexOptionsKey = config.key;
      this.fieldIndex = this.index;
      this.overlays.clear();
      this.overlayDocuments.clear();
      this.revision++;
      this.warn(this.index.diagnostics.filter(d => ['duplicate-id', 'file-id-collision', 'alias-id-collision', 'invalid-id', 'invalid-metadata', 'invalid-frontmatter'].includes(d.code)));
    }
    this.refreshViews(previous);
    if (previous !== this.index) this.notify();
  }

  private refreshViews(previous: HybridIndex): void {
    const views = new Map<EditorView, { path: string; source?: string }>();
    const collect = (cm: EditorView | undefined, file?: TFile, editor?: Editor): void => {
      if (!cm) return;
      const info = cm.state?.field(editorInfoField, false), path = info?.file?.path ?? file?.path;
      if (path) views.set(cm, { path, source: cm.state?.doc.toString() ?? editor?.getValue() });
    };
    for (const cm of this.nativeViews) collect(cm);
    for (const [editor, file] of this.observedEditors) collect((editor as Editor & { cm?: EditorView }).cm, file, editor);
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      if (!(leaf.view instanceof MarkdownView)) continue;
      const view = leaf.view, path = view.file?.path;
      // Obsidian's CM6 bridge is not in the Editor declarations. Do not fall back to CM5 APIs.
      collect((view.editor as Editor & { cm?: EditorView }).cm, view.file ?? undefined, view.editor);
      if (!path || view.getMode() !== 'preview') continue;
      const enabled = this.isEnabled(path, view.editor.getValue()), seen = this.previewRevisions.get(view);
      const wasEnabled = seen?.path === path && seen.enabled || previous !== this.index && previous.documents.get(path)?.enabled;
      if ((enabled || wasEnabled) && (seen?.path !== path || seen.revision !== this.revision || seen.enabled !== enabled)) view.previewMode.rerender(true);
      this.previewRevisions.set(view, { path, revision: this.revision, enabled });
    }
    for (const [view, { path, source }] of views) {
      const enabled = this.isEnabled(path, source), seen = this.editorRevisions.get(view);
      const wasEnabled = seen?.path === path && seen.enabled || previous !== this.index && previous.documents.get(path)?.enabled;
      if ((enabled || wasEnabled) && (seen?.path !== path || seen.revision !== this.revision || seen.enabled !== enabled)) view.dispatch({ effects: hybridRefresh.of(null) });
      this.editorRevisions.set(view, { path, revision: this.revision, enabled });
    }
  }

  private warn(diagnostics: HybridDiagnostic[]): void {
    const current = new Set<string>(), fresh: HybridDiagnostic[] = [];
    for (const d of diagnostics) {
      const key = `${d.code}:${d.path}:${d.line}:${d.message}`;
      if (!current.has(key) && !this.warned.has(key)) fresh.push(d);
      current.add(key);
    }
    for (const d of fresh.slice(0, 3)) new Notice(`Hybrid: ${d.path}${d.line === undefined ? '' : ':' + (d.line + 1)} [${d.code}] ${d.message}`, 8000);
    if (fresh.length > 3) new Notice(`Hybrid: ${fresh.length - 3} additional diagnostics (notifications limited).`, 8000);
    this.warned = current;
  }

  private editors(path: string): Editor[] {
    const editors = new Set<Editor>();
    for (const [editor, file] of this.observedEditors) if (file.path === path) editors.add(editor);
    for (const leaf of this.plugin.app.workspace.getLeavesOfType('markdown')) {
      if (leaf.view instanceof MarkdownView && leaf.view.file?.path === path) editors.add(leaf.view.editor);
    }
    this.plugin.app.workspace.iterateAllLeaves?.(leaf => {
      const view = leaf.view as { file?: TFile | null; editor?: Editor };
      if (view.file?.path === path && view.editor) editors.add(view.editor);
    });
    const active = this.plugin.app.workspace.activeEditor;
    if (active?.file?.path === path && active.editor) editors.add(active.editor);
    return [...editors];
  }

  private rememberState(state: EditorState): void {
    if (this.stopped) return;
    const info = state.field(editorInfoField, false);
    if (info?.editor && info.file instanceof TFile) this.observedEditors.set(info.editor, info.file);
  }

  private forgetEditor(editor: Editor): void {
    if ([...this.nativeViews].some(view => view.state.field(editorInfoField, false)?.editor === editor)) return;
    this.observedEditors.delete(editor);
    const timer = this.settled.get(editor); if (timer !== undefined) clearTimeout(timer); this.settled.delete(editor);
  }

  private active(path: string, editor: Editor): boolean {
    const active = this.plugin.app.workspace.activeEditor;
    return !this.stopped && active?.editor === editor && active.file?.path === path && this.plugin.app.workspace.getActiveFile()?.path === path;
  }

  private enqueueSave(path: string, editor: Editor): void {
    const run = async (): Promise<void> => {
      if (!this.active(path, editor) || !this.isEnabled(path, editor.getValue())) return;
      this.inFlight = true;
      try {
        await this.refresh();
        if (!this.active(path, editor)) return;
        const plan = planHybridSave(this.index, path);
        for (const diagnostic of plan.diagnostics) new Notice(`Hybrid: [${diagnostic.code}] ${diagnostic.message}`, 8000);
        if (!plan.edits.length || plan.diagnostics.some(d => d.severity === 'error')) return;
        await this.commitPlan(plan, path, editor);
      } catch (error) { new Notice(`Hybrid I/O: ${String(error)}`, 10000); }
      finally { this.inFlight = false; await this.refresh(); }
    };
    this.saveTail = this.saveTail.then(run, run).catch(error => { new Notice(`Hybrid: ${String(error)}`, 10000); console.error('Hybrid settled save', error); });
  }

  private async commitPlan(plan: HybridSavePlan, path: string, editor: Editor, guard = () => this.active(path, editor), dependencies: HybridDocument[] = []): Promise<boolean> {
    const key = this.configuration().key, versions = new Map(this.sourceVersions);
    const files = new Map(this.plugin.app.vault.getMarkdownFiles().map(file => [file.path, file]));
    let writingPath: string | undefined;
    const namespaceCurrent = (): boolean => {
      const now = this.plugin.app.vault.getMarkdownFiles();
      return now.length === files.size && now.every(file => files.get(file.path) === file) &&
        [...versions].every(([target, version]) => target === writingPath || this.sourceVersions.get(target) === version);
    };
    const allowed = (): boolean => guard() && this.configuration().key === key && namespaceCurrent() &&
      [...dependencySources].every(([target, source]) => openEditors(target).every(e => e.getValue() === source));
    // Unload unregisters native views, but an in-flight rollback still needs their snapshot guards.
    const retained = new Map([...plan.edits, ...dependencies].map(edit => [edit.path, this.editors(edit.path)]));
    const dependencySources = new Map(dependencies.map(doc => [doc.path, doc.source]));
    const openEditors = (target: string): Editor[] => [...new Set([...this.editors(target), ...(retained.get(target) ?? []).filter(e => {
      const info = (e as Editor & { cm?: EditorView }).cm?.state?.field(editorInfoField, false);
      return !info?.file || info.file.path === target; // Do not patch an editor reused for another file.
    })])];
    const readDependencies = async (): Promise<boolean> => {
      for (const [target, source] of dependencySources) {
        const file = this.plugin.app.vault.getAbstractFileByPath(target);
        if (!(file instanceof TFile) || !this.isEnabled(target, source)) return false;
        if (await this.io(target, () => this.plugin.app.vault.read(file)) !== source || openEditors(target).some(e => e.getValue() !== source)) return false;
      }
      return allowed();
    };
    if (!await readDependencies()) { new Notice('Hybrid: selected tree snapshot changed; insertion cancelled'); return false; }
    const result = await commitHybridPlan(plan, {
      read: async target => {
        const file = this.plugin.app.vault.getAbstractFileByPath(target);
        if (!(file instanceof TFile)) throw new Error(`Missing file: ${target}`);
        const disk = await this.io(target, () => this.plugin.app.vault.read(file));
        if (!allowed() || openEditors(target).some(e => e.getValue() !== disk)) throw new Error(`Unsettled editor: ${target}`);
        return disk;
      },
      compareWrite: async (target, before, after, purpose = 'forward') => {
        const rollback = purpose === 'rollback';
        if (!rollback && !await readDependencies()) return false;
        const file = this.plugin.app.vault.getAbstractFileByPath(target);
        if (!(file instanceof TFile) || (!rollback && !this.isEnabled(target, before))) return false;
        if (!rollback && (await this.io(target, () => this.plugin.app.vault.read(file)) !== before || !allowed())) return false;
        let accepted = false;
        writingPath = target;
        try {
        const written = await this.io(target, () => this.plugin.app.vault.process(file, current => {
          // Cleanup is still CAS-protected, but must not depend on the author staying in this view.
          if ((!rollback && !allowed()) || current !== before || openEditors(target).some(e => e.getValue() !== before && (!rollback || e.getValue() !== after))) return current;
          accepted = true; return after;
        }));
        if (!accepted || written !== after) return false;
        if (await this.io(target, () => this.plugin.app.vault.read(file)) !== after) throw new Error(`Post-write disk changed: ${target}`);
        if (!rollback && !allowed()) throw new Error(`Save interrupted: ${target}`);
        const open = openEditors(target);
        if (open.some(e => e.getValue() !== before && e.getValue() !== after)) throw new Error(`Editor changed during write: ${target}`);
        for (const e of open) if (e.getValue() === before) {
          this.updatingEditors.add(e);
          try { this.replaceEditor(e, before, after); }
          catch (error) { new Notice(`Hybrid editor ${target}: ${String(error)}`, 10000); throw error; }
          finally { this.updatingEditors.delete(e); }
        }
        this.recordSource(target, after);
        if (dependencySources.has(target)) dependencySources.set(target, after);
        versions.set(target, this.sourceVersions.get(target)!);
        return true;
        } finally { writingPath = undefined; }
      },
    }, path);
    if (!result.committed) new Notice(`Hybrid: 保存を中止 [${result.conflicts.join(', ')}]${result.partial.length ? ` / partial rollback: ${result.partial.join(', ')}` : ''}`, 10000);
    return result.committed;
  }

  async saveActive(): Promise<void> {
    const active = this.plugin.app.workspace.activeEditor;
    if (!active?.file || !active.editor || !this.active(active.file.path, active.editor)) return;
    this.recordSource(active.file.path, active.editor.getValue());
    this.enqueueSave(active.file.path, active.editor);
    await this.saveTail;
  }

  async mintNoteAddress(editor: Editor, file: TFile): Promise<void> { await this.mintAddress(editor, file, true); }
  async mintSubtreeAddress(editor: Editor, file: TFile): Promise<void> { await this.mintAddress(editor, file, false); }

  private async mintAddress(editor: Editor, file: TFile, root: boolean): Promise<void> {
    const path = file.path, before = editor.getValue(), cursor = { ...editor.getCursor() }, offset = editor.posToOffset(cursor), config = this.configuration();
    let after = before;
    const guard = (): boolean => {
      const current = editor.getCursor();
      return this.active(path, editor) && file.path === path && this.configuration().key === config.key &&
        (editor.getValue() === after || editor.getValue() === before && current.line === cursor.line && current.ch === cursor.ch);
    };
    if (!guard() || !this.isEnabled(path, before)) return;
    await this.serial(async () => {
      await this.refresh();
      if (!guard() || editor.getValue() !== before) return;
      const index = this.currentIndex(), document = index.documents.get(path);
      if (!document?.enabled) return;
      const tree = root ? document.root : document.trees.filter(tree => tree !== document.root && tree.from <= offset && (offset < tree.to || offset === document.source.length && tree.to === offset)).sort((a, b) => b.level - a.level)[0];
      if (!tree) { new Notice('Hybrid: no eligible subtree at cursor'); return; }
      if (tree.id) { new Notice(`Hybrid: this tree already has address ${tree.id}`); return; }
      const plan = root ? this.addressPlan(index, tree) : planHybridSave(index, path);
      for (const diagnostic of plan.diagnostics) new Notice(`Hybrid: [${diagnostic.code}] ${diagnostic.message}`, 8000);
      if (!plan.edits.length || plan.diagnostics.some(d => d.severity === 'error')) return;
      after = plan.edits.find(edit => edit.path === path)?.after ?? before;
      if (await this.commitPlan(plan, path, editor, guard)) new Notice('Hybrid: tree address minted');
    });
  }

  private withPlan(index: HybridIndex, plan: HybridSavePlan): HybridIndex {
    if (!plan.edits.length) return index;
    const edits = new Map(plan.edits.map(edit => [edit.path, edit.after]));
    return indexHybrid([...index.documents.values()].map(doc => edits.has(doc.path) ? this.parse(doc.path, edits.get(doc.path)!) : doc));
  }

  /** Root identity is requested explicitly; subtree normalization stays in the shared core. */
  private addressPlan(index: HybridIndex, tree: HybridTree): HybridSavePlan {
    const document = index.documents.get(tree.path)!;
    const plan = planHybridSave(index, tree.path);
    if (plan.diagnostics.some(d => d.severity === 'error') || tree !== document.root) return plan;
    const prepared = this.withPlan(index, plan), current = prepared.documents.get(tree.path)!;
    if (current.root.id) return plan;
    const taken = new Set(prepared.ids.keys());
    for (const doc of prepared.documents.values()) {
      taken.add(doc.path.split('/').pop()!.replace(/\.md$/i, '').toLowerCase());
      const aliases = doc.frontmatter.aliases;
      for (const alias of typeof aliases === 'string' ? [aliases] : Array.isArray(aliases) ? aliases : []) if (typeof alias === 'string') taken.add(alias.toLowerCase());
    }
    try {
      const id = drawHybridId(taken, this.configuration().options.reservedIds), newline = current.source.includes('\r\n') ? '\r\n' : '\n';
      const bom = current.source.charCodeAt(0) === 0xFEFF ? 1 : 0;
      const opening = /^---\r?\n/.exec(current.source.slice(bom)), at = bom + (opening?.[0].length ?? 0);
      const after = opening ? current.source.slice(0, at) + `forester-id: ${JSON.stringify(id)}${newline}` + current.source.slice(at) : current.source.slice(0, bom) + `---${newline}forester-id: ${JSON.stringify(id)}${newline}---${newline}` + current.source.slice(bom);
      const edit = plan.edits.find(edit => edit.path === tree.path);
      if (edit) edit.after = after; else plan.edits.push({ path: tree.path, before: document.source, after });
    } catch (error) { plan.diagnostics.push({ code: 'id-allocation-failed', path: tree.path, message: String(error), severity: 'error' }); plan.edits = []; }
    return plan;
  }

  private serial(action: () => Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      if (this.stopped) return;
      this.inFlight = true;
      try { await action(); }
      finally { this.inFlight = false; await this.refresh(); }
    };
    const result = this.saveTail.then(run, run);
    this.saveTail = result.catch(error => { console.error('Hybrid command', error); new Notice(`Hybrid: ${String(error)}`, 10000); });
    return result;
  }

  async insertTarget(editor: Editor, file: TFile, tree: HybridTree, embed: boolean, replacement?: Parameters<HybridInputHost['insertTarget']>[4]): Promise<void> {
    const path = file.path, before = replacement?.before ?? editor.getValue();
    const from = editor.posToOffset(replacement?.from ?? editor.getCursor('from'));
    const to = editor.posToOffset(replacement?.to ?? editor.getCursor('to'));
    const config = this.configuration();
    // Keep the picker capture live through queued work and every forward CAS await.
    // The source edit is committed last, so controller-owned source patches occur
    // only after the final guard; rollback intentionally does not use this guard.
    const selection = (): string => JSON.stringify(editor.listSelections().map(s => [s.anchor.line, s.anchor.ch, s.head.line, s.head.ch]));
    const capturedSelection = selection();
    const guard = (): boolean => {
      try { return this.active(path, editor) && file.path === path && this.plugin.app.vault.getAbstractFileByPath(path) === file && this.configuration().key === config.key && selection() === capturedSelection; }
      catch { return false; }
    };
    if (!guard() || editor.getValue() !== before || from < 0 || to < from || to > before.length) return;
    await this.serial(async () => {
      await this.refresh();
      if (!guard() || editor.getValue() !== before || !this.isEnabled(path, before)) return;
      const index = this.currentIndex(), document = index.documents.get(path), target = index.documents.get(tree.path);
      if (!syntaxReady(document) || !syntaxReady(target) || !target.trees.includes(tree)) { new Notice('Hybrid: selected tree changed; select it again'); return; }
      if (document.protectedRanges.concat(...document.trees.map(t => t.metadataRanges)).some(range => from === to ? range.from <= from && from < range.to : range.from < to && from < range.to)) return;
      const addressing = tree.id ? { edits: [], diagnostics: [] } : this.addressPlan(index, tree);
      for (const diagnostic of addressing.diagnostics) new Notice(`Hybrid: [${diagnostic.code}] ${diagnostic.message}`, 8000);
      if (addressing.diagnostics.some(d => d.severity === 'error')) return;
      const prepared = this.withPlan(index, addressing);
      const selected = prepared.documents.get(tree.path)?.trees[target.trees.indexOf(tree)];
      if (!selected?.id) { new Notice('Hybrid: cannot safely address selected tree'); return; }
      const resolved = resolveHybrid(prepared, selected.id, path);
      if (resolved.status !== 'resolved' || resolved.tree !== selected) { new Notice(`Hybrid: ${resolved.status === 'resolved' ? 'Selected tree changed' : resolved.message}`); return; }
      const middle = prepared.documents.get(path)!.source;
      const map = (at: number, bias: 'start' | 'end'): number => {
        let shift = 0;
        for (const patch of textPatches(before, middle)) {
          if (at < patch.from) break;
          if (at === patch.from && patch.from === patch.to) return patch.from + shift + (bias === 'start' ? patch.text.length : 0);
          if (at <= patch.to) return patch.from + shift + Math.min(at - patch.from, patch.text.length);
          shift += patch.text.length - (patch.to - patch.from);
        }
        return at + shift;
      };
      const label = encodeWikilinkLabel(selected.meta.title.trim().replace(/[\r\n]+/g, ' '));
      const link = embed ? `![[${selected.id}]]` : `[[${selected.id}${label ? '|' + label : ''}]]`;
      const prospective = middle.slice(0, map(from, 'start')) + link + middle.slice(map(to, to === from ? 'start' : 'end'));
      const draft = this.parse(path, prospective, config);
      const documents = [...prepared.documents.values()].filter(doc => doc.path !== path).concat(draft);
      const prospectiveIndex = indexHybrid(documents);
      const plan = planHybridSave(prospectiveIndex, path);
      const finalTarget = resolveHybrid(this.withPlan(prospectiveIndex, plan), selected.id, path);
      if (finalTarget.status !== 'resolved' || finalTarget.tree.path !== selected.path || finalTarget.tree.id !== selected.id) { new Notice('Hybrid: replacement removes or changes the selected definition; insertion cancelled'); return; }
      for (const diagnostic of plan.diagnostics) new Notice(`Hybrid: [${diagnostic.code}] ${diagnostic.message}`, 8000);
      if (plan.diagnostics.some(d => d.severity === 'error')) return;
      const edits = new Map(addressing.edits.map(edit => [edit.path, { ...edit }]));
      for (const edit of plan.edits) edits.set(edit.path, { path: edit.path, before: index.documents.get(edit.path)!.source, after: edit.after });
      const sourceEdit = plan.edits.find(edit => edit.path === path);
      edits.set(path, { path, before, after: sourceEdit?.after ?? prospective });
      await this.commitPlan({ edits: [...edits.values()], diagnostics: plan.diagnostics }, path, editor, guard, [target]);
    });
  }

  private replaceEditor(editor: Editor, before: string, after: string): void {
    const patches = textPatches(before, after);
    const selections = editor.listSelections().map(s => ({ anchor: editor.posToOffset(s.anchor), head: editor.posToOffset(s.head) }));
    const map = (offset: number): number => {
      let shift = 0;
      for (const p of patches) {
        if (offset < p.from) break;
        if (offset <= p.to) return p.from + shift + Math.min(offset - p.from, p.text.length);
        shift += p.text.length - (p.to - p.from);
      }
      return offset + shift;
    };
    for (const p of [...patches].reverse()) editor.replaceRange(p.text, editor.offsetToPos(p.from), editor.offsetToPos(p.to), 'hybrid-normalize');
    if (editor.getValue() !== after) throw new Error('Minimal editor patch did not reproduce the save snapshot');
    editor.setSelections(selections.map(s => ({ anchor: editor.offsetToPos(map(s.anchor)), head: editor.offsetToPos(map(s.head)) })));
  }

  private async io<T>(path: string, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); }
    catch (error) { new Notice(`Hybrid I/O ${path}: ${String(error)}`, 10000); throw error; }
  }

  private showReport(title: string, summary: string, diagnostics: HybridDiagnostic[]): void {
    const modal = new Modal(this.plugin.app), dom = modal.contentEl.ownerDocument;
    const heading = dom.createElement('h2'); heading.textContent = title;
    const p = dom.createElement('p'); p.textContent = summary;
    const list = dom.createElement('ul');
    for (const d of diagnostics) {
      const li = dom.createElement('li'); li.textContent = `${d.path}${d.line === undefined ? '' : ':' + (d.line + 1)} [${d.code}] ${d.message}`; list.append(li);
    }
    modal.contentEl.append(heading, p, list); modal.open(); this.plugin.register(() => modal.close());
  }

  currentIndex(): HybridIndex {
    if (this.stopped) return this.index;
    const active = this.markdownView() ?? this.plugin.app.workspace.activeEditor;
    if (!active?.file || !active.editor || active.file.extension !== 'md') return this.index;
    const doc = this.parse(active.file.path, active.editor.getValue());
    return this.overlay(doc);
  }

  /** Sidebar focus must not erase the last viewed Markdown leaf. */
  private markdownView(): MarkdownView | undefined {
    const active = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (active) this.lastMarkdown = active;
    if (this.lastMarkdown && this.plugin.app.workspace.getLeavesOfType('markdown').some(leaf => leaf.view === this.lastMarkdown)) return this.lastMarkdown;
    this.lastMarkdown = undefined;
    return undefined;
  }

  current(): { document: HybridDocument; tree: HybridTree } | null {
    if (this.stopped) return null;
    const view = this.markdownView(), path = view?.file?.path;
    if (!view || !path) return null;
    const document = this.parse(path, view.editor.getValue());
    if (!syntaxReady(document)) return null;
    const page = this.treePages.get(view);
    const tree = page?.path === path ? document.trees.find(tree => page.id ? tree.id?.toLowerCase() === page.id.toLowerCase() : tree.key === page.key) ?? document.root : document.root;
    return { document, tree };
  }

  outline(document: HybridDocument, tree: HybridTree): SidebarOutlineEntry[] {
    if (!syntaxReady(document)) return [];
    const index = this.overlay(document);
    const adapt = (entries: ReturnType<typeof treeOutline>): SidebarOutlineEntry[] => entries.map(entry => {
      const resolved = resolveHybrid(index, entry.target, document.path);
      return { ...entry, tree: resolved.status === 'resolved' ? resolved.tree : undefined, children: adapt(entry.children) };
    });
    return adapt(treeOutline(document, (target, path = document.path) => resolveHybrid(index, target, path), tree));
  }

  async openTree(tree: HybridTree, newLeaf: boolean, sourcePath?: string): Promise<void> {
    if (this.stopped) return;
    const index = this.currentIndex(), document = index.documents.get(tree.path);
    const current = document?.trees.find(node => node.key === tree.key);
    if (!syntaxReady(document) || !current) return;
    const target = current === document.root ? current.path : `${current.path}#${current.id ? '^' + current.id : current.headingTitle ?? current.meta.title}`;
    const resolved = resolveHybrid(index, target, tree.path);
    if (resolved.status !== 'resolved' || resolved.tree.key !== current.key) { new Notice(`Hybrid: ${resolved.status === 'resolved' ? 'Tree changed' : resolved.message}`); return; }
    const previous = this.markdownView();
    await this.plugin.app.workspace.openLinkText(target, sourcePath ?? previous?.file?.path ?? tree.path, newLeaf, { eState: { line: current.line } });
    if (this.stopped) return;
    const view = this.markdownView();
    if (view?.file?.path === current.path && (!newLeaf || view !== previous)) this.treePages.set(view, { path: current.path, key: current.key, id: current.id });
    this.notify();
  }

  /** Widgets are created before attachment; bind their actual mounted route lazily. */
  private bindLiveOccurrences(root: HTMLElement, cm: EditorView, document: HybridDocument): void {
    for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('.hybrid-embed'))) {
      if (wrapper.parentElement?.closest('.hybrid-embed')) continue;
      const tree = this.renderedTrees.get(wrapper);
      if (!tree) continue; // Native/excluded embeds cannot authorize a hybrid placement.
      let from: number; try { from = cm.posAtDOM(wrapper); } catch { continue; }
      const key = embedOccurrence(document, from), previous = wrapper.getAttribute('data-hybrid-occurrence') ?? tree.key;
      if (previous === key) continue;
      wrapper.setAttribute('data-hybrid-occurrence', key);
      for (const node of Array.from(wrapper.querySelectorAll<HTMLElement>('[data-hybrid-occurrence]'))) {
        const occurrence = node.getAttribute('data-hybrid-occurrence')!;
        if (occurrence === previous || occurrence.startsWith(previous + '/')) node.setAttribute('data-hybrid-occurrence', key + occurrence.slice(previous.length));
      }
    }
  }

  async focusOccurrence(entry: SidebarOutlineEntry): Promise<void> {
    const view = this.markdownView(), context = this.current();
    if (this.stopped || !view || !context || !entry.occurrenceKey) return;
    const flatten = (entries: SidebarOutlineEntry[]): SidebarOutlineEntry[] => entries.flatMap(item => [item, ...flatten(item.children)]);
    const current = flatten(this.outline(context.document, context.tree)).find(item => item.occurrenceKey === entry.occurrenceKey);
    if (!current?.occurrenceKey) return; // Old sidebar DOM never authorizes a different placement.
    if (current.sourceKey && view.getMode() !== 'preview') {
      const tree = context.document.trees.find(tree => tree.key === current.sourceKey);
      if (!tree) return;
      const position = { line: tree.line, ch: 0 };
      view.editor.setCursor(position); view.editor.scrollIntoView({ from: position, to: position }, true); view.editor.focus();
      return;
    }
    const cm = [...this.nativeViews].find(cm => cm.state.field(editorInfoField, false)?.editor === view.editor) ?? (view.editor as Editor & { cm?: EditorView }).cm;
    const root = view.getMode() === 'preview' ? view.containerEl.querySelector<HTMLElement>('.markdown-preview-view') ?? view.containerEl : cm?.dom ?? view.containerEl.querySelector<HTMLElement>('.markdown-source-view') ?? view.containerEl;
    if (view.getMode() !== 'preview' && cm) this.bindLiveOccurrences(root, cm, context.document);
    const nodes = Array.from(root.querySelectorAll<HTMLElement>('[data-hybrid-occurrence]'));
    let element = nodes.find(node => node.getAttribute('data-hybrid-occurrence') === current.occurrenceKey);
    // CM widgets are created before attachment. Authorize their mounted placement
    // through native offsets, rather than guessing the first target ID in the DOM.
    if (!element && view.getMode() !== 'preview') {
      if (cm) for (const wrapper of Array.from(root.querySelectorAll<HTMLElement>('.hybrid-embed'))) {
        let from: number; try { from = cm.posAtDOM(wrapper); } catch { continue; }
        const placement = embedOccurrence(context.document, from);
        if (current.occurrenceKey === placement) { element = wrapper; break; }
        if (current.occurrenceKey.startsWith(placement + '/tree:') && current.tree) {
          element = Array.from(wrapper.querySelectorAll<HTMLElement>('[data-hybrid-heading]')).find(node => node.getAttribute('data-hybrid-heading') === current.tree!.key);
          if (element) break;
        }
      }
    }
    if (!element) { new Notice('Hybrid: this section is not currently rendered'); return; }
    for (let parent: HTMLElement | null = element; parent && parent !== view.containerEl; parent = parent.parentElement) {
      if (parent.tagName === 'DETAILS') parent.setAttribute('open', '');
      if (parent.classList.contains('is-collapsed')) {
        parent.querySelector<HTMLElement>(':scope > .collapse-indicator')?.click();
        parent.classList.remove('is-collapsed');
      }
    }
    element.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  relations(tree: HybridTree): ReturnType<ReturnType<typeof createTreeRelations>['forTree']> {
    const index = this.currentIndex();
    if (index !== this.relationIndex) {
      this.relationIndex = index;
      this.relationGraph = createTreeRelations(index, (target, path) => resolveHybrid(index, target, path));
    }
    return this.relationGraph!.forTree(tree.key);
  }

  subscribe(update: () => void): () => void {
    if (this.stopped) return () => {};
    this.listeners.add(update);
    return () => this.listeners.delete(update);
  }

  private notify(): void {
    if (this.stopped || !this.listeners.size || this.listenerTimer !== undefined) return;
    this.listenerTimer = scheduleTask(() => {
      this.listenerTimer = undefined;
      if (!this.stopped) for (const update of this.listeners) update();
    }, 0);
  }

  private overlay(document: HybridDocument): HybridIndex {
    if (this.overlayDocuments.get(document.path) === document) return this.overlays.get(document.path)!;
    const index = this.index.documents.get(document.path) === document ? this.index :
      indexHybrid([...this.index.documents.values()].filter(doc => doc.path !== document.path).concat(document));
    this.overlayDocuments.set(document.path, document); this.overlays.set(document.path, index);
    return index;
  }

  private async checkTrees(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    const path = this.plugin.app.workspace.getActiveFile()?.path, index = this.currentIndex();
    const doc = path ? index.documents.get(path) : undefined;
    if (!doc?.enabled) { new Notice('Hybrid: 有効なノートを開いてください'); return; }
    const diagnostics = index.diagnostics.filter(d => d.path === doc.path);
    const links = /!?\[\[([^\]\r\n]+)\]\]/g;
    for (let m; (m = links.exec(doc.source));) {
      if (doc.protectedRanges.some(r => r.from < links.lastIndex && r.to > m!.index)) continue;
      let slash = m.index; while (slash > 0 && doc.source[slash - 1] === '\\') slash--;
      if ((m.index - slash) % 2) continue;
      const target = m[1].split('|')[0], result = resolveHybrid(index, target, doc.path);
      const line = doc.source.slice(0, m.index).split('\n').length - 1;
      if (result.status !== 'resolved') diagnostics.push({ code: `${result.status}-reference`, message: result.message, path: doc.path, line, severity: 'error' });
      else if (doc.source.slice(Math.max(0, m.index - 5), m.index) === '{ref:' && !citationLabel(result.tree.meta)) {
        diagnostics.push({ code: 'missing-citation-metadata', message: '文献著者/出版年が不足しています', path: doc.path, line, severity: 'error' });
      }
    }
    for (const span of planDisplay(doc, [], target => resolveHybrid(index, target, doc.path)).spans) {
      if (span.kind === 'embed' && span.error) diagnostics.push({ code: 'invalid-embed', message: span.error, path: doc.path, severity: 'error' });
    }
    this.showReport('Hybrid tree check · ローカル', `${doc.path}: ${doc.trees.length} trees / ${diagnostics.length} diagnostics`, diagnostics);
  }

  private async previewPublic(): Promise<void> {
    await this.refresh();
    if (this.stopped) return;
    const projection = projectPublic(this.currentIndex());
    // A local summary only: no private source/body/JSON, file, clipboard or network sink.
    this.showReport('Public projection preview · ローカルのみ', `${projection.trees.length} public trees / ${projection.diagnostics.length} diagnostics · 公開/書出しは行いません`, projection.diagnostics);
  }

  private open(target: string, path: string, index = this.overlays.get(path) ?? this.currentIndex(), newLeaf = false): void {
    if (this.stopped) return;
    const result = resolveHybrid(index, target, path);
    if (result.status !== 'resolved') { new Notice(`Hybrid: ${result.message}`); return; }
    void this.openTree(result.tree, newLeaf, path).catch(error => new Notice(`Hybrid navigation: ${String(error)}`, 8000));
  }

  private citation(span: DisplaySpan, path: string, dom: Document, index = this.index): HTMLElement {
    const el = dom.createElement('span'); el.className = 'hybrid-citation';
    if (span.error) { el.classList.add('hybrid-error'); el.title = span.error; }
    const a = dom.createElement('a'); a.className = 'internal-link'; a.textContent = span.text ?? '(引用情報未設定)'; a.href = '#';
    a.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); this.open(span.target ?? '', path); });
    el.append(a); return el;
  }

  private bareIdentity(target: string, index: HybridIndex): boolean {
    return !target.includes('#') && !target.includes('/') && !/\.md$/i.test(target) && index.ids.has(target.toLowerCase());
  }

  private idTargets(doc: HybridDocument, from: number, to: number, index: HybridIndex): Set<string> {
    const targets = new Set<string>(), links = /(!?)\[\[([^\]\r\n]+)\]\]/g;
    for (let m; (m = links.exec(doc.source));) {
      if (m[1] || m.index < from || links.lastIndex > to || doc.source.slice(Math.max(0, m.index - 5), m.index) === '{ref:') continue;
      if (doc.protectedRanges.some(r => r.from < links.lastIndex && r.to > m!.index)) continue;
      let start = m.index; while (start > 0 && doc.source[start - 1] === '\\') start--;
      if ((m.index - start) % 2) continue;
      const target = m[2].split('|')[0]; if (this.bareIdentity(target, index)) targets.add(target);
    }
    return targets;
  }

  private idAnchors(el: HTMLElement, doc: HybridDocument, from: number, to: number, index: HybridIndex): HTMLElement[] {
    const targets = this.idTargets(doc, from, to, index);
    return Array.from(el.querySelectorAll<HTMLElement>('a.internal-link')).filter(anchor => {
      for (let parent = anchor.parentElement; parent && parent !== el; parent = parent.parentElement) {
        if (parent.matches('pre, code, blockquote, .internal-embed, .hybrid-embed, .hybrid-citation')) return false;
      }
      return targets.has(anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '');
    });
  }

  private bindIdLinks(el: HTMLElement, doc: HybridDocument, from: number, to: number, index: HybridIndex, owner: Component): void {
    for (const anchor of this.idAnchors(el, doc, from, to, index)) {
      if (anchor.hasAttribute('data-hybrid-link')) continue;
      const target = anchor.getAttribute('data-href') ?? anchor.getAttribute('href') ?? '';
      anchor.setAttribute('data-hybrid-link', target);
      owner.registerDomEvent(anchor, 'click', event => { event.preventDefault(); event.stopImmediatePropagation(); this.open(target, doc.path, undefined, event.ctrlKey || event.metaKey); }, { capture: true });
      owner.register(() => anchor.removeAttribute('data-hybrid-link'));
    }
  }

  private previewIdClick(event: MouseEvent, view: EditorView): void {
    if (this.stopped || !view.state.field(editorLivePreviewField, false)) return;
    const info = view.state.field(editorInfoField, false);
    const clicked = event.target as HTMLElement | null;
    if (clicked?.closest?.('.hybrid-header-slug .hybrid-slug') && info?.file && this.isEnabled(info.file.path, view.state.doc.toString())) {
      const document = this.parse(info.file.path, view.state.doc.toString());
      let at: number; try { at = view.posAtDOM(clicked); } catch { return; }
      if (document.protectedRanges.some(range => range.from <= at && at < range.to)) return;
      const tree = document.trees.filter(tree => tree.from <= at && (at < tree.to || at === document.source.length && tree.to === at)).sort((a, b) => b.level - a.level)[0];
      if (tree?.id) { event.preventDefault(); event.stopImmediatePropagation(); void this.openTree(tree, event.ctrlKey || event.metaKey, info.file.path).catch(error => new Notice(`Hybrid navigation: ${String(error)}`, 8000)); }
      return;
    }
    const toc = clicked?.closest?.('.hybrid-toc'), anchor = clicked?.closest?.('a');
    if (toc && anchor && info?.file && this.isEnabled(info.file.path, view.state.doc.toString())) {
      const document = this.parse(info.file.path, view.state.doc.toString());
      const flatten = (entries: SidebarOutlineEntry[]): SidebarOutlineEntry[] => entries.reduce<SidebarOutlineEntry[]>((all, entry) => all.concat(entry, flatten(entry.children)), []);
      const entry = flatten(this.outline(document, document.root))[Array.from(toc.querySelectorAll('a')).indexOf(anchor)];
      if (entry) { event.preventDefault(); event.stopImmediatePropagation(); void this.focusOccurrence(entry); }
      return;
    }
    if (!info?.file || !this.isEnabled(info.file.path, view.state.doc.toString())) return;
    const element = event.target as HTMLElement | null;
    const link = element?.closest?.('a.internal-link, .cm-hmd-internal-link');
    if (!link || link.hasAttribute('data-hybrid-link') || link.closest('pre, code, blockquote, .internal-embed, .hybrid-embed, .hybrid-citation, .markdown-rendered, .markdown-preview-view, .markdown-embed-content')) return;
    const doc = this.parse(info.file.path, view.state.doc.toString());
    const index = this.overlay(doc);
    const sourceLink = link.matches('.cm-hmd-internal-link');
    if (sourceLink && !event.ctrlKey && !event.metaKey) return; // Plain source clicks must still edit.
    const href = link.getAttribute('data-href') ?? link.getAttribute('href') ?? '';
    let pos: number;
    try { pos = view.posAtDOM(link); } catch { return; } // Unbound/renderer-only DOM is not an authorization source.
    const links = /!?\[\[([^\]\r\n]+)\]\]/g;
    let target = '';
    for (let m; (m = links.exec(doc.source));) {
      if (m.index <= pos && pos < links.lastIndex) {
        const candidate = m[1].split('|')[0];
        if ((!sourceLink && href !== candidate) || !this.idTargets(doc, m.index, links.lastIndex, index).has(candidate)) return;
        target = candidate; break;
      }
    }
    if (!target) return;
    event.preventDefault(); event.stopImmediatePropagation(); this.open(target, doc.path, index, event.ctrlKey || event.metaKey);
  }

  private sectionSource(doc: HybridDocument, tree: Pick<HybridTree, 'contentFrom' | 'to'>, index: HybridIndex): { source: string; slots: Map<string, DisplaySpan> } {
    const slots = new Map<string, DisplaySpan>();
    const plan = planDisplay(doc, [], target => resolveHybrid(index, target, doc.path));
    const spans: DisplaySpan[] = plan.spans.filter(s => s.kind !== 'metadata');
    for (const node of doc.trees) for (const r of node.metadataRanges) spans.push({ ...r, kind: 'metadata' });
    spans.sort((a, b) => a.from - b.from || b.to - a.to);
    let cursor = tree.contentFrom, source = '';
    for (const span of spans) {
      if (span.from < cursor || span.to > tree.to) continue;
      source += doc.source.slice(cursor, span.from);
      if (span.kind !== 'metadata') {
        const id = `hybrid-${++this.slotSequence}`; slots.set(id, span);
        const tag = span.kind === 'embed' ? 'div' : 'span';
        source += `<${tag} data-hybrid-slot="${id}"></${tag}>`;
      }
      cursor = span.to;
    }
    return { source: source + doc.source.slice(cursor, tree.to), slots };
  }

  private applySlots(body: HTMLElement, slots: Map<string, DisplaySpan>, doc: HybridDocument, component: Component, index: HybridIndex, stack: string[], budget: { remaining: number }, root = doc.root, occurrence = root.key): void {
    for (const [id, span] of slots) {
      const nodes = body.querySelectorAll<HTMLElement>(`[data-hybrid-slot="${id}"]`);
      if (nodes.length !== 1) throw new Error('Native renderer removed or duplicated a hybrid placeholder');
      const slot = nodes[0]; slot.removeAttribute('data-hybrid-slot'); slot.className = `hybrid-${span.kind}`;
      slot.setAttribute('data-hybrid-source-path', doc.path); slot.setAttribute('data-hybrid-from', String(span.from)); slot.setAttribute('data-hybrid-to', String(span.to));
      if (span.kind === 'citation') slot.replaceChildren(this.citation(span, doc.path, body.ownerDocument, index));
      else if (span.kind === 'raw') {
        const label = body.ownerDocument.createElement('span'); label.className = 'hybrid-raw-label'; label.textContent = 'Forester · 未評価';
        const code = body.ownerDocument.createElement('code'); code.textContent = span.raw ?? ''; slot.append(label, code);
        if (span.error) { slot.classList.add('hybrid-error'); slot.title = span.error; }
      } else if (span.kind === 'embed') {
        slot.setAttribute('data-hybrid-occurrence', embedOccurrence(doc, doc.source.indexOf('![[', span.from), root, occurrence));
        this.renderEmbed(slot, span.target ?? '', span.flags!, doc.path, component, index, stack, budget);
      }
    }
  }

  private nativeTarget(target: string, path: string, index: HybridIndex): boolean {
    const base = resolveHybrid(index, target.split('#')[0] || path, path);
    if (base.status === 'ambiguous') return false;
    if (base.status === 'resolved' && !syntaxReady(base.document)) return true;
    const asset = this.plugin.app.vault.getAbstractFileByPath(target.split('#')[0]);
    return base.status === 'missing' && asset instanceof TFile && asset.extension !== 'md';
  }

  private renderEmbed(el: HTMLElement, target: string, flags: EmbedFlags, path: string, parent: Component = this.plugin, index = this.overlays.get(path) ?? this.index,
      stack: string[] = [index.documents.get(path)?.root.key ?? path], budget = { remaining: 256 }): () => void {
    const result = resolveHybrid(index, target, path);
    el.replaceChildren(); el.setAttribute('data-toc', String(flags.toc));
    if (this.nativeTarget(target, path, index)) {
      const component = parent.addChild(new Component()); component.load();
      el.setAttribute('data-hybrid-render', String(this.revision));
      let cancelled = false; component.register(() => { cancelled = true; });
      void MarkdownRenderer.render(this.plugin.app, `![[${target}]]`, el, path, component).catch(error => {
        if (!cancelled) { el.textContent = `Hybrid native embed: ${String(error)}`; new Notice(el.textContent, 8000); }
      });
      return () => { parent.removeChild(component); };
    }
    if (result.status !== 'resolved') { el.classList.add('hybrid-error'); el.textContent = result.message; return () => {}; }
    const { document: doc, tree } = result;
    this.renderedTrees.set(el, tree);
    const error = flags.error ?? (stack.includes(tree.key) ? 'Hybrid embed cycle' : stack.length >= 12 || --budget.remaining < 0 ? 'Hybrid embed limit' : undefined);
    if (error) { el.classList.add('hybrid-error'); el.textContent = error; return () => {}; }
    el.setAttribute('data-hybrid-render', String(this.revision));
    el.setAttribute('data-hybrid-source-path', tree.path);
    el.setAttribute('data-hybrid-from', String(tree.contentFrom)); el.setAttribute('data-hybrid-to', String(tree.to));
    const component = parent.addChild(new Component()); component.load();
    if (flags.heading) {
      const header = renderTreeHeader(el.ownerDocument, tree, [tree.meta.taxon, tree.number].filter(Boolean).join(' '), this.headerHost(component, index));
      this.bindTreeRoute(header, tree, component); el.append(header);
    }
    const body = el.ownerDocument.createElement('div'); body.className = 'hybrid-tree-body'; el.append(body);
    let cancelled = false; component.register(() => { cancelled = true; this.renderedTrees.delete(el); });
    const section = this.sectionSource(doc, tree, index);
    void MarkdownRenderer.render(this.plugin.app, section.source, body, tree.path, component).then(() => {
      if (cancelled || this.stopped) return;
      const occurrence = el.getAttribute('data-hybrid-occurrence') ?? tree.key;
      this.decorateHeadings(body, doc, tree.contentFrom, tree.to, index, component, tree, occurrence);
      this.applySlots(body, section.slots, doc, component, index, [...stack, tree.key], budget, tree, occurrence);
      this.bindIdLinks(body, doc, tree.contentFrom, tree.to, index, component);
    }).catch(error => {
      if (!cancelled) { body.classList.add('hybrid-error'); body.textContent = `Hybrid: ${String(error)}`; new Notice(body.textContent, 8000); }
    });
    return () => { parent.removeChild(component); };
  }

  /** Source positions, never a vault-wide title match. Native excerpts are deliberately left alone. */
  private readingChild(el: HTMLElement, ctx: MarkdownPostProcessorContext): MarkdownRenderChild {
    const child = new MarkdownRenderChild(el); this.readingChildren.add(child);
    child.register(() => this.readingChildren.delete(child)); ctx.addChild(child); return child;
  }

  private bindTreeRoute(heading: HTMLElement, tree: HybridTree, owner: Component): void {
    const slug = heading.querySelector<HTMLElement>('.hybrid-slug');
    if (!slug || slug.hasAttribute('data-hybrid-tree-route')) return;
    slug.setAttribute('data-hybrid-tree-route', tree.key);
    owner.registerDomEvent(slug, 'click', event => {
      event.preventDefault(); event.stopImmediatePropagation();
      void this.openTree(tree, event.ctrlKey || event.metaKey, tree.path).catch(error => new Notice(`Hybrid navigation: ${String(error)}`, 8000));
    }, { capture: true });
    owner.register(() => slug.removeAttribute('data-hybrid-tree-route'));
  }

  private headerHost(owner: Component, index = this.index): HeaderHost {
    return { resolve: (target, path) => resolveHybrid(index, target, path), open: (target, path) => this.open(target, path, index), register: cleanup => owner.register(cleanup) };
  }

  private headerHeadings(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).filter(h => {
      for (let parent = h.parentElement; parent && parent !== el; parent = parent.parentElement) if (parent.matches('pre, code, blockquote, .internal-embed, .hybrid-embed, .hybrid-tree-header')) return false;
      return true;
    });
  }

  private decorateHeadings(el: HTMLElement, doc: HybridDocument, from: number, to: number, index: HybridIndex, owner: Component, root = doc.root, occurrence = root.key): void {
    const headings = this.headerHeadings(el);
    const normalize = (text: string): string => text.replace(/^ {0,3}#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').replace(/\s+\^[A-Za-z0-9-]+$/, '').replace(/(?:^|\s)#[A-Za-z][\w/-]*(?=\s|$)/g, '').replace(/[`*_]/g, '').trim();
    const rootLine = doc.source.split('\n').findIndex((line, i, lines) => /^ {0,3}#\s+/.test(line) && !doc.protectedRanges.some(r => { const at = lines.slice(0, i).reduce((n, s) => n+s.length+1, 0); return r.from <= at && at < r.to; }));
    const rootAt = rootLine < 0 ? -1 : doc.source.split('\n').slice(0, rootLine).reduce((n, s) => n+s.length+1, 0);
    const available = doc.trees.filter(t => t.level === 1 ? rootAt >= from && rootAt < to : t.from >= from && t.from < to);
    const labels = new Map(planDisplay(doc, [], (target, sourcePath = doc.path) => resolveHybrid(index, target, sourcePath)).headings.map(h => [h.at, h.label]));
    const host = this.headerHost(owner, index);
    for (const heading of headings) {
      const existing = heading.getAttribute('data-hybrid-heading');
      const at = available.findIndex(tree => existing ? tree.key === existing : tree.level === Number(heading.tagName.slice(1)) && normalize(tree.headingTitle ?? tree.meta.title) === normalize(heading.textContent ?? ''));
      if (at < 0) continue;
      const tree = available.splice(at, 1)[0];
      if (existing) {
        if (!heading.querySelector('[data-hybrid-badge]')) appendTaxon(heading, tree, tree.level === 1 ? tree.meta.taxon ?? '' : labels.get(tree.from) ?? [tree.meta.taxon, tree.number].filter(Boolean).join(' '));
        continue;
      }
      heading.setAttribute('data-hybrid-heading', tree.key);
      heading.setAttribute('data-hybrid-occurrence', treeOccurrence(doc, tree, root, occurrence));
      heading.setAttribute('data-hybrid-source-path', doc.path); heading.setAttribute('data-hybrid-from', String(tree.level === 1 ? rootAt : tree.from)); heading.setAttribute('data-hybrid-to', String(tree.to));
      // Remove only the native caret suffix, preserving rich Markdown title nodes.
      const texts: Text[] = [];
      const collect = (node: Node): void => { if (node.nodeType === 3) texts.push(node as Text); else for (const child of Array.from(node.childNodes)) collect(child); };
      collect(heading);
      const last = texts[texts.length-1], original = last?.data;
      if (last && tree.id) last.data = last.data.replace(new RegExp('\\s+\\^' + tree.id + '\\s*$'), '');
      const label = tree.level === 1 ? tree.meta.taxon ?? '' : labels.get(tree.from) ?? [tree.meta.taxon, tree.number].filter(Boolean).join(' ');
      appendTaxon(heading, tree, label); appendSlug(heading, tree, host);
      this.bindTreeRoute(heading, tree, owner);
      const slugSpace = heading.querySelector('.hybrid-slug')?.previousSibling;
      const metadata = renderMetadata(el.ownerDocument, tree, host); if (metadata) heading.after(metadata);
      owner.register(() => { heading.querySelector('[data-hybrid-badge]')?.remove(); heading.querySelector('.hybrid-slug')?.remove(); slugSpace?.parentNode?.removeChild(slugSpace); metadata?.remove(); heading.removeAttribute('data-hybrid-heading'); heading.removeAttribute('data-hybrid-occurrence'); if (last && original !== undefined) last.data = original; });
    }
  }

  private processReading(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> | void {
    const doc = this.index.documents.get(ctx.sourcePath);
    if (this.stopped || !syntaxReady(doc) || el.closest('pre, code, blockquote, .internal-embed, [data-hybrid-render]')) return;
    for (const [native, previous] of this.readingEmbeds) {
      if (previous.section === el && (!el.contains(native) || !native.contains(previous.wrapper))) previous.child.unload();
    }

    const info = ctx.getSectionInfo(el);
    if (!info || info.text !== doc.source || info.lineStart < 0 || info.lineEnd < info.lineStart) return;
    const lines = doc.source.split('\n');
    const from = lines.slice(0, info.lineStart).reduce((n, line) => n + line.length + 1, 0);
    const to = Math.min(doc.source.length, lines.slice(0, info.lineEnd + 1).reduce((n, line) => n + line.length + 1, 0));
    // Replace this one source-matched section, not a guessed DOM substring, when raw spans could contain Markdown/HTML.
    if (doc.raw.some(r => r.from >= from && r.to <= to)) {
      this.readingHeaders.get(el)?.child.unload();
      const child = this.readingChild(el, ctx);
      let cancelled = false; child.register(() => { cancelled = true; });
      el.setAttribute('data-hybrid-render', String(this.revision)); el.replaceChildren();
      const index = this.index, section = this.sectionSource(doc, { contentFrom: from, to }, index);
      return MarkdownRenderer.render(this.plugin.app, section.source, el, doc.path, child).then(() => {
        if (!cancelled && !this.stopped) { this.decorateHeadings(el, doc, from, to, index, child); this.applySlots(el, section.slots, doc, child, index, [doc.root.key], { remaining: 256 }); this.bindIdLinks(el, doc, from, to, index, child); }
      }).catch(error => { if (!cancelled) { el.classList.add('hybrid-error'); el.textContent = `Hybrid: ${String(error)}`; new Notice(el.textContent, 8000); } });
    }
    const headings = this.headerHeadings(el), headerSignature = `${this.revision}:${doc.path}:${from}:${to}`;
    const oldHeaders = this.readingHeaders.get(el);
    if (oldHeaders && (oldHeaders.signature !== headerSignature || oldHeaders.headings.length !== headings.length || oldHeaders.headings.some((heading, at) => heading !== headings[at]) || oldHeaders.nodes.some(node => !el.contains(node)))) oldHeaders.child.unload();
    if (headings.length && !this.readingHeaders.has(el)) {
      const child = this.readingChild(el, ctx);
      this.readingHeaders.set(el, { child, headings, nodes: [], signature: headerSignature });
      child.register(() => { if (this.readingHeaders.get(el)?.child === child) this.readingHeaders.delete(el); });
    }
    const headers = this.readingHeaders.get(el);
    if (headers) {
      this.decorateHeadings(el, doc, from, to, this.index, headers.child);
      // Native partial rerenders can replace just a badge/link while keeping the heading container.
      headers.nodes = [];
      for (const heading of headings) {
        headers.nodes.push(...Array.from(heading.querySelectorAll('[data-hybrid-badge], .hybrid-slug')));
        const metadata = heading.nextElementSibling;
        if (metadata?.matches('.hybrid-metadata')) headers.nodes.push(metadata, ...Array.from(metadata.querySelectorAll('a')));
      }
    }
    const anchors = this.idAnchors(el, doc, from, to, this.index);
    const linkSignature = `${this.revision}:${doc.path}:${from}:${to}`;
    const oldLinks = this.readingLinks.get(el);
    if (oldLinks && (oldLinks.signature !== linkSignature || oldLinks.anchors.length !== anchors.length || oldLinks.anchors.some((anchor, at) => anchor !== anchors[at]))) oldLinks.child.unload();
    if (anchors.length && !this.readingLinks.has(el)) {
      const child = this.readingChild(el, ctx);
      this.readingLinks.set(el, { child, anchors, signature: linkSignature });
      child.register(() => { if (this.readingLinks.get(el)?.child === child) this.readingLinks.delete(el); });
      this.bindIdLinks(el, doc, from, to, this.index, child);
    }
    const plan = planDisplay(doc, [], target => resolveHybrid(this.index, target, doc.path));
    const consumed = new Set<HTMLElement>();
    for (const span of plan.spans.filter(s => s.kind === 'embed' && s.from >= from && s.to <= to)) {
      const native = Array.from(el.querySelectorAll<HTMLElement>('.internal-embed, .hybrid-managed-embed')).find(node => {
        const previous = this.readingEmbeds.get(node);
        // A partial native rerender may omit an earlier occurrence of the same target.
        return !consumed.has(node) && !node.closest('pre, code, blockquote, [data-hybrid-render]') &&
          (node.getAttribute('src') ?? node.getAttribute('data-href')) === span.target &&
          (!previous || previous.path !== doc.path || previous.source !== doc.source || previous.from === span.from);
      });
      if (!native) continue;
      consumed.add(native);
      if (this.nativeTarget(span.target ?? '', doc.path, this.index)) continue;
      const resolved = resolveHybrid(this.index, span.target ?? '', doc.path);
      if (resolved.status === 'resolved' && !resolved.document.enabled) continue;
      const signature = `${this.revision}:${doc.path}:${span.from}:${span.to}:${span.target}:${JSON.stringify(span.flags)}`;
      const previous = this.readingEmbeds.get(native);
      if (previous?.signature === signature && native.contains(previous.wrapper)) continue;
      previous?.child.unload();
      // Native Obsidian populates .internal-embed placeholders after postprocessing.
      // Once this source-matched occurrence is ours, prevent its filename/block
      // renderer from replacing the complete tree with a one-block excerpt.
      const wasNativeEmbed = native.classList.contains('internal-embed');
      native.classList.remove('internal-embed'); native.classList.add('hybrid-managed-embed');
      const wrapper = el.ownerDocument.createElement('div'); wrapper.className = 'hybrid-embed';
      wrapper.setAttribute('data-hybrid-occurrence', embedOccurrence(doc, doc.source.indexOf('![[', span.from)));
      native.replaceChildren(wrapper);
      const child = this.readingChild(wrapper, ctx);
      child.register(() => {
        native.classList.remove('hybrid-managed-embed');
        if (wasNativeEmbed) native.classList.add('internal-embed');
      });
      this.readingEmbeds.set(native, { section: el, child, wrapper, path: doc.path, source: doc.source, from: span.from, signature });
      child.register(() => { if (this.readingEmbeds.get(native)?.child === child) this.readingEmbeds.delete(native); });
      child.register(this.renderEmbed(wrapper, span.target ?? '', span.flags!, doc.path, child, this.index));
    }
    for (const span of plan.spans.filter(s => s.kind === 'citation' && s.from >= from && s.to <= to)) {
      const nodes: Text[] = [];
      const collect = (node: Node): void => {
        if (node.nodeType === 3) { nodes.push(node as Text); return; }
        if (node.nodeType === 1 && (node as HTMLElement).matches('pre, code, blockquote, .internal-embed, .hybrid-citation, [data-hybrid-render]')) return;
        for (const child of Array.from(node.childNodes)) collect(child);
      };
      collect(el);
      const literal = doc.source.slice(span.from, span.to);
      const text = nodes.find(node => node.data.includes(literal));
      if (text) {
        const at = text.data.indexOf(literal);
        text.replaceWith(el.ownerDocument.createTextNode(text.data.slice(0, at)), this.citation(span, doc.path, el.ownerDocument), el.ownerDocument.createTextNode(text.data.slice(at + literal.length)));
        continue;
      }
      // The native renderer splits a citation across a text node, wikilink and closing text.
      const link = Array.from(el.querySelectorAll<HTMLAnchorElement>('a.internal-link')).find(a =>
        !a.closest('pre, code, blockquote, .internal-embed, .hybrid-citation, [data-hybrid-render]') &&
        (a.getAttribute('data-href') ?? a.getAttribute('href')) === span.target &&
        a.previousSibling?.nodeType === 3 && /\{ref:$/.test(a.previousSibling.textContent ?? '') &&
        a.nextSibling?.nodeType === 3 && (a.nextSibling.textContent ?? '').startsWith('}'));
      if (link) {
        const before = link.previousSibling as Text, after = link.nextSibling as Text;
        before.data = before.data.slice(0, -5); after.data = after.data.slice(1);
        link.replaceWith(this.citation(span, doc.path, el.ownerDocument));
      }
    }
  }
}
