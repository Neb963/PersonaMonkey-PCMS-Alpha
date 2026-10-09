import assert from "node:assert/strict";

const mod = await import(`../lib/state-manager.js?test=${Date.now()}`);

const raw = {
  global: {},
  profiles: {
    p1: { managed: true, name: "P1", routeId: "missing", killSwitch: true, scriptIds: ["s1", "ghost"] },
    p2: { managed: true, name: "P2", routeId: "missing", killSwitch: false, scriptIds: [] }
  },
  routes: {},
  scripts: {
    s1: { id: "s1", name: "S1", profileIds: ["p1", "ghost"] }
  },
  workflows: {
    w1: {
      id: "w1",
      name: "W1",
      steps: [
        { profileId: "p1", urls: ["https://example.com"], scriptIds: ["s1", "ghost"] },
        { profileId: "ghost", urls: ["https://example.com"], scriptIds: ["s1"] }
      ]
    },
    empty: { id: "empty", name: "Empty", steps: [] }
  }
};

const clean = mod.sanitizeCrossRefs(raw);
assert.equal(clean.profiles.p1.routeId, "__block__", "kill-switch profile with missing route must fail closed");
assert.equal(clean.profiles.p2.routeId, "missing", "kill-switch-disabled compatibility behavior must be preserved");
assert.deepEqual(clean.scripts.s1.profileIds, ["p1"]);
assert.deepEqual(clean.profiles.p1.scriptIds, ["s1"]);
assert.equal(clean.workflows.w1.steps.length, 2, "draft steps must survive a removed persona");
assert.deepEqual(clean.workflows.w1.steps[0].scriptIds, ["s1"]);
assert.equal(clean.workflows.w1.steps[1].profileId, "", "missing persona references are cleared for editing");
assert.deepEqual(clean.workflows.w1.steps[1].scriptIds, ["s1"]);
assert.equal(clean.workflows.empty.steps.length, 1, "zero-step workflows recover to one editable blank step");
assert.equal(clean.workflows.empty.steps[0].profileId, "");
assert.deepEqual(clean.workflows.empty.steps[0].urls, []);

const noProfiles = mod.sanitizeCrossRefs({
  global: {},
  profiles: {},
  routes: { r1: { id: "r1", name: "Configured route", type: "socks", host: "127.0.0.1", port: 1080 } },
  scripts: {},
  workflows: {
    draft: {
      id: "draft",
      name: "Draft",
      steps: [{ profileId: "", urls: [], scriptIds: [] }]
    }
  }
});
assert.equal(noProfiles.workflows.draft.steps.length, 1, "route-only setups must keep workflow editor details");
assert.equal(noProfiles.workflows.draft.steps[0].profileId, "");

let stored = raw;
let saves = 0;
let hookCalls = 0;
const manager = mod.createStateManager({
  load: async () => stored,
  save: async (state) => { saves += 1; stored = structuredClone(state); return stored; }
});
manager.setAfterSetHook(async () => { hookCalls += 1; });
await manager.initialize();
assert.equal(saves, 1);
assert.equal((await manager.getState()).profiles.p1.routeId, "__block__");
await manager.setState({ ...stored, scripts: {} });
assert.equal(hookCalls, 1);
assert.deepEqual((await manager.getState()).profiles.p1.scriptIds, []);
manager.acceptStorageState(raw);
assert.equal(manager.peekState().profiles.p1.routeId, "__block__");

// PCMS mutations are serialized, even when the first mutation pauses after it
// has received its draft. The second mutation must see the first commit.
let releaseFirst;
let firstStarted;
const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
const firstStartedGate = new Promise((resolve) => { firstStarted = resolve; });
const concurrent = mod.createStateManager({
  load: async () => ({ global: {}, profiles: {}, routes: {}, scripts: {}, workflows: {} }),
  save: async (state) => structuredClone(state)
});
await concurrent.initialize();
const firstMutation = concurrent.mutate(async (draft) => {
  draft.global.profileNamePrefix = "First";
  firstStarted();
  await firstGate;
  draft.profiles.p1 = { managed: true, name: "One", routeId: "__block__" };
  return "first-result";
});
await firstStartedGate;
const secondMutation = concurrent.mutate((draft) => {
  draft.global.unmanagedPolicy = "block";
  return "second-result";
});
releaseFirst();
const [firstCommit, secondCommit] = await Promise.all([firstMutation, secondMutation]);
assert.equal(firstCommit.result, "first-result");
assert.equal(secondCommit.result, "second-result");
assert.equal(firstCommit.revision, 1);
assert.equal(secondCommit.revision, 2);
assert.equal(firstCommit.bootId, secondCommit.bootId);
assert.equal(concurrent.getRevision(), 2);
assert.equal((await concurrent.getState()).global.profileNamePrefix, "First");
assert.equal((await concurrent.getState()).global.unmanagedPolicy, "block");
assert.ok((await concurrent.getState()).profiles.p1, "queued mutations do not lose earlier edits");

