import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MODULE_RUNTIME_AVAILABILITY,
  MODULE_RUNTIME_UNAVAILABLE_REASONS as REASONS,
  createModuleRuntimeSupport,
  evaluateModuleRuntimeFloor,
  parseFirefoxMajor
} from "../../../extension/pcms/runtime/browser-floor.js";

const manifest = JSON.parse(await readFile("extension/manifest.json", "utf8"));
const pin = JSON.parse(await readFile("docs/implementation/v1/browser-pin.json", "utf8"));
const firefox = (version) => ({ name: "Firefox", vendor: "Mozilla", version, buildID: "20261001000000" });

test("A030-01 floor parses Firefox versions", () => {
  assert.equal(parseFirefoxMajor("154.0b10"), 154);
  assert.equal(parseFirefoxMajor("153.3.0esr"), 153);
  assert.equal(parseFirefoxMajor("garbage"), null);
  assert.equal(parseFirefoxMajor(undefined), null);
});

test("A030-01 pinned Developer Edition is AVAILABLE; ESR 153 reports UNAVAILABLE · Requires Firefox 154+", () => {
  const pinned = evaluateModuleRuntimeFloor({ browserInfo: firefox(pin.version), manifest });
  assert.equal(pinned.state, MODULE_RUNTIME_AVAILABILITY.AVAILABLE);
  assert.equal(pinned.browser.major, 154);
  // Regression from CI: the pinned 154.0b10 build reports getBrowserInfo().version as "154.0".
  assert.equal(evaluateModuleRuntimeFloor({ browserInfo: firefox("154.0"), manifest }).state, MODULE_RUNTIME_AVAILABILITY.AVAILABLE);

  for (const version of ["153.0", "153.3.0esr", "128.14.0esr"]) {
    const old = evaluateModuleRuntimeFloor({ browserInfo: firefox(version), manifest });
    assert.equal(old.state, MODULE_RUNTIME_AVAILABILITY.UNAVAILABLE, version);
    assert.equal(old.reason, REASONS.BROWSER_TOO_OLD);
    assert.equal(old.message, "Requires Firefox 154+");
    assert.ok(Object.isFrozen(old));
  }
});

test("A030-01 unknown browsers and unsafe manifests fail closed", () => {
  assert.equal(evaluateModuleRuntimeFloor({ browserInfo: null, manifest }).reason, REASONS.BROWSER_UNKNOWN);
  assert.equal(evaluateModuleRuntimeFloor({ browserInfo: { name: "Thunderbird", version: "154.0" }, manifest }).reason,
    REASONS.BROWSER_UNSUPPORTED);
  const withoutSandbox = { ...manifest };
  delete withoutSandbox.sandbox;
  assert.equal(evaluateModuleRuntimeFloor({ browserInfo: firefox("154.0"), manifest: withoutSandbox }).reason,
    REASONS.SANDBOX_NOT_DECLARED);
  const sameOrigin = { ...manifest, content_security_policy: {
    sandbox: manifest.content_security_policy.sandbox.replace("allow-scripts", "allow-scripts allow-same-origin") } };
  assert.equal(evaluateModuleRuntimeFloor({ browserInfo: firefox("154.0"), manifest: sameOrigin }).reason,
    REASONS.SANDBOX_CSP_UNSAFE);
});

test("A030-01 startup detection runs once, never throws and requires a proven isolated frame", async () => {
  let probes = 0;
  const ok = createModuleRuntimeSupport({
    getBrowserInfo: async () => firefox("154.0b10"),
    getManifest: () => manifest,
    probeIsolation: async () => { probes += 1; return true; }
  });
  assert.equal((await ok.getStatus()).state, MODULE_RUNTIME_AVAILABILITY.AVAILABLE);
  await ok.getStatus();
  assert.equal(probes, 1);

  const leaky = createModuleRuntimeSupport({
    getBrowserInfo: async () => firefox("154.0"),
    getManifest: () => manifest,
    probeIsolation: async () => { throw new Error("frame document reachable"); }
  });
  assert.equal((await leaky.getStatus()).reason, REASONS.SANDBOX_NOT_ISOLATED);

  let probedOld = false;
  const old = createModuleRuntimeSupport({
    getBrowserInfo: async () => firefox("153.0"),
    getManifest: () => manifest,
    probeIsolation: async () => { probedOld = true; return true; }
  });
  assert.equal((await old.getStatus()).reason, REASONS.BROWSER_TOO_OLD);
  assert.equal(probedOld, false, "no controller page is loaded below the floor");

  const broken = createModuleRuntimeSupport({
    getBrowserInfo: async () => { throw new Error("unavailable"); },
    getManifest: () => { throw new Error("unavailable"); }
  });
  assert.equal((await broken.getStatus()).state, MODULE_RUNTIME_AVAILABILITY.UNAVAILABLE);
});
