// P033 contract regressions: pcms.ui-contribution/v1 validation and the additive
// pcms.module-manifest/v2 `ui` entry (A033-01 C, A033-02 SEC).
import assert from "node:assert/strict";
import test from "node:test";

import {
  PCMS_UI_CONTRIBUTION_ERROR_CODES as E,
  PCMS_UI_LIMITS,
  normalizePcmsUiDescriptor,
  normalizePcmsUiFacet,
  normalizePcmsUiInput,
  normalizePcmsUiListPage,
  normalizePcmsUiPublish,
  normalizePcmsUiReceipt,
  normalizePcmsUiSummary,
  pcmsUiEntityHref
} from "../../../extension/pcms/integration/ui-contribution-contract.js";
import { normalizeBuiltinContribution } from "../../../extension/pcms/integration/ui-contributions.js";
import { encodeModuleArchive, hashModuleArchiveBytes, parseModuleArchive } from "../../../extension/pcms/modules/package.js";
import { createModulePackageRegistry } from "../../../extension/pcms/modules/registry.js";
import { createPcmsStorageBroker } from "../../../extension/pcms/storage/storage-broker.js";
import { makeMemoryBackend } from "../p023/harness.mjs";
import { buildCounterArchiveText } from "../../fixtures/modules/counter.mjs";
import { BOARD_ID, buildBoardArchiveText, createShelfContribution } from "./fixtures.mjs";

const base = () => ({ contractVersion: 1, moduleId: "demo", title: "Demo" });
const code = (fn) => { try { fn(); } catch (error) { return error.code; } return null; };

test("A033-01 C descriptor v1 is strict: unknown keys, bounds, icons and action references fail closed", () => {
  const ok = normalizePcmsUiDescriptor({ ...base(), nav: { label: "Demo" }, actions: [{ id: "run", label: "Run", appliesTo: "module", risk: "LOCAL" }] }, { moduleId: "demo" });
  assert.equal(ok.icon, "box");
  assert.equal(ok.nav.order, 100);
  assert.deepEqual(ok.actions.map((action) => [action.id, action.risk, action.preview]), [["run", "LOCAL", false]]);
  assert.equal(Object.isFrozen(ok), true);

  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), extra: 1 }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor(base(), { moduleId: "other" })), E.INVALID, "descriptor id must equal the module id");
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), title: "x".repeat(41) }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), title: "line\nbreak" }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), icon: "skull" }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), actions: [{ id: "a", label: "A", appliesTo: "module", risk: "ROOT" }] }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), actions: Array.from({ length: 33 }, (_, i) => ({ id: "a" + i, label: "A", appliesTo: "module", risk: "READ" })) }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), page: { views: [{ id: "l", title: "L", type: "list", columns: [{ id: "c", label: "C", kind: "text" }], actions: ["nope"] }] } }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), page: { views: [{ id: "l", title: "L", type: "list", columns: [{ id: "c", label: "C", kind: "text" }], rowHref: "missing" }] } }, { moduleId: "demo" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiDescriptor({ ...base(), page: { frame: true } }, { moduleId: "demo", kind: "builtin" })), E.INVALID, "only runtime modules get a frame");
  const getter = base();
  Object.defineProperty(getter, "description", { enumerable: true, get() { return "x"; } });
  assert.equal(code(() => normalizePcmsUiDescriptor(getter, { moduleId: "demo" })), E.INVALID, "accessors are rejected");
});

test("A033-03 unsupported contract versions are reported as incompatible, not as broken data", () => {
  let error;
  try { normalizePcmsUiDescriptor({ contractVersion: 2, moduleId: "demo", title: "Future" }, { moduleId: "demo" }); } catch (caught) { error = caught; }
  assert.equal(error.code, E.UNSUPPORTED);
  assert.equal(error.contractVersion, 2);
});

