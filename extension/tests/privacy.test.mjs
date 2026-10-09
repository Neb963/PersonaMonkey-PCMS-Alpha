import assert from "node:assert/strict";

const mod = await import(`../lib/privacy.js?test=${Date.now()}`);

function setting(value, levelOfControl = "controllable_by_this_extension") {
  return {
    value,
    levelOfControl,
    async get() { return { value: this.value, levelOfControl: this.levelOfControl }; },
    async set({ value: next }) { this.value = next; }
  };
}

const prediction = setting(true);
const peer = setting(true);
const rtc = setting("default");
const browserApi = {
  privacy: { network: {
    networkPredictionEnabled: prediction,
    peerConnectionEnabled: peer,
    webRTCIPHandlingPolicy: rtc
  }},
  proxy: { settings: { async get() { return { levelOfControl: "controlled_by_this_extension" }; } } }
};
const security = { privacySafe: false, networkPredictionSafe: false, webRTCSafe: false, proxyControl: "unknown" };
const controller = mod.createPrivacyController({
  getState: async () => ({ global: { enforcePrivacyControls: true, disableNetworkPrediction: true, webRTCMode: "proxy_only" } }),
  securityState: security,
  browserApi
});
await controller.apply();
assert.equal(prediction.value, false);
assert.equal(rtc.value, "proxy_only");
assert.equal(security.networkPredictionSafe, true);
assert.equal(security.webRTCSafe, true);
assert.equal(security.privacySafe, true);
assert.equal(security.proxyControl, "controlled_by_this_extension");

const blockedPrediction = setting(true, "controlled_by_other_extensions");
const blockedRtc = setting("default", "controlled_by_other_extensions");
const unsafe = { privacySafe: true };
await mod.createPrivacyController({
  getState: async () => ({ global: { enforcePrivacyControls: true, disableNetworkPrediction: true, webRTCMode: "proxy_only" } }),
  securityState: unsafe,
  browserApi: {
    privacy: { network: {
      networkPredictionEnabled: blockedPrediction,
      peerConnectionEnabled: setting(true, "controlled_by_other_extensions"),
      webRTCIPHandlingPolicy: blockedRtc
    }},
    proxy: { settings: { async get() { return { levelOfControl: "controlled_by_other_extensions" }; } } }
  }
}).apply();
assert.equal(unsafe.privacySafe, false, "uncontrollable unsafe browser settings must remain fail closed");

const noApi = { privacySafe: true };
await mod.createPrivacyController({
  getState: async () => ({ global: { enforcePrivacyControls: true } }),
  securityState: noApi,
  browserApi: {}
}).apply();
assert.equal(noApi.privacySafe, false);

console.log("privacy controller tests passed");
