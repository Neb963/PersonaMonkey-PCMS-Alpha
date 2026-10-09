import { BLACKHOLE_PROXY } from "./constants.js";

let proxyHandler = null;
let beforeRequestHandler = null;
let failureHandler = null;
let bootstrapRetry = null;
let proxyRegistered = false;
let beforeRequestRegistered = false;
let lastFailure = null;
let blockedCount = 0;

function failClosedProxy() {
  return [{ ...BLACKHOLE_PROXY }, null];
}

function recordFailure(reason) {
  // Only fixed reason codes enter diagnostics. Request URLs and thrown errors
  // can contain credentials, so neither is retained or passed to observers.
  blockedCount = Math.min(blockedCount + 1, 9999);
  lastFailure = { at: new Date().toISOString(), reason, count: blockedCount };
  try { failureHandler?.(lastFailure); } catch {}
}

async function guardProxy(details) {
  if (!proxyHandler) {
    try { void bootstrapRetry?.().catch(() => {}); } catch {}
    recordFailure("routing-not-ready");
    return failClosedProxy();
  }
  try {
    return await proxyHandler(details);
  } catch {
    recordFailure("routing-handler-failed");
    return failClosedProxy();
  }
}

async function guardBeforeRequest(details) {
  if (!beforeRequestHandler) {
    try { void bootstrapRetry?.().catch(() => {}); } catch {}
    recordFailure("routing-not-ready");
    return { cancel: true };
  }
  try {
    return await beforeRequestHandler(details);
  } catch {
    recordFailure("routing-handler-failed");
    return { cancel: true };
  }
}

export function registerRoutingListeners() {
  // This runs during static module evaluation, before recovery-bootstrap's
  // first await. Retry registration without adding a duplicate if one API
  // registered successfully before the other failed.
  if (!proxyRegistered) {
    browser.proxy.onRequest.addListener(guardProxy, { urls: ["<all_urls>"] });
    proxyRegistered = true;
  }
  if (!beforeRequestRegistered) {
    browser.webRequest.onBeforeRequest.addListener(
      guardBeforeRequest, { urls: ["<all_urls>"] }, ["blocking"]
    );
    beforeRequestRegistered = true;
  }
}

export function installRoutingHandlers({ onProxyRequest, onBeforeRequest, onFailure } = {}) {
  if (typeof onProxyRequest !== "function" || typeof onBeforeRequest !== "function") {
    throw new TypeError("Routing handlers must be functions");
  }
  proxyHandler = onProxyRequest;
  beforeRequestHandler = onBeforeRequest;
  failureHandler = typeof onFailure === "function" ? onFailure : null;
  if (lastFailure) {
    try { failureHandler?.(lastFailure); } catch {}
  }
}

export function setBootstrapRetry(retry) {
  bootstrapRetry = typeof retry === "function" ? retry : null;
}

registerRoutingListeners();
