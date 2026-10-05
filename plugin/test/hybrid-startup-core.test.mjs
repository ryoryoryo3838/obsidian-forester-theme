import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {dirname} from 'node:path';

// Own generated namespace: no shared controller/test bundle is overwritten.
const root = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('./build/startup-core/', import.meta.url);
const probes = {name: 'observe-real-core-work', setup(builder) {
  builder.onLoad({filter: /hybrid-core\.ts$/}, async ({path}) => {
    let contents = await readFile(path, 'utf8');
    for (const [signature, metric] of [
      ['function sourceLines(source: string): SourceLine[] {', 'sourceLines'],
      ["function scanProtected(source: string, lines: SourceLine[], front?: SourceRange, raw?: HybridRaw[], diagnostics?: HybridDiagnostic[], path = ''): SourceRange[] {", 'protectedScans'],
    ]) {
      assert.equal(contents.split(signature).length, 2, `unique observation seam: ${metric}`);
      contents = contents.replace(signature, `${signature}\n  if (globalThis.__hybridCoreWork) globalThis.__hybridCoreWork.${metric}++;`);
    }
    // Count actual source character reads without replacing parser behavior.
    contents = contents.replace(/\bsource\[([^\[\]]+)\]/g, '__sourceChar(source, $1)');
    contents += '\nfunction __sourceChar(source: string, at: number) { if (globalThis.__hybridCoreWork) globalThis.__hybridCoreWork.charReads++; return source[at]; }\n';
    return {contents, loader: 'ts', resolveDir: dirname(path)};
  });
}};
const settings = {absWorkingDir: root, bundle: true, platform: 'node', format: 'esm', logLevel: 'warning'};
await build({...settings, entryPoints: ['src/hybrid-core.ts'], outfile: fileURLToPath(new URL('core-probe.mjs', output)), plugins: [probes]});
await build({...settings, entryPoints: ['src/hybrid-core.ts'], outfile: fileURLToPath(new URL('core.mjs', output))});
await build({...settings, entryPoints: ['src/hybrid-public.ts'], outfile: fileURLToPath(new URL('public.mjs', output))});
const core = await import(new URL('core-probe.mjs', output));
const nativeCore = await import(new URL('core.mjs', output));
const {projectPublic} = await import(new URL('public.mjs', output));
const options = (overrides = {}) => ({folders: [], publicFolders: [], reservedIds: [], ...overrides});
const header = (fields, newline = '\n', closing = '---') => `---${newline}${fields.replace(/\n/g, newline)}${newline}${closing}${newline}`;
function observe(action) {
  const counts = {sourceLines: 0, protectedScans: 0, charReads: 0, sliceChars: 0, replaceChars: 0, splitChars: 0, indexOfChars: 0};
  const original = {};
  for (const method of ['slice', 'replace', 'split', 'indexOf']) {
    original[method] = String.prototype[method];
    String.prototype[method] = function (...args) {
      const result = Reflect.apply(original[method], this, args);
      if (method === 'indexOf') {
        const from = Math.max(0, Math.min(this.length, Number(args[1] ?? 0)));
        counts.indexOfChars += result < 0 ? this.length - from : result - from + String(args[0]).length;
      } else counts[`${method}Chars`] += method === 'slice' ? result.length : this.length;
      return result;
    };
  }
  globalThis.__hybridCoreWork = counts;
  try { return {value: action(), counts}; }
  finally {
    delete globalThis.__hybridCoreWork;
    for (const method of Object.keys(original)) String.prototype[method] = original[method];
  }
}

