import { BLOCK_ROUTE_ID, DIRECT_ROUTE_ID, BLACKHOLE_PROXY } from "./constants.js";

export function isExtensionOrigin(details, extensionBaseUrl) {
  const target = String(details?.url || "");
  if (target.startsWith(extensionBaseUrl)) return true;

  // A top-level http(s) navigation can be initiated by the extension (for
  // example workflow tabs opened through browser.tabs.update()) while still
  // belonging to a managed contextual identity. That navigation must pass
  // through persona routing rather than inheriting the extension's direct
  // networking exemption.
  if (details?.type === "main_frame" && Number(details?.tabId) >= 0) return false;

  const fields = [details?.documentUrl, details?.originUrl, details?.initiator];
  return fields.some((v) => typeof v === "string" && v.startsWith(extensionBaseUrl));
}

function isReservedIPv4(host) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) return false;
  const octets = host.split(".").map(Number);
  if (octets.some((n) => n < 0 || n > 255)) return false;
  if (octets[0] === 10 || octets[0] === 127 || octets[0] === 0) return true;
  if (octets[0] === 169 && octets[1] === 254) return true;
  if (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) return true;
  if (octets[0] === 192 && octets[1] === 168) return true;
  if (octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127) return true;
  return octets[0] >= 224;
}

function mappedIPv4(host) {
  let address = host;
  if (address.includes(".")) {
    const splitAt = address.lastIndexOf(":");
    const tail = address.slice(splitAt + 1);
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return null;
    const octets = tail.split(".").map(Number);
    if (octets.some((n) => n < 0 || n > 255)) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    address = `${address.slice(0, splitAt + 1)}${high}:${low}`;
  }

  const halves = address.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeroCount = 8 - left.length - right.length;
  if ((halves.length === 1 && zeroCount !== 0) || (halves.length === 2 && zeroCount < 1)) return null;
  const groups = [...left, ...Array(halves.length === 2 ? zeroCount : 0).fill("0"), ...right];
  if (groups.length !== 8 || groups.some((part) => !/^[0-9a-f]{1,4}$/i.test(part))) return null;
  const values = groups.map((part) => Number.parseInt(part, 16));
  if (values.slice(0, 5).some((value) => value !== 0) || values[5] !== 0xffff) return null;
  return `${values[6] >> 8}.${values[6] & 255}.${values[7] >> 8}.${values[7] & 255}`;
}

export function isLocalOrReservedHost(hostname) {
  if (!hostname) return false;
  let host = String(hostname).toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost")) return true;

  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return isReservedIPv4(host);
  }

  if (host.includes(":")) {
    const mapped = mappedIPv4(host);
    if (mapped && isReservedIPv4(mapped)) return true;
    if (host === "::1" || host === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(host)) return true;
    if (/^fe[89ab][0-9a-f]:/i.test(host)) return true;
    if (/^ff/i.test(host)) return true;
  }
  return false;
}

