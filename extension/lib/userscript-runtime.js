import { userScriptMatches } from "./policy.js";
import { prepareUserscriptInjection } from "./gm-compat.js";
import { shouldUseMainWorld, worldIdForScript } from "./userscripts.js";
import { assertExternalArtifactMetadataMatchesSource } from "./external-artifact-integrity.js";

export function createUserscriptRuntime({
  getState,
  getAutomationTabPolicy,
  handleAutomationSignal,
  ensureInitialized = async () => {},
  browserApi = browser,
  prepareInjection = prepareUserscriptInjection
} = {}) {
  if (!getState) throw new Error("Userscript runtime requires getState");
  if (!getAutomationTabPolicy || !handleAutomationSignal) {
    throw new Error("Userscript runtime requires automation policy callbacks");
  }

  const recentInjections = new Map();
  const configuredWorlds = new Set();

  async function hasPermission() {
    try {
      return await browserApi.permissions.contains({ permissions: ["userScripts"] });
    } catch {
      return false;
    }
  }

  async function ensureWorld(worldId) {
    if (!worldId || configuredWorlds.has(worldId)) return;
    if (!browserApi.userScripts?.configureWorld) return;
    await browserApi.userScripts.configureWorld({ worldId, messaging: true });
    configuredWorlds.add(worldId);
  }

  async function verifyExternalArtifact(script) {
    const artifact = script?.externalArtifact;
    if (!artifact) return;
    if (artifact.ownershipVerified === false) {
      throw new Error("External userscript artifact ownership is not authenticated");
    }
    const bytes = new TextEncoder().encode(String(script.code || ""));
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    const actual = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!/^[a-f0-9]{64}$/.test(String(artifact.sha256 || "")) || actual !== artifact.sha256) {
      throw new Error("External userscript artifact integrity check failed");
    }
    assertExternalArtifactMetadataMatchesSource(script, script.code);
  }

  async function injectForContext(details, stage) {
    await ensureInitialized();
    const state = await getState();
    if (!/^https?:/i.test(details.url || "")) return;
    let tab;
    try {
      tab = details.tab || await browserApi.tabs.get(details.tabId);
    } catch {
      return;
    }
    const profile = state.profiles[tab.cookieStoreId];
    if (!profile || !profile.managed) return;

    const automationPolicy = getAutomationTabPolicy(tab.id);
    const selected = new Set(automationPolicy?.allowedScriptIds || []);
    const scripts = Object.values(state.scripts).filter((script) => {
      if (!script.enabled || script.runAt !== stage || !script.profileIds?.includes(tab.cookieStoreId)) return false;
      if (!script.allFrames && Number(details.frameId || 0) !== 0) return false;
      if (!userScriptMatches(script, details.url)) return false;
      if (automationPolicy) return selected.has(script.id);
      return script.autoRun !== false;
    });

    if (!(await hasPermission()) || !browserApi.userScripts?.execute) {
      for (const script of scripts) if (automationPolicy && selected.has(script.id) && script.externalArtifact) {
        handleAutomationSignal({
          tabId: tab.id,
          scriptId: script.id,
          status: "failed",
          error: "Firefox userscript execution permission is unavailable"
        });
      }
      return;
    }

    const isolatedScripts = Object.values(state.scripts).filter((script) => !shouldUseMainWorld(script));
    const worldIds = await Promise.all(isolatedScripts.map((script) => worldIdForScript(script.id)));

    for (const script of scripts) {
      const documentKey = details.documentId || `${tab.id}:${details.frameId || 0}:${details.url}`;
      const injectionKey = `${documentKey}:${script.id}:${stage}`;
      if (recentInjections.has(injectionKey)) continue;
      recentInjections.set(injectionKey, Date.now());
      const expiry = setTimeout(() => recentInjections.delete(injectionKey), 120000);
      expiry?.unref?.();

      const target = { tabId: tab.id };
      if (details.documentId) target.documentIds = [details.documentId];
      else target.frameIds = [Number(details.frameId || 0)];

      try {
        await verifyExternalArtifact(script);
        let expectedWorldId = null;
        if (!shouldUseMainWorld(script)) {
          expectedWorldId = await worldIdForScript(script.id);
          const owners = isolatedScripts.filter((_, index) => worldIds[index] === expectedWorldId);
          if (owners.length !== 1 || owners[0] !== script) {
            throw new Error(`Ambiguous isolated userscript world identity for ${owners.map((item) => item.id).join(", ") || script.id}`);
          }
        }
        const prepared = await prepareInjection(script, {
          tab,
          url: details.url,
          automationToken: automationPolicy?.automationToken || ""
        });
        if (expectedWorldId && prepared.worldId !== expectedWorldId) {
          throw new Error("Userscript injection prepared an unexpected isolated world identity");
        }
        if (prepared.worldId) await ensureWorld(prepared.worldId);
        const injection = {
          js: [{ code: prepared.code }],
          target,
          world: prepared.world,
          injectImmediately: stage === "document_start"
        };
        if (prepared.worldId) injection.worldId = prepared.worldId;
        await browserApi.userScripts.execute(injection);
      } catch (error) {
        clearTimeout(expiry);
        recentInjections.delete(injectionKey);
        console.error(`Userscript ${script.name} injection failed`, error);
        if (automationPolicy && selected.has(script.id)) {
          handleAutomationSignal({
            tabId: tab.id,
            scriptId: script.id,
            status: "failed",
            error: String(error?.message || error)
          });
        }
      }
    }
  }

  return { hasPermission, injectForContext };
}