test('shared path activation ignores legacy metadata without parsing any source body or YAML', () => {
  assert.equal(typeof core.hybridModeEnabled, 'function', 'cheap shared activation API must be exported');
  const opt = options({folders: ['hybrid'], excludedFolders: ['Excluded'], publicFolders: ['/'], reservedIds: ['PUBLIC']});
  const body = 'text `code` $x$ \\{ raw }\n'.repeat(8192);
  const cases = [
    ['hybrid/Note.md', body, true], ['hybridish/Note.md', body, true],
    ['Ordinary.md', header('forester-mode: true') + body, true],
    ['Ordinary.md', header('setting: &mode true\nforester-mode: *mode') + body, true],
    ['Ordinary.md', header('forester-mode: >-\n  hybrid-v1') + body, true],
    ['Ordinary.md', header('forester-mode: true\nforester-id: "bad id"') + body, true],
    ['Ordinary.md', header('forester-mode: hybrid-v1', '\r\n', '...') + body, true],
    ['hybrid/Note.md', header('forester-mode: false') + body, true],
    ['hybrid/Note.md', header('forester-mode: hybrid-v0') + body, true],
    ['hybrid/Note.md', header('forester-mode: "false"') + body, true],
    ['hybrid/Note.md', header('forester-mode: unknown') + body, true],
    ['hybrid/Note.md', header('forester-mode: true\nauthors: [') + body, true],
    ['hybrid/Note.md', header('forester-mode: false\nforester-mode: true') + body, true],
    ['hybrid/Note.md', header('forester-mode: *missing') + body, true],
    ['hybrid/Note.md', '---\nforester-mode: true\n', true],
    ['Ordinary.md', header('example: |\n  forester-mode: true') + body, true],
    ['Ordinary.md', header('# forester-mode: true\nexample: "forester-mode: true"') + body, true],
    ['Ordinary.md', '```yaml\nforester-mode: true\n```\n' + body, true],
    ['Excluded/Note.md', body, false],
    ['Excluded/Note.md', header('forester-mode: true\npublish: true') + body, false],
    ['Excluded/Note.md', '---\nforester-mode: true\n' + body, false],
    ['Excludedish/Note.md', body, true],
  ];
  for (const [path, source, expected] of cases) {
    const {value, counts} = observe(() => core.hybridModeEnabled(path, source, opt));
    assert.equal(value, expected, `${path}: ${source.slice(0, 70)}`);
    assert.equal(counts.sourceLines, 0);
    assert.equal(counts.protectedScans, 0);
    assert.equal(counts.charReads, 0);
    // Only tiny path/settings work is permitted, even for malformed/unclosed YAML.
    assert.ok(counts.splitChars + counts.replaceChars + counts.sliceChars + counts.indexOfChars < 256, JSON.stringify(counts));
    assert.equal(nativeCore.parseHybrid(path, source, opt).enabled, expected);
  }
  const huge = 'ordinary text `code` $x$ \\ '.repeat(262144);
  for (const expected of [false, true]) {
    const hugeGate = observe(() => core.hybridModeEnabled('Ordinary.md', huge, options({excludedFolders: expected ? [] : ['/']})));
    assert.equal(hugeGate.value, expected);
    assert.equal(hugeGate.counts.sourceLines + hugeGate.counts.protectedScans + hugeGate.counts.charReads, 0);
    assert.ok(hugeGate.counts.splitChars + hugeGate.counts.replaceChars + hugeGate.counts.sliceChars + hugeGate.counts.indexOfChars < 128);
  }
});