// Runner admission joins the same FIFO queue as whole-state writes. A workflow
// retargeting save queued behind an admitted run cannot become visible until
// the runner callback has accepted that run.
let releaseAdmission;
let admissionEntered;
const admissionGate = new Promise((resolve) => { releaseAdmission = resolve; });
const admissionStarted = new Promise((resolve) => { admissionEntered = resolve; });
let admissionStored = {
  global: {},
  profiles: {
    p1: { containerId: "p1", managed: true, name: "P1", routeId: "__block__" },
    p2: { containerId: "p2", managed: true, name: "P2", routeId: "__block__" }
  },
  routes: {}, scripts: {},
  workflows: { flow: { id: "flow", name: "Flow", steps: [{ profileId: "p1", urls: ["https://example.test/"], scriptIds: [] }] } }
};
let admissionSaves = 0;
const admissionManager = mod.createStateManager({
  load: async () => structuredClone(admissionStored),
  save: async (state) => { admissionSaves += 1; admissionStored = structuredClone(state); return structuredClone(state); }
});
await admissionManager.initialize();
const savesBeforeAdmission = admissionSaves;
const runAdmission = admissionManager.withWorkflowAdmissionLock(async () => {
  assert.equal((await admissionManager.getState()).workflows.flow.steps[0].profileId, "p1");
  admissionEntered();
  await admissionGate;
  return "queued-job";
});
await admissionStarted;
const retargeted = await admissionManager.getState();
retargeted.workflows.flow.steps[0].profileId = "p2";
let queuedPersonaMutationStarted = false;
const retargetSave = admissionManager.setState(retargeted);
const queuedPersonaMutation = admissionManager.mutate((draft) => {
  queuedPersonaMutationStarted = true;
  draft.global.profileNamePrefix = "Queued persona write";
});
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(admissionSaves, savesBeforeAdmission, "state saves wait behind the workflow admission callback");
assert.equal(queuedPersonaMutationStarted, false, "PCMS persona/state mutations share the same admission queue");
releaseAdmission();
assert.equal(await runAdmission, "queued-job");
await Promise.all([retargetSave, queuedPersonaMutation]);
assert.equal(queuedPersonaMutationStarted, true);
assert.equal((await admissionManager.getState()).workflows.flow.steps[0].profileId, "p2");
assert.equal((await admissionManager.getState()).global.profileNamePrefix, "Queued persona write");
await assert.rejects(admissionManager.withWorkflowAdmissionLock(async () => { throw new Error("admission failed"); }), /admission failed/);
await admissionManager.mutate((draft) => { draft.global.profileNamePrefix = "Queue released"; });
assert.equal((await admissionManager.getState()).global.profileNamePrefix, "Queue released", "a failed admission releases the shared queue");

const expectedCommit = await concurrent.mutate((draft) => {
  draft.global.profileNamePrefix = "Expected";
}, { expectedRevision: 2 });
assert.equal(expectedCommit.revision, 3);
await assert.rejects(
  concurrent.mutate(() => {}, { expectedRevision: 2 }),
  (error) => error?.code === mod.STATE_CONFLICT
    && error.expectedRevision === 2
    && error.actualRevision === 3
);
assert.equal(concurrent.getRevision(), 3, "conflicts do not advance revision");

await assert.rejects(
  concurrent.mutate(() => { throw new Error("mutator failed"); }),
  /mutator failed/
);
assert.equal(concurrent.getRevision(), 3, "failed mutators do not advance revision");

let failSave = false;
const saveFailure = mod.createStateManager({
  load: async () => ({ global: {}, profiles: {}, routes: {}, scripts: {}, workflows: {} }),
  save: async (state) => {
    if (failSave) throw new Error("persistence failed");
    return structuredClone(state);
  }
});
await saveFailure.initialize();
failSave = true;
await assert.rejects(
  saveFailure.mutate((draft) => { draft.global.profileNamePrefix = "Never committed"; }),
  /persistence failed/
);
assert.equal(saveFailure.getRevision(), 0, "failed persistence does not advance revision");
assert.notEqual((await saveFailure.getState()).global.profileNamePrefix, "Never committed");