test("A033-01 C module values are bounded text with Core-owned routing", () => {
  const summary = normalizePcmsUiSummary({ status: { token: "WARNING", label: "Check" }, headline: "3 things", facts: [{ label: "A", value: 1 }], href: "#/m/demo" });
  assert.deepEqual(summary.facts, [{ label: "A", value: "1" }]);
  assert.equal(code(() => normalizePcmsUiSummary({ status: { token: "WARNING", label: "x" }, headline: "h", facts: Array(5).fill({ label: "a", value: "b" }) })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiSummary({ status: { token: "PURPLE", label: "x" }, headline: "h" })), E.INVALID);
  for (const href of ["javascript:alert(1)", "https://example.com/", "#/m/../x", "#//evil", "#/m/x\"onload"]) {
    assert.equal(code(() => normalizePcmsUiSummary({ status: { token: "OK", label: "x" }, headline: "h", href })), E.INVALID, href);
  }
  assert.equal(pcmsUiEntityHref({ kind: "account", id: "alice" }), "#/accounts/alice");
  assert.equal(pcmsUiEntityHref({ kind: "module", id: "fixture.board" }), "#/m/fixture.board");
  assert.equal(pcmsUiEntityHref({ kind: "module-object", moduleId: "fixture.board", view: "card", id: "a/b" }), "#/m/fixture.board/card/a%2Fb");
  assert.equal(code(() => pcmsUiEntityHref({ kind: "file", id: "/etc/passwd" })), E.INVALID);

  assert.equal(code(() => normalizePcmsUiFacet({ title: "F", facts: [], actions: ["undeclared"] }, { actionIds: ["pin"] })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiFacet({ title: "F", facts: [], columns: { a: { label: "a", value: 1 }, b: { label: "b", value: 1 }, c: { label: "c", value: 1 }, d: { label: "d", value: 1 } } })), E.INVALID);
  const page = normalizePcmsUiListPage({ rows: [{ id: "r1", cells: { n: "x", s: { token: "OK", label: "ok" } } }] },
    { columns: [{ id: "n", label: "N", kind: "text" }, { id: "s", label: "S", kind: "status" }] });
  assert.deepEqual(page.rows[0].cells.s, { token: "OK", label: "ok" });
  assert.equal(code(() => normalizePcmsUiListPage({ rows: [{ id: "r1", cells: { other: 1 } }] }, { columns: [{ id: "n", label: "N", kind: "text" }] })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiListPage({ rows: Array.from({ length: PCMS_UI_LIMITS.listRows + 1 }, (_, i) => ({ id: "r" + i, cells: {} })) }, { columns: [] })), E.INVALID);
});

