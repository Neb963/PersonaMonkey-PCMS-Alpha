import assert from "node:assert/strict";

const mod = await import(`../lib/mullvad-runtime.js?test=${Date.now()}`);
let now = 1000;
let prepareCalls = 0;
let stopCalls = 0;
let statusCalls = 0;
let bridgeVersion = "0.3.0";
const prepareTokens = [];
const releasedRoutes = [];
let rejectPrepare = false;
const idleStorageState = {};
const idleStorage = {
  async get(key) { return { [key]: idleStorageState[key] }; },
  async set(values) { Object.assign(idleStorageState, values); },
  async remove(key) { delete idleStorageState[key]; }
};
let state = {
  global: { mullvadNative: { enabled: true, autoStart: true, autoStopMinutes: 1 } },
  profiles: {}, routes: {}
};
const operations = {
  async prepareExit(route, _start, token) {
    prepareCalls += 1;
    prepareTokens.push(token);
    if (rejectPrepare) throw new Error("native host disconnected");
    await new Promise((resolve) => setTimeout(resolve, 2));
    return { local_host: "127.0.0.1", local_port: 5500, selected_entry: "pl-waw" };
  },
  async getStatus() { statusCalls += 1; return { installed: true, ready: false, error: null, version: bridgeVersion }; },
  async stopTunnel() { stopCalls += 1; return { ok: true }; },
  async releaseExit(routeId) { releasedRoutes.push(routeId); return { ok: true }; }
};
const runtime = mod.createMullvadRuntime({
  getState: async () => state,
  browserApi: {
    tabs: { async query() { return []; } },
    storage: { local: idleStorage }
  },
  operations,
  now: () => now
});
const route = { id: "mv", provider: "mullvad", host: "10.0.0.1", port: 1080 };
const [a, b] = await Promise.all([runtime.resolve(route), runtime.resolve(route)]);
assert.equal(prepareCalls, 1, "concurrent route preparation should be deduplicated");
assert.equal(a.port, 5500);
assert.equal(b.port, 5500);
assert.equal(a.username, "persona");
assert.match(a.password, /^[0-9a-f]{64}$/);
assert.equal(a.password, b.password, "a prepared forwarder keeps one credential for its lifetime");
assert.equal(a._relayHost, "10.0.0.1");
assert.equal(runtime.getStatus().ready, true);
assert.equal(JSON.stringify(runtime.getStatus()).includes(a.password), false, "the forwarder credential must not enter status");
await runtime.resolve(route);
assert.equal(prepareCalls, 1, "fresh runtime route should be cached");

now += 9_000;
const refreshed = await runtime.resolve(route);
assert.equal(refreshed.password, a.password, "status refreshes must preserve the credential for an active forwarder");
assert.equal(prepareTokens.at(-1), a.password);

runtime.clear();
rejectPrepare = true;
const failed = await runtime.resolve(route);
assert.equal(failed, null);
assert.equal(runtime.getStatus().ready, false);
assert.equal(runtime.getStatus().installed, false);
assert.deepEqual(releasedRoutes, ["mv"], "failed preparation should release a possibly orphaned forwarder");
rejectPrepare = false;
const recovered = await runtime.resolve(route);
assert.equal(recovered.port, 5500, "failed preparation must not poison future attempts");
assert.notEqual(recovered.password, a.password, "clearing a route must discard its old credential");

const recoveredToken = recovered.password;
now += 60 * 60 * 1000 + 1;
const rotated = await runtime.resolve(route);
assert.notEqual(rotated.password, recoveredToken, "a forwarder token must rotate after its one-hour lease");
assert.equal(prepareTokens.at(-1), rotated.password, "the replacement token must be installed natively");

runtime.clear();
now += 61_000;
const statusCallsBeforeStop = statusCalls;
assert.equal(await runtime.maybeStopIdle(), true);
assert.equal(stopCalls, 1);
assert.equal(statusCalls, statusCallsBeforeStop + 1, "idle-stop refreshes the current bridge status");

const wakeIdleStorageState = {};
const wakeIdleStorage = {
  async get(key) { return { [key]: wakeIdleStorageState[key] }; },
  async set(values) { Object.assign(wakeIdleStorageState, values); },
  async remove(key) { delete wakeIdleStorageState[key]; }
};
let wakeStops = 0;
const wakeOperations = {
  async prepareExit() { return { local_host: "127.0.0.1", local_port: 5600 }; },
  async getStatus() { return { installed: true, ready: true, version: "0.3.0" }; },
  async stopTunnel() { wakeStops += 1; return { ok: true }; }
};
const wakeBrowserApi = {
  tabs: { async query() { return []; } },
  storage: { local: wakeIdleStorage }
};
const wakeRuntimeA = mod.createMullvadRuntime({
  getState: async () => state,
  browserApi: wakeBrowserApi,
  operations: wakeOperations,
  now: () => now
});
assert.equal(await wakeRuntimeA.maybeStopIdle(), false, "first idle observation records a persistent idle start");
assert.equal(typeof wakeIdleStorageState.personaMullvadIdleSince, "number");
now += 61_000;
const wakeRuntimeB = mod.createMullvadRuntime({
  getState: async () => state,
  browserApi: wakeBrowserApi,
  operations: wakeOperations,
  now: () => now
});
assert.equal(await wakeRuntimeB.maybeStopIdle(), true, "idle deadline must survive background runtime recreation");
assert.equal(wakeStops, 1);
assert.equal(wakeIdleStorageState.personaMullvadIdleSince, undefined, "successful idle stop clears the persisted idle marker");