test('excluded and syntax-invalid documents skip body scans but retain collisions and YAML save/public refusals', () => {
  const opt = options({folders: ['hybrid'], excludedFolders: ['Excluded'], publicFolders: ['hybrid'], reservedIds: ['C0FFEE']});
  const body = 'text `code` $x$ \\{ raw }\n'.repeat(4096);
  const sources = [
    ['Excluded/Ordinary.md', body, false],
    ['Excluded/Optout.md', header('forester-mode: false\naliases: [PUBLIC]') + body, false],
    ['Excluded/Unknown.md', header('forester-mode: unknown') + body, false],
    ['hybrid/Malformed.md', header('forester-mode: true\nauthors: [') + body, true],
    ['hybrid/Unclosed.md', '---\nforester-mode: true\n' + body, true],
  ];
  const documents = sources.map(([path, source, enabled]) => {
    const {value: document, counts} = observe(() => core.parseHybrid(path, source, opt));
    assert.equal(counts.protectedScans, 0, `${path}: excluded/invalid body must not be scanned`);
    assert.equal(counts.sourceLines, 0, `${path}: excluded/invalid body must not build source lines`);
    assert.equal(document.enabled, enabled);
    assert.equal(core.hybridModeEnabled(path, source, opt), enabled);
    assert.equal(document.source, source);
    assert.equal(document.root.to, source.length);
    assert.equal(document.root.endLine, source.split('\n').length - Number(source.endsWith('\n')));
    assert.equal(document.root.meta.publish, false);
    assert.equal(document.root.meta.titleSource, 'filename');
    assert.equal(document.trees.length, 1);
    assert.deepEqual(document.raw, []);
    return document;
  });
  const publicDocument = core.parseHybrid('hybrid/Public.md', header('forester-id: PUBLIC\ntitle: Public\npublish: true') + 'Safe body.', opt);
  const namedCollision = core.parseHybrid('PUBLIC.md', 'ordinary body', opt);
  const index = core.indexHybrid([...documents, namedCollision, publicDocument]);
  assert.equal(index.documents.size, 7);
  assert.ok(index.diagnostics.some(d => d.path === 'Excluded/Optout.md' && d.code === 'alias-id-collision'));
  assert.ok(index.diagnostics.some(d => d.path === 'PUBLIC.md' && d.code === 'file-id-collision'));
  assert.ok(!index.diagnostics.some(d => d.code === 'invalid-mode'));
  assert.equal(documents[2].frontmatter['forester-mode'], 'unknown');
  for (const path of ['hybrid/Malformed.md', 'hybrid/Unclosed.md']) {
    assert.ok(index.diagnostics.some(d => d.path === path && d.code === 'invalid-frontmatter' && d.severity === 'error'));
    assert.ok(core.planHybridSave(index, path).diagnostics.some(d => d.code === 'invalid-frontmatter'),
      'malformed input must retain its source-error refusal independently of activation');
  }
  const excludedError = core.parseHybrid('Excluded/Malformed.md', header('publish: true\nauthors: [') + body, opt);
  assert.ok(excludedError.diagnostics.some(d => d.code === 'invalid-frontmatter'));
  assert.deepEqual(core.planHybridSave(core.indexHybrid([excludedError]), excludedError.path).edits, []);
  assert.equal(core.resolveHybrid(index, 'PUBLIC', publicDocument.path).status, 'ambiguous');
  assert.deepEqual(core.planHybridSave(index, documents[1].path).edits, []);
  assert.deepEqual(projectPublic(index).trees, [], 'malformed YAML must still block public projection');
  assert.equal(core.parseHybrid('Empty.md', '', opt).root.endLine, 0);
});

test('enabled inline-rich paragraphs do not repeatedly copy or normalize their remaining suffix', () => {
  const opt = options({folders: ['/']});
  for (const size of [32768, 131072]) {
    const source = 'text `code` text $x$. '.repeat(Math.ceil(size / 22)).slice(0, size);
    const {value: document, counts} = observe(() => core.parseHybrid('Enabled.md', source, opt));
    assert.equal(document.enabled, true);
    assert.equal(counts.protectedScans, 1);
    assert.ok(document.protectedRanges.length > 1000);
    assert.deepEqual(document, nativeCore.parseHybrid('Enabled.md', source, opt), 'observation must not change the parse');
    const copiedChars = counts.sliceChars + counts.replaceChars + counts.splitChars;
    assert.ok(copiedChars < source.length * 24, `suffix work must be bounded by input size: ${JSON.stringify(counts)}`);
  }
});

