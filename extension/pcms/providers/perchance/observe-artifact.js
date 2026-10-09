// Reviewed, immutable PersonaMonkey execution artifact for deterministic fixture pages.
// This is deliberately not a guessed Perchance editor selector contract (P043).
import { OBSERVE_FIXTURE_LISTING_SOURCE } from "./listing.js";
export const PERCHANCE_OBSERVE_FIXTURE_FORMAT = "pcms.perchance.observe-fixture/v1";
export function createObserveFixtureArtifact(origin, { includeContent = false } = {}) {
  const url = new URL(origin);
  if (url.origin !== origin || url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new TypeError("Observation fixture requires an exact loopback HTTP origin");
  }
  return `// ==UserScript==
// @name PCMS Perchance fixture observation
// @match ${url.protocol}//${url.hostname}/*
// @grant Persona.signal
// @run-at document-idle
// ==/UserScript==
(async () => {
  const fail = () => { throw new Error("Observation fixture contract unavailable"); };
  if (location.origin !== ${JSON.stringify(origin)}) fail();
  const page = document.querySelector('[data-pcms-observe="v1"]');
  if (!page || page.dataset.generator !== location.pathname.slice(1)) fail();
  const generatorId = page.dataset.generator;
  if (page.dataset.challenge === "true") {
    Persona.complete({ generatorId, observation:{ exists:null, challenge:true } }); return;
  }
  if (page.dataset.exists === "false") {
    Persona.complete({ generatorId, observation:{ exists:false, challenge:false } }); return;
  }
  const read = name => { const node = page.querySelector('[data-panel="' + name + '"]'); if (!node) fail(); return node.textContent; };
  const code = read("code"), html = read("html");
  const encode = text => {
    if (text.includes("\\u0000") || /[\\uD800-\\uDBFF](?![\\uDC00-\\uDFFF])|(?<![\\uD800-\\uDBFF])[\\uDC00-\\uDFFF]/.test(text)) fail();
    return new TextEncoder().encode(text);
  };
  const c = encode(code), h = encode(html);
  if (c.length + h.length > 4 * 1024 * 1024) fail();
  const parts = [encode("pcms.perchance.generator-payload/v1\\ncode " + c.length + "\\n"), c,
    encode("\\nhtml " + h.length + "\\n"), h, encode("\\n")];
  const bytes = new Uint8Array(parts.reduce((n,p) => n + p.length, 0));
  let offset = 0; for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  const hash = async value => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", value)), b => b.toString(16).padStart(2,"0")).join("");
  const thumbnail = page.querySelector('[data-panel="thumbnail"]')?.textContent || null;
  let thumbnailHash = null;
  if (thumbnail !== null) {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(thumbnail) || thumbnail.length % 4 || thumbnail.length > 1398104) fail();
    const b = Uint8Array.from(atob(thumbnail), c => c.charCodeAt(0));
    if (b.length > 1024 * 1024 || b[0] !== 255 || b[1] !== 216 || b[2] !== 255) fail();
    thumbnailHash = await hash(b);
  }
  ${OBSERVE_FIXTURE_LISTING_SOURCE}
  const observation = { exists:true, challenge:false, payloadHash:await hash(bytes), thumbnailHash, settings };
  // PersonaMonkey's result mailbox is 64 KiB. Hash reads support 4 MiB; content
  // comparison is explicitly bounded and never silently truncates a panel.
  if (${includeContent === true}) {
    if (JSON.stringify({code,html,thumbnail}).length > 24000) fail();
    Object.assign(observation, { code, html, thumbnail });
  }
  Persona.complete({ generatorId, observation });
})().catch(() => Persona.fail("Observation fixture contract unavailable"));
`;
}
