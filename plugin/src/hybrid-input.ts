import { EditorSuggest, Notice, SuggestModal, type Editor, type EditorPosition, type EditorSuggestContext, type EditorSuggestTriggerInfo, type Plugin, type TFile } from 'obsidian';
import { parseHybrid } from './hybrid-core';
import type { HybridDocument, HybridIndex, HybridResolution, HybridTree } from './hybrid-types';

/** I/O, ID minting and post-await editor/disk CAS belong to the controller. */
export type HybridInputHost = {
  index(): HybridIndex;
  resolve(target: string, path: string): HybridResolution;
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

class InputSupport {
  private drafts = new WeakMap<Editor, HybridDocument>();
  private editorVersions = new WeakMap<Editor, number>();
  private bindingVersion = 0;
  private binding: { editor: Editor; file: TFile; path: string } | null = null;
  private alive = true;
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
      for (const picker of [...this.pickers]) picker.close();
      this.pickers.clear();
    });
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
    const resolved = this.host.resolve(target, fromPath);
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
    return filterHybridTrees(index, query).filter(tree => this.support.resolveCandidate(index, tree, this.capture.path) !== null).map(tree => ({ tree, source: index.documents.get(tree.path)!.source }));
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
    const choices: LinkChoice[] = filterHybridTrees(index, query)
      .filter(tree => this.support.resolveCandidate(index, tree, capture.path) !== null)
      .map(tree => ({ kind: 'tree', tree, source: index.documents.get(tree.path)!.source, embed, capture }));
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    // Native files are metadata-only candidates: never read or mint attachments.
    // Enabled Markdown roots already have their semantic tree choice above.
    for (const target of this.support.plugin.app.vault.getFiles()) {
      if (target.extension.toLowerCase() === 'md' && index.documents.get(target.path)?.enabled) continue;
      const fields = [target.basename, target.path].map(field => field.toLowerCase());
      if (!words.every(word => fields.some(field => field.includes(word)))) continue;
      const linktext = this.support.plugin.app.metadataCache.fileToLinktext(target, capture.path);
      choices.push({ kind: 'file', file: target, path: target.path, linktext, embed, capture });
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
export function registerHybridInput(plugin: Plugin, host: HybridInputHost): void {
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
}
