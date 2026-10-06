import { parseHTML } from 'linkedom';

// The native Obsidian runtime is unavailable in Node; keep its public view boundary small.
export const { document, window } = parseHTML('<html><body></body></html>');
export const notices = [];
export class Notice { constructor(message) { notices.push(String(message)); } }
const proto = window.HTMLElement.prototype;
proto.createEl = function(tag, options = {}) {
  const el = this.ownerDocument.createElement(tag);
  if (options.cls) el.className = Array.isArray(options.cls) ? options.cls.join(' ') : options.cls;
  if (options.text !== undefined) el.textContent = options.text;
  for (const [name, value] of Object.entries(options.attr ?? {})) el.setAttribute(name, value);
  this.append(el);
  return el;
};

export class ItemView {
  constructor(leaf) {
    this.leaf = leaf;
    this.app = leaf.workspace.app;
    // Native Obsidian's View constructor dispatches identity getters before
    // derived constructor parameter properties have been initialized.
    this.constructorIdentity = {
      type: this.getViewType?.(), title: this.getDisplayText?.(), icon: this.getIcon?.(),
    };
    this.containerEl = document.createElement('div');
    this.contentEl = this.containerEl.createEl('div', { cls: 'view-content' });
    document.body.append(this.containerEl);
  }
}
export class MarkdownView extends ItemView {
  getViewType() { return 'markdown'; }
  async onOpen() {}
  async onClose() {}
}
export class WorkspaceLeaf {
  constructor(workspace) { this.workspace = workspace; this.parent = workspace.rightGroup; this.view = null; this.states = []; }
  getViewState() { return this.states.at(-1) ?? { type: 'empty' }; }
  async setViewState(state) {
    this.states.push(state);
    if (this.workspace.failSetState) throw new Error('Cannot create sidebar');
    if (this.view) await this.view.onClose();
    this.view?.containerEl.remove();
    this.view = state.type === 'markdown' ? new MarkdownView(this) : this.workspace.plugin.views.get(state.type)(this);
    await this.view.onOpen();
  }
  // The public WorkspaceLeaf.detach API is synchronous, not a Promise.
  detach() {
    if (this.view) void this.view.onClose();
    this.view?.containerEl.remove();
    this.workspace.leaves = this.workspace.leaves.filter(leaf => leaf !== this);
  }
}
export function createPlugin() {
  notices.length = 0;
  const workspace = {
    leaves: [], reveals: [], rightCalls: [], rightGroup: {}, eventSubscriptions: [],
    getLeavesOfType(type) { return this.leaves.filter(leaf => leaf.view?.getViewType() === type); },
    getRightLeaf(split) {
      this.rightCalls.push(split);
      if (this.noRightLeaf) return null;
      const leaf = new WorkspaceLeaf(this);
      this.leaves.push(leaf);
      return leaf;
    },
    async revealLeaf(leaf) { this.reveals.push(leaf); if (this.failReveal) throw new Error('Cannot reveal sidebar'); },
    on(...args) { this.eventSubscriptions.push(args); throw new Error('Sidebar must subscribe to its host, not native selection events'); },
    getActiveViewOfType() { throw new Error('No cursor-based sidebar context'); }
  };
  Object.defineProperty(workspace, 'activeEditor', { get() { throw new Error('No cursor-based sidebar context'); } });
  const plugin = {
    app: { workspace }, views: new Map(), commands: new Map(), cleanups: [],
    registerView(type, creator) { this.views.set(type, creator); },
    addCommand(command) { this.commands.set(command.id, command); },
    register(cleanup) { this.cleanups.push(cleanup); },
    async unload() {
      // Plugin unload closes its registered views, not unrelated native leaves.
      for (const leaf of [...workspace.leaves]) {
        if (this.views.has(leaf.getViewState().type)) leaf.detach();
      }
      for (const cleanup of this.cleanups.splice(0).reverse()) cleanup();
    }
  };
  workspace.plugin = plugin;
  workspace.app = plugin.app;
  return { plugin, workspace };
}
