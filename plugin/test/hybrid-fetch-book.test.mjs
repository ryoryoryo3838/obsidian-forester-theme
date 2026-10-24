import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchBook, normalizeIsbn, cleanAuthors, parseNdl } from '../dist/fetch-book.mjs';

const ISBN = '9784062776813';
const segment = (marker, payload) => Buffer.concat([Buffer.from([0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff]), payload]);
const jpeg = ({ frame = 0xc0 } = {}) => Buffer.concat([
  Buffer.from([0xff, 0xd8]),
  segment(0xe1, Buffer.from('Exif\0\0CANARY-GPS-EXIF')),
  segment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'binary')),
  segment(0xdb, Buffer.alloc(65, 1)),
  segment(frame, Buffer.from([8, 0, 3, 0, 2, 1, 1, 0x11, 0])),
  segment(0xc4, Buffer.alloc(20, 2)),
  segment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
  Buffer.from([0x12, 0xff, 0x00, 0x34, 0xff, 0xd9]),
]);
const ndlItem = ({ isbn = '978-4-06-277681-3', title = '喜嶋先生の静かな世界', link = 'https://ndlsearch.ndl.go.jp/books/R100000002-I000012345678', issued = '2013.10' } = {}) => `<item>
<title>${title}</title><link>${link}</link>
<dc:title>${title}</dc:title><dc:creator>森, 博嗣, 1957-</dc:creator><dc:publisher>講談社</dc:publisher>
<dcterms:issued>${issued}</dcterms:issued><dc:identifier xsi:type="dcndl:ISBN">${isbn}</dc:identifier>
<dc:identifier xsi:type="dcndl:NDLBibID">000012345678</dc:identifier></item>`;
const rss = items => `<rss><channel><title>x</title><link>https://example.invalid/</link>${items.join('')}</channel></rss>`;

/** Fake fetch: routes by URL prefix and records every request; no network. */
function fake(routes) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'], signal: !!init?.signal });
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) return { ok: false, status: 404, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) };
    const body = typeof hit[1] === 'function' ? hit[1](url) : hit[1];
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), arrayBuffer: async () => Uint8Array.from(body).buffer };
  };
  return { fetch, calls };
}
const openbd = (summary) => ({ 'https://api.openbd.jp/v1/get?isbn=': summary === null ? [null] : [{ summary: { isbn: ISBN, title: '', volume: '', series: '', publisher: '', pubdate: '', cover: '', author: '', ...summary } }] });
const ndl = (items) => ({ 'https://ndlsearch.ndl.go.jp/api/opensearch?': rss(items) });

async function vaultFixture(fn) {
  const base = await mkdtemp(join(tmpdir(), 'fetch-book-'));
  const vault = join(base, 'vault'); await mkdir(vault);
  try { await fn(vault, base); } finally { await rm(base, { recursive: true, force: true }); }
}
async function run(argv, routes, random) {
  const out = [], { fetch, calls } = fake(routes);
  let error;
  try { await fetchBook(argv, { fetch, out: l => out.push(l), random }); } catch (e) { error = e; }
  return { lines: out.map(l => JSON.parse(l)), calls, error };
}

test('ISBN normalization validates checksums and converts ISBN-10', () => {
  assert.equal(normalizeIsbn('978-4-06-277681-3'), ISBN);
  assert.equal(normalizeIsbn('4062776812'), ISBN);
  assert.equal(normalizeIsbn('0-8044-2957-X'), '9780804429573');
  assert.equal(normalizeIsbn('9784062776814'), undefined);
  assert.equal(normalizeIsbn('4062776813'), undefined);
  assert.equal(normalizeIsbn('abc'), undefined);
});

test('author cleaning drops role suffixes, life dates and non-author roles', () => {
  assert.deepEqual(cleanAuthors(['森博嗣／著']), ['森博嗣']);
  assert.deepEqual(cleanAuthors(['森,博嗣,1957-']), ['森博嗣']);
  assert.deepEqual(cleanAuthors(['ジョン・スミス／著 山田 太郎／訳']), ['ジョン・スミス']);
  assert.deepEqual(cleanAuthors(['Smith, John, 1950-']), ['John Smith']);
  assert.deepEqual(cleanAuthors(['黒木亮 [著]']), ['黒木亮']);
  assert.deepEqual(cleanAuthors(['田中芳樹 著', '田中, 芳樹, 1952-']), ['田中芳樹']);
});