// Subscribers are isolated and failures in either the legacy privacy hook or
// a new observer must never make a successfully persisted state look failed.
let healthySubscriberCalls = 0;
let observedMetadata = null;
const observable = mod.createStateManager({
  load: async () => ({ global: {}, profiles: {}, routes: {}, scripts: {}, workflows: {} }),
  save: async (state) => structuredClone(state)
});
await observable.initialize();
observable.setAfterSetHook(() => { throw new Error("privacy observer failure"); });
const unsubscribe = observable.subscribe((state, metadata) => {
  healthySubscriberCalls += 1;
  observedMetadata = metadata;
  state.global.profileNamePrefix = "observer must not mutate cache";
});
observable.subscribe(() => { throw new Error("broken subscriber"); });
const observedCommit = await observable.mutate((draft) => {
  draft.global.profileNamePrefix = "Committed";
});
assert.equal(observedCommit.revision, 1);
assert.equal(healthySubscriberCalls, 1);
assert.equal(observedMetadata.revision, 1);
assert.equal(observedMetadata.bootId, observable.getBootId());
assert.equal((await observable.getState()).global.profileNamePrefix, "Committed");
unsubscribe();
await observable.mutate((draft) => { draft.global.profileNamePrefix = "After unsubscribe"; });
assert.equal(healthySubscriberCalls, 1, "unsubscribed listeners are removed");

const sanitizedMutation = await concurrent.mutate((draft) => {
  draft.profiles.p1.routeId = "missing-route";
  draft.profiles.p1.killSwitch = true;
  draft.profiles.p1.scriptIds = ["missing-script"];
});
assert.equal(sanitizedMutation.state.profiles.p1.routeId, "__block__", "mutations sanitize before persistence");
assert.deepEqual(sanitizedMutation.state.profiles.p1.scriptIds, []);

// Firefox can deliver an earlier storage.onChanged notification after a later
// commit. Genuine external edits (including an intentional rollback) still
// need to be accepted when they are the current persisted value.
let persisted = { global: {}, profiles: {}, routes: {}, scripts: {}, workflows: {} };
const notifications = [];
const storageEvents = [];
const delayed = mod.createStateManager({
  load: async () => structuredClone(persisted),
  save: async (value) => {
    persisted = structuredClone(value);
    notifications.push(structuredClone(value));
    return structuredClone(value);
  }
});
delayed.subscribe((_state, meta) => storageEvents.push(meta));
await delayed.initialize();
notifications.length = 0;
await delayed.mutate((draft) => { draft.global.profileNamePrefix = "A"; });
await delayed.mutate((draft) => { draft.global.profileNamePrefix = "B"; });
const oldA = notifications[0];
const echo = await delayed.acceptStorageState(oldA);
assert.equal(echo.accepted, false, "old self-write notification must not rewind cache");
assert.equal((await delayed.getState()).global.profileNamePrefix, "B");
assert.equal(persisted.global.profileNamePrefix, "B");
assert.equal(delayed.getRevision(), 2);
assert.equal(storageEvents.length, 2);
persisted = { ...structuredClone(persisted), global: { ...persisted.global, profileNamePrefix: "C" } };
const external = await delayed.acceptStorageState(structuredClone(persisted));
assert.equal(external.accepted, true);
assert.equal((await delayed.getState()).global.profileNamePrefix, "C");
assert.equal(delayed.getRevision(), 3);
persisted = structuredClone(oldA);
const rollback = await delayed.acceptStorageState(structuredClone(oldA));
assert.equal(rollback.accepted, true, "an intentional external rollback remains valid");
assert.equal((await delayed.getState()).global.profileNamePrefix, "A");
assert.equal(delayed.getRevision(), 4);


const bootRevision = concurrent.getRevision();
await assert.rejects(
  concurrent.mutate(() => {}, { expectedRevision: bootRevision, expectedBootId: "stale-boot" }),
  (error) => error?.code === mod.STATE_CONFLICT
    && error.expectedRevision === bootRevision
    && error.actualRevision === bootRevision
    && error.expectedBootId === "stale-boot"
    && error.actualBootId === concurrent.getBootId()
);
assert.equal(concurrent.getRevision(), bootRevision, "stale-boot conflicts do not advance revision");
const bootMatched = await concurrent.mutate((draft) => {
  draft.global.profileNamePrefix = "Boot matched";
}, { expectedRevision: bootRevision, expectedBootId: concurrent.getBootId() });
assert.equal(bootMatched.revision, bootRevision + 1);

let securityStored = {
  global: { unmanagedPolicy: "block" },
  profiles: { secure: { managed: true, routeId: "__block__", killSwitch: true } },
  routes: {}, scripts: {}, workflows: {}
};
const secured = mod.createStateManager({
  load: async () => structuredClone(securityStored),
  save: async (value) => { securityStored = structuredClone(value); return structuredClone(value); }
});
await secured.initialize();
const unsafe = await secured.getState();
unsafe.profiles.secure.routeId = "__direct__";
unsafe.profiles.secure.killSwitch = false;
unsafe.global.integration.enabled = true;
unsafe.global.integration.trustedExtensionIds = ["trusted@example.com"];
unsafe.routes.proxy = { type: "socks", host: "review.example", port: 1080 };
await assert.rejects(secured.setState(unsafe, { requireMetadata: true }),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED"
    && error.delta.some((entry) => entry.kind === "persona-direct-assigned")
    && error.delta.some((entry) => entry.kind === "trusted-extension-added"));
