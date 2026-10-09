// Core-only unattended generator.update v2 driver (P042, A042-01). Every browser action goes
// through the Persona Broker as a PersonaMonkey execution artifact under a short control lease;
// PCMS holds no browser.*, userScripts or browser-execution authority of its own. The release is
// staged as a transient execution input, never persisted by PCMS. Real Perchance has no profile,
// so `available()` is false and the unattended capability stays off until live confirmation.
import { createDeployFixtureArtifact, PERCHANCE_RELEASE_INPUT_FORMAT, PERCHANCE_RELEASE_INPUT_NAME } from "./deploy-artifact.js";
import { normalizeGeneratorSlug, sha256Hex } from "./contract.js";
import { PERCHANCE_PROVIDER_ERROR_CODES as E, perchanceProviderError } from "./errors.js";

export const PERCHANCE_UNATTENDED_COMMANDS = Object.freeze(["userscript.artifact.install", "userscript.artifact.assign",
  "persona.control.acquire", "persona.control.release", "execution.input.begin", "execution.input.append",
  "execution.input.commit", "execution.input.discard", "execution.start", "execution.result.get",
  "execution.result.ack", "execution.cancel"]);
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const MAX_INPUT_BYTES = 4 * 1024 * 1024;
const CHUNK_BYTES = 192 * 1024;
const STEP_TIMEOUT_MS = 20000;
const RESULT_DEADLINE_MS = 25000;
const LEASE_TTL_MS = 45000;
const TERMINAL = ["completed", "failed", "stopped", "cancelled", "interrupted"];
const TEXT = new TextEncoder();

function unavailable() { throw perchanceProviderError(E.INCOMPATIBLE); }
function protocol() { throw perchanceProviderError(E.PROTOCOL); }
function suffix(operationId, name) {
  const value = operationId + ":" + name;
  return value.length <= 256 ? value : "pcms:" + name + ":" + operationId.slice(-220);
}
function base64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

