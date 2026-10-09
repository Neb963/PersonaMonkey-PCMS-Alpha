/**
 * The PCMS protocol is deliberately small and transport neutral. It knows
 * nothing about Firefox APIs or persisted Persona state; those are supplied by
 * the control plane's service facade.
 */
export const PCMS_PROTOCOL_VERSION = 1;
export const PCMS_REQUEST_TYPE = "PCMS_REQUEST";
export const PCMS_EVENTS_PORT = "PCMS_EVENTS";
export const MAX_PCMS_REQUEST_BYTES = 1024 * 1024;
export const MAX_PCMS_BATCH_PERSONAS = 200;
export const MAX_PCMS_BATCH_CONCURRENCY = 16;
export const DEFAULT_PCMS_BATCH_CONCURRENCY = 4;
export const MAX_PCMS_EVENT_BYTES = 32 * 1024;

export const PCMS_ERROR_CODES = Object.freeze({
  PROTOCOL_UNSUPPORTED: "PCMS_PROTOCOL_UNSUPPORTED",
  BAD_REQUEST: "PCMS_BAD_REQUEST",
  VALIDATION_FAILED: "PCMS_VALIDATION_FAILED",
  UNKNOWN_COMMAND: "PCMS_UNKNOWN_COMMAND",
  CAPABILITY_UNAVAILABLE: "PCMS_CAPABILITY_UNAVAILABLE",
  STATE_CONFLICT: "STATE_CONFLICT",
  PERSONA_NOT_FOUND: "PERSONA_NOT_FOUND",
  PERSONA_UNMANAGED: "PERSONA_UNMANAGED",
  ROUTE_NOT_FOUND: "ROUTE_NOT_FOUND",
  ROUTE_DISABLED: "ROUTE_DISABLED",
  DIRECT_ROUTE_REQUIRES_OPT_IN: "DIRECT_ROUTE_REQUIRES_OPT_IN",
  SECURITY_AUTHORIZATION_REQUIRED: "SECURITY_AUTHORIZATION_REQUIRED",
  USERSCRIPT_NOT_FOUND: "USERSCRIPT_NOT_FOUND",
  USERSCRIPT_DISABLED: "USERSCRIPT_DISABLED",
  USERSCRIPT_INCOMPATIBLE: "USERSCRIPT_INCOMPATIBLE",
  WORKFLOW_NOT_FOUND: "WORKFLOW_NOT_FOUND",
  JOB_NOT_FOUND: "JOB_NOT_FOUND",
  BATCH_COMMAND_NOT_ALLOWED: "BATCH_COMMAND_NOT_ALLOWED",
  BATCH_LIMIT_EXCEEDED: "BATCH_LIMIT_EXCEEDED",
  BATCH_CANCELLED: "BATCH_CANCELLED",
  RESULT_TOO_LARGE: "PCMS_RESULT_TOO_LARGE",
  RESULT_NOT_SERIALIZABLE: "PCMS_RESULT_NOT_SERIALIZABLE",
  PAGE_INVALID: "PCMS_PAGE_INVALID",
  PAGE_STALE: "PCMS_PAGE_STALE",
  REQUEST_ID_CONFLICT: "PCMS_REQUEST_ID_CONFLICT",
  REPLAY_CAPACITY: "PCMS_REPLAY_CAPACITY",
  DESTRUCTIVE_CONFIRMATION_REQUIRED: "DESTRUCTIVE_CONFIRMATION_REQUIRED",
  INTERNAL_ERROR: "INTERNAL_ERROR"
});

