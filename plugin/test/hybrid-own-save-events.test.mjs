import assert from 'node:assert/strict';
import test from 'node:test';
import { selectionFixture, sourcePath, targetPath, target } from './hybrid-own-save.fixture.mjs';
import { TFile } from './controller-obsidian-mock.mjs';

for (const mode of ['late-own-source-modify', 'late-own-source-modify-unawaited', 'native-source-reload']) {
  test(`Enter selection survives ${mode} without false rollback`, async t => {
    const f = await selectionFixture({ mode }); t.after(() => f.close());
    const result = await f.choose();
    assert.equal(f.view.editor.getValue(), f.expected);
    assert.equal(f.h.vault.data.get(sourcePath), f.expected);
    assert.equal(f.h.vault.data.get(targetPath), target);
    assert.ok(!result.notice.some(n => n.includes('保存を中止')));
  });
}
for (const mode of ['ordinary', 'late-own-source-metadata', 'native-source-reload-keep-selection']) {
  test(`successful selection control: ${mode}`, async t => {
    const f = await selectionFixture({ mode }); t.after(() => f.close());
    const result = await f.choose();
    assert.equal(f.view.editor.getValue(), f.expected);
    assert.equal(f.h.vault.data.get(sourcePath), f.expected);
    assert.equal(f.h.vault.data.get(targetPath), target);
    assert.ok(!result.notice.some(n => n.includes('保存を中止')));
  });
}
for (const mode of ['cursor-move', 'dirty-source-pane', 'native-source-reload-user-cursor']) {
  test(`real conflict still cancels insertion: ${mode}`, async t => {
    const f = await selectionFixture({ mode }); t.after(() => f.close());
    await f.choose();
    assert.equal(f.view.editor.getValue(), f.before);
    assert.equal(f.h.vault.data.get(targetPath), target);
    if (mode === 'native-source-reload-user-cursor') {
      assert.deepEqual(f.view.editor.getCursor(), { line: 0, ch: 0 });
      assert.equal(f.view.editor.cm.state.selection.main.head, 0);
      assert.equal(f.h.vault.data.get(sourcePath), f.before);
    }
  });
}

for (const mode of ['read-failure', 'namespace-ABA']) {
  test(`unknown unrelated namespace notification cancels: ${mode}`, async t => {
    const f = await selectionFixture(); t.after(() => f.close());
    const path = 'unrelated-synthetic.md', baseline = '# unrelated\n';
    const file = new TFile(path);
    f.h.vault.files.set(path, file); f.h.vault.data.set(path, baseline);
    await f.c.refresh();
    const version = f.c.sourceVersions.get(path), read = f.h.vault.read;
    let triggered = false, failNotification = false;
    f.h.vault.read = async currentFile => {
      if (currentFile === file && failNotification) {
        failNotification = false; throw new Error('synthetic notification read failure');
      }
      const bytes = await read(currentFile);
      if (!triggered && currentFile.path === targetPath) {
        triggered = true;
        f.h.vault.data.set(path, target.replace('合成博物館', 'duplicate namespace entry'));
        if (mode === 'read-failure') {
          await f.h.vault.emit('modify', file).catch(() => {});
          // A fixed handler invalidates synchronously and does not need this IO.
          failNotification = false;
        } else {
          const notificationB = f.h.vault.emit('modify', file);
          f.h.vault.data.set(path, baseline);
          await Promise.all([notificationB, f.h.vault.emit('modify', file)]);
        }
      }
      return bytes;
    };
    // Fail the notification read only, not the initial namespace snapshot.
    if (mode === 'read-failure') failNotification = true;
    const result = await f.choose();
    assert.equal(triggered, true);
    assert.equal(result.inserted, false, 'unknown namespace events must invalidate even if their read fails or observes ABA');
    assert.equal(f.view.editor.getValue(), f.before);
    assert.notEqual(f.c.sourceVersions.get(path), version);
    assert.equal(f.c.pendingSourceReads.size, 0);
  });
}

test('own-write notification read failure is caught and cancels before releasing its barrier', async t => {
  const f = await selectionFixture({ mode: 'late-own-source-modify-unawaited' }); t.after(() => f.close());
  const read = f.h.vault.read;
  let failed = false;
  f.h.vault.read = async file => {
    if (!failed && file === f.view.file && f.c.pendingSourceReads.size) {
      failed = true;
      throw new Error('synthetic own-notification read failure');
    }
    return read(file);
  };
  const result = await f.choose();
  assert.equal(failed, true);
  assert.equal(result.inserted, false);
  assert.equal(f.view.editor.getValue(), f.before);
  assert.ok(result.notice.some(n => n.includes('synthetic own-notification read failure')));
  assert.equal(f.c.pendingSourceReads.size, 0);
  assert.equal(f.c.ownWrite, undefined);
});

test('a second same-file modify cannot reuse an own-write receipt', async t => {
  const f = await selectionFixture({ mode: 'late-own-source-modify' }); t.after(() => f.close());
  const read = f.h.vault.read;
  let triggered = false, synchronousInvalidation = false;
  f.h.vault.read = async file => {
    const bytes = await read(file);
    if (!triggered && file.path === sourcePath && f.trace.some(entry => entry.stage === 'own-save-notification-delivered')) {
      triggered = true;
      const version = f.c.sourceVersions.get(sourcePath);
      const event = f.h.vault.emit('modify', f.view.file);
      synchronousInvalidation = f.c.sourceVersions.get(sourcePath) !== version;
      await event;
    }
    return bytes;
  };
  const result = await f.choose();
  assert.equal(triggered, true);
  assert.equal(synchronousInvalidation, true, 'second unknown notification invalidates synchronously');
  assert.equal(result.inserted, false);
  assert.equal(f.view.editor.getValue(), f.before);
  assert.equal(f.c.ownWrite, undefined);
});