test('enabled backslash runs use bounded character reads rather than repeated backward walks', () => {
  const opt = options({folders: ['/']});
  for (const size of [4096, 32768]) {
    const source = '\\'.repeat(size);
    const {value: document, counts} = observe(() => core.parseHybrid('Escapes.md', source, opt));
    assert.ok(counts.charReads < source.length * 20, `backslash work must be bounded by input size: ${JSON.stringify(counts)}`);
    assert.equal(document.enabled, true);
    assert.equal(document.protectedRanges.length, 0);
    assert.deepEqual(document, nativeCore.parseHybrid('Escapes.md', source, opt));
  }
  for (let length = 0; length <= 9; length++) {
    for (const span of ['`literal`', '$literal$', '\\(literal\\)', '\\{ literal }', '%% literal %%', '<!-- literal -->']) {
      const source = '# Root\ntext ' + '\\'.repeat(length) + span;
      const document = core.parseHybrid('Parity.md', source, opt);
      const from = source.indexOf(span);
      assert.equal(document.protectedRanges.some(r => r.from === from && r.to === from + span.length), length % 2 === 0, `${length}: ${span}`);
    }
  }
});

test('unmatched varying backtick runs do not repeatedly walk all later runs', () => {
  const opt = options({folders: ['/']});
  for (const size of [32768, 131072]) {
    let source = 'p ';
    for (let length = 1; source.length < size; length++) source += '`'.repeat(length) + ' x ';
    const {value: document, counts} = observe(() => core.parseHybrid('Runs.md', source, opt));
    assert.ok(counts.charReads < source.length * 24, `closing-run work must be bounded: ${JSON.stringify(counts)}`);
    assert.equal(document.protectedRanges.length, 0, 'different run lengths do not close one another');
    assert.deepEqual(document, nativeCore.parseHybrid('Runs.md', source, opt));
  }
  for (const source of ['p \\``literal`', 'p \\```literal``']) {
    const from = source.indexOf('`') + 1;
    const document = core.parseHybrid('Suffix-opener.md', source, opt);
    assert.ok(document.protectedRanges.some(r => r.from === from && r.to === source.length),
      'preserve a suffix opener after an escaped first backtick');
    assert.equal(core.inlineCodeEnd(source, from), source.length);
  }
});

test('unclosed inline math does not search the same missing closer through every remaining suffix', () => {
  const opt = options({folders: ['/']});
  for (const size of [32768, 131072]) {
    const source = 'p \\(unclosed\n\n'.repeat(Math.ceil(size / 14)).slice(0, size);
    const {value: document, counts} = observe(() => core.parseHybrid('Math.md', source, opt));
    assert.ok(counts.indexOfChars < source.length * 24, `delimiter search work must be bounded: ${JSON.stringify(counts)}`);
    assert.equal(document.protectedRanges.length, 0);
    assert.deepEqual(document.diagnostics, []);
    assert.deepEqual(document, nativeCore.parseHybrid('Math.md', source, opt));
  }
  for (const source of ['p \\(one\n\np \\(two\\)', 'p $one\n\np $two$', String.raw`p \(one \\) ignored \) end`]) {
    const document = core.parseHybrid('Closers.md', source, opt);
    const expected = source.includes('two') ? (source.includes('$') ? '$two$' : '\\(two\\)') : String.raw`\(one \\) ignored \)`;
    assert.ok(document.protectedRanges.some(r => source.slice(r.from, r.to) === expected));
    assert.deepEqual(document, nativeCore.parseHybrid('Closers.md', source, opt));
  }
});

