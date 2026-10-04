import { build } from 'esbuild';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const mock = fileURLToPath(new URL('./controller-obsidian-mock.mjs', import.meta.url));

mkdirSync(new URL('./build/', import.meta.url), { recursive: true });
if (existsSync(new URL('../src/hybrid-controller.ts', import.meta.url))) {
  await build({ absWorkingDir: root, entryPoints: ['src/hybrid-controller.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'test/build/hybrid-controller.mjs', external: ['@codemirror/state', '@codemirror/view'], plugins: [{ name: 'native-obsidian-boundary', setup(b) { b.onResolve({ filter: /^obsidian$/ }, () => ({ path: mock, external: true })); } }] });
} else rmSync(new URL('./build/hybrid-controller.mjs', import.meta.url), { force: true });
const result = spawnSync(process.execPath, ['--test', 'test/hybrid-controller.test.mjs', ...process.argv.slice(2)], { cwd: root, stdio: 'inherit' });
process.exit(result.status ?? 1);
