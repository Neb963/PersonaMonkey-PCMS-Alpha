import { normalizeModuleAuthority } from "./authority.js";
import { MODULE_ERROR_CODES, moduleError } from "./errors.js";

export const PCMS_MODULE_ARCHIVE_FORMAT = "pcms.module.archive/v1";
export const PCMS_MODULE_MANIFEST_VERSION = 1;
// pcms.module-manifest/v2 (P033) is additive: v1 plus an optional `ui` entry naming the
// package file that runs in the sandboxed module-UI frame. v1 archives keep their bytes and hashes.
export const PCMS_MODULE_MANIFEST_VERSIONS = Object.freeze([1, 2]);
export const MODULE_MAX_UI_BYTES = 256 * 1024;
export const MODULE_MAX_ARCHIVE_BYTES = 1024 * 1024;
export const MODULE_MAX_FILES = 32;
export const MODULE_MAX_FILE_BYTES = 256 * 1024;
export const MODULE_MAX_CONTROLLER_BYTES = 256 * 1024;
export const MODULE_MAX_PATH_LENGTH = 160;

const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION_PATTERN = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PATH_PATTERN = /^[A-Za-z0-9._/-]+$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const FORBIDDEN_PATH_SEGMENTS = new Set(["", ".", ".."]);
const TEXT_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

function fail(code) {
  throw moduleError(code);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected) {
  const keys = Object.keys(value);
  if (keys.length !== expected.length || !expected.every((key) => Object.hasOwn(value, key))) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
}

export function assertModuleId(value) {
  if (typeof value !== "string" || value.length > 96 || !MODULE_ID_PATTERN.test(value)) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  return value;
}

function validateVersion(value) {
  if (typeof value !== "string" || value.length > 64 || !VERSION_PATTERN.test(value)) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  return value;
}

export function validateModuleArchivePath(value) {
  if (typeof value !== "string"
      || value.length < 1
      || value.length > MODULE_MAX_PATH_LENGTH
      || value.startsWith("/")
      || value.endsWith("/")
      || value.includes("\\")
      || !PATH_PATTERN.test(value)) fail(MODULE_ERROR_CODES.INVALID_PATH);
  const segments = value.split("/");
  if (segments.length > 8 || segments.some((segment) => FORBIDDEN_PATH_SEGMENTS.has(segment))) fail(MODULE_ERROR_CODES.INVALID_PATH);
  return value;
}

function normalizeManifest(value) {
  if (!plainObject(value)) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  if (!PCMS_MODULE_MANIFEST_VERSIONS.includes(value.schemaVersion)) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  const keys = Object.keys(value);
  const expected = ["schemaVersion", "moduleId", "version", "controller", "authority"];
  const allowed = value.schemaVersion === 2 ? [...expected, "ui"] : expected;
  if (!expected.every((key) => Object.hasOwn(value, key)) || !keys.every((key) => allowed.includes(key))) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  const controller = validateModuleArchivePath(value.controller);
  if (!controller.endsWith(".js")) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  const manifest = {
    schemaVersion: value.schemaVersion,
    moduleId: assertModuleId(value.moduleId),
    version: validateVersion(value.version),
    controller,
    authority: normalizeModuleAuthority(value.authority)
  };
  if (Object.hasOwn(value, "ui")) {
    const ui = validateModuleArchivePath(value.ui);
    if (!ui.endsWith(".js") || ui === controller) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
    manifest.ui = ui;
  }
  return Object.freeze(manifest);
}

function normalizeFiles(value) {
  if (!plainObject(value)) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  const names = Object.keys(value);
  if (names.length < 1 || names.length > MODULE_MAX_FILES) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  const sorted = [...names].sort();
  const output = Object.create(null);
  for (const name of sorted) {
    validateModuleArchivePath(name);
    const content = value[name];
    if (typeof content !== "string" || content.includes("\u0000") || TEXT_ENCODER.encode(content).byteLength > MODULE_MAX_FILE_BYTES) {
      fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
    }
    output[name] = content;
  }
  return Object.freeze(output);
}