test('optimized guards retain publication boundaries, private canaries and soft-line literals', () => {
  const opt = options();
  const publicHeader = header('forester-mode: true\nforester-id: PUBLIC\ntitle: Public\npublish: true');
  const privateDocument = core.parseHybrid('Secret.md', header('forester-mode: true\nforester-id: PRIVATE\ntitle: CORE-PRIVATE-TITLE') + 'CORE-PRIVATE-BODY', opt);
  for (const newline of ['\n', '\r\n', '\r']) {
    for (const boundary of ['***', '___', '---', '   * * *', ' _\t_ \t_', '  - - -', '\n', '## Boundary']) {
      for (const [opening, closing] of [['`', '`'], ['``', '``'], ['$', '$'], ['\\(', '\\)']]) {
        const body = `Opening ${opening}example\n${boundary}\n[[PRIVATE|CORE-PRIVATE-LABEL]]\nClosing${closing}`.replace(/\n/g, newline);
        const document = core.parseHybrid('Public.md', publicHeader + body, opt);
        const payloadFrom = document.source.indexOf('[[PRIVATE');
        assert.ok(!document.protectedRanges.some(r => r.from <= payloadFrom && r.to > payloadFrom));
        const projection = projectPublic(core.indexHybrid([document, privateDocument]));
        assert.ok(!JSON.stringify(projection).includes('CORE-PRIVATE'));
        if (newline === '\r') {
          assert.deepEqual(projection.trees, []);
          assert.ok(projection.diagnostics.some(d => d.code === 'unsupported-line-ending'));
        } else {
          assert.deepEqual(projection.diagnostics, []);
          assert.equal(projection.trees[0].body, body.replace('[[PRIVATE|CORE-PRIVATE-LABEL]]', '[非公開]'));
        }
      }
    }
  }
  for (const [opening, closing] of [['``', '``'], ['$', '$'], ['\\(', '\\)']]) {
    for (const newline of ['\n', '\r\n', '\r']) {
      const span = `${opening}😀 literal${newline}soft continuation${newline}Closing${closing}`;
      const source = publicHeader + 'Opening ' + span;
      const document = core.parseHybrid('Public.md', source, opt);
      const from = source.indexOf(span);
      assert.ok(document.protectedRanges.some(r => r.from === from && r.to === from + span.length));
    }
  }
  const source = publicHeader + 'Opening `example\n## Hidden ^hidden\n%% publish: false %%\nCORE-PRIVATE-SUBTREE\nClosing`';
  const document = core.parseHybrid('Public.md', source, opt);
  assert.equal(document.trees[1].meta.publish, false);
  assert.ok(!JSON.stringify(projectPublic(core.indexHybrid([document]))).includes('CORE-PRIVATE'));
});

test('large valid and unclosed fixtures finish in a memory-capped isolated process', () => {
  const child = String.raw`
    import assert from 'node:assert/strict';
    const {parseHybrid, hybridModeEnabled} = await import(process.argv[1]);
    const size = 131072;
    const bodies = ['text \u0060code\u0060 text $x$. ', '\u0060x\u0060 ', '$x$ ', 'p \u0060unclosed\n\n', 'p \\(unclosed\n\n', '\\']
      .map(unit => unit.repeat(Math.ceil(size / unit.length)).slice(0, size));
    let runs = 'p ';
    for (let length = 1; runs.length < size; length++) runs += '\u0060'.repeat(length) + ' x ';
    bodies.push(runs);
    for (const source of bodies) for (const enabled of [false, true]) {
      const options = {folders: [], excludedFolders: enabled ? [] : ['/'], publicFolders: [], reservedIds: []};
      assert.equal(hybridModeEnabled('Fixture.md', source, options), enabled);
      const document = parseHybrid('Fixture.md', source, options);
      assert.equal(document.enabled, enabled);
      assert.equal(document.source, source);
      assert.equal(document.trees.length, 1);
      assert.deepEqual(document.diagnostics, []);
    }
    console.log(JSON.stringify({fixtures: bodies.length, parses: bodies.length * 2, size}));
  `;
  const result = spawnSync(process.execPath, ['--max-old-space-size=256', '--input-type=module', '-e', child, new URL('core.mjs', output).href],
    {encoding: 'utf8', timeout: 25000, maxBuffer: 1024 * 1024});
  assert.ifError(result.error);
  assert.equal(result.signal, null, result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {fixtures: 7, parses: 14, size: 131072});
});
