// P031 fixture runtime module "fixture.counter". It is never compiled into the XPI: tests
// build its pcms.module.archive/v1 text at run time (with a fresh nonce), install it through
// the PCMS UI client and let the background supervisor run it.
//
// Behaviour per version:
// - start(): declares the "tick" schedule (re-declaration is idempotent) and journals a start.
// - onTimer("tick"): increments module storage "ticks" and re-declares the next tick.
// - probe(): reports realm facts, exercises granted capabilities and one ungranted one.
// - beat(): v1 only, starts a loop that keeps writing "beat" so tests can prove a fenced
//   generation can no longer write after an update.
import { encodeModuleArchive } from "../../../extension/pcms/modules/package.js";

export const FIXTURE_MODULE_ID = "fixture.counter";
export const FIXTURE_TICK_MS = 60 * 1000;

export const FIXTURE_CAPABILITIES = Object.freeze([
  "module.audit.append",
  "module.attention.open",
  "module.attention.settle",
  "module.storage.read",
  "module.storage.write",
  "module.timers.cancel",
  "module.timers.ensure",
  "module.timers.list"
]);

function controllerSource({ version, nonce, failStart = false, beatMs = 200 }) {
  return `(api) => {
  const VERSION = ${JSON.stringify(version)};
  const NONCE = ${JSON.stringify(nonce)};
  let beating = null;
  async function write(key, update) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await api.call("module.storage.read", { key });
      const result = await api.call("module.storage.write", { key, expectedRevision: current.revision, value: update(current.value) });
      if (result.ok) return result;
    }
    throw new Error("storage conflict");
  }
  return {
    async start() {
      ${failStart ? 'throw new Error("fixture start failure");' : ""}
      const tick = await api.call("module.timers.ensure", { name: "tick", delayMs: ${FIXTURE_TICK_MS} });
      await api.call("module.audit.append", { type: "started", data: { version: VERSION, nonce: NONCE } });
      return { version: VERSION, nonce: NONCE, tick };
    },
    async onTimer(input) {
      const saved = await write("ticks", (value) => ({ count: (value && value.count || 0) + 1, version: VERSION, last: input.dueAt }));
      await api.call("module.timers.ensure", { name: input.name, delayMs: ${FIXTURE_TICK_MS} });
      return { version: VERSION, revision: saved.revision };
    },
    async probe() {
      const facts = {
        version: VERSION,
        nonce: NONCE,
        browserAbsent: typeof browser === "undefined",
        chromeAbsent: typeof chrome === "undefined",
        origin: typeof self === "undefined" ? null : String(self.origin)
      };
      facts.ticks = (await api.call("module.storage.read", { key: "ticks" })).value;
      facts.timers = (await api.call("module.timers.list", {})).timers;
      try { await api.call("core.generators.read", {}); facts.ungrantedDenied = false; }
      catch (error) { facts.ungrantedDenied = true; facts.ungrantedCode = error && error.code; }
      try {
        await api.call("module.storage.write", { key: "big", expectedRevision: 0, value: "x".repeat(40 * 1024) });
        facts.oversizedRejected = false;
      } catch (error) { facts.oversizedRejected = true; facts.oversizedCode = error && error.code; }
      try { await api.call("module.timers.ensure", { name: "too-soon", delayMs: 1000 }); facts.shortTimerRejected = false; }
      catch (error) { facts.shortTimerRejected = true; }
      const audit = await api.call("module.audit.append", { type: "probed", data: { apiToken: "fixture-secret-" + NONCE, ok: true } });
      facts.auditSequence = audit.sequence;
      const opened = await api.call("module.attention.open", { key: "review", title: "Fixture review " + VERSION });
      facts.attentionOpened = opened.ok;
      const settled = await api.call("module.attention.settle", { key: "review", outcome: "resolved" });
      facts.attentionSettled = settled.state;
      return facts;
    },
    async beat() {
      if (beating) return { version: VERSION, beating: true };
      const loop = async () => {
        try { await write("beat", (value) => ({ version: VERSION, count: (value && value.count || 0) + 1 })); }
        catch {}
        beating = setTimeout(loop, ${beatMs});
      };
      await loop();
      return { version: VERSION, beating: true };
    },
    dispose() { if (beating) clearTimeout(beating); beating = null; return { version: VERSION }; }
  };
}`;
}

export function buildCounterArchiveText({
  version = "1.0.0",
  nonce = "fixture",
  capabilities = FIXTURE_CAPABILITIES,
  failStart = false,
  moduleId = FIXTURE_MODULE_ID
} = {}) {
  const bytes = encodeModuleArchive({
    format: "pcms.module.archive/v1",
    manifest: {
      schemaVersion: 1,
      moduleId,
      version,
      controller: "controller.js",
      authority: { capabilities: [...capabilities] }
    },
    files: { "controller.js": controllerSource({ version, nonce, failStart }) }
  });
  return new TextDecoder().decode(bytes);
}