const SAFE_ERROR_MESSAGES = Object.freeze({
  [PCMS_ERROR_CODES.PROTOCOL_UNSUPPORTED]: "Unsupported PCMS protocol version",
  [PCMS_ERROR_CODES.BAD_REQUEST]: "Malformed PCMS request",
  [PCMS_ERROR_CODES.VALIDATION_FAILED]: "Request validation failed",
  [PCMS_ERROR_CODES.UNKNOWN_COMMAND]: "Unknown PCMS command",
  [PCMS_ERROR_CODES.CAPABILITY_UNAVAILABLE]: "Requested PCMS capability is unavailable",
  [PCMS_ERROR_CODES.STATE_CONFLICT]: "State revision conflict",
  [PCMS_ERROR_CODES.PERSONA_NOT_FOUND]: "Managed persona not found",
  [PCMS_ERROR_CODES.PERSONA_UNMANAGED]: "Persona is not managed",
  [PCMS_ERROR_CODES.ROUTE_NOT_FOUND]: "Route not found",
  [PCMS_ERROR_CODES.ROUTE_DISABLED]: "Route is disabled",
  [PCMS_ERROR_CODES.DIRECT_ROUTE_REQUIRES_OPT_IN]: "Direct routing requires explicit opt-in",
  [PCMS_ERROR_CODES.SECURITY_AUTHORIZATION_REQUIRED]: "Security-sensitive change requires explicit authorization",
  [PCMS_ERROR_CODES.USERSCRIPT_NOT_FOUND]: "Userscript not found",
  [PCMS_ERROR_CODES.USERSCRIPT_DISABLED]: "Userscript is disabled",
  [PCMS_ERROR_CODES.USERSCRIPT_INCOMPATIBLE]: "Userscript has unsupported grants",
  [PCMS_ERROR_CODES.WORKFLOW_NOT_FOUND]: "Workflow not found",
  [PCMS_ERROR_CODES.JOB_NOT_FOUND]: "Workflow job not found",
  [PCMS_ERROR_CODES.BATCH_COMMAND_NOT_ALLOWED]: "This command is not allowed in a batch",
  [PCMS_ERROR_CODES.BATCH_LIMIT_EXCEEDED]: "Batch request exceeds a PCMS limit",
  [PCMS_ERROR_CODES.BATCH_CANCELLED]: "Batch item was not started after an earlier failure",
  [PCMS_ERROR_CODES.RESULT_TOO_LARGE]: "Management result exceeds the response limit",
  [PCMS_ERROR_CODES.RESULT_NOT_SERIALIZABLE]: "Management result cannot be represented safely",
  [PCMS_ERROR_CODES.PAGE_INVALID]: "Invalid management page request",
  [PCMS_ERROR_CODES.PAGE_STALE]: "Management page is stale; restart the query",
  [PCMS_ERROR_CODES.REQUEST_ID_CONFLICT]: "requestId was already used for a different mutation",
  [PCMS_ERROR_CODES.REPLAY_CAPACITY]: "Management replay capacity is full; retry later",
  [PCMS_ERROR_CODES.DESTRUCTIVE_CONFIRMATION_REQUIRED]: "This operation requires explicit confirmation",
  [PCMS_ERROR_CODES.INTERNAL_ERROR]: "An internal PCMS error occurred"
});

export function safeErrorMessage(code) {
  return SAFE_ERROR_MESSAGES[code] || SAFE_ERROR_MESSAGES[PCMS_ERROR_CODES.INTERNAL_ERROR];
}

export class PcmsError extends Error {
  constructor(code, message, { retryable = false, details = null } = {}) {
    super(message);
    this.name = "PcmsError";
    this.code = code;
    this.retryable = retryable === true;
    this.details = details;
  }
}

export function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function makePcmsError(code, message, options) {
  return new PcmsError(code, message, options);
}

export function serializedSize(value) {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
  catch { return Infinity; }
}

function badRequest(message) {
  throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, message);
}

function assertJsonCompatible(value, state = { seen: new WeakSet(), nodes: 0 }, depth = 0) {
  state.nodes += 1;
  if (state.nodes > 200_000) badRequest("Request structure is too large");
  if (depth > 64) badRequest("Request structure is too deeply nested");
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) badRequest("Request numbers must be finite");
    return;
  }
  if (typeof value !== "object") badRequest("Request must contain only JSON-compatible values");
  if (state.seen.has(value)) badRequest("Request must not contain cyclic values");
  state.seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) assertJsonCompatible(item, state, depth + 1);
    state.seen.delete(value);
    return;
  }
  if (!isPlainObject(value)) badRequest("Request objects must be plain objects");
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) badRequest("Request contains a prohibited object key");
    assertJsonCompatible(child, state, depth + 1);
  }
  state.seen.delete(value);
}