export function createPerchanceExecutionUpdateDriver({ client, profile = null, allowDirect = false,
  clock = () => Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof client?.request !== "function") throw new TypeError("Unattended deployment requires a Persona Broker client");
  if (typeof allowDirect !== "boolean" || typeof clock !== "function" || typeof pause !== "function") protocol();
  if (profile !== null && (profile.kind !== "fixture" || Object.keys(profile).length !== 2)) unavailable();
  const source = profile ? createDeployFixtureArtifact(profile.origin) : null;
  profile = profile ? Object.freeze({ kind:"fixture", origin:profile.origin }) : null;

  async function available() {
    if (!profile) return false;
    try {
      const description = await client.request("system.describe", {});
      const commands = new Map((Array.isArray(description?.commands) ? description.commands : []).map(entry => [entry.command, entry]));
      return PERCHANCE_UNATTENDED_COMMANDS.every(name => commands.get(name)?.authorized === true && commands.get(name)?.available !== false)
        && description?.externalAutomation?.executionAvailable === true;
    } catch { return false; }
  }

  // One leased execution of the reviewed artifact. `started` is set before execution.start so a
  // lost start response is uncertain, never a proof that nothing happened.
  async function run({ mode, operationId, generatorId, personaUid, input }) {
    normalizeGeneratorSlug(generatorId);
    if (!UID.test(personaUid || "") || typeof operationId !== "string" || !OPERATION.test(operationId)) protocol();
    if (!await available()) unavailable();
    const sha256 = await sha256Hex(source);
    const artifactId = "pcms.perchance.deploy/1.0.0/" + sha256.slice(0, 24);
    const bytes = TEXT.encode(JSON.stringify({ format:PERCHANCE_RELEASE_INPUT_FORMAT, mode, operationId, generatorId, ...input }));
    if (bytes.byteLength > MAX_INPUT_BYTES) throw perchanceProviderError(E.INVALID_ARGUMENT);
    const digest = [...new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes))].map(b => b.toString(16).padStart(2, "0")).join("");
    // A deploy runs once per RemoteOperation; reconciliation may ask again, so each verify run
    // carries its own broker correlation and never collides with an earlier execution.
    const key = mode === "verify" ? "verify-" + globalThis.crypto.randomUUID().slice(0, 8) : "deploy";
    let lease = null, inputRef = null, executionId = null, started = false;
    try {
      await client.request("userscript.artifact.install", { artifactId, sha256, source,
        provenance:{ packageId:"pcms.perchance.deploy", packageVersion:"1.0.0", component:"deploy-fixture" } },
      { operationId:suffix(operationId, key + ":install") });
      await client.request("userscript.artifact.assign", { artifactId, personaUid }, { operationId:suffix(operationId, key + ":assign") });
      lease = await client.request("persona.control.acquire", { personaUid, purpose:"PCMS unattended generator deployment", ttlMs:LEASE_TTL_MS },
        { operationId:suffix(operationId, key + ":lease") });
      if (typeof lease?.leaseId !== "string") protocol();
      const staged = await client.request("execution.input.begin", { name:PERCHANCE_RELEASE_INPUT_NAME, mediaType:"application/json",
        byteLength:bytes.byteLength, sha256:digest, stepIds:["deploy"], artifactIds:[artifactId], ttlMs:60000 },
      { operationId:suffix(operationId, key + ":input") });
      inputRef = staged?.inputRef;
      if (typeof inputRef !== "string") protocol();
      for (let offset = 0; offset < bytes.byteLength; offset += CHUNK_BYTES) {
        await client.request("execution.input.append", { inputRef, offset, chunkBase64:base64(bytes.subarray(offset, offset + CHUNK_BYTES)) },
          { operationId:suffix(operationId, key + ":input:" + offset) });
      }
      await client.request("execution.input.commit", { inputRef }, { operationId:suffix(operationId, key + ":commit") });
      started = true;
      const execution = await client.request("execution.start", {
        allowDirect, inputRefs:[inputRef],
        plan:{ name:mode === "verify" ? "Verify generator deployment" : "Deploy generator",
          steps:[{ id:"deploy", personaUid, urls:[profile.origin + "/" + generatorId], artifacts:[artifactId], concurrency:1,
            retries:0, closeTabs:true, stopOnError:true, completion:{ mode:"signal", timeoutMs:STEP_TIMEOUT_MS } }] }
      }, { operationId:suffix(operationId, key + ":start") });
      executionId = execution?.executionId;
      if (typeof executionId !== "string") protocol();
      const deadline = clock() + RESULT_DEADLINE_MS;
      for (let polls = 0; polls < 130 && clock() <= deadline; polls++) {
        const result = await client.request("execution.result.get", { executionId });
        if (TERMINAL.includes(result?.state)) {
          if (result.state !== "completed" || result.truncated || result.acknowledged || result.tasks?.length !== 1) protocol();
          const task = result.tasks[0];
          if (task.resultOmitted || task.truncated || Object.keys(task.result || {}).length !== 1) protocol();
          const body = Object.values(task.result)[0];
          if (!body || typeof body !== "object" || Object.keys(body).length !== 4 || body.operationId !== operationId
              || body.generatorId !== generatorId || !["APPLIED", "NOT_APPLIED"].includes(body.status)
              || typeof body.challenge !== "boolean" || (body.challenge && body.status !== "NOT_APPLIED")) protocol();
          await client.request("execution.result.ack", { executionId }, { operationId:suffix(operationId, key + ":ack") });
          executionId = null;
          return Object.freeze({ status:body.status, challenge:body.challenge });
        }
        await pause(200);
      }
      protocol();
    } catch (error) {
      // Nothing reached the provider before execution.start: provably not applied.
      if (!started && mode === "deploy" && error?.code !== E.INCOMPATIBLE) return Object.freeze({ status:"NOT_APPLIED", challenge:false });
      throw error;
    } finally {
      if (executionId) { try { await client.request("execution.cancel", { executionId }, { operationId:suffix(operationId, key + ":cancel") }); } catch {} }
      if (inputRef) { try { await client.request("execution.input.discard", { inputRef }, { operationId:suffix(operationId, key + ":discard") }); } catch {} }
      if (typeof lease?.leaseId === "string") { try { await client.request("persona.control.release", { leaseId:lease.leaseId }, { operationId:suffix(operationId, key + ":release") }); } catch {} }
    }
  }

  async function updateGeneratorRelease({ operationId, generatorId, intentFingerprint, payloadHash, thumbnailHash, code, html, thumbnail, settings, personaUid } = {}) {
    const result = await run({ mode:"deploy", operationId, generatorId, personaUid,
      input:{ intentFingerprint, payloadHash, thumbnailHash, code, html, thumbnail:thumbnail ?? null, settings } });
    return Object.freeze({ status:result.status });
  }

  // Reconciliation reads the provider's own answer for exactly this operation. Anything that is
  // not a definite answer stays UNKNOWN; nothing is replayed.
  async function reconcileGeneratorRelease({ operationId, generatorId, intentFingerprint, personaUid } = {}) {
    try {
      const result = await run({ mode:"verify", operationId, generatorId, personaUid, input:{ intentFingerprint } });
      return Object.freeze({ status:result.challenge ? "UNKNOWN" : result.status });
    } catch { return Object.freeze({ status:"UNKNOWN" }); }
  }

  return Object.freeze({ available, updateGeneratorRelease, reconcileGeneratorRelease });
}
