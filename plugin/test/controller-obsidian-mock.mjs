import { StateField, EditorState } from '@codemirror/state';
import { parseHTML } from 'linkedom';

// Only Obsidian's unavailable runtime/lifecycle/IO and DOM are substituted.
export const { document, window } = parseHTML('<html><body></body></html>');
globalThis.document = document;
globalThis.window = window;
export const editorInfoField = StateField.define({ create: () => null, update: v => v });
export const editorLivePreviewField = StateField.define({ create: () => false, update: v => v });
export const notices = [];
export const modals = [];
export const renders = [];
export class Notice { constructor(message) { notices.push(String(message)); } }
export class Component {
  constructor() { this.children = []; this.cleanups = []; this.loaded = false; }
  addChild(child) { this.children.push(child); if (this.loaded) child.load(); return child; }
  removeChild(child) { this.children = this.children.filter(c => c !== child); child.unload(); return child; }
  register(fn) { this.cleanups.push(fn); }
  registerDomEvent(el, type, fn, options) { el.addEventListener(type, fn, options); this.register(() => el.removeEventListener(type, fn, options)); }
  load() { if (this.loaded) return; this.loaded = true; this.onload?.(); for (const c of this.children) c.load(); }
  unload() { if (!this.loaded) return; this.loaded = false; for (const c of [...this.children]) c.unload(); this.onunload?.(); for (const fn of this.cleanups.splice(0).reverse()) fn(); }
}
export class MarkdownRenderChild extends Component { constructor(el) { super(); this.containerEl = el; } }
export class Modal extends Component {
  constructor(app) { super(); this.app = app; this.contentEl = document.createElement('div'); }
  open() { modals.push(this); this.load(); this.onOpen?.(); }
  close() { this.onClose?.(); this.unload(); }
}
export class TFile {
  constructor(path) { this.path = path; this.extension = path.split('.').pop(); this.basename = path.split('/').pop().replace(/\.md$/i, ''); }
}
export class MarkdownView {
  constructor(file, source, plugin) {
    this.file = file; this.mode = 'source'; this.previewMode = { rerender: () => this.rerenders++ }; this.rerenders = 0;
    this.editor = new MockEditor(source, this, plugin);
  }
  getMode() { return this.mode; }
}
export class Events {
  constructor() { this.events = new Map(); }
  on(name, callback) { const ref = { owner: this, name, callback }; const list = this.events.get(name) ?? []; list.push(ref); this.events.set(name, list); return ref; }
  offref(ref) { this.events.set(ref.name, (this.events.get(ref.name) ?? []).filter(r => r !== ref)); }
  async emit(name, ...args) { await Promise.all((this.events.get(name) ?? []).map(r => r.callback(...args))); }
}
export class Plugin extends Component {
  constructor(app) { super(); this.app = app; this.extensions = []; this.postprocessors = []; this.codeblocks = new Map(); this.commands = new Map(); this.eventRefs = []; this.load(); }
  registerEvent(ref) { this.eventRefs.push(ref); this.register(() => ref.owner.offref(ref)); }
  registerEditorExtension(extension) { this.extensions.push(extension); }
  registerMarkdownPostProcessor(fn) { this.postprocessors.push(fn); }
  registerMarkdownCodeBlockProcessor(language, fn) { this.codeblocks.set(language, fn); }
  addCommand(command) { this.commands.set(command.id, command); }
}
const offset = (source, pos) => source.split('\n').slice(0, pos.line).reduce((n, s) => n + s.length + 1, 0) + pos.ch;
const position = (source, at) => { const lines = source.slice(0, at).split('\n'); return { line: lines.length - 1, ch: lines.at(-1).length }; };
export class MockEditor {
  constructor(source, view, plugin) {
    this.value = source; this.view = view; this.plugin = plugin; this.replacements = []; this.selections = [{ anchor: position(source, source.length), head: position(source, source.length) }]; this.undoStack = [];
    this.cm = { state: null, dispatches: [], dispatch: tx => { this.cm.dispatches.push(tx); if (this.cm.state) this.cm.state = this.cm.state.update(tx).state; } };
  }
  getValue() { return this.value; }
  getCursor(side = 'head') { return this.selections[0][side]; }
  listSelections() { return structuredClone(this.selections); }
  setSelections(s) { this.selections = structuredClone(s); }
  posToOffset(p) { return offset(this.value, p); }
  offsetToPos(at) { return position(this.value, at); }
  replaceRange(text, from, to = from, origin) {
    const start = this.posToOffset(from), end = this.posToOffset(to);
    this.undoStack.push(this.value); this.replacements.push({ text, from, to, origin, start, end });
    this.value = this.value.slice(0, start) + text + this.value.slice(end);
    if (this.cm.state) this.cm.state = this.cm.state.update({ changes: { from: start, to: end, insert: text } }).state;
    this.plugin?.app.workspace.emit('editor-change', this, this.view);
  }
  setValue() { throw new Error('setValue loses cursor/undo; forbidden'); }
  undo() { this.value = this.undoStack.pop() ?? this.value; }
  attach(extensions, live = true, source = this.value, path = this.view.file?.path) {
    const info = { file: path ? new TFile(path) : null, editor: this };
    this.cm.state = EditorState.create({ doc: source, selection: { anchor: source.length }, extensions: [editorInfoField.init(() => info), editorLivePreviewField.init(() => live), extensions] });
    return this.cm.state;
  }
}
export class MarkdownRenderer {
  static async render(app, source, el, sourcePath, component) {
    renders.push({ source, el, sourcePath, component });
    // Renderer is an unavoidable native boundary, not a replacement for the parser/index.
    if (app.renderOverride) return app.renderOverride(source, el, sourcePath, component);
    el.textContent = source;
  }
}
export function resetObservations() { notices.length = 0; modals.length = 0; renders.length = 0; }
export function createHarness(entries = {}, options = { folders: [], publicFolders: [], reservedIds: [] }) {
  resetObservations();
  const vault = new Events(); vault.files = new Map(); vault.data = new Map(Object.entries(entries)); vault.reads = []; vault.processes = [];
  for (const path of vault.data.keys()) vault.files.set(path, new TFile(path));
  vault.getMarkdownFiles = () => [...vault.files.values()].filter(f => f.extension === 'md');
  vault.getAbstractFileByPath = path => vault.files.get(path) ?? null;
  vault.read = async file => { vault.reads.push(file.path); if (!vault.data.has(file.path)) throw new Error(`Missing ${file.path}`); return vault.data.get(file.path); };
  vault.cachedRead = vault.read;
  vault.process = async (file, fn) => {
    vault.processes.push(file.path);
    if (vault.beforeProcess) await vault.beforeProcess(file);
    const after = fn(await vault.read(file));
    vault.data.set(file.path, after);
    await vault.emit('modify', file);
    return after;
  };
  const workspace = new Events(); workspace.views = []; workspace.active = null; workspace.opens = [];
  workspace.getLeavesOfType = () => workspace.views.map(view => ({ view }));
  workspace.getActiveViewOfType = Type => workspace.active instanceof Type ? workspace.active : null;
  workspace.getActiveFile = () => workspace.active?.file ?? null;
  Object.defineProperty(workspace, 'activeEditor', { get: () => workspace.active });
  workspace.openLinkText = async (...args) => { workspace.opens.push(args); };
  const metadataCache = new Events();
  const app = { vault, workspace, metadataCache, commands: { commands: { 'editor:save-file': { callback: () => 'native-save' } } } };
  const plugin = new Plugin(app);
  const h = { plugin, app, vault, workspace, options, getter: () => h.options,
    open(path, value = vault.data.get(path)) { const view = new MarkdownView(vault.files.get(path), value, plugin); workspace.views.push(view); workspace.active = view; return view; },
    context(path, lineStart, lineEnd, text = vault.data.get(path)) {
      const children = []; return { sourcePath: path, docId: 'test', frontmatter: {}, children,
        getSectionInfo: () => ({ text, lineStart, lineEnd }), addChild: child => { children.push(child); child.load(); } };
    }
  };
  return h;
}
