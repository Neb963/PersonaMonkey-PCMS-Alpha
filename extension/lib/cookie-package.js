import { normalizeCookieRecord } from "./persona-cookies.js";

export const COOKIE_PACKAGE_FORMAT = "personamonkey-cookies";
export const COOKIE_PACKAGE_VERSION = 1;
export const MAX_COOKIE_PACKAGE_BYTES = 20 * 1024 * 1024;
export const MAX_COOKIE_PACKAGE_COOKIES = 20000;

function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function text(input) {
  if (input instanceof Uint8Array) return new TextDecoder().decode(input);
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(input));
  return String(input ?? "");
}

function normalizePersona(persona = {}) {
  return {
    name: String(persona.name || ""),
    color: String(persona.color || ""),
    colorCode: String(persona.colorCode || ""),
    icon: String(persona.icon || "")
  };
}

export function validateCookieRecords(records = []) {
  if (!Array.isArray(records)) throw new Error("Cookie package cookies must be an array");
  if (records.length > MAX_COOKIE_PACKAGE_COOKIES) throw new Error(`Cookie package exceeds ${MAX_COOKIE_PACKAGE_COOKIES} cookies`);
  return records.map((cookie, index) => {
    const record = normalizeCookieRecord(cookie);
    if (!record.name) throw new Error(`Cookie ${index + 1} is missing a name`);
    if (!record.domain) throw new Error(`Cookie ${index + 1} is missing a domain`);
    if (record.name.length > 4096 || record.domain.length > 4096 || record.path.length > 4096 || record.value.length > 1024 * 1024) {
      throw new Error(`Cookie ${index + 1} exceeds package field limits`);
    }
    return record;
  });
}

export function createCookiePackage({ cookies = [], persona = {}, appVersion = "" } = {}) {
  return {
    format: COOKIE_PACKAGE_FORMAT,
    formatVersion: COOKIE_PACKAGE_VERSION,
    exportedAt: new Date().toISOString(),
    appVersion: String(appVersion || ""),
    persona: normalizePersona(persona),
    cookies: validateCookieRecords(cookies)
  };
}

export function encodeCookiePackage(input = {}) {
  return JSON.stringify(createCookiePackage(input), null, 2);
}

export function decodeCookiePackage(input) {
  const source = text(input);
  if (new TextEncoder().encode(source).byteLength > MAX_COOKIE_PACKAGE_BYTES) throw new Error("Cookie package is too large");
  let parsed;
  try { parsed = JSON.parse(source); }
  catch { throw new Error("Cookie package is not valid JSON"); }
  if (!parsed || parsed.format !== COOKIE_PACKAGE_FORMAT || parsed.formatVersion !== COOKIE_PACKAGE_VERSION) {
    throw new Error("Unsupported PersonaMonkey cookie package format");
  }
  return {
    ...clone(parsed),
    persona: normalizePersona(parsed.persona),
    cookies: validateCookieRecords(parsed.cookies)
  };
}
