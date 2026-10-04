import assert from 'node:assert/strict';
import { test } from 'node:test';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { MarkdownView, Notice, TFile } from './hybrid-main-obsidian.mjs';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

const root = fileURLToPath(new URL('../', import.meta.url));
const mock = fileURLToPath(new URL('./hybrid-main-obsidian.mjs', import.meta.url));
await build({
  absWorkingDir: root,
  stdin: {
    contents: "export { default } from './src/main.ts'; export { HybridController } from './src/hybrid-controller.ts';",
    resolveDir: root,
    sourcefile: 'hybrid-acceptance-entry.ts',
  },
  outfile: 'test/build/hybrid-acceptance-main.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  external: ['@codemirror/state', '@codemirror/view'],
  plugins: [{ name: 'native-obsidian-boundary', setup(b) {
    b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true }));
  } }],
});
const { default: LegacyPlugin, HybridController } = await import('./build/hybrid-acceptance-main.mjs');

const optin = body => `---\nforester-mode: hybrid-v1\n---\n${body}`;
const optout = body => `---\nforester-mode: false\n---\n${body}`;

// Substitute only Obsidian's IO/editor boundary; execute real main/controller/parser code.
function harness(entries, options = { folders: [], publicFolders: [], reservedIds: [] }) {
  const disk = new Map(Object.entries(entries));
  const files = new Map([...disk.keys()].map(path => [path, new TFile(path)]));
  const leaves = [];
  const processes = [];
  const frontmatterWrites = [];
  const on = () => ({});
  const workspace = {
    on,
    activeEditor: null,
    getActiveFile() { return this.activeEditor?.file ?? null; },
    getLeavesOfType: type => type === 'markdown' ? leaves.filter(leaf => leaf.view instanceof MarkdownView) : [],
    iterateAllLeaves: callback => leaves.forEach(callback),
  };
  const vault = {
    on,
    getMarkdownFiles: () => [...files.values()],
    getAbstractFileByPath: path => files.get(path) ?? null,
    read: async file => disk.get(file.path),
    cachedRead: async file => disk.get(file.path),
    async process(file, mutate) {
      processes.push(file.path);
      await h.beforeProcess?.(file);
      const after = mutate(disk.get(file.path));
      disk.set(file.path, after);
      return after;
    },
  };
  const app = {
    vault, workspace,
    fileManager: {
      async processFrontMatter(file, mutate) {
        await h.beforeFrontmatter?.(file);
        const source = disk.get(file.path);
        const header = /^---\n([\s\S]*?)\n---\n/.exec(source);
        const frontmatter = header ? parseYaml(header[1]) : {};
        mutate(frontmatter);
        // Native IO may serialize even an unchanged mapping; refusing must abort the callback.
        const after = `---\n${stringifyYaml(frontmatter)}---\n${header ? source.slice(header[0].length) : source}`;
        disk.set(file.path, after);
        frontmatterWrites.push(file.path);
      },
    },
    metadataCache: {
      on,
      getFirstLinkpathDest: path => files.get(path) ?? files.get(`${path}.md`) ?? null,
      getFileCache: file => ({
        frontmatter: {},
        headings: [...disk.get(file.path).matchAll(/^(#{1,6})\s+(.+)$/gm)].map(m => ({ level: m[1].length, heading: m[2] })),
      }),
    },
  };
  const plugin = new LegacyPlugin(app);
  plugin.hybridController = new HybridController(plugin, () => options);
  plugin.sources = new Map(disk);
  const h = {
    app, plugin, files, disk, workspace, leaves, processes, frontmatterWrites,
    open(path, source = disk.get(path), { active = true, markdown = true } = {}) {
      const view = markdown ? new MarkdownView() : {};
      if (markdown) view.getMode = () => 'source';
      // A distinct TFile object proves ownership uses path, not object identity.
      view.file = new TFile(path);
      view.editor = {
        value: source,
        getValue() { return this.value; },
        getCursor: () => ({ line: source.split('\n').length - 1, ch: 0 }),
        getLine(line) { return this.value.split('\n')[line]; },
        setLine(line, replacement) {
          const lines = this.value.split('\n'); lines[line] = replacement; this.value = lines.join('\n');
        },
        lineCount() { return this.value.split('\n').length; },
      };
      leaves.push({ view });
      if (active) workspace.activeEditor = view;
      return view;
    },
  };
  return h;
}

test('legacy lint stops cross-note minting when its source becomes hybrid during IO', async () => {
  const source = '# Page\n\n[[Book#Part]]';
  const target = '# Book\n\n## Part\nBody';
  const h = harness({ 'Page.md': source, 'Book.md': target });
  const inactive = h.open('Page.md', source, { active: false });
  h.open('Page.md');
  h.beforeProcess = file => {
    if (file.path === 'Page.md') inactive.editor.value = optin(source);
  };
  await h.plugin.lintActiveNote('requests');
  assert.equal(h.disk.get('Book.md'), target, 'a now-hybrid source must not authorize legacy target minting');
  assert.equal(h.disk.get('Page.md'), source);
  assert.equal(inactive.editor.getValue(), optin(source));
});

test('cross-note mint callback rechecks a source buffer that opts in after target preflight', async () => {
  const source = '# Page\n\n[[Book#Part]]';
  const target = '# Book\n\n## Part\nBody';
  const h = harness({ 'Page.md': source, 'Book.md': target });
  const inactive = h.open('Page.md', source, { active: false });
  h.open('Page.md');
  h.beforeProcess = file => {
    if (file.path === 'Book.md') inactive.editor.value = optin(source);
  };
  assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
  assert.equal(h.disk.get('Book.md'), target);
  assert.equal(h.disk.get('Page.md'), source);
});

test('cross-note mint resamples saved source after asynchronous target reads', async () => {
  const source = '# Page\n\n[[Book#Part]]';
  const target = '# Book\n\n## Part\nBody';
  const h = harness({ 'Page.md': source, 'Book.md': target });
  h.open('Page.md');
  const read = h.app.vault.read;
  h.app.vault.read = async file => {
    if (file.path === 'Book.md') h.disk.set('Page.md', optin(source));
    return read(file);
  };
  assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
  assert.equal(h.disk.get('Book.md'), target);
  assert.equal(h.disk.get('Page.md'), optin(source));
});

function holdDiskRead(h, readNumber = 1) {
  let release, begun;
  const started = new Promise(resolve => { begun = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const nativeRead = h.app.vault.read;
  let reads = 0;
  h.app.vault.read = async file => {
    const sampled = await nativeRead(file);
    if (++reads === readNumber) { begun(); await paused; }
    return sampled;
  };
  return { started, release };
}

async function subtreeCommand(h, t) {
  const previous = ['document', 'MutationObserver'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]);
  globalThis.document = { body: { addClass() {}, toggleClass() {}, removeClass() {}, style: { setProperty() {} } } };
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  t.after(() => {
    for (const cleanup of h.plugin.cleanups.splice(0).reverse()) cleanup();
    h.plugin.onunload();
    for (const [key, descriptor] of previous) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
  h.workspace.onLayoutReady = () => {};
  await h.plugin.onload();
  const command = h.plugin.commands.find(command => command.id === 'mint-subtree-address');
  assert.ok(command?.editorCallback, 'exercise the actual registered native command');
  return command;
}

test('registered legacy subtree command reports genuine disk IO errors without rejecting to the native caller', async t => {
  const body = optout('# Ordinary\n\n## Part\nBody');
  const h = harness({ 'Ordinary.md': body });
  const active = h.open('Ordinary.md');
  const command = await subtreeCommand(h, t);
  const failure = new Error('native subtree disk read failed');
  const logged = [], notices = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  // Spy only on the native Notice boundary without replacing production command logic.
  const descriptor = Object.getOwnPropertyDescriptor(Notice.prototype, 'message');
  Object.defineProperty(Notice.prototype, 'message', { configurable: true, set(message) { notices.push(message); } });
  t.after(() => descriptor ? Object.defineProperty(Notice.prototype, 'message', descriptor) : delete Notice.prototype.message);
  for (const failAt of [1, 2]) {
    let reads = 0;
    h.app.vault.read = async () => { if (++reads === failAt) throw failure; return body; };
    await assert.rejects(h.plugin.mintSubtreeAddress(active.editor, active.file), error => error === failure, 'the method preserves genuine IO provenance');
    reads = 0;
    await assert.doesNotReject(() => command.editorCallback(active.editor, active), 'native callbacks may ignore promises; rejection must be handled at registration');
    assert.equal(active.editor.getValue(), body);
    assert.equal(h.disk.get('Ordinary.md'), body);
  }
  assert.ok(logged.some(args => args.includes(failure)), 'log the original IO error, not a hybrid ownership refusal');
  assert.ok(notices.some(message => /failed/i.test(message) && message.includes(failure.message)), 'show the failure, never a success notice');
  assert.ok(!notices.some(message => /minted/.test(message)));
});

test('registered legacy subtree command enforces raw-disk and all-buffer ownership with ordinary controls', async t => {
  const body = '# Ordinary\n\n## Part\nBody';
  const cases = [
    { name: 'saved opt-in with only unsaved opt-out', saved: optin(body), live: optout(body), mint: false },
    { name: 'unsaved active opt-in on plain disk', saved: body, live: optin(body), mint: false },
    { name: 'another Markdown opt-in buffer', saved: optout(body), live: optout(body), other: true, mint: false },
    { name: 'another non-Markdown opt-in buffer', saved: optout(body), live: optout(body), other: false, mint: false },
    { name: 'folder-enabled disk with unsaved opt-out', saved: body, live: optout(body), folder: true, mint: false },
    { name: 'ordinary default with unrelated opt-in', saved: body, live: body, mint: true },
    { name: 'explicit opt-outs in enabled folder', saved: optout(body), live: optout(body), folder: true, mint: true },
  ];
  for (const spec of cases) await t.test(spec.name, async st => {
    const path = spec.folder ? 'Trees/Ordinary.md' : 'Ordinary.md';
    const h = harness({ [path]: spec.saved, 'Unrelated.md': optin('# Unrelated') });
    // Persist the setting through the actual entrypoint's loadSettings path.
    h.plugin.loadData = async () => ({ hybrid: { folders: spec.folder ? ['Trees'] : [], publicFolders: [], reservedIds: [] } });
    h.open('Unrelated.md', undefined, { active: false });
    if (spec.other !== undefined) h.open(path, optin(body), { active: false, markdown: spec.other });
    const active = h.open(path, spec.live);
    const command = await subtreeCommand(h, st);
    h.plugin.sources.set(path, spec.mint ? optin(body) : optout(body)); // Deliberately opposite/stale renderer cache.
    h.app.vault.cachedRead = async () => { throw new Error('command must not rely on cachedRead'); };
    await command.editorCallback(active.editor, active);
    if (spec.mint) assert.match(active.editor.getValue(), /^## Part \^[A-Za-z0-9-]+$/m);
    else assert.equal(active.editor.getValue(), spec.live);
    assert.equal(h.disk.get(path), spec.saved, 'the legacy subtree command edits only its eligible editor');
    assert.equal(h.disk.get('Unrelated.md'), optin('# Unrelated'));
    assert.deepEqual(h.processes, []);
    assert.deepEqual(h.frontmatterWrites, []);
  });
});

test('legacy subtree command resamples changed inactive buffers after either awaited disk read', async t => {
  for (const readAt of [1, 2]) {
    for (const change of ['existing-opt-in', 'new-markdown-opt-in', 'new-non-markdown-opt-in', 'unreadable-value', 'unreadable-editor']) {
      await t.test(`read ${readAt}: ${change}`, async () => {
        const body = '# Ordinary\n\n## Part\nBody', before = optout(body);
        const h = harness({ 'Ordinary.md': before });
        const inactive = h.open('Ordinary.md', before, { active: false });
        const active = h.open('Ordinary.md');
        const gate = holdDiskRead(h, readAt);
        const pending = h.plugin.mintSubtreeAddress(active.editor, active.file);
        await gate.started;
        if (change === 'existing-opt-in') inactive.editor.value = optin(body);
        else if (change === 'new-markdown-opt-in') h.open('Ordinary.md', optin(body), { active: false });
        else if (change === 'new-non-markdown-opt-in') h.open('Ordinary.md', optin(body), { active: false, markdown: false });
        else if (change === 'unreadable-value') inactive.editor.getValue = () => { throw new Error('inactive buffer unavailable'); };
        else Object.defineProperty(inactive, 'editor', { get() { throw new Error('inactive editor unavailable'); } });
        gate.release();
        await assert.doesNotReject(() => pending, 'unavailable known matching buffers refuse locally');
        assert.equal(active.editor.getValue(), before);
        assert.equal(h.disk.get('Ordinary.md'), before);
      });
    }
  }
});

test('legacy subtree command invalidates changed native activation snapshots after the confirming read', async t => {
  for (const change of ['other-view', 'rebound-file', 'renamed-file', 'replaced-editor', 'source-input', 'cursor', 'unavailable-source', 'unavailable-cursor', 'unavailable-editor']) {
    await t.test(change, async () => {
      const before = optout('# Ordinary\n\n## Part\nBody');
      const h = harness({ 'Ordinary.md': before, 'Other.md': before });
      const active = h.open('Ordinary.md'), editor = active.editor, file = active.file;
      const gate = holdDiskRead(h, 2);
      const pending = h.plugin.mintSubtreeAddress(editor, file);
      await gate.started;
      if (change === 'other-view') h.open('Other.md');
      else if (change === 'rebound-file') active.file = new TFile('Other.md');
      else if (change === 'renamed-file') file.path = 'Other.md';
      else if (change === 'replaced-editor') active.editor = h.open('Other.md', before, { active: false }).editor;
      else if (change === 'source-input') editor.value += '\nNew input';
      else if (change === 'cursor') editor.getCursor = () => ({ line: 6, ch: 1 });
      else if (change === 'unavailable-source') editor.getValue = () => { throw new Error('source unavailable'); };
      else if (change === 'unavailable-cursor') editor.getCursor = () => { throw new Error('cursor unavailable'); };
      else Object.defineProperty(active, 'editor', { get() { throw new Error('active editor unavailable'); } });
      gate.release();
      await assert.doesNotReject(() => pending);
      assert.equal(editor.value, change === 'source-input' ? `${before}\nNew input` : before);
      assert.equal(h.disk.get('Ordinary.md'), before);
      assert.equal(h.disk.get('Other.md'), before);
    });
  }
});

test('inactive unsaved hybrid target is never addressed by the legacy heading-reference pass', async () => {
  const target = '# Hybrid\n\n## Part\nBody';
  const source = '# Page\n\n[[Hybrid#Part]]';
  const h = harness({ 'Hybrid.md': target, 'Page.md': source });
  const inactive = h.open('Hybrid.md', optin(target), { active: false });
  const active = h.open('Page.md');
  assert.notEqual(inactive.file, h.files.get('Hybrid.md'));
  assert.equal(h.workspace.activeEditor, active);
  assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
  assert.equal(h.disk.get('Hybrid.md'), target, 'unsaved opt-in in the inactive leaf protects disk');
  assert.equal(inactive.editor.getValue(), optin(target));
  assert.equal(h.disk.get('Page.md'), source);
  assert.deepEqual(h.processes, []);
});

test('non-Markdown leaf with a matching-file editor protects an inactive unsaved hybrid target', async () => {
  const target = '# Hybrid\n\n## Part\nBody';
  const h = harness({ 'Hybrid.md': target, 'Page.md': '# Page\n\n[[Hybrid#Part]]' });
  const canvasLike = h.open('Hybrid.md', optin(target), { active: false, markdown: false });
  h.open('Page.md');
  assert.equal(h.workspace.getLeavesOfType('markdown').length, 1);
  assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
  assert.equal(h.disk.get('Hybrid.md'), target);
  assert.equal(canvasLike.editor.getValue(), optin(target));
  assert.deepEqual(h.processes, []);
});

test('unreadable matching-file editor fails closed without disabling legacy writes to unrelated notes', async () => {
  for (const broken of ['getValue', 'editor']) {
    const body = '# Page\n\n[[Book#Part]]';
    const h = harness({ 'Unreadable.md': body, 'Plain.md': body, 'Book.md': '# Book\n\n## Part ^ABCD01\nBody' });
    const inactive = h.open('Unreadable.md', body, { active: false });
    h.open('Plain.md');
    const unavailable = () => { throw new Error(`unavailable matching ${broken}`); };
    if (broken === 'getValue') inactive.editor.getValue = unavailable;
    else Object.defineProperty(inactive, 'editor', { get: unavailable });
    assert.equal(await h.plugin.retargetVault(), 1, `${broken}: unrelated ordinary note still rewrites`);
    assert.equal(h.disk.get('Unreadable.md'), body);
    assert.equal(h.disk.get('Plain.md'), body.replace('[[Book#Part]]', '[[ABCD01]]'));
    assert.deepEqual(h.processes, ['Plain.md', 'Book.md']);
  }
});

test('legacy subtree command preserves saved hybrid ownership when its only buffer has unsaved opt-out', async () => {
  const body = '# Hybrid\n\n## Part\nBody';
  const saved = optin(body), unsaved = optout(body);
  const h = harness({ 'Hybrid.md': saved });
  const active = h.open('Hybrid.md', unsaved);
  h.plugin.sources.set('Hybrid.md', unsaved); // Neither cache nor editor overrides actual saved ownership.
  assert.equal(h.plugin.hybridController.isEnabled('Hybrid.md', saved), true);
  await h.plugin.mintSubtreeAddress(active.editor, active.file);
  assert.equal(active.editor.getValue(), unsaved, 'saved hybrid opt-in must prevent legacy buffer mutation');
  assert.equal(h.disk.get('Hybrid.md'), saved);
  assert.deepEqual(h.processes, []);
  assert.deepEqual(h.frontmatterWrites, []);
});

test('legacy subtree command refuses a same-editor note rebind during its disk read even with identical text', async () => {
  const body = optout('# Ordinary\n\n## Part\nBody');
  const h = harness({ 'Ordinary.md': body, 'Other.md': body });
  const active = h.open('Ordinary.md');
  let resume;
  h.app.vault.read = async file => {
    await new Promise(resolve => { resume = resolve; });
    return h.disk.get(file.path);
  };
  const pending = h.plugin.mintSubtreeAddress(active.editor, active.file);
  assert.equal(typeof resume, 'function', 'the command must consult actual disk before editing');
  active.file = new TFile('Other.md'); // Same editor/view and byte-identical text, but a different note.
  resume();
  await pending;
  assert.equal(active.editor.getValue(), body, 'an editor rebound to another file must not be edited');
  assert.equal(h.disk.get('Ordinary.md'), body);
  assert.equal(h.disk.get('Other.md'), body);
});

test('legacy subtree command refuses changed editor source during its disk read', async () => {
  const before = optout('# Ordinary\n\n## Part\nBody');
  const after = `${before}\nAuthor kept typing`;
  const h = harness({ 'Ordinary.md': before });
  const active = h.open('Ordinary.md');
  let resume;
  h.app.vault.read = async file => {
    await new Promise(resolve => { resume = resolve; });
    return h.disk.get(file.path);
  };
  const pending = h.plugin.mintSubtreeAddress(active.editor, active.file);
  active.editor.value = after;
  resume();
  await pending;
  assert.equal(active.editor.getValue(), after, 'new input must invalidate the pending command');
  assert.equal(h.disk.get('Ordinary.md'), before);
});

test('legacy subtree command refuses cursor movement during its disk read', async t => {
  for (const change of ['line', 'column']) await t.test(change, async () => {
    const body = optout('# Ordinary\n\n## Part\nBody\n\n## Other part\nMore');
    const h = harness({ 'Ordinary.md': body });
    const active = h.open('Ordinary.md');
    const cursor = { line: body.split('\n').length - 1, ch: 0 };
    active.editor.getCursor = () => cursor; // Exercise a mutable native position object too.
    let resume;
    h.app.vault.read = async file => {
      await new Promise(resolve => { resume = resolve; });
      return h.disk.get(file.path);
    };
    const pending = h.plugin.mintSubtreeAddress(active.editor, active.file);
    if (change === 'line') cursor.line = 6;
    else cursor.ch = 1;
    resume();
    await pending;
    assert.equal(active.editor.getValue(), body, 'cursor movement must invalidate the pending command');
    assert.equal(h.disk.get('Ordinary.md'), body);
  });
});

test('legacy subtree command refuses disk opt-in that occurs while a stale read is pending', async () => {
  const body = '# Hybrid\n\n## Part\nBody', before = optout(body), after = optin(body);
  const h = harness({ 'Hybrid.md': before });
  const active = h.open('Hybrid.md');
  let resume;
  h.app.vault.read = async file => {
    const sampled = h.disk.get(file.path);
    if (!resume) await new Promise(resolve => { resume = resolve; });
    return sampled; // The first native read was sampled before a concurrent save.
  };
  const pending = h.plugin.mintSubtreeAddress(active.editor, active.file);
  h.disk.set('Hybrid.md', after);
  resume();
  await pending;
  assert.equal(active.editor.getValue(), before, 'a stale first disk sample must not grant legacy write permission');
  assert.equal(h.disk.get('Hybrid.md'), after);
});

test('legacy subtree command refuses an unbound editor with no file for saved ownership', async () => {
  const body = '# Ordinary\n\n## Part\nBody';
  const h = harness({ 'Ordinary.md': body });
  const active = h.open('Ordinary.md');
  let reads = 0;
  h.app.vault.read = async () => { reads++; return body; };
  await h.plugin.mintSubtreeAddress(active.editor, null);
  assert.equal(active.editor.getValue(), body, 'no file means saved ownership cannot be verified');
  assert.equal(reads, 0);
  assert.equal(h.disk.get('Ordinary.md'), body);
});

test('legacy subtree command rechecks permission immediately before its editor mutation', async t => {
  for (const change of ['source-input', 'new-matching-opt-in']) await t.test(change, async () => {
    const body = '# Ordinary\n\n## Part\nBody', before = optout(body);
    const h = harness({ 'Ordinary.md': before });
    const active = h.open('Ordinary.md');
    const draw = h.plugin.newAddress.bind(h.plugin);
    h.plugin.newAddress = () => {
      const address = draw(); // Keep real address generation, but inject a synchronous boundary change.
      if (change === 'source-input') active.editor.value = `${before}\nMore input`;
      else h.open('Ordinary.md', optin(body), { active: false });
      return address;
    };
    await h.plugin.mintSubtreeAddress(active.editor, active.file);
    assert.equal(active.editor.getValue(), change === 'source-input' ? `${before}\nMore input` : before, 'permission must still hold at the actual setLine boundary');
    assert.equal(h.disk.get('Ordinary.md'), before);
  });
});

test('legacy subtree command refuses an unavailable initial activation snapshot locally', async () => {
  const body = optout('# Ordinary\n\n## Part\nBody');
  const h = harness({ 'Ordinary.md': body });
  const active = h.open('Ordinary.md');
  Object.defineProperty(h.workspace, 'activeEditor', { get() { throw new Error('active editor unavailable'); } });
  await assert.doesNotReject(() => h.plugin.mintSubtreeAddress(active.editor, active.file), 'a failed activation getter cannot grant edit permission');
  assert.equal(active.editor.getValue(), body);
  assert.equal(h.disk.get('Ordinary.md'), body);
});

test('legacy subtree command respects another enabled buffer at the same path despite active opt-out', async () => {
  const body = '# Hybrid\n\n## Part\nBody';
  const h = harness({ 'Hybrid.md': body });
  const inactive = h.open('Hybrid.md', optin(body), { active: false });
  const active = h.open('Hybrid.md', optout(body));
  h.plugin.newAddress = () => 'A0BC01';
  // The disk ownership preflight is async; observe the completed command, not a pending invocation.
  await h.plugin.mintSubtreeAddress(active.editor, active.file);
  assert.equal(active.editor.getValue(), optout(body));
  assert.equal(inactive.editor.getValue(), optin(body));
  assert.equal(h.disk.get('Hybrid.md'), body);
});

test('legacy note mint rechecks ownership inside the current frontmatter IO callback', async t => {
  for (const change of ['inactive-editor', 'raw-frontmatter']) await t.test(change, async () => {
    const body = '# Hybrid\n\n## Part\nBody';
    const h = harness({ 'Hybrid.md': body, 'Page.md': '# Page' });
    const inactive = h.open('Hybrid.md', body, { active: false });
    h.open('Page.md');
    h.plugin.newAddress = () => 'A0BC01';
    h.beforeFrontmatter = () => {
      if (change === 'inactive-editor') inactive.editor.value = optin(body);
      else h.disk.set('Hybrid.md', optin(body));
    };
    await h.plugin.mintNoteAddress(h.files.get('Hybrid.md'));
    assert.equal(h.disk.get('Hybrid.md'), change === 'raw-frontmatter' ? optin(body) : body);
    assert.equal(inactive.editor.getValue(), change === 'inactive-editor' ? optin(body) : body);
    assert.deepEqual(h.frontmatterWrites, []);
  });
});

test('legacy linter rechecks ownership inside the current frontmatter IO callback', async t => {
  for (const change of ['inactive-editor', 'raw-frontmatter']) await t.test(change, async () => {
    const body = '# Page\n\n<!-- id -->\n\n## Part\nBody';
    const h = harness({ 'Page.md': body });
    const inactive = h.open('Page.md', body, { active: false });
    const active = h.open('Page.md');
    h.beforeFrontmatter = () => {
      if (change === 'inactive-editor') inactive.editor.value = optin(body);
      else h.disk.set('Page.md', optin(body));
    };
    await h.plugin.lintActiveNote('notes');
    assert.equal(h.disk.get('Page.md'), change === 'raw-frontmatter' ? optin(body) : body);
    assert.equal(active.editor.getValue(), body);
    assert.deepEqual(h.frontmatterWrites, []);
  });
});

test('legacy vault retargeting preserves inactive unsaved hybrid source including raw and math regions', async () => {
  const body = '# Hybrid\n\n[[Book#Part]]\n$[[Book#Part]]$\n\\{ [[Book#Part]] }';
  const plain = optout('# Plain\n\n[[Book#Part]]');
  const h = harness({ 'Hybrid.md': body, 'Plain.md': plain, 'Book.md': '# Book\n\n## Part ^ABCD01\nBody' });
  const inactive = h.open('Hybrid.md', optin(body), { active: false });
  const active = h.open('Plain.md');
  h.plugin.sources.set('Plain.md', optin(plain)); // Deliberately stale cache must not override raw opt-out.
  assert.equal(await h.plugin.retargetVault(), 1);
  assert.equal(h.disk.get('Hybrid.md'), body);
  assert.equal(inactive.editor.getValue(), optin(body));
  assert.equal(h.disk.get('Plain.md'), plain.replace('[[Book#Part]]', '[[ABCD01]]'));
  assert.equal(active.editor.getValue(), plain, 'legacy disk IO must not rewrite an unrelated editor');
  assert.ok(!h.processes.includes('Hybrid.md'));
});

test('conflicting buffers at one path are hybrid-owned in either leaf order even with active opt-out', async t => {
  for (const enabledFirst of [true, false]) await t.test(`enabled first: ${enabledFirst}`, async () => {
    const body = '# Hybrid\n\n## Part\nBody';
    const h = harness({ 'Hybrid.md': body, 'Page.md': '# Page\n\n[[Hybrid#Part]]' });
    const buffers = enabledFirst ? [optin(body), optout(body)] : [optout(body), optin(body)];
    const views = buffers.map(source => h.open('Hybrid.md', source, { active: false }));
    h.workspace.activeEditor = views[enabledFirst ? 1 : 0];
    assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
    assert.equal(h.disk.get('Hybrid.md'), body);
    assert.deepEqual(views.map(view => view.editor.getValue()), buffers);
    assert.deepEqual(h.processes, []);
  });
});

test('active and inactive explicit opt-outs retain ordinary legacy minting with no enabled matching buffer', async t => {
  for (const active of [true, false]) await t.test(`target active: ${active}`, async () => {
    const target = optout('# Ordinary\n\n## Part\nBody');
    const h = harness({ 'Ordinary.md': target, 'Page.md': '# Page\n\n[[Ordinary#Part]]', 'Unrelated.md': optin('# Unrelated') });
    const view = h.open('Ordinary.md', target, { active });
    h.open('Unrelated.md', undefined, { active: false });
    if (!active) h.open('Page.md');
    assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 1);
    assert.equal(h.disk.get('Ordinary.md'), target.replace('## Part', '## Part ^A0BC01'));
    assert.equal(view.editor.getValue(), target);
    assert.deepEqual(h.processes, ['Ordinary.md']);
  });
});

test('enabled raw disk remains protected even when every matching editor has opted out', async t => {
  for (const folder of [false, true]) await t.test(`folder opt-in: ${folder}`, async () => {
    const body = '# Hybrid\n\n## Part\nBody';
    const path = folder ? 'Trees/Hybrid.md' : 'Hybrid.md';
    const target = folder ? body : optin(body);
    const h = harness({ [path]: target, 'Page.md': `# Page\n\n[[${path.replace(/\.md$/, '')}#Part]]` }, { folders: folder ? ['Trees'] : [], publicFolders: [], reservedIds: [] });
    const view = h.open(path, optout(body));
    assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
    await h.plugin.mintNoteAddress(h.files.get(path));
    assert.equal(h.disk.get(path), target);
    assert.equal(view.editor.getValue(), optout(body));
    assert.deepEqual(h.processes, []);
    assert.deepEqual(h.frontmatterWrites, []);
  });
});

test('referenced-heading IO callback resamples matching buffers and current raw disk after preflight', async t => {
  for (const change of ['inactive-editor', 'new-inactive-leaf', 'raw-source']) await t.test(change, async () => {
    const body = '# Hybrid\n\n## Part\nBody';
    const h = harness({ 'Hybrid.md': body, 'Page.md': '# Page\n\n[[Hybrid#Part]]' });
    const inactive = h.open('Hybrid.md', body, { active: false });
    h.open('Page.md');
    h.beforeProcess = file => {
      if (file.path !== 'Hybrid.md') return;
      if (change === 'inactive-editor') inactive.editor.value = optin(body);
      else if (change === 'new-inactive-leaf') h.open('Hybrid.md', optin(body), { active: false });
      else h.disk.set(file.path, optin(body));
    };
    assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
    assert.equal(h.disk.get('Hybrid.md'), change === 'raw-source' ? optin(body) : body);
    assert.deepEqual(h.processes, ['Hybrid.md']);
  });
});

test('vault retarget IO callback resamples inactive editor and current raw source after preflight', async t => {
  for (const change of ['inactive-editor', 'raw-source']) await t.test(change, async () => {
    const body = '# Page\n\n[[Book#Part]]\n$[[Book#Part]]$\n\\{ [[Book#Part]] }';
    const h = harness({ 'Page.md': body, 'Book.md': '# Book\n\n## Part ^ABCD01\nBody' });
    const inactive = h.open('Page.md', body, { active: false });
    h.open('Book.md');
    h.beforeProcess = file => {
      if (file.path !== 'Page.md') return;
      if (change === 'inactive-editor') inactive.editor.value = optin(body);
      else h.disk.set(file.path, optin(body));
    };
    assert.equal(await h.plugin.retargetVault(), 0);
    assert.equal(h.disk.get('Page.md'), change === 'raw-source' ? optin(body) : body);
  });
});

test('legacy linter body and retarget callbacks resample inactive unsaved opt-in', async t => {
  for (const enableAt of [1, 2]) await t.test(`enable at callback: ${enableAt}`, async () => {
    const body = '# Page\n\n[[Book#Part]]';
    const h = harness({ 'Page.md': body, 'Book.md': '# Book\n\n## Part ^ABCD01\nBody' });
    const inactive = h.open('Page.md', body, { active: false });
    h.open('Page.md');
    let callbacks = 0;
    h.beforeProcess = file => {
      if (file.path === 'Page.md' && ++callbacks === enableAt) inactive.editor.value = optin(body);
    };
    await h.plugin.lintActiveNote('requests');
    assert.equal(callbacks, 2);
    assert.equal(h.disk.get('Page.md'), body);
    assert.equal(inactive.editor.getValue(), optin(body));
    assert.deepEqual(h.frontmatterWrites, []);
  });
});

test('a leaf reused for a different path does not retain stale hybrid ownership of its old file', async () => {
  const body = '# Ordinary\n\n## Part\nBody';
  const h = harness({ 'Ordinary.md': body, 'Page.md': '# Page\n\n[[Ordinary#Part]]' });
  const reused = h.open('Ordinary.md', body, { active: false });
  h.open('Page.md');
  h.beforeProcess = file => {
    if (file.path !== 'Ordinary.md') return;
    reused.file = new TFile('Other.md');
    reused.editor.value = optin('# Other');
  };
  assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 1);
  assert.equal(h.disk.get('Ordinary.md'), body.replace('## Part', '## Part ^A0BC01'));
  assert.equal(reused.editor.getValue(), optin('# Other'));
});

test('explicitly disabled ordinary note and subtree commands remain usable', async () => {
  const body = optout('# Ordinary\n\n## Part\nBody');
  const h = harness({ 'Ordinary.md': body });
  const active = h.open('Ordinary.md');
  h.plugin.newAddress = () => 'A0BC01';
  // The disk ownership preflight is async; observe the completed command, not a pending invocation.
  await h.plugin.mintSubtreeAddress(active.editor, active.file);
  assert.equal(active.editor.getValue(), body.replace('## Part', '## Part ^A0BC01'));
  await h.plugin.mintNoteAddress(h.files.get('Ordinary.md'));
  assert.equal(h.disk.get('Ordinary.md'), body.replace('forester-mode: false\n', 'forester-mode: false\nid: A0BC01\n'));
  assert.deepEqual(h.frontmatterWrites, ['Ordinary.md']);
});

test('frontmatter IO errors are not swallowed as hybrid ownership refusals', async t => {
  for (const command of ['mintNoteAddress', 'lintActiveNote']) await t.test(command, async () => {
    const h = harness({ 'Ordinary.md': '# Ordinary' });
    h.open('Ordinary.md');
    const failure = new Error('native frontmatter IO failed');
    h.app.fileManager.processFrontMatter = async () => { throw failure; };
    await assert.rejects(command === 'mintNoteAddress' ? h.plugin.mintNoteAddress(h.files.get('Ordinary.md')) : h.plugin.lintActiveNote('notes'), error => error === failure);
    assert.equal(h.disk.get('Ordinary.md'), '# Ordinary');
  });
});

test('an unreadable editor first observed inside a target IO callback still prevents the write', async () => {
  const body = '# Hybrid\n\n## Part\nBody';
  const h = harness({ 'Hybrid.md': body, 'Page.md': '# Page\n\n[[Hybrid#Part]]' });
  const inactive = h.open('Hybrid.md', body, { active: false });
  h.open('Page.md');
  h.beforeProcess = () => { inactive.editor.getValue = () => { throw new Error('editor closed during IO'); }; };
  assert.equal(await h.plugin.addressReferencedHeadings(h.files.get('Page.md'), () => 'A0BC01'), 0);
  assert.equal(h.disk.get('Hybrid.md'), body);
});
