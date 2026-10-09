import assert from "node:assert/strict";
import {
  MAX_PCMS_REQUEST_BYTES,
  PCMS_ERROR_CODES,
  PCMS_PROTOCOL_VERSION,
  PCMS_REQUEST_TYPE,
  sanitizePcmsValue,
  toStructuredError,
  validateRequestEnvelope
} from "../lib/pcms-protocol.js";

const envelope = (params = {}) => ({
  type: PCMS_REQUEST_TYPE,
  version: PCMS_PROTOCOL_VERSION,
  requestId: "hardening",
  command: "system.describe",
  params
});

for (const bad of [null, [], "request", 1]) {
  assert.throws(() => validateRequestEnvelope(bad), (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST);
}
assert.throws(
  () => validateRequestEnvelope({ ...envelope(), extra: true }),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);
assert.throws(
  () => validateRequestEnvelope({ ...envelope(), requestId: "" }),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);
assert.throws(
  () => validateRequestEnvelope({ ...envelope(), version: 999 }),
  (error) => error?.code === PCMS_ERROR_CODES.PROTOCOL_UNSUPPORTED
);

for (const value of [NaN, Infinity, -Infinity, undefined, 1n, () => {}]) {
  assert.throws(
    () => validateRequestEnvelope(envelope({ value })),
    (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST,
    `direct request value ${String(value)} must fail deterministically`
  );
}
assert.throws(
  () => validateRequestEnvelope(envelope({ value: new Date() })),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);

const cyclic = {};
cyclic.self = cyclic;
assert.throws(
  () => validateRequestEnvelope(envelope({ cyclic })),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);

const protoField = JSON.parse('{"__proto__":{"polluted":true}}');
assert.throws(
  () => validateRequestEnvelope(envelope({ protoField })),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);
assert.throws(
  () => validateRequestEnvelope(envelope({ constructor: { prototype: { polluted: true } } })),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);

let deep = {};
let cursor = deep;
for (let i = 0; i < 70; i += 1) cursor = cursor.next = {};
assert.throws(
  () => validateRequestEnvelope(envelope({ deep })),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);

const oversized = envelope({ padding: "x".repeat(MAX_PCMS_REQUEST_BYTES) });
assert.throws(
  () => validateRequestEnvelope(oversized),
  (error) => error?.code === PCMS_ERROR_CODES.BAD_REQUEST
);

const sanitized = sanitizePcmsValue({
  cookies: { count: 3, bytes: 240 },
  cookieStoreId: "firefox-container-1",
  oldCookieStoreId: "firefox-container-1",
  newCookieStoreId: "firefox-container-2",
  cookieValues: [{ name: "sid", value: "session-secret" }],
  username: "proxy-user",
  password: "proxy-pass",
  harmless: "visible",
  url: "https://example.com/path?token=query-secret#fragment-secret",
  authorizationHeader: "Bearer auth-secret",
  note: "Authorization: Bearer inline-secret",
  privateMaterial: "-----BEGIN PRIVATE KEY-----\nkey-secret\n-----END PRIVATE KEY-----"
});
assert.deepEqual(sanitized.cookies, { count: 3, bytes: 240 }, "cookie counts/bytes are safe telemetry and must not be over-redacted");
assert.equal(sanitized.cookieStoreId, "firefox-container-1", "container IDs are compatibility identifiers, not cookie contents");
assert.equal(sanitized.oldCookieStoreId, "firefox-container-1");
assert.equal(sanitized.newCookieStoreId, "firefox-container-2");
assert.equal(sanitized.cookieValues, "[redacted]");
assert.equal(sanitized.username, "[redacted]");
assert.equal(sanitized.password, "[redacted]");
assert.equal(sanitized.harmless, "visible");
assert.equal(sanitized.url, "https://example.com/path");
assert.equal(sanitized.authorizationHeader, "[redacted]");
assert.equal(JSON.stringify(sanitized).includes("query-secret"), false);
assert.equal(JSON.stringify(sanitized).includes("fragment-secret"), false);
assert.equal(JSON.stringify(sanitized).includes("inline-secret"), false);
assert.equal(JSON.stringify(sanitized).includes("key-secret"), false);

const validationError = new Error("raw validation error");
validationError.issues = [{
  code: "url-invalid",
  message: "Step 1: invalid URL https://example.com/?token=fixture-value",
  stepIndex: 0
}];
const structuredValidation = toStructuredError(validationError);
assert.equal(structuredValidation.code, PCMS_ERROR_CODES.VALIDATION_FAILED);
assert.equal(structuredValidation.message, "Request validation failed");
assert.equal(structuredValidation.details.issues[0].stepIndex, 0);
assert.equal(JSON.stringify(structuredValidation).includes("fixture-value"), false, "structured validation details must be sanitized");

const largeDomain = Array.from({ length: 200 }, (_, index) => ({ id: `persona-${index}`, publicName: `Persona ${index}` }));
const projected = sanitizePcmsValue(largeDomain, { maxBytes: 256 * 1024, strict: true });
assert.equal(projected.length, 200, "successful domain responses must preserve item 101 through 200");
assert.equal(projected[199].id, "persona-199");
assert.equal(Object.keys(sanitizePcmsValue(Object.fromEntries(largeDomain.map((item) => [item.id, item.id])), { maxBytes: 256 * 1024, strict: true })).length, 200);
assert.throws(() => sanitizePcmsValue(largeDomain, { maxBytes: 20, strict: true }),
  (error) => error?.code === PCMS_ERROR_CODES.RESULT_TOO_LARGE);
assert.throws(() => sanitizePcmsValue({ text: "x".repeat(2050) }, { maxBytes: 4096, strict: true }),
  (error) => error?.code === PCMS_ERROR_CODES.RESULT_TOO_LARGE);

console.log("pcms protocol hardening tests passed");
