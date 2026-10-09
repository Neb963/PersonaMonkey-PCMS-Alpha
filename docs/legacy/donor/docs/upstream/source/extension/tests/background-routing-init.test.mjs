import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BLACKHOLE_PROXY } from "../lib/constants.js";
import { RECOVERY_CONSENT_KEY, RECOVERY_LOCAL_CONSENT_KEY } from "../lib/recovery-sync.js";

const testFile = fileURLToPath(import.meta.url);
const childIndex = process.argv.indexOf("--case");

function makeEvent(name, order) {
  const callbacks = new Set();
  const event = {
    addCalls: 0,
    addListener(callback) {
      event.addCalls += 1;
      callbacks.add(callback);
      order.push(`listener:${name}`);
    },
    removeListener(callback) { callbacks.delete(callback); },
    hasListener(callback) { return callbacks.has(callback); },
    first() { return callbacks.values().next().value; },
    async emit(value) {
      return Promise.all([...callbacks].map((callback) => callback(value)));
    }
  };
  return event;
}

function makeState() {
  const profile = (containerId, routeId) => ({
    containerId,
    managed: true,
    name: containerId,
    routeId,
    killSwitch: true,
    blockLocalNetwork: false,
    domainMode: "any",
    allowedDomains: [],
    blockedDomains: [],
    scriptIds: [],
    owned: true,
    status: "permanent"
  });
  return {
    schemaVersion: 3,
    global: {
      unmanagedPolicy: "block",
      strictProxyVerification: true,
      enforcePrivacyControls: false,
      disableNetworkPrediction: false,
      webRTCMode: "proxy_only",
      autoReloadOnRouteChange: true
    },
    profiles: {
      "firefox-container-proxy": profile("firefox-container-proxy", "route-proxy"),
      "firefox-container-direct": profile("firefox-container-direct", "__direct__"),
      "firefox-container-disabled": profile("firefox-container-disabled", "route-disabled"),
      "firefox-container-missing": profile("firefox-container-missing", "route-missing")
    },
    routes: {
      "route-proxy": {
        id: "route-proxy", name: "Test proxy", provider: "custom", type: "http",
        host: "proxy.example.test", port: 3128, enabled: true
      },
      "route-disabled": {
        id: "route-disabled", name: "Disabled proxy", provider: "custom", type: "http",
        host: "disabled.example.test", port: 3128, enabled: false
      }
    },
    scripts: {},
    workflows: {},
    wireguardImports: []
  };
}

