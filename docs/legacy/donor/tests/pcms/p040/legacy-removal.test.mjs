import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const LEGACY_IDS = [
  "accountCreateForm", "accountRebindForm", "accountCreatePersonaUid", "accountRebindPersonaUid",
  "explorerLiveForm", "deployerLiveForm", "refresherLiveForm", "provisioningLiveForm",
  "backupCreateForm", "restoreApplyForm", "recoveryReleaseForm", "backupPayload", "recoveryStatus",
  "moduleExplorerList", "moduleDeployerList", "moduleRefresherList", "moduleStatisticsList", "moduleProvisioningList"
];

test("A040-03 the P026 legacy operator forms and module cards are removed from the dashboard", async () => {
  const [html, app, controls, css] = await Promise.all([
    readFile("extension/pcms/app/index.html", "utf8"),
    readFile("extension/pcms/app/app.js", "utf8"),
    readFile("extension/pcms/app/live-controls.js", "utf8"),
    readFile("extension/pcms/app/app.css", "utf8")
  ]);
  for (const id of LEGACY_IDS) {
    assert.equal(html.includes('id="' + id + '"'), false, "index.html still has " + id);
    assert.equal(app.includes('"' + id + '"'), false, "app.js still renders " + id);
  }
  assert.doesNotMatch(html, /Credential SecretRef|Observed source SHA-256|Desired source<textarea|Refresh source/);
  assert.doesNotMatch(controls, /form\(|FormData|LiveForm|sha256Hex|createCohort|createDeployment|createAttempt|createBackup/);
  assert.doesNotMatch(app, /function renderModules|appendModuleRow|#restoreApplyForm/);
  assert.doesNotMatch(css, /#backupPayload/);
  // What stays in live-controls is the accepted ADR-002 §9 handoff and HumanTask handling.
  assert.match(controls, /providerHandoff\.describe/);
  assert.match(controls, /providerHandoff\.answer/);
  assert.match(controls, /humanTasks\.resolve/);
});

test("A040-03 every superseded P026 DOM assertion is replaced by an equivalent assertion on its new surface", async () => {
  const superseding = {
    "tests/pcms/p026/boundary.test.mjs":[/superseded by A040-03/, /SETTINGS_VIEW/, /PROVISIONING_UI/, /REFRESHER_UI/, /EXPLORER_UI/, /ACCOUNTS_VIEW/,
      /LEGACY_FORM_IDS/, /accountsV2/],
    "tests/pcms/p032/shell.test.mjs":[/P040 \(A040-03\)/, /"settingsBackup","viewModulePage","moduleInputDialog"/],
    "tests/pcms/p041/boundary.test.mjs":[/P040 superseded the inherited P026 restore form/, /doesNotMatch\(html, \/id="restoreApplyForm"/],
    "tests/pcms/p034/accounts-model.test.mjs":[/A040-03 supersedes the hidden P026 account forms/],
    "tests/pcms/p025/live-wiring.test.mjs":[/A040-03: the module cards of the P026 page are superseded/, /renderModulePage/],
    "tools/firefox/packaged.mjs":[/P040 \(A040-03\)/, /backupFromSettings/, /all packaged feature modules contribute live pages/]
  };
  for (const [path, patterns] of Object.entries(superseding)) {
    const source = await readFile(path, "utf8");
    for (const pattern of patterns) assert.match(source, pattern, path);
    for (const id of ["explorerLiveForm", "deployerLiveForm", "refresherLiveForm", "backupCreateForm"]) {
      // A legacy ID may only appear in an assertion that it is absent.
      for (const line of source.split("\n").filter((text) => text.includes(id))) {
        assert.match(line, /LEGACY|doesNotMatch|includes\('id="'\+id|"accountCreateForm"|'accountCreateForm'|'refresherLiveForm'|"explorerLiveForm"|"backupCreateForm"/, path + ": " + line.trim());
      }
    }
  }
});
