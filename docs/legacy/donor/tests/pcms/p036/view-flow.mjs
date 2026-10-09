// A036-03 Generators view flow, run in the P036 fixture add-on page (pinned Firefox in CI; see
// fixture-extension.mjs). Every module is imported from `base`, the fixture root, which holds
// the product XPI's pcms/ and pcms-modules/ trees byte for byte. Real shipped modules are used
// (Deployer, RemoteOps, ProviderGate, HumanTasks, Audit Journal, provider handoff, assisted
// driver, generator index and the Generators view) over in-memory storage, so the page drives
// the real view code with real File inputs, TextDecoder, crypto.subtle and Blob URLs while the
// product Core and PersonaMonkey state are never mutated.
export async function generatorsViewFlow({ base, documentRef, windowRef, hostId = "p036Fixture", nonce = String(Date.now()) }) {
  // W() waives Xrays if a caller ever runs this from a privileged sandbox (identity in a page);
  // objects handed to shipped modules are built with the modules' own Object/Array constructors
  // so their plain-data checks hold in whichever realm the modules live.
  const W = (value) => (value && typeof value === "object" && value.wrappedJSObject) || value;
  const load = async (path) => W(await import(base + path));
  const [deployerMod, remoteMod, holdMod, gateMod, adapterMod, assistedMod, handoffMod, indexMod, tasksMod, journalMod,
    auditBackendMod, storageMod, storageBackendMod, viewMod, adaptersMod] = await Promise.all([
    load("pcms-modules/p015/deployer.js"),
    load("pcms/remoteops/remote-ops.js"),
    load("pcms/remoteops/recovery-hold.js"),
    load("pcms/remoteops/provider-gate.js"),
    load("pcms/providers/perchance/adapter.js"),
    load("pcms/providers/perchance/assisted-driver.js"),
    load("pcms/integration/provider-handoff.js"),
    load("pcms/integration/generator-index.js"),
    load("pcms/services/human-tasks.js"),
    load("pcms/audit/journal.js"),
    load("pcms/audit/indexeddb-journal.js"),
    load("pcms/storage/storage-broker.js"),
    load("pcms/storage/indexeddb-backend.js"),
    load("pcms/app/views/generators/generators-view.js"),
    load("pcms/integration/adapters.js")
  ]);
  const dbName = "pcms-p036-fixture-" + nonce;
  const storage = W(storageMod.createPcmsStorageBroker({ backend:storageBackendMod.createIndexedDbStorageBackend({ dbName }) }));
  const RealmObject = W(Object.getPrototypeOf(storage)).constructor;
  const RealmArray = W(Object.getPrototypeOf(indexMod.PCMS_GENERATOR_STATUS_FILTERS)).constructor;
  const realm = (value) => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) { const out = W(new RealmArray()); for (const item of value) out.push(realm(item)); return out; }
    const out = W(new RealmObject());
    for (const [key, item] of Object.entries(value)) out[key] = typeof item === "function" ? item : realm(item);
    return out;
  };
  const copy = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(W(value))));
  const journal = W(journalMod.createPcmsAuditJournal({ backend:auditBackendMod.createIndexedDbAuditBackend({ dbName }) }));
  const remoteOps = W(remoteMod.createRemoteOps({ storageBroker:storage }));
  const recoveryHold = W(holdMod.createRecoveryHoldController({ storageBroker:storage, remoteOps }));
  const humanTasks = W(tasksMod.createHumanTaskService({ storageBroker:storage, auditJournal:journal }));
  const handoff = W(handoffMod.createProviderHandoff({ storageBroker:storage, humanTasks }));
  const opened = [];
  const release = W(assistedMod.createPerchanceAssistedReleaseMethods({
    operator:handoff,
    async openTarget({ operationId, generatorId, phase }) {
      trace.push("openTarget:" + phase);
      opened.push({ operationId, generatorId, phase });
      return realm({ targetRef:{ kind:"generator", id:generatorId } });
    }
  }));
  const driver = realm({
    async probe() {
      trace.push("probe");
      return realm({ contractId:"pcms.perchance.driver", contractVersion:2, providerId:"perchance", operations:["generator.update"],
        capabilities:{ unattended:false, observe:false, listing:false, thumbnail:false, create:false } });
    },
    async updateGenerator() { throw new Error("v1 path unused"); },
    async reconcileGeneratorUpdate() { return realm({ status:"UNKNOWN" }); },
    updateGeneratorRelease:release.updateGeneratorRelease,
    reconcileGeneratorRelease:release.reconcileGeneratorRelease
  });
  const adapter = W(adapterMod.createPerchanceProviderAdapter({ driver }));
  const gate = W(gateMod.createProviderGate({ remoteOps, recoveryHold, providers:realm({ perchance:adapter.providerDescriptor }) }));
  const accountRows = [
    { schemaVersion:1, kind:"account", accountId:"alice", providerId:"perchance", displayName:"Alice", personaUid:"11111111-1111-4111-8111-111111111111", bindingEpoch:1, createdAt:"2026-10-01T00:00:00.000Z", updatedAt:"2026-10-01T00:00:00.000Z" },
    { schemaVersion:1, kind:"account", accountId:"bob", providerId:"perchance", displayName:"Bob", personaUid:"22222222-2222-4222-8222-222222222222", bindingEpoch:1, createdAt:"2026-10-01T00:00:00.000Z", updatedAt:"2026-10-01T00:00:00.000Z" }
  ];
  const accounts = realm({
    async getAccount(id) { const row = accountRows.find((item) => item.accountId === id); return row ? realm(row) : null; },
    async listAccounts() { return realm({ revision:2, accounts:accountRows }); }
  });
  const deployer = W(deployerMod.createDeployerService({
    stateStore:adaptersMod.createSingletonStateStore({ storageBroker:storage, namespace:"module.deployer" }),
    accountsService:accounts,
    providerGateResolver:realm({ async get() { return gate; } }),
    remoteOperationReader:remoteOps
  }));
  const generators = W(indexMod.createGeneratorIndexService({ deployer, accounts, humanTasks, recoveryHold }));
  // UI-client facade: JSON round trip, exactly what crosses runtime.sendMessage.
  const trace = [];
  const call = (target, name) => async (...args) => {
    trace.push(name + ":start");
    try { const result = copy(await target[name](...args.map((arg) => realm(copy(arg))))); trace.push(name + ":ok"); return result; }
    catch (error) { trace.push(name + ":error:" + String(error?.code || error?.message || error).slice(0, 120)); throw error; }
  };
  const runtime = {
    generators:{ list:call(generators, "list"), get:call(generators, "get"), search:call(generators, "search") },
    deployer:Object.fromEntries(["listDeployments","createDeployment","setDesired","setPaused","prepareRetry","deploy","reconcileDeployment"].map((name) => [name, call(deployer, name)])),
    accounts:{ listAccounts:call(accounts, "listAccounts") },
    providerHandoff:{
      describe:call(handoff, "describe"),
      async answer(taskId, outcome) {
        const answered = copy(await handoff.answer(taskId, outcome));
        let operation = copy(await remoteOps.get(answered.operationId));
        if (operation?.value?.state === "UNCERTAIN") operation = copy(await gate.reconcile(answered.operationId));
        return { ...answered, operationState:operation?.value?.state ?? null };
      }
    }
  };

  const host = documentRef.createElement("div");
  host.id = hostId;
  documentRef.body.appendChild(host);
  const location = { hash:"#/generators" };
  const win = { location, navigator:{ clipboard:{ async writeText(text) { win.copied.push(String(text)); } } }, URL:W(windowRef).URL, copied:[] };
  const view = viewMod.createPcmsGeneratorsView({ documentRef, windowRef:win, runtime, mount:host });
  const q = (selector) => host.querySelector(selector);
  const qa = (selector) => [...host.querySelectorAll(selector)];
  const wait = async (predicate, label) => {
    for (let index = 0; index < 400; index += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 25)); }
    throw new Error("timed out: " + label + " · feedback: " + (q(".generators-feedback")?.textContent || "") + " · dialog: " + (q(".generators-dialog-status")?.textContent || "") + " · submitDisabled: " + q(".generators-modal button[type=submit]")?.disabled + " · trace: " + trace.join(",") + " · " + host.textContent.slice(0, 400));
  };
  const out = { steps:[] };

  await view.render({ route:"generators", id:null, filter:"", page:null });
  out.emptyText = q(".empty-state")?.textContent ?? null;

  // Deploy from file: Perchance address, account picker, real files, listing.
  q("[data-generators-action=deploy-new]").click();
  await wait(() => q(".generators-modal"), "deploy dialog");
  const textInputs = qa(".generators-modal input").filter((input) => input.type !== "file" && input.type !== "radio" && input.type !== "search");
  out.dialogTextInputs = textInputs.map((input) => input.name);
  const address = q(".generators-modal input[name=address]");
  address.value = "https://perchance.org/tavern-names";
  address.dispatchEvent(new Event("input", { bubbles:true }));
  q(".generators-modal [data-entity-id=alice]").click();
  const code = "// tavern-names 1.1.0\ntitle\n  The [adjective] [noun]\n";
  const html = "<h1>[title]</h1>\n";
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8]);
  const setFile = (name, parts, fileName, type) => {
    const input = q(".generators-modal input[name=" + name + "]");
    const transfer = new DataTransfer();
    transfer.items.add(new File(parts, fileName, { type }));
    input.files = transfer.files;
    input.dispatchEvent(new Event("change", { bubbles:true }));
  };
  setFile("code", [code], "code.perchance", "text/plain");
  setFile("html", [html], "page.html", "text/html");
  setFile("thumbnail", [jpeg], "thumbnail.jpeg", "image/jpeg");
  q(".generators-modal input[name=listing][value=UNLISTED]").click();
  out.previewText = q(".generators-preview")?.textContent ?? null;
  out.submitEnabled = q(".generators-modal button[type=submit]").disabled === false;
  q(".generators-modal button[type=submit]").click();
  await wait(() => !q(".generators-modal") && location.hash === "#/generators/perchance/tavern-names", "dialog closes and links to the generator");
  out.steps.push("deployed");

  // The background command returned with a durable handoff; render the detail page.
  await view.render({ route:"generators", id:"tavern-names", filter:"", page:null });
  await wait(() => q(".generators-handoff"), "handoff panel");
  out.waiting = { banner:q(".generators-banner")?.dataset.token ?? null, label:q(".generators-banner .status-token")?.textContent ?? null };
  const areas = qa(".generators-handoff textarea");
  out.handoffPanels = areas.map((area) => ({ label:area.getAttribute("aria-label"), value:area.value }));
  out.handoffListing = qa(".generators-handoff p").map((p) => p.textContent).find((text) => text.startsWith("Listing:")) ?? null;
  out.thumbnailLink = q(".generators-handoff a[download]")?.getAttribute("download") ?? null;
  q(".generators-handoff [data-copy=code]").click();
  await wait(() => win.copied.length === 1, "copy code");
  out.copiedCode = win.copied[0] === code;
  out.storedDeployer = JSON.stringify(copy(await deployer.listDeployments()));

  // "I'm not sure": stays unknown, nothing is retried, a fresh task opens.
  const firstTask = q(".generators-handoff").dataset.handoffTask;
  q(".generators-answer input[value=UNKNOWN]").click();
  q(".generators-answer button[type=submit]").click();
  await wait(() => q(".generators-handoff") && q(".generators-handoff").dataset.handoffTask !== firstTask, "fresh handoff task after UNKNOWN");
  out.afterUnknown = q(".generators-banner")?.dataset.token ?? null;
  out.dispatchOpens = opened.filter((item) => item.phase === "open").length;

  // "Yes": recorded Applied, Deployer settles from the RemoteOperation.
  q(".generators-answer input[value=APPLIED]").click();
  q(".generators-answer button[type=submit]").click();
  await wait(() => q(".generators-banner")?.dataset.token === "OK", "in sync after the answer");
  out.final = { label:q(".generators-banner .status-token")?.textContent ?? null, handoff:Boolean(q(".generators-handoff")),
    cards:qa(".generators-card").map((card) => card.textContent) };
  out.dispatchOpensFinal = opened.filter((item) => item.phase === "open").length;

  await view.render({ route:"generators", id:null, filter:"", page:null });
  await wait(() => q(".generators-table"), "list");
  out.listRow = qa(".generators-table tbody tr").map((tr) => [...tr.children].map((td) => td.textContent));
  out.rowHref = q(".generators-table tbody a")?.getAttribute("href") ?? null;
  view.destroy();
  host.remove();
  out.dbName = dbName;
  return out;
}
