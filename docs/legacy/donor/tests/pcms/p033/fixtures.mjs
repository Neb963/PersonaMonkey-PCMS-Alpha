// P033 fixtures. Neither module is compiled into the XPI or named anywhere in extension code.
//
// "fixture.board" is a runtime module (pcms.module-manifest/v2 with a `ui` entry). Its
// controller publishes its descriptor, summary, conditions and search entries through
// core.ui.publish and answers on-demand pulls (uiFacet, uiListRows, uiGetDetail, uiInvoke).
// Its `ui` entry runs in the sandboxed module-UI frame: it records realm facts through a
// declared LOCAL action and then requests the DESTRUCTIVE "reset", which Core must confirm.
//
// "fixture-shelf" is a built-in contribution object, injected as one bundled-module entry.
import { encodeModuleArchive } from "../../../extension/pcms/modules/package.js";

export const BOARD_ID = "fixture.board";
export const SHELF_ID = "fixture-shelf";
export const BOARD_CAPABILITIES = Object.freeze([
  "core.ui.publish",
  "module.audit.append",
  "module.storage.read",
  "module.storage.write"
]);

function controllerSource({ version, nonce, variant }) {
  return `(api) => {
  const VERSION = ${JSON.stringify(version)};
  const NONCE = ${JSON.stringify(nonce)};
  const VARIANT = ${JSON.stringify(variant)};
  const ID = ${JSON.stringify(BOARD_ID)};
  async function read(key) { return (await api.call("module.storage.read", { key })).value; }
  async function write(key, update) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await api.call("module.storage.read", { key });
      const result = await api.call("module.storage.write", { key, expectedRevision: current.revision, value: update(current.value) });
      if (result.ok) return result;
    }
    throw new Error("storage conflict");
  }
  async function board() { return (await read("board")) || { resets: 0, cards: ["alpha", "beta"], pinned: [] }; }
  function descriptor() {
    if (VARIANT === "future-contract") return { contractVersion: 2, moduleId: ID, title: "Board from the future" };
    if (VARIANT === "invalid-ui") return { contractVersion: 1, moduleId: ID, title: "Board", nav: { label: "Board", order: 60 }, unknownKey: true };
    return {
      contractVersion: 1,
      moduleId: ID,
      title: "Fixture board",
      description: "Runtime fixture module contributing through pcms.ui-contribution/v1.",
      icon: "grid",
      nav: { label: "Board", order: 60, statusFrom: "summary" },
      facets: ["account"],
      actions: [
        { id: "record-probe", label: "Record UI probe", appliesTo: "module", risk: "LOCAL",
          input: [{ key: "facts", label: "Facts", kind: "text", maxLength: 4000 }] },
        { id: "reset", label: "Reset board", appliesTo: "module", risk: "DESTRUCTIVE", preview: true },
        { id: "pin", label: "Pin account", appliesTo: "account", risk: "LOCAL" }
      ],
      settings: [{ key: "columns", label: "Columns", kind: "integer", min: 1, max: 6, default: 3 }],
      page: { frame: true }
    };
  }
  async function publish() {
    const state = await board();
    return api.call("core.ui.publish", {
      descriptor: descriptor(),
      summary: { status: { token: "WARNING", label: "Needs review" },
        headline: state.cards.length + " cards · board " + NONCE.slice(0, 8),
        facts: [{ label: "Version", value: VERSION }, { label: "Resets", value: String(state.resets) }],
        href: "#/m/" + ID },
      conditions: [{ key: "review", priority: "HIGH", status: { token: "WARNING", label: "Review" },
        title: "Board review " + NONCE.slice(0, 8), subject: { kind: "module", id: ID } }],
      search: state.cards.map((card) => ({ entity: { kind: "module-object", moduleId: ID, view: "card", id: card },
        title: "Board card " + card, subtitle: "Fixture board " + VERSION, keywords: ["boardcard", NONCE] }))
    });
  }
  return {
    async start() {
      if (VARIANT === "fail-start") throw new Error("fixture start failure");
      const published = await publish();
      return { version: VERSION, published };
    },
    async uiFacet(input) {
      if (VARIANT === "slow-facet") { await new Promise((resolve) => setTimeout(resolve, 5000)); }
      const state = await board();
      const id = input.entity.id;
      return { title: "Board", status: { token: "OK", label: "Tracked" },
        facts: [{ label: "Pinned", value: state.pinned.includes(id) ? "yes" : "no" }, { label: "Board", value: NONCE.slice(0, 8) }],
        actions: ["pin"] };
    },
    async uiListRows(input) {
      const state = await board();
      return { rows: state.cards.map((card) => ({ id: card, cells: { card } })), next: null };
    },
    async uiGetDetail(input) {
      return { title: "Card " + input.id, sections: [{ title: "Card", facts: [{ label: "Id", value: input.id }] }] };
    },
    async uiInvoke(input) {
      if (input.actionId === "reset") {
        if (input.mode === "preview") {
          const state = await board();
          return { status: { token: "INFO", label: "Preview" }, message: "Reset clears " + state.cards.length + " cards.",
            impact: { title: "Reset the fixture board?", consequences: ["All " + state.cards.length + " cards are removed."], confirmLabel: "Reset board" } };
        }
        await write("board", (value) => ({ resets: ((value && value.resets) || 0) + 1, cards: [], pinned: (value && value.pinned) || [] }));
        await publish();
        return { status: { token: "OK", label: "Reset" }, message: "Board reset.", subject: { kind: "module", id: ID } };
      }
      if (input.actionId === "record-probe") {
        await write("ui-probe", () => ({ facts: JSON.parse(input.input.facts), version: VERSION }));
        return { status: { token: "OK", label: "Recorded" }, message: "UI probe recorded." };
      }
      if (input.actionId === "pin") {
        await write("board", (value) => {
          const state = value || { resets: 0, cards: ["alpha", "beta"], pinned: [] };
          return { ...state, pinned: [...new Set([...state.pinned, input.target.id])] };
        });
        return { status: { token: "OK", label: "Pinned" }, message: "Account pinned.", subject: input.target };
      }
      throw new Error("unknown action");
    }
  };
}`;
}

