import assert from "node:assert/strict";
import { createStateManager, STATE_CONFLICT } from "../lib/state-manager.js";

const blank = () => ({ global: {}, profiles: {}, routes: {}, scripts: {}, workflows: {} });
let persisted = blank();
const manager = createStateManager({
  load: async () => structuredClone(persisted),
  save: async (state) => { persisted = structuredClone(state); return structuredClone(state); }
});

const initialized = await manager.initialize();
initialized.global.profileNamePrefix = "escaped-init";
assert.notEqual((await manager.getState()).global.profileNamePrefix, "escaped-init");

const read = await manager.getState();
read.global.profileNamePrefix = "escaped-read";
assert.notEqual((await manager.getState()).global.profileNamePrefix, "escaped-read");

const peek = manager.peekState();
peek.global.profileNamePrefix = "escaped-peek";
assert.notEqual(manager.peekState().global.profileNamePrefix, "escaped-peek");

await manager.mutate((draft) => { draft.global.profileNamePrefix = "committed"; });
const revisionAfterCommit = manager.getRevision();
const echo = await manager.acceptStorageState(await manager.getState());
assert.equal(echo.accepted, false);
assert.equal(manager.getRevision(), revisionAfterCommit, "self storage echo must not advance revision");

const external = await manager.getState();
external.global.unmanagedPolicy = "block";
persisted = structuredClone(external);
delete persisted.__stateMeta;
const accepted = await manager.acceptStorageState(external);
assert.equal(accepted.accepted, true);
assert.equal(manager.getRevision(), revisionAfterCommit + 1, "external storage write must advance revision");

// Legacy GET_SNAPSHOT -> edit -> SAVE_STATE carries transient revision metadata.
// The caller does not need to know about revisions explicitly, but an old
// whole-state snapshot must not overwrite a newer PCMS mutation.
const stale = await manager.getState();
const expectedRevision = manager.getRevision();
assert.equal(stale.__stateMeta.revision, expectedRevision);
assert.equal(stale.__stateMeta.bootId, manager.getBootId());
await manager.mutate((draft) => { draft.global.profileNamePrefix = "newer"; });
stale.global.profileNamePrefix = "stale";
await assert.rejects(
  manager.setState(stale),
  (error) => error?.code === STATE_CONFLICT && error.actualRevision === expectedRevision + 1
);
assert.equal((await manager.getState()).global.profileNamePrefix, "newer");

const metadataFree = await manager.getState();
delete metadataFree.__stateMeta;
metadataFree.global.profileNamePrefix = "metadata-free";
await assert.rejects(
  manager.setState(metadataFree, { requireMetadata: true }),
  (error) => error?.code === STATE_CONFLICT
);
assert.equal((await manager.getState()).global.profileNamePrefix, "newer", "metadata-free compatibility writes must not overwrite current state");

await assert.rejects(
  manager.mutate(() => {}, { expectedRevision: manager.getRevision(), expectedBootId: "previous-worker" }),
  (error) => error?.code === STATE_CONFLICT && error.actualBootId === manager.getBootId()
);

console.log("state integrity tests passed");
