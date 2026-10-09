import { REMOTE_OP_ERROR_CODES, remoteOpError } from "./errors.js";
import { REMOTE_OP_STATES, normalizeRemoteOperationDraft } from "./schema.js";

function fail(code) { throw remoteOpError(code); }

function plain(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function normalizeProviders(providers) {
  if (!plain(providers)) throw new TypeError("ProviderGate providers must be a plain object");
  const output = Object.create(null);
  for (const [providerId, provider] of Object.entries(providers)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(providerId) || !plain(provider) || !plain(provider.operations)) {
      throw new TypeError("ProviderGate provider descriptor is invalid");
    }
    const operations = Object.create(null);
    for (const [action, behavior] of Object.entries(provider.operations)) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(action)
          || !plain(behavior)
          || Object.keys(behavior).length !== 2
          || typeof behavior.dispatch !== "function"
          || typeof behavior.reconcile !== "function") {
        throw new TypeError("ProviderGate mutation behavior is invalid");
      }
      operations[action] = Object.freeze({ dispatch: behavior.dispatch, reconcile: behavior.reconcile });
    }
    output[providerId] = Object.freeze({ operations: Object.freeze(operations) });
  }
  return Object.freeze(output);
}

function getBehavior(providers, operation) {
  const provider = Object.hasOwn(providers, operation.providerId) ? providers[operation.providerId] : null;
  if (!provider) fail(REMOTE_OP_ERROR_CODES.PROVIDER_UNKNOWN);
  const behavior = Object.hasOwn(provider.operations, operation.action) ? provider.operations[operation.action] : null;
  if (!behavior) fail(REMOTE_OP_ERROR_CODES.ACTION_UNKNOWN);
  return behavior;
}

function dispatchStatus(outcome) {
  if (!plain(outcome) || Object.keys(outcome).length !== 1 || !["APPLIED", "NOT_APPLIED"].includes(outcome.status)) return null;
  return outcome.status;
}

function reconciliationStatus(outcome) {
  if (!plain(outcome) || Object.keys(outcome).length !== 1 || !["APPLIED", "NOT_APPLIED", "UNKNOWN"].includes(outcome.status)) return null;
  return outcome.status;
}

export function createProviderGate({ remoteOps, recoveryHold, providers } = {}) {
  if (!remoteOps || typeof remoteOps.prepare !== "function" || typeof remoteOps.beginDispatch !== "function") throw new TypeError("ProviderGate requires RemoteOps");
  if (!recoveryHold || typeof recoveryHold.assertMutationAllowed !== "function") throw new TypeError("ProviderGate requires recovery hold");
  const registry = normalizeProviders(providers);

  async function mutate({ operation, dispatchInput } = {}) {
    await recoveryHold.assertMutationAllowed();
    const draft = normalizeRemoteOperationDraft(operation);
    const behavior = getBehavior(registry, draft);
    const prepared = await remoteOps.prepare(draft);

    if ([REMOTE_OP_STATES.UNCERTAIN, REMOTE_OP_STATES.DISPATCHING].includes(prepared.value.state)) fail(REMOTE_OP_ERROR_CODES.RECONCILE_REQUIRED);
    if (prepared.value.state === REMOTE_OP_STATES.SUCCEEDED) return Object.freeze({ operation: prepared, status: "ALREADY_APPLIED" });
    if (![REMOTE_OP_STATES.PREPARED, REMOTE_OP_STATES.RETRYABLE].includes(prepared.value.state)) fail(REMOTE_OP_ERROR_CODES.INVALID_TRANSITION);

    const dispatching = await remoteOps.beginDispatch(prepared.value.operationId, { expectedRevision: prepared.revision });
    let outcome;
    try {
      outcome = await behavior.dispatch(Object.freeze({ operation: dispatching.value, dispatchInput }));
    } catch {
      try { await remoteOps.markUncertain(dispatching.value.operationId, { expectedRevision: dispatching.revision }); } catch {}
      fail(REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL);
    }
    const status = dispatchStatus(outcome);
    if (!status) {
      try { await remoteOps.markUncertain(dispatching.value.operationId, { expectedRevision: dispatching.revision }); } catch {}
      fail(REMOTE_OP_ERROR_CODES.PROVIDER_PROTOCOL);
    }
    const settled = status === "APPLIED"
      ? await remoteOps.markSucceeded(dispatching.value.operationId, { expectedRevision: dispatching.revision })
      : await remoteOps.markFailed(dispatching.value.operationId, { expectedRevision: dispatching.revision });
    return Object.freeze({ operation: settled, status });
  }

  async function reconcile(operationId) {
    const current = await remoteOps.get(operationId);
    if (!current) fail(REMOTE_OP_ERROR_CODES.NOT_FOUND);
    const behavior = getBehavior(registry, current.value);
    if (current.value.state !== REMOTE_OP_STATES.UNCERTAIN) fail(REMOTE_OP_ERROR_CODES.INVALID_TRANSITION);
    let outcome;
    try { outcome = await behavior.reconcile(Object.freeze({ operation: current.value })); }
    catch { return remoteOps.reconcile(operationId, { expectedRevision: current.revision, outcome: "UNKNOWN" }); }
    const status = reconciliationStatus(outcome);
    if (!status) return remoteOps.reconcile(operationId, { expectedRevision: current.revision, outcome: "UNKNOWN" });
    return remoteOps.reconcile(operationId, { expectedRevision: current.revision, outcome: status });
  }

  return Object.freeze({ mutate, reconcile });
}
