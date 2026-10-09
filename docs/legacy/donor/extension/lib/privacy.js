export function canSet(settingInfo) {
  return settingInfo?.levelOfControl === "controllable_by_this_extension" ||
    settingInfo?.levelOfControl === "controlled_by_this_extension";
}

export function createPrivacyController({ getState, securityState, browserApi = browser } = {}) {
  if (!getState) throw new Error("Privacy controller requires getState");
  if (!securityState) throw new Error("Privacy controller requires securityState");

  async function apply() {
    const state = await getState();
    const g = state.global;
    const network = browserApi.privacy?.network;
    if (!network) {
      securityState.networkPredictionSafe = false;
      securityState.webRTCSafe = false;
      securityState.privacySafe = !g.enforcePrivacyControls;
      return securityState;
    }

    try {
      let prediction = await network.networkPredictionEnabled.get({});
      if (g.disableNetworkPrediction && prediction.value !== false && canSet(prediction)) {
        await network.networkPredictionEnabled.set({ value: false });
        prediction = await network.networkPredictionEnabled.get({});
      }
      securityState.networkPredictionSafe = !g.disableNetworkPrediction || prediction.value === false;

      let peer = await network.peerConnectionEnabled.get({});
      let rtc = await network.webRTCIPHandlingPolicy.get({});

      if (g.webRTCMode === "disabled") {
        if (peer.value !== false && canSet(peer)) {
          await network.peerConnectionEnabled.set({ value: false });
          peer = await network.peerConnectionEnabled.get({});
        }
        securityState.webRTCSafe = peer.value === false;
      } else if (g.webRTCMode === "proxy_only") {
        if (peer.value !== false && rtc.value !== "proxy_only" && canSet(rtc)) {
          await network.webRTCIPHandlingPolicy.set({ value: "proxy_only" });
          rtc = await network.webRTCIPHandlingPolicy.get({});
        }
        securityState.webRTCSafe = peer.value === false || rtc.value === "proxy_only";
      } else {
        securityState.webRTCSafe = true;
      }

      try {
        const proxySettings = await browserApi.proxy.settings.get({});
        securityState.proxyControl = proxySettings.levelOfControl || "unknown";
      } catch {
        securityState.proxyControl = "unknown";
      }

      securityState.privacySafe = securityState.networkPredictionSafe && securityState.webRTCSafe;
    } catch (error) {
      console.error("Unable to apply privacy controls", error);
      securityState.privacySafe = false;
    }
    return securityState;
  }

  return { apply };
}
