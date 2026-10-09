// Core-only read driver. Every browser action uses the Persona Broker; there is
// no PCMS browser.* or userScripts authority. Real Perchance stays disabled.
import { createObserveFixtureArtifact } from "./observe-artifact.js";
import { normalizeGeneratorSlug, sha256Hex } from "./contract.js";
import { PERCHANCE_PROVIDER_ERROR_CODES as E, perchanceProviderError } from "./errors.js";
import { normalizeProviderObservation } from "./observation.js";

const REQUIRED = ["userscript.artifact.install", "userscript.artifact.assign", "persona.control.acquire",
  "persona.control.release", "execution.start", "execution.result.get", "execution.result.ack", "execution.cancel"];
const UID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unavailable() { throw perchanceProviderError(E.INCOMPATIBLE); }
function protocol() { throw perchanceProviderError(E.PROTOCOL); }

export function createPerchanceExecutionReadDriver({ client, profile = null, allowDirect = false,
  clock = () => Date.now(), pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  if (typeof client?.request !== "function") throw new TypeError("Observation requires a Persona Broker client");
  if(typeof allowDirect!=="boolean"||typeof clock!=="function"||typeof pause!=="function")protocol();
  if (profile !== null && (profile.kind !== "fixture" || Object.keys(profile).length !== 2)) unavailable();
  if (profile) createObserveFixtureArtifact(profile.origin);
  profile=profile?Object.freeze({kind:"fixture",origin:profile.origin}):null;
  async function available() {
    if (!profile) return false;
    try {
      const description = await client.request("system.describe", {});
      const commands = new Map((Array.isArray(description?.commands) ? description.commands : []).map(entry => [entry.command, entry]));
      return REQUIRED.every(name => commands.get(name)?.authorized === true
        && commands.get(name)?.available !== false)
        && description?.externalAutomation?.executionAvailable === true;
    } catch { return false; }
  }
  async function observeGenerator({ generatorId, personaUid, readId, includeContent = false } = {}) {
    normalizeGeneratorSlug(generatorId);
    if (!UID.test(personaUid || "") || typeof readId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(readId)
        || typeof includeContent !== "boolean") protocol();
    if (!await available()) unavailable();
    const source = createObserveFixtureArtifact(profile.origin, { includeContent });
    const sha256 = await sha256Hex(source);
    const artifactId = "pcms.perchance.observe/1.0.0/" + sha256.slice(0, 24);
    let lease = null, executionId = null;
    try {
      await client.request("userscript.artifact.install", { artifactId, sha256, source,
        provenance:{ packageId:"pcms.perchance.observe", packageVersion:"1.0.0", component:includeContent ? "compare-fixture" : "read-fixture" }
      }, { operationId:readId + ":install" });
      await client.request("userscript.artifact.assign", { artifactId, personaUid }, { operationId:readId + ":assign" });
      lease = await client.request("persona.control.acquire", { personaUid, purpose:"PCMS generator observation", ttlMs:10000 }, { operationId:readId + ":lease" });
      const execution = await client.request("execution.start", {
        allowDirect,
        plan:{ name:"Observe generator", steps:[{ id:"observe", personaUid, urls:[profile.origin + "/" + generatorId],
          artifacts:[artifactId], concurrency:1, retries:0, closeTabs:true, stopOnError:true,
          completion:{ mode:"signal", timeoutMs:8000 } }] }
      }, { operationId:readId + ":start" });
      executionId = execution?.executionId;
      if (typeof executionId !== "string") protocol();
      const deadline = clock() + 8500;
      for (let polls = 0; polls < 45 && clock() <= deadline; polls++) {
        const result = await client.request("execution.result.get", { executionId });
        if (["completed", "failed", "stopped", "cancelled", "interrupted"].includes(result?.state)) {
          if (result.state !== "completed" || result.truncated || result.acknowledged || result.tasks?.length !== 1) protocol();
          const task = result.tasks[0];
          if (task.resultOmitted || task.truncated || Object.keys(task.result || {}).length !== 1) protocol();
          // Results are keyed by PersonaMonkey's internal script ID, not artifact ID.
          const body = Object.values(task.result)[0];
          if (body?.generatorId !== generatorId || !body.observation || Object.keys(body).length !== 2) protocol();
          const observation = structuredClone(body.observation);
          await normalizeProviderObservation(observation,{includeContent});
          await client.request("execution.result.ack", { executionId }, { operationId:readId + ":ack" });
          executionId = null;
          return observation;
        }
        await pause(200);
      }
      protocol();
    } finally {
      if (executionId) { try { await client.request("execution.cancel", { executionId }, { operationId:readId + ":cancel" }); } catch {} }
      if (typeof lease?.leaseId === "string") { try { await client.request("persona.control.release", { leaseId:lease.leaseId }, { operationId:readId + ":release" }); } catch {} }
    }
  }
  return Object.freeze({ available, observeGenerator });
}
