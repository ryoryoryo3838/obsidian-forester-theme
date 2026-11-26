import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHybrid, indexHybrid } from './build/hybrid-core.mjs';
import { liftTarget, planLift } from './build/hybrid-lift.mjs';

const o = { folders: [], publicFolders: [], reservedIds: [] };
const apply = (source, edits) => [...edits].reverse().reduce((text, e) => text.slice(0, e.from) + e.text + text.slice(e.to), source);
const page = [
  '---', 'forester-id: page-id', '---', '# Page', '', '## *Claim.* A ^a-id', 'a1', '',
  '### *Lemma.* B #private ^b-id', 'b body [[#^a-id]] [[#^c-id]] [[#^b-id]]', '#### Deep ^d-id', 'deep', '```', '## not a heading', '```',
  '## C ^c-id', 'c body [[#^b-id]] [[Page#^d-id]]', '',
].join('\n');

test('v0.6: the caret picks the innermost subtree, never the root', () => {
  const doc = parseHybrid('Page.md', page, o);
  assert.equal(liftTarget(doc, page.indexOf('b body')).id, 'b-id');
  assert.equal(liftTarget(doc, page.indexOf('deep')).id, 'd-id');
  assert.equal(liftTarget(doc, page.indexOf('# Page')), undefined);
});

test('v0.6: lifting a section promotes it, embeds it in place and retargets links', () => {
  const doc = parseHybrid('Page.md', page, o);
  const other = parseHybrid('Other.md', '# Other\n[[Page#^b-id]] [[Page#^d-id|deep]] ![[Page#^b-id|-h]] [[b-id]] [[Page#^a-id]]\n', o);
  const index = indexHybrid([doc, other]);
  const tree = doc.trees.find(t => t.id === 'b-id');
  const plan = planLift(index, doc, tree, 'B');
  assert.equal(plan.noteSource, [
    '---', 'forester-id: "b-id"', '---', '# *Lemma.* B #private', 'b body [[Page#^a-id]] [[Page#^c-id]] [[B]]',
    '## Deep ^d-id', 'deep', '```', '## not a heading', '```', '',
  ].join('\n'));
  const after = apply(page, plan.sourceEdits);
  assert.ok(after.includes('a1\n\n![[B]]\n\n## C ^c-id\nc body [[B]] [[B#^d-id]]\n'), after);
  assert.equal(after.slice(plan.caret - 'a1\n\n![[B]]\n'.length, plan.caret), 'a1\n\n![[B]]\n');
  assert.deepEqual(plan.otherEdits, [{ path: 'Other.md', before: other.source,
    after: '# Other\n[[B]] [[B#^d-id|deep]] ![[B|-h]] [[b-id]] [[Page#^a-id]]\n' }]);
  // The result parses: the new note's root is b-id, its child keeps d-id.
  const note = parseHybrid('B.md', plan.noteSource, o);
  assert.deepEqual([note.root.id, note.root.meta.taxon, note.root.meta.visibility, note.trees[1].id], ['b-id', 'Lemma', 'private', 'd-id']);
});

test('v0.6: a section at the end of the note and without an ID still lifts cleanly', () => {
  const source = '# Page\n\nintro\n\n## Tail\ntail body\n';
  const doc = parseHybrid('Page.md', source, o);
  const plan = planLift(indexHybrid([doc]), doc, doc.trees[1], 'Tail');
  assert.equal(plan.noteSource, '# Tail\ntail body\n');
  assert.equal(apply(source, plan.sourceEdits), '# Page\n\nintro\n\n![[Tail]]\n');
  assert.equal(plan.caret, '# Page\n\nintro\n\n![[Tail]]\n'.length);
});
