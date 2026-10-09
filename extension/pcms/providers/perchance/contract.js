import { PERCHANCE_PROVIDER_ERROR_CODES, perchanceProviderError } from "./errors.js";

export const PERCHANCE_PROVIDER_ID = "perchance";
export const PERCHANCE_DRIVER_CONTRACT_ID = "pcms.perchance.driver";
export const PERCHANCE_DRIVER_CONTRACT_VERSION = 1;
export const PERCHANCE_GENERATOR_UPDATE_ACTION = "generator.update";
export const PERCHANCE_GENERATOR_TARGET_KIND = "generator";
export const PERCHANCE_MAX_SOURCE_BYTES = 4 * 1024 * 1024;

// pcms.perchance.driver/v2 (04 §E.13, F). Additive: v1 probes, inputs and fingerprints keep
// their exact accepted meaning for legacy single-source deployments and runtime modules.
export const PERCHANCE_DRIVER_CONTRACT_VERSION_V2 = 2;
export const PERCHANCE_GENERATOR_OBSERVE_ACTION = "generator.observe";
export const PERCHANCE_GENERATOR_CREATE_ACTION = "generator.create";
export const PERCHANCE_V2_OPERATIONS = Object.freeze([
  PERCHANCE_GENERATOR_UPDATE_ACTION, PERCHANCE_GENERATOR_OBSERVE_ACTION, PERCHANCE_GENERATOR_CREATE_ACTION
]);
export const PERCHANCE_V2_CAPABILITIES = Object.freeze(["unattended", "observe", "listing", "thumbnail", "create"]);
export const PERCHANCE_MAX_THUMBNAIL_BYTES = 1024 * 1024;
export const PERCHANCE_PAYLOAD_FORMAT = "pcms.perchance.generator-payload/v1";
export const PERCHANCE_SOURCE_FINGERPRINT_PREFIX = "perchance:generator-source:v1:";
export const PERCHANCE_RELEASE_FINGERPRINT_PREFIX = "perchance:generator-release:v2:";
// PCMS domain listing vocabulary. Provider serialization lives only in listing.js.
export const GENERATOR_LISTINGS = Object.freeze(["PUBLICLY_LISTED", "UNLISTED"]);
export const OBSERVED_LISTINGS = Object.freeze(["PUBLICLY_LISTED", "UNLISTED", "UNKNOWN"]);
export const GENERATOR_SLUG_PATTERN = /^[a-z0-9][a-z0-9_-]{0,99}$/;

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const OUTCOMES = new Set(["APPLIED", "NOT_APPLIED", "UNKNOWN"]);
const TEXT_ENCODER = new TextEncoder();

function fail(code = PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT) {
  throw perchanceProviderError(code);
}
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
function exact(value, names, code) {
  if (!plain(value) || Object.getOwnPropertySymbols(value).length) fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.keys(descriptors);
  if (keys.length !== names.length || !names.every((name) => Object.hasOwn(descriptors, name))) fail(code);
  for (const descriptor of Object.values(descriptors)) {
    if (!descriptor.enumerable || !Object.hasOwn(descriptor, "value")) fail(code);
  }
}
function boundedId(value, code = PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(code);
  return value;
}

export function generatorSourceFingerprint(sourceHash) {
  if (typeof sourceHash !== "string" || !SHA256_PATTERN.test(sourceHash)) fail();
  return PERCHANCE_SOURCE_FINGERPRINT_PREFIX + sourceHash;
}

export function isSha256Hex(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function normalizeGeneratorListing(value, code = PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT) {
  if (!GENERATOR_LISTINGS.includes(value)) fail(code);
  return value;
}

export function normalizeGeneratorSlug(value, code = PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT) {
  if (typeof value !== "string" || !GENERATOR_SLUG_PATTERN.test(value)) fail(code);
  return value;
}

async function digestHex(bytes) {
  if (!globalThis.crypto?.subtle?.digest) fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  let digest;
  try { digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes)); }
  catch { fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL); }
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function utf8Text(value) {
  if (typeof value !== "string" || value.includes("\u0000")) fail();
  // Lone surrogates cannot round-trip through UTF-8 byte-exactly.
  if (/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)) fail();
  return TEXT_ENCODER.encode(value);
}

// 04 §E.4.1: byte-exact, length-prefixed, no normalisation.
export function encodeGeneratorPayload(code, html) {
  const codeBytes = utf8Text(code);
  const htmlBytes = utf8Text(html);
  if (codeBytes.byteLength + htmlBytes.byteLength > PERCHANCE_MAX_SOURCE_BYTES) fail();
  const parts = [
    TEXT_ENCODER.encode(PERCHANCE_PAYLOAD_FORMAT + "\ncode " + codeBytes.byteLength + "\n"), codeBytes,
    TEXT_ENCODER.encode("\nhtml " + htmlBytes.byteLength + "\n"), htmlBytes, TEXT_ENCODER.encode("\n")
  ];
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.byteLength; }
  return out;
}