test('NDL parsing keeps only ndlsearch book links and normalized ISBNs', () => {
  const items = parseNdl(rss([ndlItem(), ndlItem({ link: 'https://evil.example/books/x', isbn: 'bogus' })]));
  assert.equal(items[0].link, 'https://ndlsearch.ndl.go.jp/books/R100000002-I000012345678');
  assert.deepEqual(items[0].isbns, [ISBN]);
  assert.equal(items[1].link, undefined); assert.deepEqual(items[1].isbns, []);
});

test('search mode prints deduplicated candidates and writes nothing', async () => {
  const r = await run(['--search', '喜嶋先生の静かな世界'], ndl([ndlItem(), ndlItem(), ndlItem({ isbn: '978-4-06-216636-2', issued: '2010.10' })]));
  assert.equal(r.error, undefined);
  assert.deepEqual(r.lines.map(l => l.isbn), [ISBN, '9784062166362']);
  assert.deepEqual(Object.keys(r.lines[0]), ['isbn', 'title', 'creator', 'publisher', 'issued']);
  assert.equal(r.calls.length, 1);
  assert.match(r.calls[0].url, /title=%E5%96%9C.*&mediatype=books&cnt=20$/);
  assert.match(r.calls[0].ua, /forester/); assert.ok(r.calls[0].signal);
  const narrowed = await run(['--search', '銀河英雄伝説', '--creator', '田中芳樹'], ndl([]));
  assert.match(narrowed.calls[0].url, /&creator=%E7%94%B0.*&mediatype=books&cnt=20$/);
  assert.equal((await run(['--creator', '田中芳樹'], ndl([]))).error.code, 'usage');
});