export function hostMatchesRule(host, rule) {
  host = String(host || "").toLowerCase().replace(/\.$/, "");
  rule = String(rule || "").trim().toLowerCase().replace(/^https?:\/\//, "");
  if (!rule || !host) return false;
  rule = rule.split("/")[0].split(":")[0].replace(/\.$/, "");
  if (rule === "*" || rule === "<all_urls>") return true;
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  if (rule.startsWith(".")) {
    const suffix = rule.slice(1);
    return host === suffix || host.endsWith(`.${suffix}`);
  }
  return host === rule;
}

export function profileAllowsUrl(profile, url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { allowed: true, reason: "non-url" };
  }

  if (!["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) {
    return { allowed: true, reason: "non-network-scheme" };
  }

  if (profile.blockLocalNetwork && isLocalOrReservedHost(parsed.hostname)) {
    return { allowed: false, reason: "local-network-blocked" };
  }

  const blocked = (profile.blockedDomains || []).some((rule) => hostMatchesRule(parsed.hostname, rule));
  if (blocked) return { allowed: false, reason: "blocked-domain" };

  if (profile.domainMode === "allowlist") {
    const allowed = (profile.allowedDomains || []).some((rule) => hostMatchesRule(parsed.hostname, rule));
    return allowed
      ? { allowed: true, reason: "allowlist-match" }
      : { allowed: false, reason: "not-on-allowlist" };
  }

  return { allowed: true, reason: "allowed" };
}

function basicAuth(username, password) {
  if (!username && !password) return undefined;
  const raw = `${username || ""}:${password || ""}`;
  const bytes = new TextEncoder().encode(raw);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return `Basic ${btoa(binary)}`;
}

export function buildProxyInfo(route, isolationKey) {
  if (!route || route.enabled === false || !route.host || !route.port) {
    return [{ ...BLACKHOLE_PROXY, connectionIsolationKey: isolationKey || BLACKHOLE_PROXY.connectionIsolationKey }, null];
  }

  const info = {
    type: route.type,
    host: route.host,
    port: Number(route.port),
    failoverTimeout: 2,
    connectionIsolationKey: isolationKey || undefined
  };

  if (route.type === "socks") {
    info.proxyDNS = route.proxyDNS !== false;
    if (route.username) info.username = route.username;
    if (route.password) info.password = route.password;
  } else if (route.username || route.password) {
    info.proxyAuthorizationHeader = basicAuth(route.username, route.password);
  }

  return [info, null];
}

export function routeDecision(state, details) {
  const profile = state.profiles?.[details.cookieStoreId];
  if (!profile || profile.managed === false) {
    if (state.global.unmanagedPolicy === "block") {
      return { mode: "block", reason: "unmanaged-container", profile: null, route: null };
    }
    return { mode: "unmanaged-direct", reason: "unmanaged-container", profile: null, route: null };
  }

  const urlPolicy = profileAllowsUrl(profile, details.url);
  if (!urlPolicy.allowed) {
    return { mode: "block", reason: urlPolicy.reason, profile, route: null };
  }

  if (profile.routeId === BLOCK_ROUTE_ID || !profile.routeId) {
    return { mode: "block", reason: "profile-block-route", profile, route: null };
  }

  if (profile.routeId === DIRECT_ROUTE_ID) {
    return { mode: "direct", reason: "direct-route", profile, route: null };
  }

  const route = state.routes?.[profile.routeId];
  if (!route || route.enabled === false) {
    if (profile.killSwitch !== false) {
      return { mode: "block", reason: "route-missing-or-disabled", profile, route: null };
    }
    return { mode: "direct", reason: "kill-switch-disabled-fallback", profile, route: null };
  }

  return { mode: "proxy", reason: "configured-route", profile, route };
}

export function proxyInfoMatches(actual, route) {
  if (!actual || !route) return false;
  const actualType = actual.type === "socks5" ? "socks" : actual.type;
  if (actualType !== route.type) return false;
  if (String(actual.host || "").toLowerCase() !== String(route.host || "").toLowerCase()) return false;
  if (Number(actual.port) !== Number(route.port)) return false;
  if (route.type === "socks" && route.proxyDNS !== false && actual.proxyDNS !== true) return false;
  return true;
}

export function directInfoIsDirect(actual) {
  return !actual || actual.type === "direct";
}

export function globToRegExp(glob) {
  const escaped = String(glob)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function matchPattern(url, pattern) {
  if (pattern === "<all_urls>") return /^(https?|file|ftp|ws|wss):/i.test(url);
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  const m = String(pattern).match(/^(\*|http|https|file|ftp|ws|wss):\/\/([^/]*)(\/.*)$/i);
  if (!m) return false;
  const [, scheme, hostPattern, pathPattern] = m;
  if (scheme !== "*" && parsed.protocol !== `${scheme.toLowerCase()}:`) return false;
  if (scheme === "*" && !["http:", "https:", "ws:", "wss:"].includes(parsed.protocol)) return false;

  if (hostPattern) {
    if (hostPattern === "*") {
      // any host
    } else if (hostPattern.startsWith("*.")) {
      const suffix = hostPattern.slice(2).toLowerCase();
      const host = parsed.hostname.toLowerCase();
      if (!(host === suffix || host.endsWith(`.${suffix}`))) return false;
    } else if (parsed.hostname.toLowerCase() !== hostPattern.toLowerCase()) {
      return false;
    }
  }

  return globToRegExp(pathPattern).test(`${parsed.pathname}${parsed.search}${parsed.hash}`);
}

export function userScriptMatches(script, url) {
  const hasIncludes = Boolean(script.includes?.length);
  const matches = script.matches?.length ? script.matches : (hasIncludes ? [] : ["*://*/*"]);
  let included = matches.some((p) => matchPattern(url, p));
  if (!included && hasIncludes) {
    included = script.includes.some((p) => {
      try { return globToRegExp(p).test(url); } catch { return false; }
    });
  }
  if (!included) return false;
  if (script.excludeMatches?.some((p) => matchPattern(url, p))) return false;
  if (script.excludes?.some((p) => {
    try { return globToRegExp(p).test(url); } catch { return false; }
  })) return false;
  return true;
}

function declaredHostPatterns(script) {
  if (script?.hostScopeDeclared !== true) return [];
  const patterns = [];
  for (const pattern of script.matches || []) {
    if (pattern === "<all_urls>") {
      patterns.push("*");
      continue;
    }
    const match = String(pattern).match(/^(?:\*|https?|wss?|ftp|file):\/\/([^/]*)(?:\/.*)?$/i);
    if (match && match[1]) patterns.push(match[1].toLowerCase());
  }
  for (const include of script.includes || []) {
    const value = String(include || "").trim();
    if (value === "<all_urls>") {
      patterns.push("*");
      continue;
    }
    // @include accepts arbitrary globs. Only URL-shaped host rules are safe
    // to use as cookie authority; regex-like and otherwise ambiguous forms
    // remain usable for matching but grant no cookie host access.
    const withScheme = value.match(/^(?:\*|https?|wss?|ftp):\/\/([^/]+)(?:\/.*)?$/i);
    const bare = value.match(/^((?:\*\.)?[a-z0-9.-]+)(?:\/.*)?$/i);
    const host = withScheme?.[1] || bare?.[1];
    if (!host || (host !== "*" && !/^(?:\*\.)?[a-z0-9.-]+$/i.test(host))) continue;
    patterns.push(host.toLowerCase());
  }
  return patterns;
}

function hostPatternAllows(hostPattern, host) {
  const pattern = String(hostPattern || "").toLowerCase().replace(/\.$/, "");
  const candidate = String(host || "").toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!pattern || !candidate) return false;
  if (pattern === "*") return true;
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(2);
    return candidate === suffix || candidate.endsWith(`.${suffix}`);
  }
  return candidate === pattern;
}

function hostnameFromUrlOrHost(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname;
  } catch {
    return "";
  }
}

export function userScriptHostAllowed(script, urlOrHost) {
  const host = hostnameFromUrlOrHost(urlOrHost);
  if (!host) return false;
  return declaredHostPatterns(script).some((pattern) => hostPatternAllows(pattern, host));
}

export function userScriptCookieDomainAllowed(script, domain) {
  const value = String(domain || "").trim();
  if (!value) return false;
  const includesSubdomains = value.startsWith(".");
  const host = hostnameFromUrlOrHost(value.replace(/^\./, ""));
  if (!host) return false;
  return declaredHostPatterns(script).some((pattern) => {
    if (!hostPatternAllows(pattern, host)) return false;
    if (!includesSubdomains) return true;
    return pattern === "*" || pattern.startsWith("*.");
  });
}