export async function generatorPayloadHash(code, html) {
  return digestHex(encodeGeneratorPayload(code, html));
}

export function decodeThumbnail(base64) {
  if (typeof base64 !== "string" || base64.length < 4 || base64.length > Math.ceil(PERCHANCE_MAX_THUMBNAIL_BYTES / 3) * 4
      || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4 !== 0) fail();
  let binary;
  try { binary = atob(base64); } catch { fail(); }
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  if (bytes.byteLength > PERCHANCE_MAX_THUMBNAIL_BYTES || bytes.byteLength < 3
      || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) fail();
  return bytes;
}

export async function thumbnailHash(base64) {
  return digestHex(decodeThumbnail(base64));
}

// 04 §E.4.2. The listing is part of the intent, so a listing-only change is a new deployment.
export async function generatorReleaseFingerprint({ payloadHash, thumbnailHash: thumb, listing } = {}) {
  if (!isSha256Hex(payloadHash) || (thumb !== null && !isSha256Hex(thumb))) fail();
  normalizeGeneratorListing(listing);
  return PERCHANCE_RELEASE_FINGERPRINT_PREFIX + await digestHex(TEXT_ENCODER.encode(payloadHash + ":" + (thumb ?? "-") + ":" + listing));
}

function denseStringArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.keys(descriptors).length !== value.length + 1 || value.length > 16) return null;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "string") return null;
  }
  return value;
}

