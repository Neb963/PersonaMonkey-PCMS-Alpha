import { PCMS_ERROR_CODES, makePcmsError, sanitizePcmsValue, serializedSize } from "./pcms-protocol.js";

const PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;
const RESPONSE_BYTES = 256 * 1024;
const COLLECTION_BYTES = 8 * 1024 * 1024;
const CURSOR_KEY = crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)),
  { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
const encoder = new TextEncoder();

function invalidPage() {
  throw makePcmsError(PCMS_ERROR_CODES.PAGE_INVALID, "Invalid management page request");
}

function cursorPayload(value) {
  return { v: value.v, bootId: value.bootId, revision: value.revision, command: value.command,
    digest: value.digest, offset: value.offset, size: value.size };
}

function toHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function fromHex(value) {
  return Uint8Array.from(value.match(/.{2}/g), (byte) => Number.parseInt(byte, 16));
}

async function encodeCursor(payload) {
  const signature = await crypto.subtle.sign("HMAC", await CURSOR_KEY, encoder.encode(JSON.stringify(payload)));
  return btoa(JSON.stringify({ ...payload, signature: toHex(signature) }))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function decodeCursor(cursor, bootId) {
  if (typeof cursor !== "string" || !cursor || cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) invalidPage();
  let value;
  try {
    value = JSON.parse(atob(cursor.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { invalidPage(); }
  const hasSignature = Object.hasOwn(value || {}, "signature");
  if (!value || value.v !== 1 || typeof value.bootId !== "string" || !Number.isInteger(value.revision) ||
      typeof value.command !== "string" || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest) ||
      !Number.isInteger(value.offset) || value.offset < 1 || !Number.isInteger(value.size) ||
      value.size < 1 || value.size > MAX_PAGE_SIZE ||
      (hasSignature && (typeof value.signature !== "string" || !/^[a-f0-9]{64}$/.test(value.signature))) ||
      Object.keys(value).length !== (hasSignature ? 8 : 7)) invalidPage();
  // A cursor from an earlier worker has a different ephemeral signing key; preserve the documented stale result across restarts.
  if (value.bootId !== bootId) {
    throw makePcmsError(PCMS_ERROR_CODES.PAGE_STALE, "Management page is stale; restart the query", { retryable: true });
  }
  // Legacy v1 cursors can only be treated as stale after a restart; they are never trusted within the current worker.
  if (!hasSignature) invalidPage();
  const payload = cursorPayload(value);
  let valid = false;
  try {
    valid = await crypto.subtle.verify("HMAC", await CURSOR_KEY, fromHex(value.signature), encoder.encode(JSON.stringify(payload)));
  } catch { invalidPage(); }
  if (!valid) invalidPage();
  return { ...payload, signature: value.signature };
}

async function digestCollection(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > COLLECTION_BYTES) throw makePcmsError(PCMS_ERROR_CODES.RESULT_TOO_LARGE, "Collection exceeds the pagination snapshot limit");
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Page a complete, sanitized snapshot. Cursors become stale on any collection change, including job-only updates. */
export async function paginatePcmsCollection(rows, { page, command, bootId, revision }) {
  if (!Array.isArray(rows)) throw makePcmsError(PCMS_ERROR_CODES.RESULT_NOT_SERIALIZABLE, "List service did not return an array");
  const ordered = rows.map((item, index) => ({ item, index })).sort((a, b) => {
    const left = String(a.item?.id ?? a.item?.personaUid ?? a.item?.jobId ?? "");
    const right = String(b.item?.id ?? b.item?.personaUid ?? b.item?.jobId ?? "");
    return left < right ? -1 : left > right ? 1 : a.index - b.index;
  }).map(({ item }) => item);
  if (page === undefined) return ordered;
  if (!page || typeof page !== "object" || Array.isArray(page) || Object.keys(page).some((key) => !["size", "cursor"].includes(key))) invalidPage();
  const size = page.size ?? PAGE_SIZE;
  if ((Object.hasOwn(page, "size") && page.size == null) || !Number.isInteger(size) || size < 1 || size > MAX_PAGE_SIZE) invalidPage();
  const cursor = page.cursor === undefined ? null : await decodeCursor(page.cursor, bootId);
  if (cursor && (cursor.command !== command || cursor.size !== size)) invalidPage();

  // Snapshot the redacted public projection so a changed job result cannot be missed by a state-only revision.
  const sanitized = sanitizePcmsValue(ordered, { maxBytes: Infinity, maxDepth: 16, strict: true });
  const digest = await digestCollection(sanitized);
  if (cursor && (cursor.bootId !== bootId || cursor.revision !== revision || cursor.digest !== digest)) {
    throw makePcmsError(PCMS_ERROR_CODES.PAGE_STALE, "Management page is stale; restart the query", { retryable: true });
  }
  const offset = cursor?.offset ?? 0;
  if (cursor && offset >= sanitized.length) invalidPage();
  if (!sanitized.length) return { items: [], hasMore: false, nextCursor: null };
  // Page size is a maximum; shrink a page if its complete response would exceed the transport budget.
  let end = Math.min(offset + size, sanitized.length);
  while (end > offset && serializedSize({ items: sanitized.slice(offset, end), hasMore: true, nextCursor: "x".repeat(512) }) > RESPONSE_BYTES) end -= 1;
  if (end === offset) throw makePcmsError(PCMS_ERROR_CODES.RESULT_TOO_LARGE, "One list item exceeds the page limit");
  const hasMore = end < sanitized.length;
  return { items: sanitized.slice(offset, end), hasMore,
    nextCursor: hasMore ? await encodeCursor({ v: 1, bootId, revision, command, digest, offset: end, size }) : null };
}