// Runs in the module-UI sandbox frame with the Core UI kit. Realm facts are reported only
// through a declared action, so the evidence crosses the same validated boundary as data.
export const BOARD_UI_SOURCE = `(ui) => {
  const facts = {
    browserAbsent: typeof browser === "undefined",
    chromeAbsent: typeof chrome === "undefined",
    origin: String(self.origin),
    moduleId: ui.context.moduleId
  };
  try { facts.parentDocumentReadable = Boolean(parent.document && parent.document.body); } catch (error) { facts.parentDocumentReadable = false; }
  try { facts.topLocation = String(top.location.href); } catch (error) { facts.topLocation = null; }
  try { localStorage.setItem("pcms-p033", "x"); facts.storageAvailable = true; } catch (error) { facts.storageAvailable = false; }
  const heading = ui.h("h2", { text: "Fixture board (runtime module page)" });
  const list = ui.h("ul", { "data-board": "cards" });
  const status = ui.h("p", { text: "Probing…" });
  ui.root.append(ui.h("section", null, heading, status, list));
  const network = typeof fetch !== "function"
    ? Promise.resolve("no-fetch")
    : fetch("https://example.com/pcms-p033-probe").then(() => "reached", () => "blocked");
  return ui.listRows("cards").then((page) => {
    for (const row of page.rows) list.append(ui.h("li", { text: row.cells.card }));
    facts.rowsRead = page.rows.length;
    return network;
  }).then((outcome) => {
    facts.network = outcome;
    return ui.invoke("other-module-action").then(() => { facts.undeclaredActionRejected = false; }, () => { facts.undeclaredActionRejected = true; });
  }).then(() => ui.invoke("record-probe", null, { facts: JSON.stringify(facts) }))
    .then(() => ui.resize(360))
    .then(() => { status.textContent = "Requesting reset…"; return ui.invoke("reset"); })
    .then((receipt) => { status.textContent = receipt.cancelled ? "Reset cancelled" : "Reset done"; });
}`;

