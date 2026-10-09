// Static evaluation installs fail-closed routing listeners before the first
// asynchronous recovery read or dynamic import of the full background.
import { setBootstrapRetry } from "./routing-gate.js";
import { initializeRecoveryConsent, readRecoverySnapshot, restoreRecoveryPayload, writeRecoverySnapshot } from "./recovery-sync.js";
import { makeDefaultState } from "./storage.js";

let recoveryTimer = null;
let recoveryWrite = Promise.resolve();
let bootstrapPromise = null;
let bootstrapped = false;
let recoveryListenerRegistered = false;

async function localState() {
  const stored = await browser.storage.local.get("state");
  const state = stored.state;
  // An object with missing policy/profile collections is not authoritative:
  // normalizing it would silently turn unknown containers into unmanaged Direct.
  if (!state || typeof state !== "object" || Array.isArray(state)
    || !state.global || typeof state.global !== "object" || Array.isArray(state.global)
    || !["direct", "block"].includes(state.global.unmanagedPolicy)
    || !state.profiles || typeof state.profiles !== "object" || Array.isArray(state.profiles)) {
    return null;
  }
  return state;
}

async function saveRecoveryFromLocal() {
  const restoreStatus = await browser.storage.local.get("personaRecoveryRestore");
  const state = await localState();
  if (!state || !browser.storage.sync) return null;
  // Preserve the last sync snapshot after local state loss; the temporary
  // quarantine state is not a replacement for the missing Persona records.
  if (restoreStatus.personaRecoveryRestore?.quarantined && !Object.keys(state.profiles || {}).length) return null;
  let containers = [];
  try { containers = await browser.contextualIdentities.query({}); } catch {}
  return writeRecoverySnapshot({
    state,
    containers,
    appVersion: browser.runtime.getManifest().version
  });
}

function scheduleRecoveryWrite(delay = 5000) {
  clearTimeout(recoveryTimer);
  recoveryTimer = setTimeout(() => {
    recoveryWrite = recoveryWrite.then(saveRecoveryFromLocal, saveRecoveryFromLocal).catch(() => {
      console.warn("Unable to update PersonaMonkey sync recovery snapshot");
    });
  }, delay);
}

async function restoreBeforeStartup() {
  if (await localState()) return false;
  let failure = null;
  if (browser.storage.sync) {
    let recovery;
    try {
      recovery = await readRecoverySnapshot();
    } catch {
      // A damaged/incomplete snapshot cannot authorize a default Direct state.
      // storage.sync may also be unavailable for temporary Firefox installs.
      failure = "Recovery snapshot could not be restored";
    }
    if (recovery?.available && recovery.payload) {
      const state = await restoreRecoveryPayload(recovery.payload);
      // A failed write must retry rather than booting from default Direct state.
      await browser.storage.local.set({
        state,
        personaRecoveryRestore: {
          restoredAt: new Date().toISOString(),
          snapshotUpdatedAt: recovery.meta?.updatedAt || null,
          sourceAppVersion: recovery.meta?.appVersion || recovery.envelope?.appVersion || null
        }
      });
      return true;
    }
  }

  // Without stored authority, existing Firefox containers might include
  // formerly managed Personas. Quarantine all unknown containers rather than
  // letting the default unmanaged Direct policy turn a storage loss into egress.
  const containers = await browser.contextualIdentities.query({});
  if (!containers.length) return false;
  const blockedState = makeDefaultState();
  blockedState.global.unmanagedPolicy = "block";
  await browser.storage.local.set({
    state: blockedState,
    personaRecoveryRestore: {
      restoredAt: null,
      failedAt: new Date().toISOString(),
      error: failure || "No recoverable Persona state was found",
      quarantined: true
    }
  });
  return false;
}

function bootstrap() {
  if (bootstrapped) return Promise.resolve();
  if (bootstrapPromise) return bootstrapPromise;
  const attempt = (async () => {
    await initializeRecoveryConsent();
    await restoreBeforeStartup();
    if (!recoveryListenerRegistered) {
      browser.storage.onChanged.addListener((changes, area) => {
        if (area === "local" && changes.state?.newValue) scheduleRecoveryWrite();
      });
      recoveryListenerRegistered = true;
    }
    await import("../background.js");
    bootstrapped = true;
    scheduleRecoveryWrite(1500);
  })();
  bootstrapPromise = attempt;
  void attempt.catch(() => {
    // A later guarded request retries transient storage/bootstrap failures.
    // Never print the exception; storage failures can contain private data.
    console.warn("PersonaMonkey bootstrap failed; routing remains blocked");
  }).finally(() => {
    if (bootstrapPromise === attempt) bootstrapPromise = null;
  });
  return attempt;
}

setBootstrapRetry(bootstrap);
void bootstrap().catch(() => {});