test('ISBN mode prefers openBD, fills gaps from NDL, sanitizes and embeds the cover', () => vaultFixture(async vault => {
  await writeFile(join(vault, 'a.md'), '---\nforester-id: AAAAAA\n---\n');
  await writeFile(join(vault, 'b.md'), '---\nid: "bbbbbb"\n---\n');
  const seq = [0xAAAAAA, 0xBBBBBB, 0xCCCCCC].map(n => (n - 0x111111) / (0xFFFFFF - 0x111111 + 1));
  let i = 0;
  const routes = { ...openbd({ title: '喜嶋先生の静かな世界 = The Silent World of Dr.Kishima', author: '森博嗣／著', pubdate: '20131015', cover: 'https://cover.openbd.jp/9784062776813.jpg' }), ...ndl([ndlItem({ issued: '1999' })]), 'https://cover.openbd.jp/': jpeg() };
  const r = await run(['--vault', vault, '--isbn', '4062776812'], routes, () => seq[i++]);
  assert.equal(r.error, undefined, r.error?.message);
  assert.deepEqual(r.lines, [{ status: 'ok', path: 'PUBLIC/books/喜嶋先生の静かな世界.tree.md', id: 'CCCCCC', cover: true, sources: ['openbd', 'ndl'] }]);
  assert.equal(r.calls.length, 3);
  const note = await readFile(join(vault, 'PUBLIC/books/喜嶋先生の静かな世界.tree.md'), 'utf8');
  assert.equal(note, '---\nforester-id: CCCCCC\ntitle: "喜嶋先生の静かな世界"\ntaxon: Book\ncitation-authors:\n  - "森博嗣"\npublication-year: "2013"\nexternal: "https://ndlsearch.ndl.go.jp/books/R100000002-I000012345678"\nisbn: "9784062776813"\n---\n![[9784062776813.jpg]]\n\n');
  assert.ok(!/^#/m.test(note.split('---\n')[2]));
  const image = await readFile(join(vault, 'PUBLIC/books/_assets/9784062776813.jpg'));
  assert.ok(!image.includes('CANARY'));
  // Second run refuses to overwrite.
  const again = await run(['--vault', vault, '--isbn', ISBN], routes);
  assert.equal(again.error?.code, 'exists');
}));

test('NDL-only record works; progressive cover is skipped and reported', () => vaultFixture(async vault => {
  const r = await run(['--vault', vault, '--isbn', ISBN, '--folder', 'Books'], { ...openbd({ cover: 'https://cover.openbd.jp/x.jpg' }), ...ndl([ndlItem({ isbn: '978-4-06-216636-2', title: 'Wrong' }), ndlItem()]), 'https://cover.openbd.jp/': jpeg({ frame: 0xc2 }) });
  assert.equal(r.error, undefined, r.error?.message);
  assert.equal(r.lines[0].cover, false); assert.equal(r.lines[0].coverSkipped, 'unsupported-or-unavailable');
  const note = await readFile(join(vault, 'Books/喜嶋先生の静かな世界.tree.md'), 'utf8');
  assert.match(note, /citation-authors:\n {2}- "森博嗣"\npublication-year: "2013"\n/);
  assert.ok(!note.includes('![['));
  assert.ok(!existsSync(join(vault, 'Books/_assets')));
}));

test('no cover field: no image request, no embed; missing NDL record omits external', () => vaultFixture(async vault => {
  const r = await run(['--vault', vault, '--isbn', ISBN], { ...openbd({ title: 'T', pubdate: '2013-10' }), ...ndl([]) });
  assert.equal(r.error, undefined);
  assert.deepEqual(r.lines[0].sources, ['openbd']); assert.equal(r.calls.length, 2);
  const note = await readFile(join(vault, 'PUBLIC/books/T.tree.md'), 'utf8');
  assert.ok(!note.includes('external')); assert.match(note, /citation-authors: \[\]/);
}));

test('fail-closed: bad ISBN, unknown book, unsafe folders, symlinks, network errors, usage', () => vaultFixture(async (vault, base) => {
  const ok = { ...openbd({ title: 'T' }), ...ndl([]) };
  assert.equal((await run(['--vault', vault, '--isbn', '9784062776814'], ok)).error.code, 'invalid-isbn');
  assert.equal((await run(['--vault', vault, '--isbn', ISBN], { ...openbd(null), ...ndl([]) })).error.code, 'not-found');
  for (const folder of ['../out', '/abs', 'a/../b', '.hidden', 'a//b'])
    assert.equal((await run(['--vault', vault, '--isbn', ISBN, '--folder', folder], ok)).error.code, 'unsafe-folder', folder);
  await mkdir(join(base, 'outside'));
  await symlink(join(base, 'outside'), join(vault, 'link'));
  assert.equal((await run(['--vault', vault, '--isbn', ISBN, '--folder', 'link/books'], ok)).error.code, 'unsafe-folder');
  assert.deepEqual(await readdir(join(base, 'outside')), []);
  const down = await run(['--vault', vault, '--isbn', ISBN], { 'https://api.openbd.jp/': new Error('CANARY-NET') });
  assert.equal(down.error.code, 'openbd-unavailable'); assert.ok(!down.error.message.includes('CANARY'));
  assert.equal((await run(['--vault', vault], ok)).error.code, 'usage');
  assert.equal((await run(['--vault', vault, '--isbn', ISBN, '--bogus', 'x'], ok)).error.code, 'usage');
  assert.equal((await run(['--vault', join(base, 'missing'), '--isbn', ISBN], ok)).error.code, 'invalid-vault');
  assert.deepEqual((await readdir(vault)).sort(), ['link']);
}));

test('title sanitization strips link and path syntax from the file name only', () => vaultFixture(async vault => {
  const r = await run(['--vault', vault, '--isbn', ISBN], { ...openbd({ title: 'A/B: [C]#D|E?' }), ...ndl([]) });
  assert.equal(r.lines[0].path, 'PUBLIC/books/A B C D E.tree.md');
  assert.match(await readFile(join(vault, r.lines[0].path), 'utf8'), /title: "A\/B: \[C\]#D\|E\?"/);
}));
