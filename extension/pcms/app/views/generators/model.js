// Pure helpers for the Generators views (P036). No DOM, no network, no storage.
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
const BUSY = new Set(["ACTIVE", "RECONCILE", "RETRYABLE"]);
export const GENERATOR_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const GENERATOR_MAX_THUMBNAIL_BYTES = 1024 * 1024;
export const LISTING_CHOICES = Object.freeze([
  Object.freeze({ value:"PUBLICLY_LISTED", label:"Publicly listed" }),
  Object.freeze({ value:"UNLISTED", label:"Unlisted" })
]);

export function listingLabel(listing) {
  if (listing === "PUBLICLY_LISTED") return "Publicly listed";
  if (listing === "UNLISTED") return "Unlisted";
  return "Not managed by PCMS";
}

// The operator names a generator by its Perchance address, never by an internal ID:
// "tavern-names", "perchance.org/tavern-names" or "https://perchance.org/tavern-names".
export function parsePerchanceAddress(raw) {
  if (typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text || text.length > 300) return null;
  text = text.replace(/^https?:\/\//i, "").replace(/^(?:www\.)?perchance\.org\//i, "");
  text = text.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return SLUG.test(text) ? text : null;
}

export function deploymentIdForSlug(slug) {
  if (!SLUG.test(String(slug))) throw new TypeError("Generator address is invalid");
  return "gen:" + slug;
}

// Byte-exact UTF-8 (payload identity is over the bytes as uploaded): invalid UTF-8 and NUL are
// rejected, and a BOM is kept rather than silently stripped.
// Realm-independent (a File read can yield bytes from another JS realm, where instanceof fails).
function isBytes(value) {
  return Object.prototype.toString.call(value) === "[object Uint8Array]";
}

export function decodeUtf8Exact(bytes, label) {
  if (!isBytes(bytes)) throw new TypeError(label + " could not be read");
  let text;
  try { text = new TextDecoder("utf-8", { fatal:true, ignoreBOM:true }).decode(bytes); }
  catch { throw new TypeError(label + " is not valid UTF-8 text"); }
  if (text.includes("\u0000")) throw new TypeError(label + " contains a NUL character");
  return text;
}

export function isJpeg(bytes) {
  return isBytes(bytes) && bytes.byteLength >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

export function bytesToBase64(bytes) {
  let binary = "";
  for (let index = 0; index < bytes.byteLength; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
}

// Human-checkable evidence instead of a hash (02 §5.3 confirm page).
export function payloadEvidence(code, html) {
  const firstLine = (code.split(/\r?\n/, 1)[0] || "").slice(0, 120);
  return Object.freeze({ firstLine, codeChars:code.length, htmlChars:html.length });
}

export function validateDraft({ code, html, thumbnailBytes = null, listing }) {
  const encoder = new TextEncoder();
  if (typeof code !== "string" || code.length === 0) throw new TypeError("Choose the code panel file");
  if (typeof html !== "string") throw new TypeError("HTML panel is invalid");
  if (encoder.encode(code).byteLength + encoder.encode(html).byteLength > GENERATOR_MAX_SOURCE_BYTES) throw new TypeError("Code and HTML are larger than 4 MiB");
  if (thumbnailBytes !== null && (!isJpeg(thumbnailBytes) || thumbnailBytes.byteLength > GENERATOR_MAX_THUMBNAIL_BYTES)) {
    throw new TypeError("The thumbnail must be a JPEG of at most 1 MiB");
  }
  if (!LISTING_CHOICES.some((choice) => choice.value === listing)) throw new TypeError("Choose how the generator is listed");
  return true;
}

// What a manual "Deploy from file" needs to do for the current Deployer record. UNCERTAIN is
// never replayed: a busy operation must be checked (reconciled) first.
export function manualDeployPlan(deployment, intent) {
  if (!deployment) return Object.freeze({ step:"create" });
  const status = deployment.operation.status;
  if (status === "RECONCILE" || status === "ACTIVE") return Object.freeze({ step:"blocked", reason:"The last deployment's outcome is unknown. Check Perchance first; nothing is retried until you answer." });
  const desired = deployment.desired;
  const same = desired.payloadKind === "v2-release" && desired.payloadHash === intent.payloadHash
    && desired.thumbnailHash === intent.thumbnailHash && desired.listing === intent.listing;
  if (!same) {
    if (BUSY.has(status)) return Object.freeze({ step:"blocked", reason:"A previous deployment must be finished first." });
    return Object.freeze({ step:"setDesired" });
  }
  if (status === "FAILED" || status === "CANCELLED") return Object.freeze({ step:"retry" });
  if (status === "SUCCEEDED") return Object.freeze({ step:"none", reason:"This content is already deployed." });
  return Object.freeze({ step:"deploy" });
}

export function originLabel(origin) {
  if (!origin) return "—";
  return origin.kind === "REPOSITORY" ? "Release " + origin.version : "Uploaded manually";
}

export function shortTime(iso) {
  if (typeof iso !== "string") return "never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

export function generatorDeployError(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (code === "PCMS_DEPLOYER_REVISION_CONFLICT") return "Deployer data changed in another tab. Review and try again.";
  if (code === "PCMS_DEPLOYER_ACCOUNT_UNAVAILABLE") return "The account is unavailable. Fix its Persona binding first.";
  if (code === "PCMS_DEPLOYER_PROVIDER_UNAVAILABLE") return "Perchance is unavailable for this account.";
  if (code === "PCMS_DEPLOYER_TARGET_CONFLICT") return "This generator is already managed by another deployment.";
  if (code === "PCMS_DEPLOYER_CONTENT_MISMATCH") return "The files changed while preparing the deployment. Choose them again.";
  if (code === "PCMS_RECOVERY_HOLD" || code === "PCMS_REMOTE_OP_RECOVERY_HOLD") return "On hold until recovery checks finish.";
  return typeof error?.message === "string" && error.message ? error.message : "The deployment could not be started.";
}
