import {
  PERCHANCE_DRIVER_CONTRACT_ID,
  PERCHANCE_DRIVER_CONTRACT_VERSION,
  PERCHANCE_DRIVER_CONTRACT_VERSION_V2,
  PERCHANCE_GENERATOR_OBSERVE_ACTION,
  PERCHANCE_GENERATOR_UPDATE_ACTION,
  PERCHANCE_PROVIDER_ID
} from "./contract.js";

function clone(value) { return structuredClone(value); }

// Deterministic Perchance stand-in. Version 1 (default) is the accepted P013 emulator exactly;
// version 2 adds release payloads (code/HTML/thumbnail), provider-shaped listing settings and
// generator.observe so driver v2 behaviour is provable without live Perchance.
export function createPerchanceEmulator({ contractVersion = PERCHANCE_DRIVER_CONTRACT_VERSION, capabilities = {} } = {}) {
  if (![PERCHANCE_DRIVER_CONTRACT_VERSION, PERCHANCE_DRIVER_CONTRACT_VERSION_V2].includes(contractVersion)) {
    throw new TypeError("Unknown emulator contract version");
  }
  const v2 = contractVersion === PERCHANCE_DRIVER_CONTRACT_VERSION_V2;
  const generators = new Map();
  const receipts = new Map();
  let compatible = true;
  let nextFault = null;
  let probeCapabilities = { unattended:true, observe:true, listing:true, thumbnail:true, create:false, ...capabilities };
  let settingsShape = null; // null → { isPrivate }; otherwise a raw object returned verbatim by observe
  let challenge = false;
  const dispatched = [];

  function probe() {
    if (!compatible) {
      return Promise.resolve({ contractId:PERCHANCE_DRIVER_CONTRACT_ID, contractVersion:999, providerId:PERCHANCE_PROVIDER_ID, operations:[PERCHANCE_GENERATOR_UPDATE_ACTION] });
    }
    if (v2) {
      return Promise.resolve({
        contractId:PERCHANCE_DRIVER_CONTRACT_ID,
        contractVersion:PERCHANCE_DRIVER_CONTRACT_VERSION_V2,
        providerId:PERCHANCE_PROVIDER_ID,
        operations:[PERCHANCE_GENERATOR_UPDATE_ACTION, PERCHANCE_GENERATOR_OBSERVE_ACTION],
        capabilities:{ ...probeCapabilities }
      });
    }
    return Promise.resolve({ contractId:PERCHANCE_DRIVER_CONTRACT_ID, contractVersion:PERCHANCE_DRIVER_CONTRACT_VERSION, providerId:PERCHANCE_PROVIDER_ID, operations:[PERCHANCE_GENERATOR_UPDATE_ACTION] });
  }

  function takeFault() { const fault = nextFault; nextFault = null; return fault; }

  async function updateGenerator(input) {
    const fault = takeFault();
    if (fault === "before-apply") {
      receipts.set(input.operationId, { status:"NOT_APPLIED", generatorId:input.generatorId, sourceHash:input.sourceHash });
      throw new Error("emulated pre-apply transport loss");
    }
    generators.set(input.generatorId, { generatorId:input.generatorId, sourceHash:input.sourceHash, source:input.source });
    receipts.set(input.operationId, { status:"APPLIED", generatorId:input.generatorId, sourceHash:input.sourceHash });
    if (fault === "after-apply") throw new Error("emulated post-apply transport loss");
    if (fault === "malformed") return { status:"APPLIED", extra:true };
    return { status:"APPLIED" };
  }

  async function reconcileGeneratorUpdate(input) {
    const receipt = receipts.get(input.operationId);
    if (!receipt) return { status:"UNKNOWN" };
    if (receipt.generatorId !== input.generatorId || receipt.sourceHash !== input.sourceHash) return { status:"UNKNOWN" };
    return { status: receipt.status };
  }

  async function updateGeneratorRelease(input) {
    dispatched.push(clone({ operationId:input.operationId, generatorId:input.generatorId, settings:input.settings }));
    const fault = takeFault();
    const receipt = { generatorId:input.generatorId, intentFingerprint:input.intentFingerprint };
    if (fault === "before-apply") {
      receipts.set(input.operationId, { ...receipt, status:"NOT_APPLIED" });
      throw new Error("emulated pre-apply transport loss");
    }
    // P042: the provider definitely rejected the save (for example a stale editor).
    if (fault === "not-applied") {
      receipts.set(input.operationId, { ...receipt, status:"NOT_APPLIED" });
      return { status:"NOT_APPLIED" };
    }
    generators.set(input.generatorId, {
      generatorId:input.generatorId, code:input.code, html:input.html, thumbnail:input.thumbnail,
      settings:clone(input.settings)
    });
    receipts.set(input.operationId, { ...receipt, status:"APPLIED" });
    if (fault === "after-apply") throw new Error("emulated post-apply transport loss");
    if (fault === "malformed") return { status:"APPLIED", extra:true };
    return { status:"APPLIED" };
  }

  async function reconcileGeneratorRelease(input) {
    const receipt = receipts.get(input.operationId);
    if (!receipt || receipt.generatorId !== input.generatorId || receipt.intentFingerprint !== input.intentFingerprint) return { status:"UNKNOWN" };
    return { status: receipt.status };
  }

  async function observeGenerator({ generatorId }) {
    const item = generators.get(generatorId);
    if (!item) return { exists:false, challenge };
    return {
      exists:true,
      code:item.code ?? item.source ?? "",
      html:item.html ?? "",
      thumbnail:item.thumbnail ?? null,
      settings:settingsShape === null ? clone(item.settings ?? { isPrivate:false }) : clone(settingsShape),
      challenge
    };
  }

  const driver = v2
    ? Object.freeze({ probe, updateGenerator, reconcileGeneratorUpdate, updateGeneratorRelease, reconcileGeneratorRelease, observeGenerator })
    : Object.freeze({ probe, updateGenerator, reconcileGeneratorUpdate });

  return Object.freeze({
    driver,
    seedGenerator({ generatorId, sourceHash, source = "", code, html, thumbnail = null, settings }) {
      generators.set(generatorId, code === undefined
        ? { generatorId, sourceHash, source }
        : { generatorId, code, html: html ?? "", thumbnail, settings: settings ?? { isPrivate:false } });
    },
    getGenerator(generatorId) {
      const item=generators.get(generatorId);
      return item ? clone(item) : null;
    },
    dispatched() { return clone(dispatched); },
    setCompatible(value) { compatible = value === true; },
    setCapabilities(value) { probeCapabilities = { ...probeCapabilities, ...value }; },
    setSettingsShape(value) { settingsShape = value === null ? null : clone(value); },
    setChallenge(value) { challenge = value === true; },
    failNext(mode) {
      if (!["before-apply","after-apply","malformed","not-applied"].includes(mode)) throw new TypeError("Unknown emulator fault");
      nextFault = mode;
    },
    clearReceipts() { receipts.clear(); }
  });
}