function makeBrowser({ scenario }) {
  const order = [];
  const events = {};
  const event = (name) => (events[name] ||= makeEvent(name, order));
  const localStateInitiallyMissing = ["quarantine-missing", "quarantine-corrupt", "recovery-write-once"].includes(scenario);
  const data = localStateInitiallyMissing ? {} : { state: scenario === "quarantine-malformed" ? {} : makeState() };
  const syncData = {};
  if (scenario === "quarantine-corrupt") {
    syncData[RECOVERY_CONSENT_KEY] = { version: 1, enabled: true, epoch: "corrupt-fixture-epoch", updatedAt: new Date().toISOString() };
    syncData.personaRecoveryMetaV1 = {
      version: 1, available: true, chunks: 1, generation: "corrupt-fixture",
      encoding: "plain", digest: "not-the-content-digest", consentEpoch: "corrupt-fixture-epoch"
    };
    syncData["personaRecoveryChunkV1:corrupt-fixture:00"] = "corrupt recovery fixture";
  }
  if (scenario === "recovery-write-once") {
    syncData[RECOVERY_CONSENT_KEY] = { version: 1, enabled: true, epoch: "write-once-epoch", updatedAt: new Date().toISOString() };
    data[RECOVERY_LOCAL_CONSENT_KEY] = { enabled: true, epoch: "write-once-epoch", updatedAt: new Date().toISOString() };
  }
  const contextualIdentityState = new Map(
    Object.keys(makeState().profiles).map((cookieStoreId) => [cookieStoreId, {
      cookieStoreId, name: cookieStoreId, color: "blue", icon: "fingerprint"
    }])
  );
  let getCalls = 0;
  let setCalls = 0;
  let failStateSaveOnce = scenario === "one-shot";
  let failEveryStateSave = scenario === "persistent";
  let failJobsSaveOnce = scenario === "post-save";
  let failFirstGetOnce = scenario === "read-once";
  let failRecoveryStateWriteOnce = scenario === "recovery-write-once";
  let recoveryStateWriteCalls = 0;
  let releaseFirstGet;
  let releaseFirstSet;
  let signalFirstGet;
  let signalFirstSet;
  let releaseJobsSet;
  let signalJobsSet;
  let signalRecoveryStateWrite;
  let firstGetBlocked = new Promise((resolve) => { releaseFirstGet = resolve; });
  let firstSetBlocked = new Promise((resolve) => { releaseFirstSet = resolve; });
  const firstGetEntered = new Promise((resolve) => { signalFirstGet = resolve; });
  const firstSetEntered = new Promise((resolve) => { signalFirstSet = resolve; });
  const jobsSetEntered = new Promise((resolve) => { signalJobsSet = resolve; });
  const recoveryStateWriteEntered = new Promise((resolve) => { signalRecoveryStateWrite = resolve; });
  const jobsSetBlocked = new Promise((resolve) => { releaseJobsSet = resolve; });
  let firstGetPending = true;
  let firstSetPending = true;
  const secretFailure = new Error("storage token=do-not-log-this-secret");

  function readValue(key) {
    if (Array.isArray(key)) return Object.fromEntries(key.map((name) => [name, data[name]]));
    if (typeof key === "string") return { [key]: data[key] };
    if (key && typeof key === "object") {
      return Object.fromEntries(Object.entries(key).map(([name, fallback]) => [name, data[name] ?? fallback]));
    }
    return structuredClone(data);
  }

  const networkSetting = (value) => ({
    async get() { return { value, levelOfControl: "controllable_by_this_extension" }; },
    async set() { return true; },
    onChange: event(`privacy.${Math.random()}`)
  });
  const browserApi = {
    runtime: {
      id: "persona-route-manager@local",
      getURL: () => "moz-extension://persona-route-manager/",
      getManifest: () => ({ version: "1.0.0" }),
      connectNative() { throw new Error("Native host should not be needed by this fixture"); },
      onMessage: event("runtime.onMessage"),
      onConnect: event("runtime.onConnect"),
      onMessageExternal: event("runtime.onMessageExternal"),
      onConnectExternal: event("runtime.onConnectExternal"),
      onInstalled: event("runtime.onInstalled")
    },
    storage: {
      local: {
        async get(key) {
          getCalls += 1;
          order.push(`storage.get:${getCalls}`);
          if (firstGetPending) {
            firstGetPending = false;
            signalFirstGet();
            await firstGetBlocked;
          }
          if (failFirstGetOnce) {
            failFirstGetOnce = false;
            throw secretFailure;
          }
          return readValue(key);
        },
        async set(values) {
          setCalls += 1;
          if (Object.hasOwn(values, "state")) {
            order.push(`storage.set:state:${setCalls}`);
            if (values.personaRecoveryRestore?.restoredAt) {
              recoveryStateWriteCalls += 1;
              signalRecoveryStateWrite();
              if (failRecoveryStateWriteOnce) {
                failRecoveryStateWriteOnce = false;
                throw secretFailure;
              }
            }
            if (firstSetPending && !Object.hasOwn(values, "personaRecoveryRestore")) {
              firstSetPending = false;
              signalFirstSet();
              await firstSetBlocked;
            }
            if (failEveryStateSave || failStateSaveOnce) {
              failStateSaveOnce = false;
              throw secretFailure;
            }
          }
          if (Object.hasOwn(values, "automationJobs") && failJobsSaveOnce) {
            signalJobsSet();
            await jobsSetBlocked;
            failJobsSaveOnce = false;
            throw secretFailure;
          }
          Object.assign(data, structuredClone(values));
        }
      },
      onChanged: event("storage.onChanged"),
      sync: {
        async get(key) {
          if (Array.isArray(key)) return Object.fromEntries(key.map((name) => [name, syncData[name]]));
          if (typeof key === "string") return { [key]: syncData[key] };
          return structuredClone(syncData);
        },
        async set(values) { Object.assign(syncData, structuredClone(values)); },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete syncData[key];
        }
      }
    },
    proxy: {
      onRequest: event("proxy.onRequest"),
      onError: event("proxy.onError"),
      settings: {
        async get() { return { levelOfControl: "controllable_by_this_extension" }; },
        onChange: event("proxy.settings.onChange")
      }
    },
    webRequest: { onBeforeRequest: event("webRequest.onBeforeRequest") },
    webNavigation: {
      onCommitted: event("webNavigation.onCommitted"),
      onDOMContentLoaded: event("webNavigation.onDOMContentLoaded"),
      onCompleted: event("webNavigation.onCompleted")
    },
    privacy: { network: {
      networkPredictionEnabled: networkSetting(false),
      peerConnectionEnabled: networkSetting(false),
      webRTCIPHandlingPolicy: networkSetting("proxy_only")
    } },
    contextualIdentities: {
      async query() { return [...contextualIdentityState.values()].map((entry) => structuredClone(entry)); },
      async get(id) {
        const value = contextualIdentityState.get(id);
        if (!value) throw new Error("Contextual identity not found");
        return structuredClone(value);
      },
      async create(details) {
        const created = { cookieStoreId: `firefox-container-created-${contextualIdentityState.size + 1}`, ...structuredClone(details) };
        contextualIdentityState.set(created.cookieStoreId, created);
        return structuredClone(created);
      },
      async update() { throw new Error("No contextual identity needed"); },
      async remove() { throw new Error("No contextual identity needed"); },
      onRemoved: event("contextualIdentities.onRemoved"),
      onUpdated: event("contextualIdentities.onUpdated")
    },
    tabs: {
      async query() { return []; },
      async get() { throw new Error("No tabs needed"); },
      async create() { throw new Error("No tabs needed"); },
      async update() { throw new Error("No tabs needed"); },
      async remove() {},
      async reload() {},
      async sendMessage() { throw new Error("No tabs needed"); },
      onRemoved: event("tabs.onRemoved"),
      onActivated: event("tabs.onActivated"),
      onUpdated: event("tabs.onUpdated")
    },
    cookies: { async getAll() { return []; }, async remove() {}, async set() {} },
    browsingData: { async remove() {} },
    permissions: { async contains() { return false; } },
    scripting: { async executeScript() { throw new Error("No scripts needed"); } },
    alarms: { create() {}, onAlarm: event("alarms.onAlarm") }
  };
  globalThis.browser = browserApi;

  return {
    browser: browserApi,
    events,
    order,
    data,
    syncData,
    syncStorage: browserApi.storage.sync,
    firstGetEntered,
    firstSetEntered,
    jobsSetEntered,
    recoveryStateWriteEntered,
    getCalls: () => getCalls,
    setCalls: () => setCalls,
    recoveryStateWriteCalls: () => recoveryStateWriteCalls,
    contextualIdentityCount: () => contextualIdentityState.size,
    allowFirstGet: () => releaseFirstGet(),
    allowFirstSet: () => releaseFirstSet(),
    allowJobsSet: () => releaseJobsSet(),
    allowStateSave: () => { failStateSaveOnce = false; failEveryStateSave = false; },
    setPersistentFailure: (value) => { failEveryStateSave = value; },
    setJobsFailure: (value) => { failJobsSaveOnce = value; }
  };
}

