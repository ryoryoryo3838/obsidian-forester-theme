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
    this.containerEl = document.createElement('div');
    this.editor = new MockEditor(source, this, plugin);
  }
  getMode() { return this.mode; }
  // Native TextFileView.save(): write the editor text to the vault.
  async save() {
    const vault = this.editor.plugin.app.vault;
    vault.saves = (vault.saves ?? 0) + 1;
    if (vault.data.get(this.file.path) === this.editor.getValue()) return;
    vault.data.set(this.file.path, this.editor.getValue());
    await vault.emit('modify', this.file);
  }
}
export class Events {
  constructor() { this.events = new Map(); }
  on(name, callback) { const ref = { owner: this, name, callback }; const list = this.events.get(name) ?? []; list.push(ref); this.events.set(name, list); return ref; }
  offref(ref) { this.events.set(ref.name, (this.events.get(ref.name) ?? []).filter(r => r !== ref)); }
  async emit(name, ...args) { await Promise.all((this.events.get(name) ?? []).map(r => r.callback(...args))); }
}
export class Plugin extends Component {
  constructor(app) { super(); this.app = app; this.extensions = []; this.postprocessors = []; this.codeblocks = new Map(); this.commands = new Map(); this.eventRefs = []; this.views = new Map(); this.suggesters = []; this.loaded = true; }
  async loadData() { return null; }
  async saveData(value) { this.savedData = value; }
  addSettingTab(tab) { this.settingTab = tab; }
  registerView(type, create) { this.views.set(type, create); this.register(() => this.views.delete(type)); }
  registerEditorSuggest(suggest) { this.suggesters.push(suggest); }
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
  getCursor(side = 'head') { const s = this.selections[0]; if (side === 'from' || side === 'to') { const ordered = [s.anchor, s.head].sort((a,b) => this.posToOffset(a) - this.posToOffset(b)); return { ...ordered[side === 'from' ? 0 : 1] }; } return s[side]; }
  getRange(from, to) { return this.value.slice(this.posToOffset(from), this.posToOffset(to)); }
  setCursor(position) { this.selections = [{ anchor: { ...position }, head: { ...position } }]; }
  getLine(line) { return this.value.split('\n')[line] ?? ''; }
  lineCount() { return this.value.split('\n').length; }
  focus() { this.focused = true; }
  scrollIntoView(range) { this.scrolled = range; }
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
  workspace.getLeavesOfType = type => type === 'markdown' ? workspace.views.filter(v => v instanceof MarkdownView).map(view => ({ view })) : [];
  workspace.onLayoutReady = fn => { workspace.layoutReady = fn; };
  workspace.iterateAllLeaves = fn => workspace.views.forEach(view => fn({ view }));
  workspace.detachLeavesOfType = type => { workspace.detached = type; };
  workspace.getRightLeaf = () => ({ view: null, setViewState: async state => { workspace.rightState = state; } });
  workspace.revealLeaf = async leaf => { workspace.revealed = leaf; };
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

export class EditorSuggest extends Component { constructor(app) { super(); this.app = app; this.context = null; } close() { this.context = null; } }
export class FuzzySuggestModal extends Modal { setPlaceholder(text) { this.placeholder = text; } }
export class SuggestModal extends FuzzySuggestModal { selectSuggestion(item, event) { this.close(); return this.onChooseSuggestion(item, event); } }
export class ItemView extends Component { constructor(leaf) { super(); this.leaf = leaf; this.app = leaf.app; this.containerEl = document.createElement('div'); this.contentEl = document.createElement('div'); this.containerEl.append(this.contentEl); } }
export class PluginSettingTab { constructor(app, plugin) { this.app = app; this.plugin = plugin; this.containerEl = document.createElement('div'); } }
export class Setting {
  constructor(container) { this.container = container; this.el = document.createElement('div'); container.append(this.el); }
  setName(name) { this.el.setAttribute('data-setting-name', name); return this; }
  setDesc(desc) { this.el.textContent = desc; return this; }
  addTextArea(fn) { return this.control(fn); } addText(fn) { return this.control(fn); } addToggle(fn) { return this.control(fn); } addSlider(fn) { return this.control(fn); } addDropdown(fn) { return this.control(fn); }
  control(fn) { const c = { setValue() { return c; }, setPlaceholder() { return c; }, onChange() { return c; }, setLimits() { return c; }, setDynamicTooltip() { return c; }, addOption() { return c; } }; fn(c); return this; }
}
export const Platform = { isMobile: false };
export const Keymap = { isModEvent: event => event.ctrlKey || event.metaKey };
export function debounce(fn, delay) { let timer; return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), delay); }; }
for (const [name, fn] of Object.entries({ addClass(...names) { this.classList.add(...names); }, removeClass(...names) { this.classList.remove(...names); }, toggleClass(name, on) { this.classList.toggle(name, on); }, empty() { this.replaceChildren(); }, createEl(tag, attrs = {}) { const el = document.createElement(tag); if (attrs.text) el.textContent = attrs.text; if (attrs.cls) el.className = attrs.cls; this.append(el); return el; } })) {
  if (!window.HTMLElement.prototype[name]) window.HTMLElement.prototype[name] = fn;
}