test('no-op flush does not authorize an unknown source notification', async t => {
  const f = await selectionFixture(); t.after(() => f.close());
  f.h.vault.data.set(sourcePath, f.before);
  const read = f.h.vault.read;
  let triggered = false, noReceipt = false, synchronousInvalidation = false;
  f.h.vault.read = async file => {
    const bytes = await read(file);
    if (!triggered && file.path === targetPath) {
      triggered = true;
      noReceipt = f.c.ownWrite === undefined;
      const version = f.c.sourceVersions.get(sourcePath);
      const event = f.h.vault.emit('modify', f.view.file);
      synchronousInvalidation = f.c.sourceVersions.get(sourcePath) !== version;
      await event;
    }
    return bytes;
  };
  const result = await f.choose();
  assert.equal(triggered, true);
  assert.equal(noReceipt, true);
  assert.equal(synchronousInvalidation, true);
  assert.equal(result.inserted, false);
});

test('a Markdown view rebound during flush pre-read is not saved into another file', async t => {
  const f = await selectionFixture(); t.after(() => f.close());
  const other = new TFile('other-synthetic.md');
  const savedOther = '# Other saved\n', draftOther = '# Other unsaved draft\n';
  f.h.vault.files.set(other.path, other); f.h.vault.data.set(other.path, savedOther);
  await f.c.refresh();
  const read = f.h.vault.read;
  let rebound = false;
  f.h.vault.read = async file => {
    const bytes = await read(file);
    if (!rebound && file === f.view.file) {
      rebound = true;
      f.view.file = other;
      f.view.editor.replaceRange(draftOther, { line: 0, ch: 0 }, f.view.editor.offsetToPos(f.view.editor.getValue().length));
    }
    return bytes;
  };
  await f.choose();
  assert.equal(rebound, true);
  assert.equal(f.h.vault.data.get(other.path), savedOther);
  assert.equal(f.view.editor.getValue(), draftOther);
  assert.deepEqual(f.h.vault.processes, []);
});

test('pending own-notification validation blocks source CAS', async t => {
  const f = await selectionFixture({ mode: 'late-own-source-modify-unawaited' }); t.after(() => f.close());
  const read = f.h.vault.read;
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let blocked = false;
  f.h.vault.read = async file => {
    if (!blocked && file === f.view.file && f.c.pendingSourceReads.size) {
      blocked = true; entered(); await gate;
    }
    return read(file);
  };
  const choosing = f.choose();
  await started;
  assert.equal(f.c.pendingSourceReads.size, 1);
  assert.deepEqual(f.h.vault.processes, []);
  release();
  assert.equal((await choosing).inserted, true);
  assert.equal(f.c.pendingSourceReads.size, 0);
  assert.equal(f.c.ownWrite, undefined);
});

for (const mode of ['own-notification-read-failure-during-CAS', 'unknown-source-ABA-during-CAS']) {
  test(`CAS-stage invalidation cancels and rolls back: ${mode}`, async t => {
    const f = await selectionFixture(); t.after(() => f.close());
    const selection = f.view.editor.listSelections();
    let triggered = false;
    if (mode === 'own-notification-read-failure-during-CAS') {
      const read = f.h.vault.read;
      f.h.vault.read = async file => {
        if (!triggered && file === f.view.file && f.h.vault.processes.length > 0 && f.c.pendingSourceReads.size > 0) {
          triggered = true;
          throw new Error('synthetic CAS receipt validation read failure');
        }
        return read(file);
      };
    } else {
      const process = f.h.vault.process;
      f.h.vault.process = async (file, transform) => {
        const bytes = await process(file, transform);
        if (!triggered && file.path === sourcePath && bytes === f.expected) {
          triggered = true;
          const version = f.c.sourceVersions.get(sourcePath);
          f.h.vault.data.set(sourcePath, f.expected + 'external change\n');
          await f.h.vault.emit('modify', file);
          f.h.vault.data.set(sourcePath, f.expected);
          await f.h.vault.emit('modify', file);
          assert.notEqual(f.c.sourceVersions.get(sourcePath), version, 'unknown events invalidate synchronously');
        }
        return bytes;
      };
    }
    const result = await f.choose();
    assert.equal(triggered, true);
    assert.equal(result.inserted, false, 'CAS-stage invalidation must cancel insertion');
    assert.equal(f.view.editor.getValue(), f.before);
    assert.equal(f.h.vault.data.get(sourcePath), f.before, 'source disk is restored by CAS rollback');
    assert.equal(f.h.vault.data.get(targetPath), target, 'selected target remains unchanged');
    assert.deepEqual(f.view.editor.listSelections(), selection, 'rollback preserves the captured cursor');
    assert.equal(f.c.pendingSourceReads.size, 0);
    assert.equal(f.c.ownWrite, undefined);
    assert.ok(result.notice.some(n => n.includes('保存を中止')));
  });
}
