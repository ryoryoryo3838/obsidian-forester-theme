import { Component, editorInfoField, editorLivePreviewField, MarkdownRenderChild, MarkdownRenderer, MarkdownView, Modal, Notice, Plugin, TFile, type Editor, type MarkdownPostProcessorContext } from 'obsidian';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import type { EditorState } from '@codemirror/state';
import { hybridModeEnabled, indexHybrid, parseHybrid, planHybridSave, resolveHybrid } from './hybrid-core';
import { createHybridEditor, hybridRefresh } from './hybrid-editor';
import { commitHybridPlan } from './hybrid-save';
import { projectPublic } from './hybrid-public';
import { citationLabel, foresterTokens, planDisplay, type DisplaySpan, type EmbedFlags } from './hybrid-display';
import { appendSlug, appendTaxon, renderMetadata, renderTreeHeader, type HeaderHost } from './hybrid-header';
import type { HybridDiagnostic, HybridDocument, HybridIndex, HybridOptions, HybridTree } from './hybrid-types';

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
  private readingHeaders = new WeakMap<HTMLElement, { child: MarkdownRenderChild; headings: HTMLElement[]; nodes: Element[]; signature: string }>();
  private readingEmbeds = new Map<HTMLElement, { section: HTMLElement; child: MarkdownRenderChild; wrapper: HTMLElement; path: string; source: string; from: number; signature: string }>();
  private readingLinks = new WeakMap<HTMLElement, { child: MarkdownRenderChild; anchors: HTMLElement[]; signature: string }>();

  constructor(private plugin: Plugin, private options: () => HybridOptions) {}

  private configuration(): { options: HybridOptions; key: string } {
    const value = this.options();
    const options = { folders: [...value.folders], publicFolders: [...value.publicFolders], reservedIds: [...value.reservedIds] };
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
    let document = parseHybrid(path, source, config.options);
    // hybrid-v0 is a core compatibility dialect, not an adapter opt-in.
    if (Object.prototype.hasOwnProperty.call(document.frontmatter, 'forester-mode') &&
        ![true, false, 'hybrid-v1'].includes(document.frontmatter['forester-mode'] as boolean | string)) {
      document = { ...document, enabled: false };
    }
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
      const dom = el.ownerDocument; el.replaceChildren();
      if (this.isEnabled(ctx.sourcePath)) { const label = dom.createElement('span'); label.className = 'hybrid-raw-label'; label.textContent = 'Forester · 未評価'; el.append(label); }
      const pre = dom.createElement('pre'), code = dom.createElement('code'); code.className = 'language-forester';
      for (const token of foresterTokens(source)) { const span = dom.createElement('span'); span.className = `hybrid-token-${token.kind}`; span.textContent = token.text; code.append(span); }
      pre.append(code); el.append(pre);
    });
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
        // Unload unregisters native views, but an in-flight rollback still needs their snapshot guards.
        const retained = new Map(plan.edits.map(edit => [edit.path, this.editors(edit.path)]));
        const openEditors = (target: string): Editor[] => [...new Set([...this.editors(target), ...(retained.get(target) ?? []).filter(e => {
          const info = (e as Editor & { cm?: EditorView }).cm?.state?.field(editorInfoField, false);
          return !info?.file || info.file.path === target; // Do not patch an editor reused for another file.
        })])];
        const result = await commitHybridPlan(plan, {
          read: async target => {
            const file = this.plugin.app.vault.getAbstractFileByPath(target);
            if (!(file instanceof TFile)) throw new Error(`Missing file: ${target}`);
            const disk = await this.io(target, () => this.plugin.app.vault.read(file));
            if (!this.active(path, editor) || openEditors(target).some(e => e.getValue() !== disk)) throw new Error(`Unsettled editor: ${target}`);
            return disk;
          },
          compareWrite: async (target, before, after, purpose = 'forward') => {
            const rollback = purpose === 'rollback';
            const file = this.plugin.app.vault.getAbstractFileByPath(target);
            if (!(file instanceof TFile) || (!rollback && !this.isEnabled(target, before))) return false;
            let accepted = false;
            const written = await this.io(target, () => this.plugin.app.vault.process(file, current => {
              // Cleanup is still CAS-protected, but must not depend on the author staying in this view.
              if ((!rollback && !this.active(path, editor)) || current !== before || openEditors(target).some(e => e.getValue() !== before && (!rollback || e.getValue() !== after))) return current;
              accepted = true; return after;
            }));
            if (!accepted || written !== after) return false;
            if (await this.io(target, () => this.plugin.app.vault.read(file)) !== after) throw new Error(`Post-write disk changed: ${target}`);
            if (!rollback && !this.active(path, editor)) throw new Error(`Save interrupted: ${target}`);
            const open = openEditors(target);
            if (open.some(e => e.getValue() !== before && e.getValue() !== after)) throw new Error(`Editor changed during write: ${target}`);
            for (const e of open) if (e.getValue() === before) {
              this.updatingEditors.add(e);
              try { this.replaceEditor(e, before, after); }
              catch (error) { new Notice(`Hybrid editor ${target}: ${String(error)}`, 10000); throw error; }
              finally { this.updatingEditors.delete(e); }
            }
            this.recordSource(target, after);
            return true;
          },
        }, path);
        if (!result.committed) new Notice(`Hybrid: 保存を中止 [${result.conflicts.join(', ')}]${result.partial.length ? ` / partial rollback: ${result.partial.join(', ')}` : ''}`, 10000);
      } catch (error) { new Notice(`Hybrid I/O: ${String(error)}`, 10000); }
      finally { this.inFlight = false; await this.refresh(); }
    };
    this.saveTail = this.saveTail.then(run, run).catch(error => { new Notice(`Hybrid: ${String(error)}`, 10000); console.error('Hybrid settled save', error); });
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

  private currentIndex(): HybridIndex {
    const active = this.plugin.app.workspace.activeEditor;
    if (!active?.file || !active.editor) return this.index;
    const doc = this.parse(active.file.path, active.editor.getValue());
    return this.overlay(doc);
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

  private open(target: string, path: string, index = this.overlays.get(path) ?? this.currentIndex()): void {
    if (this.stopped) return;
    const result = resolveHybrid(index, target, path);
    if (result.status !== 'resolved') { new Notice(`Hybrid: ${result.message}`); return; }
    const link = result.tree === result.document.root ? result.tree.path : `${result.tree.path}#${result.tree.id ? '^' + result.tree.id : result.tree.meta.title}`;
    void this.plugin.app.workspace.openLinkText(link, path, false, { eState: { line: result.tree.line } });
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
      owner.registerDomEvent(anchor, 'click', event => { event.preventDefault(); event.stopImmediatePropagation(); this.open(target, doc.path); }, { capture: true });
      owner.register(() => anchor.removeAttribute('data-hybrid-link'));
    }
  }

  private previewIdClick(event: MouseEvent, view: EditorView): void {
    if (this.stopped || !view.state.field(editorLivePreviewField, false)) return;
    const info = view.state.field(editorInfoField, false);
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
    event.preventDefault(); event.stopImmediatePropagation(); this.open(target, doc.path, index);
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

  private applySlots(body: HTMLElement, slots: Map<string, DisplaySpan>, doc: HybridDocument, component: Component, index: HybridIndex, stack: string[], budget: { remaining: number }): void {
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
      } else if (span.kind === 'embed') this.renderEmbed(slot, span.target ?? '', span.flags!, doc.path, component, index, stack, budget);
    }
  }

  private nativeTarget(target: string, path: string, index: HybridIndex): boolean {
    const base = resolveHybrid(index, target.split('#')[0] || path, path);
    if (base.status === 'ambiguous') return false;
    if (base.status === 'resolved' && !base.document.enabled) return true;
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
    const error = flags.error ?? (stack.includes(tree.key) ? 'Hybrid embed cycle' : stack.length >= 12 || --budget.remaining < 0 ? 'Hybrid embed limit' : undefined);
    if (error) { el.classList.add('hybrid-error'); el.textContent = error; return () => {}; }
    el.setAttribute('data-hybrid-render', String(this.revision));
    el.setAttribute('data-hybrid-source-path', tree.path);
    el.setAttribute('data-hybrid-from', String(tree.contentFrom)); el.setAttribute('data-hybrid-to', String(tree.to));
    const component = parent.addChild(new Component()); component.load();
    if (flags.heading) el.append(renderTreeHeader(el.ownerDocument, tree, [tree.meta.taxon, tree.number].filter(Boolean).join(' '), this.headerHost(component, index)));
    const body = el.ownerDocument.createElement('div'); body.className = 'hybrid-tree-body'; el.append(body);
    let cancelled = false; component.register(() => { cancelled = true; });
    const section = this.sectionSource(doc, tree, index);
    void MarkdownRenderer.render(this.plugin.app, section.source, body, tree.path, component).then(() => {
      if (cancelled || this.stopped) return;
      this.decorateHeadings(body, doc, tree.contentFrom, tree.to, index, component);
      this.applySlots(body, section.slots, doc, component, index, [...stack, tree.key], budget);
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

  private headerHost(owner: Component, index = this.index): HeaderHost {
    return { resolve: (target, path) => resolveHybrid(index, target, path), open: (target, path) => this.open(target, path, index), register: cleanup => owner.register(cleanup) };
  }

  private headerHeadings(el: HTMLElement): HTMLElement[] {
    return Array.from(el.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6')).filter(h => {
      for (let parent = h.parentElement; parent && parent !== el; parent = parent.parentElement) if (parent.matches('pre, code, blockquote, .internal-embed, .hybrid-embed, .hybrid-tree-header')) return false;
      return true;
    });
  }

  private decorateHeadings(el: HTMLElement, doc: HybridDocument, from: number, to: number, index: HybridIndex, owner: Component): void {
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
      heading.setAttribute('data-hybrid-source-path', doc.path); heading.setAttribute('data-hybrid-from', String(tree.level === 1 ? rootAt : tree.from)); heading.setAttribute('data-hybrid-to', String(tree.to));
      // Remove only the native caret suffix, preserving rich Markdown title nodes.
      const texts: Text[] = [];
      const collect = (node: Node): void => { if (node.nodeType === 3) texts.push(node as Text); else for (const child of Array.from(node.childNodes)) collect(child); };
      collect(heading);
      const last = texts[texts.length-1], original = last?.data;
      if (last && tree.id) last.data = last.data.replace(new RegExp('\\s+\\^' + tree.id + '\\s*$'), '');
      const label = tree.level === 1 ? tree.meta.taxon ?? '' : labels.get(tree.from) ?? [tree.meta.taxon, tree.number].filter(Boolean).join(' ');
      appendTaxon(heading, tree, label); appendSlug(heading, tree, host);
      const slugSpace = heading.querySelector('.hybrid-slug')?.previousSibling;
      const metadata = renderMetadata(el.ownerDocument, tree, host); if (metadata) heading.after(metadata);
      owner.register(() => { heading.querySelector('[data-hybrid-badge]')?.remove(); heading.querySelector('.hybrid-slug')?.remove(); slugSpace?.parentNode?.removeChild(slugSpace); metadata?.remove(); heading.removeAttribute('data-hybrid-heading'); if (last && original !== undefined) last.data = original; });
    }
  }

  private processReading(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> | void {
    const doc = this.index.documents.get(ctx.sourcePath);
    if (this.stopped || !doc?.enabled || el.closest('pre, code, blockquote, .internal-embed, [data-hybrid-render]')) return;
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
      const wrapper = el.ownerDocument.createElement('div'); wrapper.className = 'hybrid-embed'; native.replaceChildren(wrapper);
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
