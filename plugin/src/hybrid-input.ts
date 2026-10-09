import { EditorSuggest, Notice, SuggestModal, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type Plugin, type TFile } from 'obsidian';
import { parseHybrid } from './hybrid-core';
import type { HybridDocument, HybridIndex, HybridResolution, HybridTree } from './hybrid-types';

/** I/O, ID minting and post-await editor/disk CAS belong to the controller. */
export type HybridInputHost = {
  index(): HybridIndex;
  resolve(target: string, path: string, index?: HybridIndex): HybridResolution;
  /** Canonical publications, not draft overlays, prepare reusable search facts. */
  searchIndex?(): HybridIndex;
  subscribeSearch?(update: () => void): () => void;
  insertTarget(editor: Editor, file: TFile, tree: HybridTree, embed: boolean, replacement?: {
    from: { line: number; ch: number };
    to: { line: number; ch: number };
    before: string;
  }): Promise<void>;
  /** Whether typing `[[` offers trees alongside native file candidates (default on). */
  linkSuggest?(): boolean;
};

/** Search only the existing index; never read or rescan the vault on input. */
export function filterHybridTrees(index: HybridIndex, query: string): HybridTree[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const trees: HybridTree[] = [];
  for (const document of index.documents.values()) {
    if (!document.enabled) continue;
    for (const tree of document.trees) {
      const fields = [tree.id ?? '', tree.meta.title, tree.path].map(field => field.toLowerCase());
      if (words.every(word => fields.some(field => field.includes(word)))) trees.push(tree);
    }
  }
  return trees;
}

type SlashCommand = 'subtree' | 'transclude' | 'link';
type Replacement = NonNullable<Parameters<HybridInputHost['insertTarget']>[4]>;
interface InputCapture {
  editor: Editor; file: TFile; path: string; replacement: Replacement;
  indexedBefore: string;
  anchor: EditorPosition; head: EditorPosition; editorVersion: number; bindingVersion: number;
}
interface SlashChoice { command: SlashCommand; capture: InputCapture; }
interface TreeChoice { tree: HybridTree; source: string; }
const slashCommands: SlashCommand[] = ['subtree', 'transclude', 'link'];
const samePosition = (a: EditorPosition, b: EditorPosition): boolean => a.line === b.line && a.ch === b.ch;

const suggestionLimit = 100;
type SearchTree = { tree: HybridTree; source: string; fields: string[] };
type SearchFile = { file: TFile; path: string; fields: string[] };
const searchWords = (query: string): string[] => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const matchesWords = (fields: string[], words: string[]): boolean => words.every(word => fields.some(field => field.includes(word)));

class InputSupport {
  private drafts = new WeakMap<Editor, HybridDocument>();
  private editorVersions = new WeakMap<Editor, number>();
  private bindingVersion = 0;
  private binding: { editor: Editor; file: TFile; path: string } | null = null;
  private alive = true;
  private catalog = new Map<string, { document: HybridDocument; facts: SearchTree[] }>();
  private nativeCatalog = new Map<string, SearchFile>();
  private nativePreparation: Promise<void>;
  private preparationIndex?: HybridIndex;
  private preparation?: Promise<void>;
  private searchGeneration = 0;
  private searchTimer?: ReturnType<typeof setTimeout>;
  readonly pickers = new Set<HybridTreePicker>();