export function validateRequestEnvelope(request) {
  if (!isPlainObject(request) || request.type !== PCMS_REQUEST_TYPE) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "Request must be a PCMS request envelope");
  }
  const allowedEnvelopeKeys = new Set(["type", "version", "requestId", "command", "params"]);
  if (Object.keys(request).some((key) => !allowedEnvelopeKeys.has(key))) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "Request envelope contains unknown fields");
  }
  assertJsonCompatible(request);
  if (serializedSize(request) > MAX_PCMS_REQUEST_BYTES) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "Request exceeds the 1 MiB size limit");
  }
  if (request.version !== PCMS_PROTOCOL_VERSION) {
    throw makePcmsError(PCMS_ERROR_CODES.PROTOCOL_UNSUPPORTED, "Unsupported PCMS protocol version", {
      details: { supportedVersion: PCMS_PROTOCOL_VERSION }
    });
  }
  if (typeof request.requestId !== "string" || !request.requestId.trim() || request.requestId.length > 256) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "requestId must be a non-empty string of at most 256 characters");
  }
  if (typeof request.command !== "string" || !request.command.trim() || request.command.length > 128) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "command must be a non-empty string");
  }
  if (!isPlainObject(request.params ?? {})) {
    throw makePcmsError(PCMS_ERROR_CODES.BAD_REQUEST, "params must be an object");
  }
  return { ...request, params: request.params || {} };
}

