import { normalizeStringArray } from "./storage.js";

function metaHeader(text) {
  const start = text.indexOf("// ==UserScript==");
  const end = text.indexOf("// ==/UserScript==");
  return start >= 0 && end > start ? text.slice(start, end + "// ==/UserScript==".length) : "";
}

function linesForKey(header, key) {
  const re = new RegExp(`^\\s*//\\s*@${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\s*(.*?)\\s*$`, "gmi");
  const values = [];
  let m;
  while ((m = re.exec(header))) values.push(m[1].trim());
  return values;
}

function first(header, keys, fallback = "") {
  for (const key of keys) {
    const value = linesForKey(header, key)[0];
    if (value) return value;
  }
  return fallback;
}

function parseResources(header) {
  const resources = {};
  for (const line of linesForKey(header, "resource")) {
    const match = line.match(/^(\S+)\s+(.+)$/);
    if (match) resources[match[1]] = match[2].trim();
  }
  return resources;
}

export const SUPPORTED_GRANTS = Object.freeze(new Set([
  "none",
  "unsafeWindow",
  "window.close",
  "window.focus",
  "GM_info",
  "GM_cookie",
  "GM_getTabData",
  "GM_saveTabData",
  "GM_getTabsData",
  "Persona.signal",
  "Persona.input",
  "GM_getValue",
  "GM_getValues",
  "GM_setValue",
  "GM_setValues",
  "GM_deleteValue",
  "GM_deleteValues",
  "GM_listValues",
  "GM_addValueChangeListener",
  "GM_removeValueChangeListener",
  "GM_getResourceText",
  "GM_getResourceURL",
  "GM_addElement",
  "GM_addStyle",
  "GM_openInTab",
  "GM_registerMenuCommand",
  "GM_unregisterMenuCommand",
  "GM_notification",
  "GM_setClipboard",
  "GM_xmlhttpRequest",
  "GM_download",
  "GM.info",
  "GM.cookie",
  "GM.getTabData",
  "GM.saveTabData",
  "GM.getTabsData",
  "GM.getValue",
  "GM.getValues",
  "GM.setValue",
  "GM.setValues",
  "GM.deleteValue",
  "GM.deleteValues",
  "GM.listValues",
  "GM.addValueChangeListener",
  "GM.removeValueChangeListener",
  "GM.getResourceText",
  "GM.getResourceUrl",
  "GM.getResourceURL",
  "GM.addElement",
  "GM.addStyle",
  "GM.openInTab",
  "GM.registerMenuCommand",
  "GM.unregisterMenuCommand",
  "GM.notification",
  "GM.setClipboard",
  "GM.xmlHttpRequest",
  "GM.xmlhttpRequest",
  "GM.download"
]));

export function analyzeGrants(grants = []) {
  const normalized = normalizeStringArray(grants);
  const unsupported = normalized.filter((grant) => !SUPPORTED_GRANTS.has(grant));
  return {
    supported: normalized.filter((grant) => SUPPORTED_GRANTS.has(grant)),
    unsupported,
    compatible: unsupported.length === 0
  };
}

export function parseUserscriptMetadata(code, fallbackName = "Imported userscript") {
  const text = String(code || "");
  const header = metaHeader(text);
  const name = first(header, ["name"], fallbackName);
  const description = first(header, ["description"]);
  const matches = linesForKey(header, "match");
  const excludeMatches = linesForKey(header, "exclude-match");
  const includes = linesForKey(header, "include");
  const excludes = linesForKey(header, "exclude");
  const runAtRaw = first(header, ["run-at"], "document-idle").toLowerCase();
  const runAt = ({
    "document-start": "document_start",
    "document-body": "document_end",
    "document-end": "document_end",
    "document-idle": "document_idle"
  })[runAtRaw] || "document_idle";
  const noframes = /^\s*\/\/\s*@noframes\b/mi.test(header);
  const unwrap = /^\s*\/\/\s*@unwrap\b/mi.test(header);
  const grants = normalizeStringArray(linesForKey(header, "grant"));
  const injectIntoRaw = first(header, ["inject-into"], "auto").toLowerCase();
  const injectInto = ["auto", "page", "content"].includes(injectIntoRaw) ? injectIntoRaw : "auto";
  const compatibility = analyzeGrants(grants);

  return {
    name,
    namespace: first(header, ["namespace"]),
    version: first(header, ["version"]),
    description,
    author: first(header, ["author"]),
    homepageURL: first(header, ["homepageURL", "homepage", "website"]),
    supportURL: first(header, ["supportURL"]),
    updateURL: first(header, ["updateURL"]),
    downloadURL: first(header, ["downloadURL"]),
    icon: first(header, ["icon", "iconURL", "defaulticon"]),
    matches: matches.length || includes.length ? normalizeStringArray(matches) : ["*://*/*"],
    hostScopeDeclared: matches.length > 0 || includes.length > 0,
    excludeMatches: normalizeStringArray(excludeMatches),
    includes: normalizeStringArray(includes),
    excludes: normalizeStringArray(excludes),
    runAt,
    allFrames: !noframes,
    grants,
    requires: normalizeStringArray(linesForKey(header, "require")),
    resources: parseResources(header),
    connects: normalizeStringArray(linesForKey(header, "connect")),
    tags: normalizeStringArray(linesForKey(header, "tag")),
    injectInto,
    unwrap,
    // Keep the import preview's disclosure in the same precedence order as
    // shouldUseMainWorld(), so @inject-into content overrides @grant none.
    world: unwrap || injectInto === "page"
      ? "MAIN"
      : injectInto === "content"
        ? "USER_SCRIPT"
        : grants.includes("none") ? "MAIN" : "USER_SCRIPT",
    compatibility,
    metaBlock: header
  };
}

export function makeScriptId(name = "script") {
  const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "script";
  return `${slug}-${crypto.randomUUID().slice(0, 8)}`;
}

const scriptWorldIds = new Map();

export async function worldIdForScript(scriptId) {
  if (typeof scriptId !== "string" || !scriptId) throw new Error("Userscript ID is required to derive its isolated world");
  let pending = scriptWorldIds.get(scriptId);
  if (!pending) {
    pending = crypto.subtle.digest("SHA-256", new TextEncoder().encode(scriptId)).then((digest) => {
      const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
      return `persona-${hex}`;
    }).catch((error) => {
      scriptWorldIds.delete(scriptId);
      throw error;
    });
    scriptWorldIds.set(scriptId, pending);
    if (scriptWorldIds.size > 1024) scriptWorldIds.delete(scriptWorldIds.keys().next().value);
  }
  return pending;
}

export function shouldUseMainWorld(script) {
  if (script.unwrap) return true;
  if (script.injectInto === "page") return true;
  if (script.injectInto === "content") return false;
  return script.grants?.includes("none") === true;
}