function normalizeV1Compatibility(raw) {
  exact(raw, ["contractId", "contractVersion", "providerId", "operations"], PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  const operations = raw.operations;
  if (!Array.isArray(operations)
      || Object.getPrototypeOf(operations) !== Array.prototype
      || Object.getOwnPropertySymbols(operations).length
      || Object.keys(Object.getOwnPropertyDescriptors(operations)).some((key) => key !== "length" && key !== "0")
      || !Object.hasOwn(Object.getOwnPropertyDescriptor(operations, "0") || {}, "value")
      || raw.contractId !== PERCHANCE_DRIVER_CONTRACT_ID
      || raw.contractVersion !== PERCHANCE_DRIVER_CONTRACT_VERSION
      || raw.providerId !== PERCHANCE_PROVIDER_ID
      || operations.length !== 1
      || operations[0] !== PERCHANCE_GENERATOR_UPDATE_ACTION) {
    fail(PERCHANCE_PROVIDER_ERROR_CODES.INCOMPATIBLE);
  }
  return Object.freeze({
    contractId: raw.contractId,
    contractVersion: raw.contractVersion,
    providerId: raw.providerId,
    operations: Object.freeze([...raw.operations])
  });
}

// v2: unknown operations are ignored and every capability that is not exactly `true` is
// false, so an unknown or absent capability fails closed for that capability only.
function normalizeV2Compatibility(raw) {
  exact(raw, ["contractId", "contractVersion", "providerId", "operations", "capabilities"], PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  const operations = denseStringArray(raw.operations);
  if (raw.contractId !== PERCHANCE_DRIVER_CONTRACT_ID || raw.providerId !== PERCHANCE_PROVIDER_ID
      || !operations || !operations.includes(PERCHANCE_GENERATOR_UPDATE_ACTION) || !plain(raw.capabilities)
      || Object.getOwnPropertySymbols(raw.capabilities).length) {
    fail(PERCHANCE_PROVIDER_ERROR_CODES.INCOMPATIBLE);
  }
  const known = PERCHANCE_V2_OPERATIONS.filter((name) => operations.includes(name));
  const descriptors = Object.getOwnPropertyDescriptors(raw.capabilities);
  const capability = (name) => Object.hasOwn(descriptors, name) && Object.hasOwn(descriptors[name], "value") && descriptors[name].value === true;
  const capabilities = Object.fromEntries(PERCHANCE_V2_CAPABILITIES.map((name) => [name, capability(name)]));
  if (!known.includes(PERCHANCE_GENERATOR_OBSERVE_ACTION)) capabilities.observe = false;
  if (!known.includes(PERCHANCE_GENERATOR_CREATE_ACTION)) capabilities.create = false;
  return Object.freeze({
    contractId: raw.contractId,
    contractVersion: PERCHANCE_DRIVER_CONTRACT_VERSION_V2,
    providerId: raw.providerId,
    operations: Object.freeze(known),
    capabilities: Object.freeze(capabilities)
  });
}

export function normalizePerchanceCompatibility(raw) {
  if (plain(raw) && raw.contractVersion === PERCHANCE_DRIVER_CONTRACT_VERSION_V2) return normalizeV2Compatibility(raw);
  return normalizeV1Compatibility(raw);
}

export function normalizePerchanceOperation(operation) {
  exact(operation, ["schemaVersion","kind","operationId","providerId","action","targetRef","intentFingerprint","state","attempt","createdAt","updatedAt","lastDispatchAt","resolvedAt","resolution"], PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  if (operation.providerId !== PERCHANCE_PROVIDER_ID || operation.action !== PERCHANCE_GENERATOR_UPDATE_ACTION) fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  boundedId(operation.operationId, PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  exact(operation.targetRef, ["kind","id"], PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  if (operation.targetRef.kind !== PERCHANCE_GENERATOR_TARGET_KIND) fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  boundedId(operation.targetRef.id, PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  const fingerprint = operation.intentFingerprint;
  if (typeof fingerprint === "string" && fingerprint.startsWith(PERCHANCE_RELEASE_FINGERPRINT_PREFIX)) {
    if (!SHA256_PATTERN.test(fingerprint.slice(PERCHANCE_RELEASE_FINGERPRINT_PREFIX.length))) fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
    return Object.freeze({ payloadKind:"v2-release", operationId:operation.operationId, generatorId:operation.targetRef.id,
      intentFingerprint:fingerprint, state:operation.state });
  }
  if (typeof fingerprint !== "string" || !fingerprint.startsWith(PERCHANCE_SOURCE_FINGERPRINT_PREFIX)) {
    fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  }
  const sourceHash = fingerprint.slice(PERCHANCE_SOURCE_FINGERPRINT_PREFIX.length);
  if (!SHA256_PATTERN.test(sourceHash)) fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  return Object.freeze({ operationId:operation.operationId, generatorId:operation.targetRef.id, sourceHash, state:operation.state });
}

// generator.update v2 dispatch input (04 §E.13). The thumbnail travels as base64 JPEG so the
// command stays plain JSON; hashes are recomputed by the adapter before any dispatch.
export function normalizeGeneratorReleaseInput(input) {
  exact(input, ["payloadHash", "thumbnailHash", "listing", "code", "html", "thumbnail"], PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT);
  if (!isSha256Hex(input.payloadHash)) fail();
  if ((input.thumbnail === null) !== (input.thumbnailHash === null)) fail();
  if (input.thumbnailHash !== null && !isSha256Hex(input.thumbnailHash)) fail();
  if (input.thumbnail !== null) decodeThumbnail(input.thumbnail);
  encodeGeneratorPayload(input.code, input.html);
  return Object.freeze({
    payloadHash:input.payloadHash, thumbnailHash:input.thumbnailHash, listing:normalizeGeneratorListing(input.listing),
    code:input.code, html:input.html, thumbnail:input.thumbnail
  });
}

export function normalizeGeneratorUpdateInput(input, operation) {
  exact(input, ["sourceHash", "source"], PERCHANCE_PROVIDER_ERROR_CODES.INVALID_ARGUMENT);
  const op = normalizePerchanceOperation(operation);
  if (typeof input.sourceHash !== "string" || !SHA256_PATTERN.test(input.sourceHash) || input.sourceHash !== op.sourceHash) fail();
  if (typeof input.source !== "string" || TEXT_ENCODER.encode(input.source).byteLength > PERCHANCE_MAX_SOURCE_BYTES) fail();
  return Object.freeze({ sourceHash:input.sourceHash, source:input.source });
}

export function normalizePerchanceOutcome(raw, { reconciliation = false } = {}) {
  exact(raw, ["status"], PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  if (!OUTCOMES.has(raw.status) || (!reconciliation && raw.status === "UNKNOWN")) fail(PERCHANCE_PROVIDER_ERROR_CODES.PROTOCOL);
  return Object.freeze({ status: raw.status });
}

export async function sha256Hex(source) {
  if (typeof source !== "string") fail();
  const bytes = TEXT_ENCODER.encode(source);
  if (bytes.byteLength > PERCHANCE_MAX_SOURCE_BYTES) fail();
  return digestHex(bytes);
}

const DRIVER_V1_METHODS = Object.freeze(["probe", "updateGenerator", "reconcileGeneratorUpdate"]);
const DRIVER_V2_METHODS = Object.freeze(["updateGeneratorRelease", "reconcileGeneratorRelease", "observeGenerator"]);

// A v1 driver exposes exactly the three accepted methods. A v2 driver may add any of the v2
// methods; anything else is rejected. Absent v2 methods fail closed when they are needed.
export function normalizeDriver(driver) {
  const message = "Perchance driver must expose only probe(), updateGenerator(), reconcileGeneratorUpdate() and the v2 release methods";
  if (!plain(driver) || Object.getOwnPropertySymbols(driver).length) throw new TypeError(message);
  const descriptors = Object.getOwnPropertyDescriptors(driver);
  const allowed = new Set([...DRIVER_V1_METHODS, ...DRIVER_V2_METHODS]);
  for (const [name, descriptor] of Object.entries(descriptors)) {
    if (!allowed.has(name) || !descriptor.enumerable || !Object.hasOwn(descriptor, "value") || typeof descriptor.value !== "function") {
      throw new TypeError(message);
    }
  }
  if (!DRIVER_V1_METHODS.every((name) => Object.hasOwn(descriptors, name))) throw new TypeError(message);
  return Object.freeze(Object.fromEntries(Object.keys(descriptors).map((name) => [name, descriptors[name].value])));
}
