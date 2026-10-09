function clone(value) {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
}

function normalizeDomain(value) {
  return String(value || "").trim().replace(/^\.+/, "").toLowerCase();
}

function cookieUrl(cookie = {}) {
  const host = normalizeDomain(cookie.domain);
  if (!host) throw new Error("Cookie domain is required");
  const path = String(cookie.path || "/").startsWith("/") ? String(cookie.path || "/") : `/${cookie.path}`;
  return `${cookie.secure ? "https" : "http"}://${host}${path}`;
}

function isFirstPartyDomain(value) {
  // Firefox exposes the origin attribute as a domain; empty means FPI is off.
  if (value === "") return true;
  if (typeof value !== "string" || value !== value.trim() || value.startsWith(".")
    || /[/?#@]/.test(value)
    || (value.includes(":") && !(value.startsWith("[") && value.endsWith("]")))) return false;
  try {
    const url = new URL(`https://${value}`);
    return Boolean(url.hostname)
      && !url.username
      && !url.password
      && !url.port
      && url.pathname === "/"
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function normalizeIsolationMetadata(cookie = {}) {
  const firstPartyDomain = cookie.firstPartyDomain;
  if (firstPartyDomain !== undefined && firstPartyDomain !== null && typeof firstPartyDomain !== "string") {
    throw new Error("Cookie firstPartyDomain must be a string or null");
  }
  if (typeof firstPartyDomain === "string" && !isFirstPartyDomain(firstPartyDomain)) {
    throw new Error("Cookie firstPartyDomain must be an empty string or a domain");
  }

  const partitionKey = cookie.partitionKey;
  if (partitionKey === undefined || partitionKey === null) {
    return { firstPartyDomain: typeof firstPartyDomain === "string" ? firstPartyDomain : null, partitionKey: null };
  }
  if (!partitionKey || typeof partitionKey !== "object" || Array.isArray(partitionKey)) {
    throw new Error("Cookie partitionKey must be null or an object with topLevelSite");
  }
  // Firefox's Cookie shape contains a schemeful site URL and optional ancestor bit.
  const keys = Object.keys(partitionKey);
  if (keys.some((key) => !["topLevelSite", "hasCrossSiteAncestor"].includes(key))
    || typeof partitionKey.topLevelSite !== "string"
    || !partitionKey.topLevelSite
    || ("hasCrossSiteAncestor" in partitionKey && typeof partitionKey.hasCrossSiteAncestor !== "boolean")) {
    throw new Error("Cookie partitionKey must contain a topLevelSite and optional boolean hasCrossSiteAncestor");
  }
  let site;
  try { site = new URL(partitionKey.topLevelSite); } catch {}
  if (!site || !["http:", "https:"].includes(site.protocol) || !site.hostname || site.username || site.password
    || site.pathname !== "/" || site.search || site.hash || /[?#]/.test(partitionKey.topLevelSite)) {
    throw new Error("Cookie partitionKey.topLevelSite must be an HTTP(S) site URL without credentials, path, query, or fragment");
  }
  if (typeof firstPartyDomain === "string" && firstPartyDomain && partitionKey) {
    // Firefox rejects these together in cookies.set; FPI takes precedence over dynamic partitioning.
    throw new Error("Cookie cannot have both firstPartyDomain and partitionKey");
  }
  return {
    firstPartyDomain: typeof firstPartyDomain === "string" ? firstPartyDomain : null,
    partitionKey: clone(partitionKey)
  };
}

function copyIsolation(details, cookie = {}) {
  if (typeof cookie.firstPartyDomain === "string") details.firstPartyDomain = cookie.firstPartyDomain;
  if (cookie.partitionKey && typeof cookie.partitionKey === "object") details.partitionKey = clone(cookie.partitionKey);
  return details;
}

export function cookieIdentity(cookie = {}) {
  return JSON.stringify([
    normalizeDomain(cookie.domain),
    String(cookie.path || "/"),
    String(cookie.name || ""),
    typeof cookie.firstPartyDomain === "string" ? cookie.firstPartyDomain : null,
    cookie.partitionKey || null
  ]);
}

export function normalizeCookieRecord(cookie = {}) {
  const isolation = normalizeIsolationMetadata(cookie);
  const record = {
    name: String(cookie.name || ""),
    value: String(cookie.value || ""),
    domain: String(cookie.domain || ""),
    hostOnly: cookie.hostOnly === true,
    path: String(cookie.path || "/") || "/",
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: String(cookie.sameSite || "unspecified"),
    session: cookie.session === true,
    expirationDate: Number.isFinite(Number(cookie.expirationDate)) ? Number(cookie.expirationDate) : null,
    firstPartyDomain: isolation.firstPartyDomain,
    partitionKey: isolation.partitionKey
  };
  if (record.session) record.expirationDate = null;
  return record;
}

export function createPersonaCookieService({ browserApi = browser, assertPersona } = {}) {
  if (!browserApi?.cookies) throw new Error("Persona cookie service requires the cookies API");

  async function checkedStore(profileId) {
    const id = String(profileId || "");
    if (!id) throw new Error("Persona cookie store id is required");
    if (assertPersona) await assertPersona(id);
    return id;
  }

  async function list(profileId) {
    const storeId = await checkedStore(profileId);
    // Firefox cookie enumeration has two independent isolation dimensions.
    // firstPartyDomain:null means all first-party domains, including FPI
    // cookies. partitionKey:{} means both dynamically partitioned and
    // unpartitioned cookie jars. storeId still constrains everything to the
    // selected contextual identity/persona.
    return (await browserApi.cookies.getAll({
      storeId,
      firstPartyDomain: null,
      partitionKey: {}
    })).map(normalizeCookieRecord);
  }

  async function remove(profileId, cookie) {
    const storeId = await checkedStore(profileId);
    const record = normalizeCookieRecord(cookie);
    const details = copyIsolation({
      storeId,
      name: record.name,
      url: cookieUrl(record)
    }, record);
    return browserApi.cookies.remove(details);
  }

  async function set(profileId, cookie, original = null) {
    const storeId = await checkedStore(profileId);
    const record = normalizeCookieRecord(cookie);
    if (!record.name) throw new Error("Cookie name is required");
    const details = copyIsolation({
      storeId,
      url: cookieUrl(record),
      name: record.name,
      value: record.value,
      path: record.path,
      secure: record.secure,
      httpOnly: record.httpOnly
    }, record);
    if (!record.hostOnly && record.domain) details.domain = record.domain;
    if (!record.session && Number.isFinite(record.expirationDate)) details.expirationDate = record.expirationDate;
    if (["no_restriction", "lax", "strict", "unspecified"].includes(record.sameSite)) details.sameSite = record.sameSite;

    const result = await browserApi.cookies.set(details);
    if (!result) throw new Error("Firefox did not create the cookie");
    if (original && cookieIdentity(original) !== cookieIdentity(record)) {
      await remove(profileId, original);
    }
    return normalizeCookieRecord(result);
  }

  async function clear(profileId, { domain = "" } = {}) {
    const target = normalizeDomain(domain);
    const cookies = await list(profileId);
    const selected = target
      ? cookies.filter((cookie) => {
          const domain = normalizeDomain(cookie.domain);
          return domain === target || domain.endsWith(`.${target}`);
        })
      : cookies;
    const results = await Promise.allSettled(selected.map((cookie) => remove(profileId, cookie)));
    const failed = results.filter((result) => result.status === "rejected");
    if (failed.length) throw new Error(`Unable to remove ${failed.length} of ${selected.length} cookies`);
    return { removed: selected.length };
  }

  async function importRecords(profileId, records = [], mode = "merge") {
    const normalized = (Array.isArray(records) ? records : []).map(normalizeCookieRecord);
    if (mode === "replace") await clear(profileId);
    const failures = [];
    let imported = 0;
    for (const record of normalized) {
      try { await set(profileId, record); imported++; }
      catch (error) { failures.push({ cookie: record, error: String(error?.message || error) }); }
    }
    return { imported, failed: failures.length, failures };
  }

  return { list, set, remove, clear, importRecords };
}