  constructor(readonly plugin: Plugin, readonly host: HybridInputHost) {
    const workspace = plugin.app.workspace;
    this.syncBinding();
    plugin.registerEvent(workspace.on('editor-change', editor => {
      this.editorVersions.set(editor, (this.editorVersions.get(editor) ?? 0) + 1);
      this.syncBinding();
    }));
    plugin.registerEvent(workspace.on('active-leaf-change', () => this.syncBinding()));
    plugin.registerEvent(workspace.on('file-open', () => this.syncBinding()));
    plugin.register(() => {
      this.alive = false;
      this.searchGeneration++;
      if (this.searchTimer !== undefined) clearTimeout(this.searchTimer);
      this.catalog.clear(); this.nativeCatalog.clear();
      for (const picker of [...this.pickers]) picker.close();
      this.pickers.clear();
    });
    // Subscribe before taking the inventory so events during bootstrap cannot
    // be lost or rolled back by the late normalization of snapshot objects.
    const vault = plugin.app.vault;
    if (typeof vault.on === 'function') {
      plugin.registerEvent(vault.on('create', file => { if ('extension' in file && this.alive) this.rememberFile(file as TFile); }));
      plugin.registerEvent(vault.on('delete', file => { this.nativeCatalog.delete(file.path); }));
      plugin.registerEvent(vault.on('rename', (file, oldPath) => {
        this.nativeCatalog.delete(oldPath);
        if ('extension' in file && this.alive) this.rememberFile(file as TFile);
      }));
    }
    this.nativePreparation = this.buildNativeSearch(vault.getFiles());
    if (host.subscribeSearch) plugin.register(host.subscribeSearch(() => {
      if (!this.alive) return;
      // Invalidate immediately: a yielded old build may resume before the
      // coalesced replacement timer and must not publish obsolete facts.
      this.searchGeneration++;
      this.preparationIndex = undefined;
      if (this.searchTimer !== undefined) return;
      this.searchTimer = setTimeout(() => { this.searchTimer = undefined; void this.prepareSearch(); }, 0);
    }));
    void this.prepareSearch();
  }

  private rememberFile(file: TFile): void {
    this.nativeCatalog.set(file.path, { file, path: file.path, fields: [file.basename, file.path].map(field => field.toLowerCase()) });
  }

