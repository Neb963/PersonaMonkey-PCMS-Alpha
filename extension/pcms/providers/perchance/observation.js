// generator.observe/v2. Only the reviewed driver can supply a hash-only result;
// page content is never copied into ordinary state, receipts, audit or diagnostics.
import { generatorPayloadHash, isSha256Hex, thumbnailHash } from "./contract.js";
import { parseGeneratorListing } from "./listing.js";
import { PERCHANCE_PROVIDER_ERROR_CODES as E, perchanceProviderError } from "./errors.js";

function fail() { throw perchanceProviderError(E.PROTOCOL); }
function data(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
      || Object.getOwnPropertySymbols(raw).length) fail();
  const descriptors = Object.getOwnPropertyDescriptors(raw);
  for (const [key, d] of Object.entries(descriptors)) {
    if (!["exists", "challenge", "code", "html", "thumbnail", "settings", "payloadHash", "thumbnailHash"].includes(key)
        || !d.enumerable || !Object.hasOwn(d, "value")) fail();
  }
  return Object.fromEntries(Object.entries(descriptors).map(([k, d]) => [k, d.value]));
}

export async function normalizeProviderObservation(raw, { includeContent = false } = {}) {
  const value = data(raw);
  if (![true, false, null].includes(value.exists) || typeof value.challenge !== "boolean") fail();
  // A challenge never proves existence, content or listing, even when a stale editor is visible.
  if (value.challenge || value.exists !== true) {
    if (value.exists === null && !value.challenge) fail();
    return Object.freeze({ exists:value.challenge ? null : false, payloadHash:null,
      thumbnailHash:null, listing:"UNKNOWN", challenge:value.challenge });
  }
  const hasContent = typeof value.code === "string" && typeof value.html === "string";
  if (!hasContent && (value.code != null || value.html != null)) fail();
  let payloadHash;
  try { payloadHash = hasContent ? await generatorPayloadHash(value.code, value.html) : value.payloadHash; }
  catch { fail(); }
  if (!isSha256Hex(payloadHash) || (value.payloadHash != null && value.payloadHash !== payloadHash)) fail();
  let thumb = value.thumbnailHash ?? null;
  if (value.thumbnail != null) {
    try { thumb = await thumbnailHash(value.thumbnail); } catch { fail(); }
    if (value.thumbnailHash != null && thumb !== value.thumbnailHash) fail();
  }
  if (thumb !== null && !isSha256Hex(thumb)) fail();
  if (includeContent && !hasContent) fail(); // Oversized/omitted comparison fails closed.
  return Object.freeze({ exists:true, payloadHash, thumbnailHash:thumb,
    listing:parseGeneratorListing(value.settings), challenge:false,
    ...(includeContent ? { content:Object.freeze({ code:value.code, html:value.html, thumbnail:value.thumbnail ?? null }) } : {}) });
}