async function waitFor(promise, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 3000); })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function runScenario(scenario) {
  const harness = makeBrowser({ scenario });
  if (scenario === "recovery-write-once") {
    const { writeRecoverySnapshot } = await import("../lib/recovery-sync.js");
    const recoveredState = makeState();
    recoveredState.global.unmanagedPolicy = "direct";
    const result = await writeRecoverySnapshot({
      syncStorage: harness.syncStorage,
      localStorage: {
        async get(key) { return { [key]: structuredClone(harness.data[key]) }; },
        async set(values) { Object.assign(harness.data, structuredClone(values)); },
        async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete harness.data[key]; }
      },
      state: recoveredState,
      containers: await harness.browser.contextualIdentities.query({}),
      appVersion: "test"
    });
    assert.equal(result.available, true, "the recovery fixture is a valid persisted snapshot");
  }
  const consoleErrors = [];
  const originalConsoleWarn = console.warn;
  const consoleWarnings = [];
  const originalConsoleError = console.error;
  console.warn = (...args) => { consoleWarnings.push(args.map(String).join(" ")); };
  console.error = (...args) => { consoleErrors.push(args.map(String).join(" ")); };
  try {
    // Importing the actual background entry must register routing guards before
    // recovery's first storage read is allowed to finish.
    const bootstrap = import(`../lib/recovery-bootstrap.js?routing-init-${scenario}`);
    await waitFor(harness.firstGetEntered, "first recovery storage read");
    assert.equal(harness.events["proxy.onRequest"]?.addCalls, 1, "proxy guard registers before recovery awaits storage");
    assert.equal(harness.events["webRequest.onBeforeRequest"]?.addCalls, 1, "webRequest guard registers before recovery awaits storage");
    const proxyRegistration = harness.order.indexOf("listener:proxy.onRequest");
    const webRequestRegistration = harness.order.indexOf("listener:webRequest.onBeforeRequest");
    const firstRead = harness.order.indexOf("storage.get:1");
    assert.ok(proxyRegistration >= 0 && proxyRegistration < firstRead);
    assert.ok(webRequestRegistration >= 0 && webRequestRegistration < firstRead);

    if (scenario === "startup") {
      const early = {
        url: "https://alice:password@example.test/?token=early-secret",
        documentUrl: "moz-extension://persona-route-manager/options/options.html",
        cookieStoreId: "firefox-container-direct",
        type: "main_frame",
        tabId: 40
      };
      assert.deepEqual(
        await harness.events["proxy.onRequest"].first()(early),
        [{ ...BLACKHOLE_PROXY }, null],
        "even an extension-origin or formerly Direct request blocks before recovery completes"
      );
      assert.deepEqual(
        await harness.events["webRequest.onBeforeRequest"].first()({ ...early, proxyInfo: { type: "direct" } }),
        { cancel: true },
        "startup cancellation does not depend on port 9 refusing connections"
      );
    }

    if (scenario === "read-once" || scenario === "recovery-write-once") {
      harness.allowFirstGet();
      await waitFor(bootstrap, "recovery bootstrap module import");
      const retryRequest = {
        url: "https://protected.example.test/retry", type: "main_frame",
        cookieStoreId: "firefox-container-proxy", tabId: 43
      };
      if (scenario === "read-once") {
        const firstBlocked = await harness.events["proxy.onRequest"].first()(retryRequest);
        assert.deepEqual(firstBlocked, [{ ...BLACKHOLE_PROXY }, null], "a failed first storage read remains blocked");
      } else {
        await waitFor(harness.recoveryStateWriteEntered, "first recovery state write");
        assert.equal(harness.recoveryStateWriteCalls(), 1);
        const firstBlocked = await harness.events["proxy.onRequest"].first()(retryRequest);
        assert.deepEqual(firstBlocked, [{ ...BLACKHOLE_PROXY }, null], "a failed recovery state write remains blocked");
      }
      // A later guarded request retries bootstrap in the same background
      // context. Keep probing only while the full background has not loaded.
      while (harness.events["runtime.onMessage"].addCalls === 0) {
        const stillBlocked = await harness.events["proxy.onRequest"].first()(retryRequest);
        if (harness.events["runtime.onMessage"].addCalls === 0) {
          assert.deepEqual(stillBlocked, [{ ...BLACKHOLE_PROXY }, null]);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
      }
      await waitFor(harness.firstSetEntered, "state initialization after retrying the failed read");
    } else {
      harness.allowFirstGet();
      await waitFor(bootstrap, "recovery bootstrap module import");
      await waitFor(harness.firstSetEntered, "state initialization write");
    }

    const eventMessages = [];
    harness.events["runtime.onConnect"].emit({
      name: "PCMS_EVENTS",
      sender: { id: "persona-route-manager@local", url: "moz-extension://persona-route-manager/options/options.html" },
      postMessage(message) { eventMessages.push(structuredClone(message)); },
      onDisconnect: { addListener() {} }
    });

    const protectedRequest = {
      url: "https://alice:password@example.test/path?token=request-secret",
      type: "main_frame",
      cookieStoreId: "firefox-container-proxy",
      tabId: 41
    };
    const proxyListener = harness.events["proxy.onRequest"].first();
    const beforeListener = harness.events["webRequest.onBeforeRequest"].first();

    if (scenario === "startup") {
      harness.allowFirstSet();
      const snapshot = await waitFor(
        harness.events["runtime.onMessage"].first()({ type: "GET_SNAPSHOT" }, {
          id: "persona-route-manager@local",
          url: "moz-extension://persona-route-manager/options/options.html"
        }),
        "normal startup after early blocks"
      );
      assert.equal(snapshot.security.ready, true);
      assert.equal(snapshot.security.lastBlock?.reason, "routing-not-ready");
      assert.ok(!JSON.stringify(snapshot.security.lastBlock).includes("early-secret"));
      assert.equal(harness.events["proxy.onRequest"].addCalls, 1);
      assert.equal(harness.events["webRequest.onBeforeRequest"].addCalls, 1);
    } else if (scenario === "read-once") {
      harness.allowFirstSet();
      const recovered = await proxyListener(protectedRequest);
      assert.equal(recovered[0].host, "proxy.example.test", "the later guarded request recovers without reload");
      assert.ok(harness.getCalls() >= 3, "the failed recovery read and retried bootstrap both reach storage");
      assert.equal(harness.events["storage.onChanged"].addCalls, 2, "recovery and background each register one storage listener across retries");
      assert.equal(harness.events["proxy.onRequest"].addCalls, 1);
      assert.equal(harness.events["webRequest.onBeforeRequest"].addCalls, 1);
      assert.ok(!consoleWarnings.join("\n").includes("do-not-log-this-secret"));
    } else if (["quarantine-missing", "quarantine-corrupt", "quarantine-malformed"].includes(scenario)) {
      assert.ok(harness.contextualIdentityCount() > 0, "the fixture retains a pre-existing Firefox container");
      assert.equal(harness.data.state?.global?.unmanagedPolicy, "block", "unknown existing containers are quarantined");
      assert.equal(harness.data.personaRecoveryRestore?.quarantined, true);
      harness.allowFirstSet();
      const orphanRequest = {
        url: "https://formerly-managed.example.test/", type: "main_frame",
        cookieStoreId: "firefox-container-proxy", tabId: 44
      };
      assert.deepEqual(await proxyListener(orphanRequest), [{ ...BLACKHOLE_PROXY, connectionIsolationKey: "firefox-container-proxy" }, null]);
      assert.deepEqual(await beforeListener({ ...orphanRequest, proxyInfo: { type: "direct" } }), { cancel: true });
      assert.equal(harness.events["proxy.onRequest"].addCalls, 1);
      assert.equal(harness.events["webRequest.onBeforeRequest"].addCalls, 1);
      assert.equal(harness.events["storage.onChanged"].addCalls, 2, "quarantine bootstrap and background each register once");
      if (scenario === "quarantine-corrupt") {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        assert.equal(harness.syncData.personaRecoveryMetaV1.digest, "not-the-content-digest",
          "quarantine must not overwrite the existing sync recovery evidence");
      }
    } else if (scenario === "recovery-write-once") {
      assert.ok(harness.recoveryStateWriteCalls() >= 2, "a transient recovery state write is retried");
      assert.ok(harness.data.state?.profiles?.["firefox-container-proxy"], "the saved persona state is restored instead of replacing it with defaults");
      assert.equal(harness.data.state.global.unmanagedPolicy, "block", "automatic recovery quarantines unmanaged traffic");
      assert.equal(harness.data.state.profiles["firefox-container-proxy"].routeId, "__block__");
      harness.allowFirstSet();
      const recovered = await proxyListener(protectedRequest);
      assert.deepEqual(recovered, [{ ...BLACKHOLE_PROXY, connectionIsolationKey: "firefox-container-proxy" }, null], "recovered routes require review before activation");
      assert.equal(harness.events["proxy.onRequest"].addCalls, 1);
      assert.equal(harness.events["webRequest.onBeforeRequest"].addCalls, 1);
      assert.equal(harness.events["storage.onChanged"].addCalls, 2, "recovery bootstrap and background each register once");
    } else if (scenario === "one-shot" || scenario === "persistent") {
      const firstProxy = proxyListener(protectedRequest);
      const firstBefore = beforeListener({ ...protectedRequest, proxyInfo: { type: "direct" } });
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(harness.setCalls(), 1, "concurrent callers share the in-flight initialization generation");
      harness.allowFirstSet();
      const failedResults = await Promise.all([firstProxy, firstBefore]);
      assert.deepEqual(failedResults[0], [{ ...BLACKHOLE_PROXY }, null]);
      assert.deepEqual(failedResults[1], { cancel: true });
      assert.equal(harness.events["proxy.onRequest"].addCalls, 1, "failure does not duplicate proxy listener");
      assert.equal(harness.events["webRequest.onBeforeRequest"].addCalls, 1, "failure does not duplicate webRequest listener");
      assert.ok(!consoleErrors.join("\n").includes("do-not-log-this-secret"), "initialization logs must not expose thrown storage secrets");
      const diagnostic = JSON.stringify(eventMessages);
      assert.ok(diagnostic.includes("routing.guard.blocked"), "guard failure emits a diagnostic event");
      assert.ok(!diagnostic.includes("do-not-log-this-secret"));
      assert.ok(!diagnostic.includes("request-secret"));
      assert.ok(!diagnostic.includes("alice:password"));
      assert.ok(diagnostic.length < 2000, "diagnostics remain bounded");

      if (scenario === "persistent") {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const writesBefore = harness.setCalls();
          const [proxyResult, beforeResult] = await Promise.all([
            proxyListener(protectedRequest),
            beforeListener({ ...protectedRequest, proxyInfo: { type: "direct" } })
          ]);
          assert.deepEqual(proxyResult, [{ ...BLACKHOLE_PROXY }, null]);
          assert.deepEqual(beforeResult, { cancel: true });
          assert.equal(harness.setCalls(), writesBefore + 1, "each rejected generation can be retried once by concurrent requests");
          assert.equal(harness.events["proxy.onRequest"].addCalls, 1);
          assert.equal(harness.events["webRequest.onBeforeRequest"].addCalls, 1);
        }
        assert.ok(eventMessages.length <= 1, "a burst of guard failures is represented by bounded diagnostics");
        assert.ok(JSON.stringify(eventMessages).length < 2000);
        assert.ok(!JSON.stringify(eventMessages).includes("do-not-log-this-secret"));
        harness.setPersistentFailure(false);
      } else {
        harness.allowStateSave();
      }

      const recovered = await proxyListener(protectedRequest);
      assert.deepEqual(recovered[0], {
        type: "http", host: "proxy.example.test", port: 3128,
        failoverTimeout: 2, connectionIsolationKey: "firefox-container-proxy"
      }, "the next request retries initialization and applies the protected route");
      assert.equal(harness.events["proxy.onRequest"].addCalls, 1);
      assert.equal(harness.events["webRequest.onBeforeRequest"].addCalls, 1);

      // The gate must preserve a persisted explicit Direct assignment, while
      // an unmanaged request follows its separate block policy.
      const directRequest = {
        url: "https://direct.example.test/", type: "main_frame",
        cookieStoreId: "firefox-container-direct", tabId: 42
      };
      assert.deepEqual(await proxyListener(directRequest), { type: "direct" });
      assert.deepEqual(await beforeListener({ ...directRequest, proxyInfo: { type: "direct" } }), {});

      const unmanagedRequest = { ...protectedRequest, cookieStoreId: "firefox-default" };
      assert.deepEqual(await proxyListener(unmanagedRequest), [{ ...BLACKHOLE_PROXY, connectionIsolationKey: "firefox-default" }, null]);
      assert.deepEqual(await beforeListener({ ...unmanagedRequest, proxyInfo: { type: "direct" } }), { cancel: true });

      for (const cookieStoreId of ["firefox-container-disabled", "firefox-container-missing"]) {
        const invalidRouteRequest = { ...protectedRequest, cookieStoreId };
        assert.deepEqual(await proxyListener(invalidRouteRequest), [{ ...BLACKHOLE_PROXY, connectionIsolationKey: cookieStoreId }, null]);
        assert.deepEqual(await beforeListener({ ...invalidRouteRequest, proxyInfo: { type: "direct" } }), { cancel: true });
      }

      assert.deepEqual(
        await beforeListener({ ...protectedRequest, proxyInfo: { type: "direct" } }),
        { cancel: true },
        "strict verification mismatch remains explicitly cancelled independent of the blackhole proxy port"
      );
    } else if (scenario === "post-save") {
      // State storage succeeded; a later orchestrator persistence failure must
      // still make the request fail closed, then permit a fresh attempt.
      harness.allowFirstSet();
      await waitFor(harness.jobsSetEntered, "post-state-save orchestrator write");
      const inFlight = proxyListener(protectedRequest);
      await new Promise((resolve) => setImmediate(resolve));
      harness.allowJobsSet();
      const blocked = await inFlight;
      assert.deepEqual(blocked, [{ ...BLACKHOLE_PROXY }, null]);
      assert.ok(!consoleErrors.join("\n").includes("do-not-log-this-secret"));
      harness.setJobsFailure(false);
      const retried = await proxyListener(protectedRequest);
      assert.equal(retried[0].host, "proxy.example.test");
    }

    console.log(`background routing initialization regression passed: ${scenario}`);
  } finally {
    console.error = originalConsoleError;
    console.warn = originalConsoleWarn;
  }
}

if (childIndex >= 0) {
  await runScenario(process.argv[childIndex + 1]);
} else {
  for (const scenario of [
    "startup", "read-once", "quarantine-missing", "quarantine-corrupt", "quarantine-malformed",
    "recovery-write-once", "one-shot", "persistent", "post-save"
  ]) {
    const result = spawnSync(process.execPath, [testFile, "--case", scenario], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 15000
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    assert.equal(result.status, 0, `scenario ${scenario} failed (status ${result.status})`);
  }
}
