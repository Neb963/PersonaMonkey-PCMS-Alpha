import {
  PERCHANCE_DRIVER_CONTRACT_VERSION_V2,
  PERCHANCE_GENERATOR_UPDATE_ACTION,
  PERCHANCE_PROVIDER_ID,
  generatorPayloadHash,
  generatorReleaseFingerprint,
  isSha256Hex,
  normalizeDriver,
  normalizeGeneratorReleaseInput,
  normalizeGeneratorUpdateInput,
  normalizePerchanceCompatibility,
  normalizePerchanceOperation,
  normalizePerchanceOutcome,
  sha256Hex,
  thumbnailHash
} from "./contract.js";
import { parseGeneratorListing, serializeGeneratorListing } from "./listing.js";
import { PERCHANCE_PROVIDER_ERROR_CODES, perchanceProviderError } from "./errors.js";
import { normalizeProviderObservation } from "./observation.js";

function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function createPerchanceProviderAdapter({ driver } = {}) {
  const transport = normalizeDriver(driver);
  // Set once the provider returns a listing shape PCMS does not understand (04 §F.2).
  let listingUnknownSeen = false;

  async function probeRaw() {
    let raw;
    try { raw = await transport.probe(); }
    catch { throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL); }
    return normalizePerchanceCompatibility(raw);
  }

  async function probeCompatibility() {
    const compatibility = await probeRaw();
    if (compatibility.contractVersion !== PERCHANCE_DRIVER_CONTRACT_VERSION_V2 || !listingUnknownSeen) return compatibility;
    return Object.freeze({ ...compatibility, capabilities: Object.freeze({ ...compatibility.capabilities, listing: false }) });
  }

  async function requireV2(method) {
    const compatibility = await probeCompatibility();
    if (compatibility.contractVersion !== PERCHANCE_DRIVER_CONTRACT_VERSION_V2 || typeof transport[method] !== "function") {
      throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INCOMPATIBLE);
    }
    return compatibility;
  }

  async function guarded(fn) {
    try { return await fn(); }
    catch (error) {
      if (error?.name === "PcmsPerchanceProviderError") throw error;
      throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
    }
  }

  async function compatibleCall(fn) {
    await probeCompatibility();
    return guarded(fn);
  }

  async function dispatchRelease(op, dispatchInput) {
    const input = normalizeGeneratorReleaseInput(dispatchInput);
    if (await generatorPayloadHash(input.code, input.html) !== input.payloadHash) throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT);
    if (input.thumbnail !== null && await thumbnailHash(input.thumbnail) !== input.thumbnailHash) {
      throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT);
    }
    const fingerprint = await generatorReleaseFingerprint(input);
    if (fingerprint !== op.intentFingerprint) throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT);
    const compatibility = await requireV2("updateGeneratorRelease");
    if (input.thumbnail !== null && !compatibility.capabilities.thumbnail && compatibility.capabilities.unattended) {
      throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INCOMPATIBLE);
    }
    return guarded(async () => normalizePerchanceOutcome(await transport.updateGeneratorRelease(Object.freeze({
      operationId: op.operationId,
      generatorId: op.generatorId,
      intentFingerprint: op.intentFingerprint,
      payloadHash: input.payloadHash,
      thumbnailHash: input.thumbnailHash,
      code: input.code,
      html: input.html,
      thumbnail: input.thumbnail,
      settings: serializeGeneratorListing(input.listing)
    }))));
  }

  async function dispatch({ operation, dispatchInput } = {}) {
    const op = normalizePerchanceOperation(operation);
    if (op.state !== "DISPATCHING") throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
    if (op.payloadKind === "v2-release") return dispatchRelease(op, dispatchInput);
    const input = normalizeGeneratorUpdateInput(dispatchInput, operation);
    if (await sha256Hex(input.source) !== input.sourceHash) throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT);
    return compatibleCall(async () => normalizePerchanceOutcome(await transport.updateGenerator(Object.freeze({
      operationId: op.operationId,
      generatorId: op.generatorId,
      sourceHash: op.sourceHash,
      source: input.source
    }))));
  }

  async function reconcile({ operation } = {}) {
    const op = normalizePerchanceOperation(operation);
    if (op.state !== "UNCERTAIN") throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
    if (op.payloadKind === "v2-release") {
      await requireV2("reconcileGeneratorRelease");
      return guarded(async () => normalizePerchanceOutcome(await transport.reconcileGeneratorRelease(Object.freeze({
        operationId: op.operationId,
        generatorId: op.generatorId,
        intentFingerprint: op.intentFingerprint
      })), { reconciliation:true }));
    }
    return compatibleCall(async () => normalizePerchanceOutcome(await transport.reconcileGeneratorUpdate(Object.freeze({
      operationId: op.operationId,
      generatorId: op.generatorId,
      sourceHash: op.sourceHash
    })), { reconciliation:true }));
  }

  // generator.observe (read; no RemoteOperation). Capability-gated and fail-closed: it is
  // enabled for real Perchance only after live confirmation (P039/P043).
  async function observe(generatorId, options = {}) {
    const compatibility = await requireV2("observeGenerator");
    if (!compatibility.capabilities.observe) throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INCOMPATIBLE);
    if (typeof generatorId !== "string" || !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(generatorId)
        || !plain(options) || Object.keys(options).some(key => !["personaUid", "readId", "includeContent"].includes(key))
        || (options.includeContent !== undefined && typeof options.includeContent !== "boolean")) {
      throw perchanceProviderError(PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT);
    }
    const raw = await guarded(() => transport.observeGenerator(Object.freeze({ generatorId, ...options })));
    const observed = await guarded(() => normalizeProviderObservation(raw, options));
    if (observed.exists === true && observed.listing === "UNKNOWN") listingUnknownSeen = true;
    return observed;
  }

  const providerDescriptor = Object.freeze({
    operations: Object.freeze({
      [PERCHANCE_GENERATOR_UPDATE_ACTION]: Object.freeze({ dispatch, reconcile })
    })
  });

  return Object.freeze({
    providerId: PERCHANCE_PROVIDER_ID,
    probeCompatibility,
    observe,
    providerDescriptor
  });
}
