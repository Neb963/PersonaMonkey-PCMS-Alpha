// ADR-003 §1 browser floor. Firefox supports the manifest `sandbox` key and
// `content_security_policy.sandbox` only from 154. `strict_min_version` stays 153.0
// (ADR-003 open decision, default b), so below 154 the module runtime reports
// UNAVAILABLE while Core and the built-in modules keep working.

export const MODULE_RUNTIME_MIN_FIREFOX_MAJOR = 154;
export const MODULE_RUNTIME_CONTROLLER_PAGE = "pcms/sandbox/controller.html";
export const MODULE_RUNTIME_UI_PAGE = "pcms/sandbox/module-ui.html";

export const MODULE_RUNTIME_AVAILABILITY = Object.freeze({
  AVAILABLE: "AVAILABLE",
  UNAVAILABLE: "UNAVAILABLE"
});

export const MODULE_RUNTIME_UNAVAILABLE_REASONS = Object.freeze({
  BROWSER_UNKNOWN: "BROWSER_UNKNOWN",
  BROWSER_UNSUPPORTED: "BROWSER_UNSUPPORTED",
  BROWSER_TOO_OLD: "BROWSER_TOO_OLD",
  SANDBOX_NOT_DECLARED: "SANDBOX_NOT_DECLARED",
  SANDBOX_CSP_UNSAFE: "SANDBOX_CSP_UNSAFE",
  SANDBOX_NOT_ISOLATED: "SANDBOX_NOT_ISOLATED"
});

const REASONS = MODULE_RUNTIME_UNAVAILABLE_REASONS;
const MESSAGES = Object.freeze({
  [REASONS.BROWSER_UNKNOWN]: "Requires Firefox 154+ (browser version unknown)",
  [REASONS.BROWSER_UNSUPPORTED]: "Requires Firefox 154+",
  [REASONS.BROWSER_TOO_OLD]: "Requires Firefox 154+",
  [REASONS.SANDBOX_NOT_DECLARED]: "The controller sandbox page is not declared",
  [REASONS.SANDBOX_CSP_UNSAFE]: "The sandbox content security policy is not isolating",
  [REASONS.SANDBOX_NOT_ISOLATED]: "The controller page did not load as an isolated sandbox"
});

function unavailable(reason, browser = null) {
  return Object.freeze({
    state: MODULE_RUNTIME_AVAILABILITY.UNAVAILABLE,
    reason,
    message: MESSAGES[reason],
    browser
  });
}

export function parseFirefoxMajor(version) {
  if (typeof version !== "string") return null;
  const match = /^(\d{1,4})\.\d+/.exec(version);
  return match ? Number(match[1]) : null;
}

function browserSummary(info) {
  if (!info || typeof info !== "object") return null;
  const name = typeof info.name === "string" ? info.name.slice(0, 64) : null;
  const version = typeof info.version === "string" ? info.version.slice(0, 64) : null;
  return Object.freeze({ name, version, major: parseFirefoxMajor(version) });
}

// Exact sandbox CSP checks: every page must stay script-only toward the
// extension, without same-origin, network, nested frames or workers.
export function assessSandboxCsp(csp) {
  if (typeof csp !== "string" || !csp.trim()) return false;
  const directives = new Map();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const name = tokens[0].toLowerCase();
    if (directives.has(name)) return false;
    directives.set(name, tokens.slice(1));
  }
  const sandbox = directives.get("sandbox");
  if (!sandbox || sandbox.join(" ") !== "allow-scripts") return false;
  if ((directives.get("default-src") || []).join(" ") !== "'none'") return false;
  for (const name of ["connect-src", "frame-src", "child-src", "worker-src", "object-src", "base-uri", "form-action"]) {
    if ((directives.get(name) || []).join(" ") !== "'none'") return false;
  }
  for (const [, sources] of directives) {
    for (const source of sources) {
      const lower = source.toLowerCase();
      if (lower === "*" || lower === "allow-same-origin" || lower.includes("://")
          || /^(?:https?|wss?|blob|filesystem):?$/.test(lower)) return false;
    }
  }
  return true;
}

export function assessSandboxManifest(manifest) {
  const pages = manifest?.sandbox?.pages;
  if (!Array.isArray(pages) || !pages.includes(MODULE_RUNTIME_CONTROLLER_PAGE)) {
    return REASONS.SANDBOX_NOT_DECLARED;
  }
  if (!assessSandboxCsp(manifest?.content_security_policy?.sandbox)) return REASONS.SANDBOX_CSP_UNSAFE;
  return null;
}

// Pure floor decision from runtime.getBrowserInfo() and runtime.getManifest().
export function evaluateModuleRuntimeFloor({ browserInfo, manifest }) {
  const summary = browserSummary(browserInfo);
  if (!summary || !summary.name || summary.major === null) return unavailable(REASONS.BROWSER_UNKNOWN, summary);
  if (summary.name !== "Firefox") return unavailable(REASONS.BROWSER_UNSUPPORTED, summary);
  if (summary.major < MODULE_RUNTIME_MIN_FIREFOX_MAJOR) return unavailable(REASONS.BROWSER_TOO_OLD, summary);
  const manifestProblem = assessSandboxManifest(manifest);
  if (manifestProblem) return unavailable(manifestProblem, summary);
  return Object.freeze({ state: MODULE_RUNTIME_AVAILABILITY.AVAILABLE, reason: null, message: null, browser: summary });
}

// Startup feature detection. `probeIsolation` (optional) loads the declared
// controller page once and must resolve true only for an opaque-origin frame.
// Any failure reports UNAVAILABLE; it never throws into Core start-up.
export function createModuleRuntimeSupport({ getBrowserInfo, getManifest, probeIsolation = null } = {}) {
  if (typeof getBrowserInfo !== "function" || typeof getManifest !== "function") {
    throw new TypeError("Module runtime support requires getBrowserInfo and getManifest");
  }
  if (probeIsolation !== null && typeof probeIsolation !== "function") {
    throw new TypeError("Module runtime isolation probe is invalid");
  }
  let pending = null;

  async function detect() {
    let browserInfo = null;
    try { browserInfo = await getBrowserInfo(); } catch { browserInfo = null; }
    let manifest = null;
    try { manifest = await getManifest(); } catch { manifest = null; }
    const floor = evaluateModuleRuntimeFloor({ browserInfo, manifest });
    if (floor.state !== MODULE_RUNTIME_AVAILABILITY.AVAILABLE || !probeIsolation) return floor;
    let isolated = false;
    try { isolated = (await probeIsolation()) === true; } catch { isolated = false; }
    return isolated ? floor : unavailable(REASONS.SANDBOX_NOT_ISOLATED, floor.browser);
  }

  return Object.freeze({
    getStatus() {
      if (!pending) pending = detect();
      return pending;
    }
  });
}