export function buildBoardArchiveText({
  version = "1.0.0",
  nonce = "fixture-nonce-0000",
  variant = "ok",
  withUi = true,
  capabilities = BOARD_CAPABILITIES
} = {}) {
  const manifest = {
    schemaVersion: 2,
    moduleId: BOARD_ID,
    version,
    controller: "controller.js",
    authority: { capabilities: [...capabilities] }
  };
  const files = { "controller.js": controllerSource({ version, nonce, variant }) };
  if (withUi) {
    manifest.ui = "ui.js";
    files["ui.js"] = BOARD_UI_SOURCE;
  }
  return new TextDecoder().decode(encodeModuleArchive({ format: "pcms.module.archive/v1", manifest, files }));
}

// A built-in module contribution, as pcms-modules/<id>/ui.js would return it.
export function createShelfContribution({ fail = null, state = { items: ["oak", "pine"] } } = {}) {
  const calls = [];
  const contribution = {
    contractVersion: 1,
    moduleId: SHELF_ID,
    title: "Fixture shelf",
    description: "Built-in fixture contributing in process.",
    icon: "archive",
    nav: { label: "Shelf", order: 40, statusFrom: "summary" },
    actions: [
      { id: "restock", label: "Restock", appliesTo: "module", risk: "LOCAL" },
      { id: "empty", label: "Empty shelf", appliesTo: "module", risk: "DESTRUCTIVE" },
      { id: "assign", label: "Assign account", appliesTo: "account", risk: "BINDING",
        input: [{ key: "slot", label: "Slot", kind: "integer", min: 1, max: 9, required: true }] }
    ],
    page: { views: [
      { id: "items", title: "Items", type: "list", columns: [{ id: "name", label: "Name", kind: "text" }], rowHref: "item", actions: [] },
      { id: "item", title: "Item", type: "detail", actions: [] }
    ] },
    async summary() {
      if (fail === "summary") throw new Error("summary failed");
      return { status: { token: "OK", label: "Stocked" }, headline: state.items.length + " shelf items", facts: [{ label: "Items", value: String(state.items.length) }] };
    },
    async search(_ctx, query, limit) {
      return state.items.filter((item) => item.includes(query.toLowerCase())).slice(0, limit)
        .map((item) => ({ entity: { kind: "module-object", moduleId: SHELF_ID, view: "item", id: item }, title: "Shelf item " + item, score: 85 }));
    },
    facets: {
      async account(_ctx, ref) {
        if (fail === "facet") throw new Error("facet failed");
        if (fail === "slow-facet") return new Promise(() => {});
        return { title: "Shelf", facts: [{ label: "Slots for " + ref.id, value: "2" }], actions: ["assign"] };
      }
    },
    async conditions() {
      return [{ key: "low-stock", priority: "NORMAL", status: { token: "INFO", label: "Low" }, title: "Shelf stock is low", subject: { kind: "module", id: SHELF_ID } }];
    },
    async listRows(_ctx, viewId) {
      return { rows: state.items.map((item) => ({ id: item, cells: { name: item } })) };
    },
    async getDetail(_ctx, viewId, id) {
      return { title: "Item " + id, sections: [{ title: "Item", facts: [{ label: "Name", value: id }] }] };
    },
    async invoke(_ctx, actionId, target, input, options) {
      calls.push({ actionId, target, input, options });
      if (actionId === "empty") state.items = [];
      if (actionId === "restock") state.items = [...state.items, "birch"];
      return { status: { token: "OK", label: "Done" }, message: actionId + " done" };
    },
    formatActivity(event) {
      return event.type === "module.event.restocked" ? { text: "Shelf restocked", token: "OK" } : null;
    }
  };
  return { contribution, calls, state };
}
