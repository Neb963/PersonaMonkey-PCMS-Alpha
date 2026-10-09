import assert from 'node:assert/strict';
import { dirname } from 'node:path';
import { realpath } from 'node:fs/promises';
import { verifyInstallation } from './pin.mjs';

// Exercise the pinned browser's actual native updater lock, not a fabricated
// cache file. This performs no update check/download and keeps auto-update off.
export async function exerciseUpdaterMutex(h) {
  const before = await verifyInstallation();
  const state = await h.client.script(`const done = arguments[arguments.length - 1];
    (async () => {
      const {UpdateUtils} = ChromeUtils.importESModule("resource://gre/modules/UpdateUtils.sys.mjs");
      const autoUpdate = await UpdateUtils.getAppUpdateAutoEnabled();
      if (autoUpdate) throw new Error("Unexpected automatic updates");
      const mutex = Components.classes["@mozilla.org/updates/update-mutex;1"]
        .getService(Components.interfaces.nsIUpdateMutex);
      return {autoUpdate, acquired:mutex.tryLock(), locked:mutex.isLocked(),
        updateRoot:Services.dirsvc.get("UpdRootD", Components.interfaces.nsIFile).path};
    })().then(done, () => done({failed:true}));`, [], { async: true });
  assert.equal(state.failed, undefined);
  assert.equal(state.autoUpdate, false);
  assert.equal(state.acquired, true);
  assert.equal(state.locked, true);
  assert.equal(await realpath(state.updateRoot), dirname(await realpath(h.firefoxBin)));
  let held;
  try {
    held = await verifyInstallation();
    assert.ok(held.artifactIntegrity.runtimeMetadata.some(entry => entry.path === '.parentlock'));
    assert.ok(held.artifactIntegrity.runtimeMetadata.some(entry => entry.path === 'lock'));
    assert.notEqual(held.artifactIntegrity.observedTreeSha256, held.extractedTreeSha256);
  } finally {
    assert.equal(await h.client.script(`const mutex = Components.classes["@mozilla.org/updates/update-mutex;1"]
      .getService(Components.interfaces.nsIUpdateMutex);
      mutex.unlock(); return mutex.isLocked();`), false);
  }
  const released = await verifyInstallation();
  assert.deepEqual(released.artifactIntegrity.runtimeMetadata.map(entry => entry.path), ['.parentlock']);
  return { mechanism: 'pinned-native-nsIUpdateMutex', autoUpdate: false,
    before: before.artifactIntegrity, held: held.artifactIntegrity, released: released.artifactIntegrity };
}