test("A033-02 SEC receipts: impact only from previews, downloads only from READ actions", () => {
  const receipt = { status: { token: "OK", label: "ok" }, message: "done" };
  assert.equal(normalizePcmsUiReceipt(receipt).message, "done");
  const impact = { ...receipt, impact: { title: "Reset?", consequences: ["Removes 2"], confirmLabel: "Reset" } };
  assert.equal(normalizePcmsUiReceipt(impact, { mode: "preview" }).impact.confirmLabel, "Reset");
  assert.equal(code(() => normalizePcmsUiReceipt(impact, { mode: "execute" })), E.INVALID);
  const download = { ...receipt, download: { filename: "x.csv", mediaType: "text/csv", text: "a,b" } };
  assert.equal(normalizePcmsUiReceipt(download, { risk: "READ" }).download.filename, "x.csv");
  assert.equal(code(() => normalizePcmsUiReceipt(download, { risk: "LOCAL" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiReceipt({ ...receipt, download: { filename: "../x", mediaType: "text/csv", text: "" } }, { risk: "READ" })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiReceipt({ ...receipt, download: { filename: "x.html", mediaType: "text/html", text: "" } }, { risk: "READ" })), E.INVALID);
});

test("A033-02 SEC action input is validated by Core against the declared InputSpec", () => {
  const { contribution } = createShelfContribution();
  const { descriptor } = normalizeBuiltinContribution(contribution, "fixture-shelf");
  const assign = descriptor.actions.find((action) => action.id === "assign");
  assert.deepEqual(normalizePcmsUiInput(assign.input, { slot: 3 }), { slot: 3 });
  assert.equal(code(() => normalizePcmsUiInput(assign.input, { slot: 10 })), E.INVALID);
  assert.equal(code(() => normalizePcmsUiInput(assign.input, {})), E.INVALID, "required");
  assert.equal(code(() => normalizePcmsUiInput(assign.input, { slot: 1, extra: true })), E.INVALID, "undeclared field");
  assert.equal(code(() => normalizePcmsUiInput(null, { anything: 1 })), E.INVALID, "an action without input takes none");
});

test("A033-01 C runtime publish payload is bounded to 64 KiB and validated as a whole", () => {
  const publish = { descriptor: { contractVersion: 1, moduleId: BOARD_ID, title: "Board", page: { frame: true } }, summary: null };
  assert.equal(normalizePcmsUiPublish(publish, BOARD_ID).descriptor.page.frame, true);
  assert.equal(code(() => normalizePcmsUiPublish({ ...publish, search: [{ entity: { kind: "module", id: BOARD_ID }, title: "x".repeat(70), keywords: Array(9).fill("k") }] }, BOARD_ID)), E.INVALID);
  assert.equal(code(() => normalizePcmsUiPublish({ ...publish, conditions: Array.from({ length: PCMS_UI_LIMITS.conditions + 1 }, (_, i) => ({ key: "k" + i, priority: "LOW", status: { token: "INFO", label: "x" }, title: "t", subject: { kind: "module", id: BOARD_ID } })) }, BOARD_ID)), E.INVALID);
  // Each entry is individually valid; together they exceed the 64 KiB publish bound.
  const big = Array.from({ length: 200 }, (_, i) => ({ entity: { kind: "module", id: BOARD_ID }, title: "t" + i, subtitle: "s".repeat(200), keywords: Array(8).fill("k".repeat(80)) }));
  assert.equal(code(() => normalizePcmsUiPublish({ ...publish, search: big }, BOARD_ID)), E.INVALID, "64 KiB");
  assert.equal(normalizePcmsUiPublish({ ...publish, search: big.slice(0, 20) }, BOARD_ID).search.length, 20);
  assert.equal(code(() => normalizePcmsUiPublish({ ...publish, script: "alert(1)" }, BOARD_ID)), E.INVALID);
});

test("pcms.module-manifest/v2 is additive: v1 archives keep their exact bytes and hash", async () => {
  const v1Text = buildCounterArchiveText({ nonce: "manifest-v1" });
  const v1 = await parseModuleArchive(new TextEncoder().encode(v1Text));
  assert.equal(v1.manifest.schemaVersion, 1);
  assert.equal(v1.manifest.ui, undefined);
  const reencoded = encodeModuleArchive({ format: v1.format, manifest: v1.manifest, files: v1.files });
  assert.equal(new TextDecoder().decode(reencoded), v1Text, "canonical v1 bytes are unchanged");
  assert.equal(await hashModuleArchiveBytes(reencoded), v1.packageHash);

  const v2 = await parseModuleArchive(new TextEncoder().encode(buildBoardArchiveText()));
  assert.equal(v2.manifest.schemaVersion, 2);
  assert.equal(v2.manifest.ui, "ui.js");
  assert.ok(v2.files["ui.js"].startsWith("(ui) =>"));
  assert.equal((await parseModuleArchive(new TextEncoder().encode(buildBoardArchiveText({ withUi: false })))).manifest.ui, undefined, "ui stays optional in v2");

  const reject = async (manifest, files = { "controller.js": "(api) => ({})" }) => {
    try { encodeModuleArchive({ format: "pcms.module.archive/v1", manifest, files }); } catch (error) { return error.code; }
    return null;
  };
  const m = { moduleId: "demo.mod", version: "1.0.0", controller: "controller.js", authority: { capabilities: [] } };
  assert.equal(await reject({ schemaVersion: 1, ...m, ui: "ui.js" }, { "controller.js": "x", "ui.js": "y" }), "PCMS_MODULE_INVALID_MANIFEST", "v1 has no ui entry");
  assert.equal(await reject({ schemaVersion: 2, ...m, ui: "ui.js" }), "PCMS_MODULE_INVALID_MANIFEST", "ui file must exist");
  assert.equal(await reject({ schemaVersion: 2, ...m, ui: "controller.js" }), "PCMS_MODULE_INVALID_MANIFEST", "ui differs from controller");
  assert.equal(await reject({ schemaVersion: 2, ...m, ui: "ui.css" }, { "controller.js": "x", "ui.css": "y" }), "PCMS_MODULE_INVALID_MANIFEST");
  assert.equal(await reject({ schemaVersion: 3, ...m }), "PCMS_MODULE_INVALID_MANIFEST");
});

test("pcms.module-manifest/v2 packages round-trip through the registry with their ui entry", async () => {
  const storageBroker = createPcmsStorageBroker({ backend: makeMemoryBackend({ rows: new Map() }), clock: () => "2026-10-08T12:00:00.000Z" });
  const registry = createModulePackageRegistry({ storageBroker, clock: () => "2026-10-08T12:00:00.000Z" });
  const staged = await registry.stageCandidate(new TextEncoder().encode(buildBoardArchiveText()), { expectedModuleRevision: 0 });
  const stored = await registry.getPackage(staged.value.candidate.packageHash);
  assert.equal(stored.manifest.schemaVersion, 2);
  assert.equal(stored.manifest.ui, "ui.js");
  assert.equal(typeof stored.files["ui.js"], "string");
});
