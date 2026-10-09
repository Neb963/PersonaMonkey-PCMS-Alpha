export const SCHEMA_VERSION = 3;
export const MAX_WORKFLOW_STEP_TIMEOUT_MS = 60 * 60_000;
export const BLOCK_ROUTE_ID = "__block__";
export const DIRECT_ROUTE_ID = "__direct__";
export const MULLVAD_SOCKS_API = "https://api.mullvad.net/network/v1-beta1/socks-proxies";
export const MULLVAD_CHECK_URL = "https://am.i.mullvad.net/json";
export const BLACKHOLE_PROXY = Object.freeze({
  type: "socks",
  host: "127.0.0.1",
  port: 9,
  proxyDNS: true,
  failoverTimeout: 1,
  connectionIsolationKey: "persona-route-manager-block"
});

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  global: {
    profileTargetCount: 30,
    profileNamePrefix: "Persona",
    unmanagedPolicy: "direct",
    blockSpeculative: true,
    strictProxyVerification: true,
    enforcePrivacyControls: true,
    disableNetworkPrediction: true,
    webRTCMode: "proxy_only",
    autoReloadOnRouteChange: true,
    exportSecretsByDefault: false,
    integration: {
      enabled: false,
      trustedExtensionIds: [],
      allowDestructive: false,
      allowDirect: false,
      allowExternalAutomation: false,
      allowExecutableInstall: false
    },
    userscripts: {
      dependencyFetch: "direct",
      autoAssignImportedToAllProfiles: false,
      autoAssignImportedToAllProfilesConfirmed: false,
      defaultInjectInto: "auto"
    },
    automation: {
      maxTabsTotal: 40,
      maxTabsPerStep: 20,
      maxJobRuntimeMinutes: 60,
      historyLimit: 100
    },
    mullvadNative: {
      enabled: true,
      autoStart: true,
      autoStopMinutes: 15,
      requireReady: true
    }
  },
  profiles: {},
  routes: {},
  scripts: {},
  workflows: {},
  personaRotations: {},
  wireguardImports: []
});