  private async buildNativeSearch(files: TFile[]): Promise<void> {
    let work = 0, began = performance.now();
    for (const file of files) {
      if (!this.alive) return;
      // Objects can be deleted, replaced or renamed while we yield. Normalize
      // their latest metadata only when the path still identifies this object.
      if (this.plugin.app.vault.getAbstractFileByPath(file.path) === file) this.rememberFile(file);
      if (++work >= 128 || performance.now() - began >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0)); work = 0; began = performance.now();
      }
    }
  }

  /** Differential, cooperative and generation-gated canonical preparation. */
  prepareSearch(): Promise<void> {
    if (!this.alive) return Promise.resolve();
    const index = this.host.searchIndex?.() ?? this.host.index();
    if (this.preparationIndex === index && this.preparation) return this.preparation;
    if (this.searchTimer !== undefined) { clearTimeout(this.searchTimer); this.searchTimer = undefined; }
    this.preparationIndex = index;
    this.preparation = Promise.all([this.nativePreparation, this.buildSearch(index, ++this.searchGeneration)]).then(() => undefined);
    return this.preparation;
  }

  private async buildSearch(index: HybridIndex, generation: number): Promise<void> {
    const next = new Map<string, { document: HybridDocument; facts: SearchTree[] }>();
    let work = 0, began = performance.now();
    for (const document of index.documents.values()) {
      if (!this.alive || generation !== this.searchGeneration) return;
      const previous = this.catalog.get(document.path);
      if (previous?.document === document) next.set(document.path, previous);
      else {
        const facts: SearchTree[] = [];
        if (document.enabled) for (const tree of document.trees) {
          facts.push({ tree, source: document.source, fields: [tree.id ?? '', tree.meta.title, tree.path].map(field => field.toLowerCase()) });
          if (++work >= 128 || performance.now() - began >= 8) {
            await new Promise<void>(resolve => setTimeout(resolve, 0)); work = 0; began = performance.now();
            if (!this.alive || generation !== this.searchGeneration) return;
          }
        }
        next.set(document.path, { document, facts });
      }
      if (++work >= 128 || performance.now() - began >= 8) {
        await new Promise<void>(resolve => setTimeout(resolve, 0)); work = 0; began = performance.now();
      }
    }
    if (this.alive && generation === this.searchGeneration) this.catalog = next;
  }

  *searchTrees(index: HybridIndex, query: string, path: string): Generator<SearchTree> {
    const words = searchWords(query);
    let attempts = 0;
    for (const { facts } of this.catalog.values()) for (const fact of facts) {
      if (!matchesWords(fact.fields, words) || index.documents.get(fact.tree.path)?.source !== fact.source) continue;
      if (attempts++ >= suggestionLimit) return;
      if (this.resolveCandidate(index, fact.tree, path)) yield fact;
    }
  }

  *searchFiles(index: HybridIndex, query: string): Generator<SearchFile> {
    const words = searchWords(query);
    for (const fact of this.nativeCatalog.values()) {
      if (fact.file.extension.toLowerCase() === 'md' && index.documents.get(fact.path)?.enabled) continue;
      if (matchesWords(fact.fields, words)) yield fact;
    }
  }

  private syncBinding(): void {
    const active = this.plugin.app.workspace.activeEditor;
    // Focusing a sidebar or a native modal is not a Markdown-editor switch.
    if (!active?.editor || !active.file) return;
    if (this.binding?.editor === active.editor && this.binding.file === active.file && this.binding.path === active.file.path) return;
    this.binding = { editor: active.editor, file: active.file, path: active.file.path };
    this.bindingVersion++;
  }

  capture(editor: Editor, file: TFile | null, from: EditorPosition, to: EditorPosition): InputCapture | null {
    this.syncBinding();
    const active = this.plugin.app.workspace.activeEditor;
    if (!this.alive || !file || active?.editor !== editor || active.file !== file || this.plugin.app.vault.getAbstractFileByPath(file.path) !== file) return null;
    const selections = editor.listSelections();
    const indexed = this.host.index().documents.get(file.path);
    if (!indexed?.enabled || selections.length !== 1) return null;
    const before = editor.getValue();
    // Source offsets in the shared structural parser are LF/CRLF based.
    if (/\r(?!\n)/.test(before)) return null;
    let draft = this.drafts.get(editor);
    if (!draft || draft.path !== file.path || draft.source !== before) {
      // Only the current unsaved document is scanned. Activation itself is
      // supplied by the host index, which already knows exclusion settings.
      draft = parseHybrid(file.path, before, { folders: ['/'], publicFolders: [], reservedIds: [] });
      this.drafts.set(editor, draft);
    }
    // Activation is path-only; parse errors may leave body masks incomplete.
    if (!draft.enabled || draft.diagnostics.some(diagnostic => diagnostic.severity === 'error')) return null;
    const start = editor.posToOffset(from), end = editor.posToOffset(to);
    const ranges = [...draft.protectedRanges];
    for (const tree of draft.trees) ranges.push(...tree.metadataRanges);
    if (ranges.some(range => {
      if (start !== end) return range.from < end && start < range.to;
      if (range.from <= start && start < range.to) return true;
      // Comment masks use the same half-open range for closed and unclosed
      // spans. Only a missing scanner delimiter keeps the EOF caret inside,
      // even after a trailing newline. Raw/YAML/math errors are refused above.
      if (start === range.to && start === before.length && (
        (before.startsWith('<!--', range.from) && before.indexOf('-->', range.from + 4) < 0) ||
        (before.startsWith('%%', range.from) && before.indexOf('%%', range.from + 2) < 0)
      )) return true;
      // At EOF a block's last line has no newline, but its end caret is still
      // in that code/quote/math line (unlike the boundary after inline code).
      return start === range.to && before[start - 1] !== '\n' && /^(?: {0,3}(?:`{3,}|~{3,}|>|\$\$)| {4}|\t)/.test(before.slice(range.from, range.to));
    })) return null;
    return {
      editor, file, path: file.path, replacement: { from: { ...from }, to: { ...to }, before },
      indexedBefore: indexed.source,
      anchor: { ...selections[0].anchor }, head: { ...selections[0].head },
      editorVersion: this.editorVersions.get(editor) ?? 0, bindingVersion: this.bindingVersion,
    };
  }

  valid(capture: InputCapture): boolean {
    this.syncBinding();
    const { editor, file, path, replacement } = capture;
    const active = this.plugin.app.workspace.activeEditor;
    if (!this.alive || this.bindingVersion !== capture.bindingVersion || (this.editorVersions.get(editor) ?? 0) !== capture.editorVersion) return false;
    if (active?.editor !== editor || active.file !== file || file.path !== path || this.plugin.app.vault.getAbstractFileByPath(path) !== file) return false;
    const indexed = this.host.index().documents.get(path);
    if (editor.getValue() !== replacement.before || !indexed?.enabled || indexed.source !== capture.indexedBefore) return false;
    const selections = editor.listSelections();
    return selections.length === 1 && samePosition(selections[0].anchor, capture.anchor) && samePosition(selections[0].head, capture.head);
  }

  resolveCandidate(index: HybridIndex, tree: HybridTree, fromPath: string): HybridTree | null {
    const document = index.documents.get(tree.path);
    if (!document?.enabled) return null;
    let target: string;
    if (tree.id !== undefined) {
      if (!/^[A-Za-z0-9-]+$/.test(tree.id)) return null;
      target = tree.id; // Preserve exactly the spelling found in source.
    } else if (tree.key === document.root.key) target = tree.path;
    else {
      const heading = tree.headingTitle !== undefined ? tree.headingTitle : tree.meta.title;
      if (!heading) return null;
      target = `${tree.path}#${heading}`;
    }
    const resolved = this.host.resolve(target, fromPath, index);
    return resolved.status === 'resolved' && resolved.document.enabled && resolved.document.path === tree.path && resolved.tree.key === tree.key && resolved.tree.path === tree.path ? tree : null;
  }

  run(command: SlashCommand, capture: InputCapture): void {
    if (!this.valid(capture)) return;
    if (command === 'subtree') insertSubtree(capture.editor, capture.replacement.from, capture.replacement.to);
    else {
      const picker = new HybridTreePicker(this, capture, command === 'transclude');
      this.pickers.add(picker);
      picker.open();
    }
  }
}

class HybridTreePicker extends SuggestModal<TreeChoice> {
  private hasClosed = false;
  private choosing = false;
  private used = false;
  constructor(private support: InputSupport, private capture: InputCapture, private embed: boolean) {
    super(support.plugin.app);
    this.setPlaceholder('Search trees by ID, title or file path');
    this.emptyStateText = 'No matching trees';
  }
  getSuggestions(query: string): TreeChoice[] {
    if (this.hasClosed || !this.support.valid(this.capture)) return [];
    const index = this.support.host.index();
    const choices: TreeChoice[] = [];
    for (const fact of this.support.searchTrees(index, query, this.capture.path)) {
      choices.push({ tree: fact.tree, source: fact.source });
      if (choices.length >= suggestionLimit) break;
    }
    return choices;
  }
  renderSuggestion(choice: TreeChoice, el: HTMLElement): void {
    const { tree } = choice;
    el.textContent = `${tree.meta.title || '(untitled)'} · ${tree.id ?? 'ID on insertion'} · ${tree.path}`;
  }
  onClose(): void { this.hasClosed = true; this.support.pickers.delete(this); }
  selectSuggestion(choice: TreeChoice, event: MouseEvent | KeyboardEvent): void {
    if (this.hasClosed || this.used) return;
    // Obsidian closes SuggestModal before onChooseSuggestion. Remember that
    // this close was an intentional choice, not Escape/cancel or plugin unload.
    this.choosing = true;
    try { super.selectSuggestion(choice, event); } finally { this.choosing = false; }
  }
  async onChooseSuggestion(choice: TreeChoice): Promise<void> {
    if (this.used || (this.hasClosed && !this.choosing) || !this.support.valid(this.capture)) return;
    this.used = true;
    const index = this.support.host.index(), document = index.documents.get(choice.tree.path);
    if (!document?.enabled || document.source !== choice.source) return;
    const tree = document.trees.find(candidate => candidate.key === choice.tree.key && candidate.id === choice.tree.id);
    if (!tree || !this.support.resolveCandidate(index, tree, this.capture.path) || !this.support.valid(this.capture)) return;
    try {
      await this.support.host.insertTarget(this.capture.editor, this.capture.file, tree, this.embed, this.capture.replacement);
    } catch (error) {
      new Notice(`Tree insertion failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function insertSubtree(editor: Editor, from: EditorPosition, to: EditorPosition): void {
  const source = editor.getValue(), start = editor.posToOffset(from), end = editor.posToOffset(to);
  const lineStart = source.lastIndexOf('\n', start - 1) + 1;
  const newline = source.indexOf('\n', end);
  const lineEnd = newline < 0 ? source.length : newline;
  const firstNewline = source.indexOf('\n');
  const eol = firstNewline > 0 && source[firstNewline - 1] === '\r' ? '\r\n' : '\n';
  const prefix = source.slice(lineStart, start).trim() ? eol + eol : '';
  const suffix = source.slice(end, lineEnd).trim() ? eol + eol : '';
  editor.replaceRange(`${prefix}## ${suffix}`, from, to);
  editor.setCursor(editor.offsetToPos(start + prefix.length + 3));
  editor.focus();
}

class HybridSlashSuggest extends EditorSuggest<SlashChoice> {
  constructor(private support: InputSupport) { super(support.plugin.app); }
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file) return null;
    const line = editor.getLine(cursor.line);
    if (cursor.ch < line.length && !/[ \t\r]/.test(line[cursor.ch])) return null;
    const match = /(?:^|[ \t])\/([a-z]*)$/.exec(line.slice(0, cursor.ch));
    if (!match || !slashCommands.some(command => command.startsWith(match[1]))) return null;
    const start = { line: cursor.line, ch: cursor.ch - match[1].length - 1 };
    if (!samePosition(editor.getCursor('from'), cursor) || !samePosition(editor.getCursor('to'), cursor) || !this.support.capture(editor, file, start, cursor)) return null;
    return { start, end: { ...cursor }, query: match[1] };
  }
  getSuggestions(context: EditorSuggestContext): SlashChoice[] {
    if (!samePosition(context.editor.getCursor('head'), context.end) || context.editor.getRange(context.start, context.end) !== `/${context.query}`) return [];
    const capture = this.support.capture(context.editor, context.file, context.start, context.end);
    return capture ? slashCommands.filter(command => command.startsWith(context.query)).map(command => ({ command, capture })) : [];
  }
  renderSuggestion(choice: SlashChoice, el: HTMLElement): void { el.textContent = `/${choice.command}`; }
  selectSuggestion(choice: SlashChoice): void {
    if (!this.context || !this.support.valid(choice.capture)) return;
    this.close();
    this.support.run(choice.command, choice.capture);
  }
}

type LinkChoice =
  | { kind: 'tree'; tree: HybridTree; source: string; embed: boolean; capture: InputCapture }
  | { kind: 'file'; file: TFile; path: string; linktext: string; embed: boolean; capture: InputCapture };
// `[[query` or `![[query` up to the caret. `|`, `#` and `^` hand the link back to Obsidian
// (alias, heading or block references are written by hand).
const wikilinkTrigger = /(!?)\[\[([^[\]|#^\r\n]*)$/;

/** `[[` suggests semantic trees plus native files; only trees use host minting/CAS. */
class HybridWikilinkSuggest extends EditorSuggest<LinkChoice> {
  constructor(private support: InputSupport) { super(support.plugin.app); }
  onTrigger(cursor: EditorPosition, editor: Editor, file: TFile | null): EditorSuggestTriggerInfo | null {
    if (!file || this.support.host.linkSuggest?.() === false) return null;
    if (!samePosition(editor.getCursor('from'), cursor) || !samePosition(editor.getCursor('to'), cursor)) return null;
    const line = editor.getLine(cursor.line);
    const match = wikilinkTrigger.exec(line.slice(0, cursor.ch));
    if (!match) return null;
    const start = { line: cursor.line, ch: cursor.ch - match[0].length };
    // Swallow the `]]` that Obsidian auto-pairs after `[[`, so the link is not closed twice.
    const end = { line: cursor.line, ch: cursor.ch + (line.startsWith(']]', cursor.ch) ? 2 : 0) };
    if (!this.support.capture(editor, file, start, end)) return null;
    return { start, end, query: match[2] };
  }
  getSuggestions(context: EditorSuggestContext): LinkChoice[] {
    if (this.support.host.linkSuggest?.() === false) return [];
    const { editor, file, start, end, query } = context;
    const text = editor.getRange(start, end);
    const match = /^(!?)\[\[/.exec(text);
    if (!match || !text.slice(match[0].length).startsWith(query)) return [];
    const cursor = { line: start.line, ch: start.ch + match[0].length + query.length };
    if (!samePosition(editor.getCursor('from'), cursor) || !samePosition(editor.getCursor('to'), cursor)) return [];
    const capture = this.support.capture(editor, file, start, end);
    if (!capture) return [];
    const index = this.support.host.index();
    const embed = match[1] === '!';
    const choices: LinkChoice[] = [];
    const trees = this.support.searchTrees(index, query, capture.path);
    const files = this.support.searchFiles(index, query);
    let treesDone = false, filesDone = false;
    // Balanced prepared lanes, with spare capacity available to either lane.
    while (choices.length < suggestionLimit && (!treesDone || !filesDone)) {
      if (!treesDone) {
        const next = trees.next(); treesDone = !!next.done;
        if (!next.done) choices.push({ kind: 'tree', tree: next.value.tree, source: next.value.source, embed, capture });
      }
      if (!filesDone && choices.length < suggestionLimit) {
        const next = files.next(); filesDone = !!next.done;
        if (!next.done) {
          const { file: target, path } = next.value;
          const linktext = this.support.plugin.app.metadataCache.fileToLinktext(target, capture.path);
          choices.push({ kind: 'file', file: target, path, linktext, embed, capture });
        }
      }
    }
    return choices;
  }
  renderSuggestion(choice: LinkChoice, el: HTMLElement): void {
    if (choice.kind === 'file') { el.textContent = choice.file.path; return; }
    const { tree } = choice;
    el.textContent = `${tree.meta.title || '(untitled)'} · ${tree.id ?? 'ID on insertion'} · ${tree.path}`;
  }
  selectSuggestion(choice: LinkChoice): void {
    if (!this.context || this.support.host.linkSuggest?.() === false || !this.support.valid(choice.capture)) return;
    this.close();
    if (choice.kind === 'file') {
      const { editor, replacement } = choice.capture;
      const app = this.support.plugin.app;
      if (choice.file.path !== choice.path || app.vault.getAbstractFileByPath(choice.path) !== choice.file) return;
      const linktext = app.metadataCache.fileToLinktext(choice.file, choice.capture.path);
      if (linktext !== choice.linktext || this.support.host.linkSuggest?.() === false || !this.support.valid(choice.capture)) return;
      const literal = `${choice.embed ? '!' : ''}[[${linktext}]]`;
      const start = editor.posToOffset(replacement.from);
      editor.replaceRange(literal, replacement.from, replacement.to);
      editor.setCursor(editor.offsetToPos(start + literal.length));
      return;
    }
    const index = this.support.host.index(), document = index.documents.get(choice.tree.path);
    if (!document?.enabled || document.source !== choice.source) return;
    const tree = document.trees.find(candidate => candidate.key === choice.tree.key && candidate.id === choice.tree.id);
    if (!tree || !this.support.resolveCandidate(index, tree, choice.capture.path)) return;
    const { editor, file, replacement } = choice.capture;
    this.support.host.insertTarget(editor, file, tree, choice.embed, replacement).catch(error => {
      new Notice(`Tree insertion failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }
}

/**
 * Obsidian checks editor suggesters in order and its own `[[` file suggester comes first, so a
 * plugin suggester registered normally never sees `[[`. Move ours to the front of the private
 * list; where that list is missing, nothing changes and Obsidian's suggester keeps `[[`.
 */
function preferSuggest(plugin: Plugin, suggest: EditorSuggest<unknown>): void {
  const list = (plugin.app.workspace as unknown as { editorSuggest?: { suggests?: unknown[] } }).editorSuggest?.suggests;
  if (!Array.isArray(list)) return;
  const at = list.indexOf(suggest);
  if (at > 0) { list.splice(at, 1); list.unshift(suggest); }
}

/** Register input support only; importing this module never changes editors. */
export function registerHybridInput(plugin: Plugin, host: HybridInputHost): { prepareSearch(): Promise<void> } {
  const support = new InputSupport(plugin, host);
  const suggest = new HybridSlashSuggest(support);
  plugin.registerEditorSuggest(suggest);
  plugin.register(() => suggest.close());
  const links = new HybridWikilinkSuggest(support);
  plugin.registerEditorSuggest(links);
  preferSuggest(plugin, links as EditorSuggest<unknown>);
  plugin.register(() => links.close());
  for (const [command, id, name] of [
    ['subtree', 'insert-subtree', 'Insert subtree'],
    ['transclude', 'insert-tree-embed', 'Insert tree embed'],
    ['link', 'insert-tree-link', 'Insert tree link'],
  ] as const) {
    plugin.addCommand({ id, name, editorCallback: (editor, context) => {
      const capture = support.capture(editor, context.file, editor.getCursor('from'), editor.getCursor('to'));
      if (capture) support.run(command, capture);
    } });
  }
  return { prepareSearch: () => support.prepareSearch() };
}
