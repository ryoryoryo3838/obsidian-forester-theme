import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const mock = resolve('test/controller-obsidian-mock.mjs');
await build({ entryPoints: ['src/hybrid-controller.ts'], outfile: 'test/build/v2-workspace-controller.mjs', bundle: true, platform: 'node', format: 'esm', external: ['@codemirror/state', '@codemirror/view'], plugins: [{ name: 'native-obsidian-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true })); } }] });
await build({ entryPoints: ['src/main.ts', 'src/settings.ts'], outdir: 'test/build/v2-workspace', outExtension: { '.js': '.mjs' }, bundle: true, platform: 'node', format: 'esm', external: ['@codemirror/state', '@codemirror/view'], plugins: [{ name: 'native-obsidian-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true })); } }] });
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), 'test/v2-workspace-integration.test.mjs'], { stdio: 'inherit', timeout: 60000 });
process.exit(result.status ?? 1);
