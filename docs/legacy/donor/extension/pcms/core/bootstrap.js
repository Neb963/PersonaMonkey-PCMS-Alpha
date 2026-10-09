import {
  PERSONA_BROKER_COMMAND_NAMES,
  PERSONA_BROKER_CONTRACT_VERSION,
  PERSONA_BROKER_ERROR_CODES,
  PERSONA_BROKER_IDENTITY_FIELD
} from "./persona-broker-contract.js";

export const PCMS_NAMESPACE_VERSION = 1;

let namespaceSingleton = null;

export function createPcmsNamespace() {
  return Object.freeze({
    name: "PCMS",
    version: PCMS_NAMESPACE_VERSION,
    phase: "P003",
    broker: Object.freeze({
      contractVersion: PERSONA_BROKER_CONTRACT_VERSION,
      durablePersonaIdentity: PERSONA_BROKER_IDENTITY_FIELD,
      commandCount: PERSONA_BROKER_COMMAND_NAMES.length,
      errorCodeCount: PERSONA_BROKER_ERROR_CODES.length,
      implementation: "integration-v1-adapter"
    })
  });
}

export function getPcmsNamespace() {
  if (!namespaceSingleton) namespaceSingleton=createPcmsNamespace();
  return namespaceSingleton;
}

export function installPcmsNamespace(target = globalThis) {
  if ((typeof target !== "object" && typeof target !== "function") || target === null) {
    throw new TypeError("PCMS namespace target must be an object");
  }
  const namespace=getPcmsNamespace();
  if (!Object.prototype.hasOwnProperty.call(target, "PCMS")) {
    Object.defineProperty(target, "PCMS", {
      value: namespace,
      enumerable: true,
      configurable: false,
      writable: false
    });
    return namespace;
  }
  if (target.PCMS !== namespace) throw new Error("PCMS namespace collision");
  return namespace;
}