assert.equal(secured.getRevision(), 0);
assert.equal(securityStored.profiles.secure.routeId, "__block__");

const preview = await secured.previewState(unsafe);
assert.equal(preview.revision, 0);
assert.equal(preview.bootId, secured.getBootId());
assert.deepEqual(preview.delta.find((entry) => entry.kind === "proxy-destination-added").after,
  { scheme: "socks", host: "review.example", port: 1080 });
const changedProposal = structuredClone(unsafe);
changedProposal.routes.proxy.host = "not-reviewed.example";
await assert.rejects(secured.setState(changedProposal, { authorizationId: preview.authorizationId }),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED");
await assert.rejects(secured.commitPreview(preview.previewId),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED");
await assert.rejects(secured.authorizePreview(preview.previewId, []),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED");
const { authorizationId } = await secured.authorizePreview(preview.previewId, preview.delta);
await assert.rejects(secured.setState(changedProposal, { authorizationId }),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED");
const applied = await secured.commitPreview(authorizationId);
assert.equal(applied.revision, 1);
assert.equal(applied.state.profiles.secure.routeId, "__direct__");
assert.equal(applied.state.routes.proxy.host, "review.example");
await assert.rejects(secured.commitPreview(authorizationId),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED");

let dnsStored = {
  global: { unmanagedPolicy: "block", strictProxyVerification: true },
  profiles: { persona: { containerId: "persona", managed: true, routeId: "socks-route", killSwitch: true, blockLocalNetwork: true } },
  routes: { "socks-route": { id: "socks-route", type: "socks", host: "proxy.example", port: 1080, proxyDNS: true, enabled: true } },
  scripts: {}, workflows: {}
};
const dnsSecured = mod.createStateManager({
  load: async () => structuredClone(dnsStored),
  save: async (value) => { dnsStored = structuredClone(value); return structuredClone(value); }
});
await dnsSecured.initialize();
const dnsDowngrade = await dnsSecured.getState();
dnsDowngrade.routes["socks-route"].proxyDNS = false;
await assert.rejects(dnsSecured.setState(dnsDowngrade, { requireMetadata: true }),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED"
    && error.delta.some((entry) => entry.kind === "privacy-control-weakened"
      && entry.path === 'routes["socks-route"].proxyDNS'
      && entry.before === true && entry.after === false));
assert.equal(dnsStored.routes["socks-route"].proxyDNS, true, "unapproved SOCKS DNS downgrade must not reach persisted state");
assert.equal(dnsSecured.getRevision(), 0, "rejected SOCKS DNS downgrade must not advance state revision");
const dnsPreview = await dnsSecured.previewState(dnsDowngrade);
assert.deepEqual(dnsPreview.delta, [{
  kind: "privacy-control-weakened",
  path: 'routes["socks-route"].proxyDNS',
  before: true,
  after: false
}], "the preview must disclose the exact SOCKS DNS privacy downgrade");
await assert.rejects(dnsSecured.commitPreview(dnsPreview.previewId),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED");
assert.equal(dnsStored.routes["socks-route"].proxyDNS, true, "an unapproved preview must not apply the DNS downgrade");

const staleState = await secured.getState();
staleState.global.strictProxyVerification = false;
const stalePreview = await secured.previewState(staleState);
await secured.mutate((draft) => { draft.global.profileNamePrefix = "Changed elsewhere"; });
await assert.rejects(secured.authorizePreview(stalePreview.previewId, stalePreview.delta),
  (error) => error.code === mod.STATE_CONFLICT);
assert.equal((await secured.getState()).global.strictProxyVerification, true);

await secured.mutate((draft) => { draft.profiles.other = { managed: true, routeId: "__block__" }; });
await assert.rejects(secured.mutate((draft) => { draft.profiles.other.routeId = "__direct__"; }, { granular: true }),
  (error) => error.code === "SECURITY_AUTHORIZATION_REQUIRED");
await secured.mutate((draft) => { draft.profiles.other.routeId = "__direct__"; }, { granular: true, allowDirect: true });

const externalSecurity = await secured.getState();
externalSecurity.global.integration.allowDestructive = true;
securityStored = structuredClone(externalSecurity);
const rejectedStorage = await secured.acceptStorageState(externalSecurity);
assert.equal(rejectedStorage.accepted, false);
assert.equal(securityStored.global.integration.allowDestructive, false);
assert.equal(secured.getRevision(), 4);

console.log("state manager tests passed");