function normalizedKey(key) {
  return String(key || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function safeCookieSummary(value, key) {
  if (normalizedKey(key) !== "cookies" || !isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (!keys.length || keys.some((name) => !["count", "bytes"].includes(name))) return false;
  return keys.every((name) => Number.isFinite(value[name]) && value[name] >= 0);
}

function sensitiveKey(key) {
  const normalized = normalizedKey(key);
  if (!normalized) return false;
  if (["cookiecount", "cookiebytes"].includes(normalized) || normalized.endsWith("cookiestoreid")) return false;
  return [
    "username", "password", "passphrase", "secret", "token", "credential",
    "privatekey", "authorization", "wireguard", "session", "cookie"
  ].some((fragment) => normalized.includes(fragment));
}

function sanitizeString(value, strict = false) {
  // URLs may appear in descriptions, diagnostics or errors, not only as the
  // entire field. Remove userinfo and query/fragment before generic redaction.
  let output = String(value).replace(/https?:\/\/[^\s<>"']+/gi, (candidate) => {
    const suffix = candidate.match(/[),.;!?]+$/)?.[0] || "";
    try {
      const url = new URL(candidate.slice(0, candidate.length - suffix.length));
      url.username = "";
      url.password = "";
      return `${url.origin}${url.pathname}${suffix}`;
    } catch { return candidate; }
  });
  output = output
    .replace(/-----BEGIN[^\n]{0,80}PRIVATE KEY-----[\s\S]*?-----END[^\n]{0,80}PRIVATE KEY-----/gi, "[redacted-private-key]")
    .replace(/\b(authorization\s*[:=]\s*)([^\r\n]+)/gi, "$1[redacted]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]")
    .replace(/\b(?:password|passphrase|secret|token|credential|session|cookie|api[_-]?key|private[_-]?key)\s*[-:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/([?&](?:access_?token|token|auth(?:orization)?|api_?key|key|secret|session(?:id)?|code|credential|password)=)[^&#\s]*/gi, "$1[redacted]");
  if (output.length > 2048 && strict) throw makePcmsError(PCMS_ERROR_CODES.RESULT_TOO_LARGE, "A result field exceeds the string limit");
  return output.length > 2048 ? `${output.slice(0, 2048)}…` : output;
}

/** Keep response/event auxiliary details useful without ever serializing secrets. */
export function sanitizePcmsValue(value, { maxBytes = MAX_PCMS_EVENT_BYTES, maxDepth = 6, strict = false } = {}) {
  const seen = new WeakSet();
  const visit = (input, depth, key = "") => {
    if (safeCookieSummary(input, key)) {
      return { count: Number(input.count || 0), bytes: Number(input.bytes || 0) };
    }
    if (sensitiveKey(key)) return "[redacted]";
    if (input == null || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "string") return sanitizeString(input, strict);
    if (typeof input !== "object") {
      if (strict) throw makePcmsError(PCMS_ERROR_CODES.RESULT_NOT_SERIALIZABLE, "Result has an unsupported value");
      return String(input);
    }
    if (depth >= maxDepth || seen.has(input) || (!Array.isArray(input) && !isPlainObject(input))) {
      if (strict) throw makePcmsError(PCMS_ERROR_CODES.RESULT_NOT_SERIALIZABLE, "Result is too deep, cyclic, or non-plain");
      return "[truncated]";
    }
    seen.add(input);
    try {
      if (Array.isArray(input)) return input.map((entry) => visit(entry, depth + 1));
      const out = {};
      for (const [childKey, child] of Object.entries(input)) out[childKey] = visit(child, depth + 1, childKey);
      return out;
    } finally {
      // Track only the current ancestor path. Repeated/shared objects are
      // valid JSON structure and must not be mistaken for cycles.
      seen.delete(input);
    }
  };
  const result = visit(value, 0);
  if (serializedSize(result) <= maxBytes) return result;
  if (strict) throw makePcmsError(PCMS_ERROR_CODES.RESULT_TOO_LARGE, "Result exceeds the response byte limit");
  return { truncated: true };
}

export function toStructuredError(error) {
  if (Array.isArray(error?.issues) && error.issues.length) {
    return {
      code: PCMS_ERROR_CODES.VALIDATION_FAILED,
      message: safeErrorMessage(PCMS_ERROR_CODES.VALIDATION_FAILED),
      retryable: false,
      details: sanitizePcmsValue({
        issues: error.issues.slice(0, 20).map((issue) => ({
          code: String(issue?.code || "validation-error").slice(0, 64),
          message: String(issue?.message || "Validation failed").slice(0, 512),
          stepIndex: Number.isInteger(issue?.stepIndex) ? issue.stepIndex : null
        }))
      }, { maxBytes: 4096, maxDepth: 4 })
    };
  }
  if (/persona name must not be empty/i.test(String(error?.message || ""))) {
    return {
      code: PCMS_ERROR_CODES.VALIDATION_FAILED,
      message: safeErrorMessage(PCMS_ERROR_CODES.VALIDATION_FAILED),
      retryable: false,
      details: { issues: [{ code: "persona-name-empty", message: "Persona name must not be empty", stepIndex: null }] }
    };
  }
  if (error instanceof PcmsError) {
    return {
      code: error.code,
      message: safeErrorMessage(error.code),
      retryable: error.retryable === true,
      details: error.details == null ? null : sanitizePcmsValue(error.details, { maxBytes: 4096, maxDepth: 3 })
    };
  }
  // Some Persona OS methods will progressively gain structured domain errors.
  if (error && typeof error.code === "string" && Object.values(PCMS_ERROR_CODES).includes(error.code)) {
    return {
      code: error.code,
      message: safeErrorMessage(error.code),
      retryable: error.retryable === true,
      details: error.details == null ? null : sanitizePcmsValue(error.details, { maxBytes: 4096, maxDepth: 3 })
    };
  }
  const message = String(error?.message || error || "");
  if (/managed persona not found|profile is not managed/i.test(message)) {
    return { code: PCMS_ERROR_CODES.PERSONA_NOT_FOUND, message: safeErrorMessage(PCMS_ERROR_CODES.PERSONA_NOT_FOUND), retryable: false, details: null };
  }
  if (/route.*missing|route.*not found/i.test(message)) {
    return { code: PCMS_ERROR_CODES.ROUTE_NOT_FOUND, message: safeErrorMessage(PCMS_ERROR_CODES.ROUTE_NOT_FOUND), retryable: false, details: null };
  }
  if (/route.*disabled/i.test(message)) {
    return { code: PCMS_ERROR_CODES.ROUTE_DISABLED, message: safeErrorMessage(PCMS_ERROR_CODES.ROUTE_DISABLED), retryable: false, details: null };
  }
  if (/direct.*allowDirect|allowDirect.*direct/i.test(message)) {
    return { code: PCMS_ERROR_CODES.DIRECT_ROUTE_REQUIRES_OPT_IN, message: safeErrorMessage(PCMS_ERROR_CODES.DIRECT_ROUTE_REQUIRES_OPT_IN), retryable: false, details: null };
  }
  if (/workflow.*not found/i.test(message)) {
    return { code: PCMS_ERROR_CODES.WORKFLOW_NOT_FOUND, message: safeErrorMessage(PCMS_ERROR_CODES.WORKFLOW_NOT_FOUND), retryable: false, details: null };
  }
  if (/job.*not found/i.test(message)) {
    return { code: PCMS_ERROR_CODES.JOB_NOT_FOUND, message: safeErrorMessage(PCMS_ERROR_CODES.JOB_NOT_FOUND), retryable: false, details: null };
  }
  return { code: PCMS_ERROR_CODES.INTERNAL_ERROR, message: "An internal PCMS error occurred", retryable: false, details: null };
}