function normalizeDefinition(value) {
  if (!plainObject(value)) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  exactKeys(value, ["format", "manifest", "files"]);
  if (value.format !== PCMS_MODULE_ARCHIVE_FORMAT) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  const manifest = normalizeManifest(value.manifest);
  const files = normalizeFiles(value.files);
  if (!Object.hasOwn(files, manifest.controller)) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  const controllerBytes = TEXT_ENCODER.encode(files[manifest.controller]).byteLength;
  if (controllerBytes < 1 || controllerBytes > MODULE_MAX_CONTROLLER_BYTES) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  if (manifest.ui !== undefined) {
    if (!Object.hasOwn(files, manifest.ui)) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
    const uiBytes = TEXT_ENCODER.encode(files[manifest.ui]).byteLength;
    if (uiBytes < 1 || uiBytes > MODULE_MAX_UI_BYTES) fail(MODULE_ERROR_CODES.INVALID_MANIFEST);
  }
  return Object.freeze({ format: PCMS_MODULE_ARCHIVE_FORMAT, manifest, files });
}

// Key order is part of the canonical bytes: v1 stays byte-identical, v2 appends `ui`.
export function canonicalModuleManifest(manifest) {
  const out = {
    schemaVersion: manifest.schemaVersion,
    moduleId: manifest.moduleId,
    version: manifest.version,
    controller: manifest.controller,
    authority: { capabilities: [...manifest.authority.capabilities] }
  };
  if (manifest.ui !== undefined) out.ui = manifest.ui;
  return out;
}
const canonicalManifest = canonicalModuleManifest;

function canonicalObject(definition) {
  const files = Object.create(null);
  for (const path of Object.keys(definition.files).sort()) files[path] = definition.files[path];
  return {
    format: PCMS_MODULE_ARCHIVE_FORMAT,
    manifest: canonicalManifest(definition.manifest),
    files
  };
}

function canonicalText(definition) {
  return JSON.stringify(canonicalObject(definition));
}

function normalizeArchiveBytes(value) {
  let bytes;
  if (value instanceof Uint8Array) {
    bytes = new Uint8Array(value);
  } else if (value instanceof ArrayBuffer) {
    bytes = new Uint8Array(value.slice(0));
  } else {
    fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  }
  if (bytes.byteLength < 2) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  if (bytes.byteLength > MODULE_MAX_ARCHIVE_BYTES) fail(MODULE_ERROR_CODES.ARCHIVE_TOO_LARGE);
  return bytes;
}

export function encodeModuleArchive(value) {
  const definition = normalizeDefinition(value);
  const bytes = TEXT_ENCODER.encode(canonicalText(definition));
  if (bytes.byteLength > MODULE_MAX_ARCHIVE_BYTES) fail(MODULE_ERROR_CODES.ARCHIVE_TOO_LARGE);
  return new Uint8Array(bytes);
}

export async function hashModuleArchiveBytes(value, { crypto = globalThis.crypto } = {}) {
  const bytes = normalizeArchiveBytes(value);
  if (!crypto?.subtle || typeof crypto.subtle.digest !== "function") fail(MODULE_ERROR_CODES.HASH_UNAVAILABLE);
  let digest;
  try {
    digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  } catch {
    fail(MODULE_ERROR_CODES.HASH_UNAVAILABLE);
  }
  return "sha256:" + [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function assertModulePackageHash(value) {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  return value;
}

export async function parseModuleArchive(value, options = {}) {
  const bytes = normalizeArchiveBytes(value);
  let text;
  try {
    text = UTF8_DECODER.decode(bytes);
  } catch {
    fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  }
  if (text.charCodeAt(0) === 0xfeff) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  }
  const definition = normalizeDefinition(parsed);
  if (canonicalText(definition) !== text) fail(MODULE_ERROR_CODES.INVALID_ARCHIVE);
  const packageHash = await hashModuleArchiveBytes(bytes, options);
  return Object.freeze({
    packageHash,
    format: definition.format,
    manifest: definition.manifest,
    files: definition.files
  });
}

export async function verifyStoredModulePackage(value, options = {}) {
  if (!plainObject(value)) fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);
  const expectedHash = assertModulePackageHash(value.packageHash);
  const bytes = encodeModuleArchive({ format: value.format, manifest: value.manifest, files: value.files });
  const actualHash = await hashModuleArchiveBytes(bytes, options);
  if (actualHash !== expectedHash) fail(MODULE_ERROR_CODES.IDENTITY_CONFLICT);
  return parseModuleArchive(bytes, options);
}