state.profiles.p1 = { managed: true, routeId: "mv" };
state.routes.mv = route;
const activeRuntime = mod.createMullvadRuntime({
  getState: async () => state,
  browserApi: { tabs: { async query() { return [{ cookieStoreId: "p1" }]; } } },
  operations,
  now: () => now
});
now += 61_000;
assert.equal(await activeRuntime.maybeStopIdle(), false, "active Mullvad persona tab must prevent idle shutdown");

let finishInFlight;
let markStarted;
const inFlightStarted = new Promise((resolve) => { markStarted = resolve; });
const raceReleased = [];
let racePrepareCount = 0;
const raceRuntime = mod.createMullvadRuntime({
  getState: async () => state,
  browserApi: { tabs: { async query() { return []; } } },
  operations: {
    prepareExit() {
      racePrepareCount += 1;
      if (racePrepareCount === 1) {
        markStarted();
        return new Promise((resolve) => { finishInFlight = resolve; });
      }
      return Promise.resolve({ local_host: "127.0.0.1", local_port: 5501 });
    },
    async getStatus() { return { installed: true, ready: false, version: "0.3.0" }; },
    async stopTunnel() { return { ok: true }; },
    async releaseExit(routeId) { raceReleased.push(routeId); return { ok: true }; }
  },
  now: () => now
});
const staleResolution = raceRuntime.resolve(route);
await inFlightStarted;
raceRuntime.clear();
finishInFlight({ local_host: "127.0.0.1", local_port: 5500 });
assert.equal(await staleResolution, null, "a prepare reply arriving after clear must not restore stale proxy info");
assert.deepEqual(raceReleased, ["mv"], "the late native forwarder must be released after a stop/restart race");
const postClearRoute = await raceRuntime.resolve(route);
assert.equal(postClearRoute.port, 5501, "new route preparation remains available after stale completion");

let retiredPrepareCalls = 0;
const retiredTokens = [];
const retiredReleased = [];
const retiredRuntime = mod.createMullvadRuntime({
  getState: async () => state,
  browserApi: { tabs: { async query() { return []; } } },
  operations: {
    async prepareExit(_route, _start, token) {
      retiredPrepareCalls += 1;
      retiredTokens.push(token);
      if (retiredPrepareCalls === 2) throw new Error("forwarder token has expired");
      return { local_host: "127.0.0.1", local_port: 5503 };
    },
    async getStatus() { return { installed: true, ready: true, version: "0.3.0" }; },
    async stopTunnel() { return { ok: true }; },
    async releaseExit(routeId) { retiredReleased.push(routeId); return { ok: true }; }
  },
  now: () => now
});
const retiredInitial = await retiredRuntime.resolve(route);
now += 9_000;
const retiredRecovered = await retiredRuntime.resolve(route);
assert.equal(retiredPrepareCalls, 3, "an explicitly retired cached token should be retried exactly once");
assert.equal(retiredTokens[1], retiredInitial.password, "the stale locally cached credential is what the bridge rejects");
assert.notEqual(retiredTokens[2], retiredInitial.password, "retry must use fresh entropy");
assert.equal(retiredRecovered.password, retiredTokens[2]);
assert.deepEqual(retiredReleased, [], "recoverable retired-token races must not tear down the active forwarder");

let oldBridgeVersion = "0.2.0";
let oldBridgePrepareCalls = 0;
let oldBridgeReleaseCalls = 0;
const oldBridgeRuntime = mod.createMullvadRuntime({
  getState: async () => state,
  browserApi: { tabs: { async query() { return []; } } },
  operations: {
    async prepareExit() {
      oldBridgePrepareCalls += 1;
      return { local_host: "127.0.0.1", local_port: 5502 };
    },
    async getStatus() { return { installed: true, ready: true, version: oldBridgeVersion }; },
    async stopTunnel() { return { ok: true }; },
    async releaseExit() { oldBridgeReleaseCalls += 1; return { ok: true }; }
  },
  now: () => now
});
assert.equal(await oldBridgeRuntime.resolve(route), null, "an outdated bridge cannot prepare authenticated exits");
assert.equal(oldBridgePrepareCalls, 0, "do not send prepare_exit to an incompatible native host");
assert.equal(oldBridgeReleaseCalls, 0, "preflight rejection must not release another profile's existing exit");
assert.equal(oldBridgeRuntime.getStatus().ready, false, "an old bridge must not be reported ready");
assert.equal(oldBridgeRuntime.getStatus().compatible, false);
assert.equal(oldBridgeRuntime.getStatus().minimum_supported_version, "0.3.0");
assert.match(oldBridgeRuntime.getStatus().error, /0\.2\.0.*0\.3\.0/);

oldBridgeVersion = "0.3.0";
assert.equal((await oldBridgeRuntime.resolve(route)).port, 5502, "a refreshed compatible bridge can prepare the route");
assert.equal(oldBridgePrepareCalls, 1);

assert.equal(mod.isNativeBridgeVersionSupported("0.3.0"), true);
assert.equal(mod.isNativeBridgeVersionSupported("0.4.0"), true);
assert.equal(mod.isNativeBridgeVersionSupported("1.0.0"), true);
assert.equal(mod.isNativeBridgeVersionSupported("0.2.99"), false);
assert.equal(mod.isNativeBridgeVersionSupported("0.3.0-rc.1"), false);
assert.equal(mod.isNativeBridgeVersionSupported("unknown"), false);

console.log("Mullvad runtime tests passed");
