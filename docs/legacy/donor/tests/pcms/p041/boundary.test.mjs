// A041 boundary (SEC): the Settings views are UI clients only, and the recovery core keeps
// the accepted P020 authority limits for the new preview/checklist code.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const VIEW_DIR = "extension/pcms/app/views/settings/";

test("A041 SEC settings views use only the UI client: no Core, recovery, browser or storage authority", async () => {
  const names = (await readdir(VIEW_DIR)).filter((name) => name.endsWith(".js"));
  assert.deepEqual(names.sort(), ["backup-model.js", "modules-model.js", "settings-view.js"]);
  for (const name of names) {
    const source = await readFile(VIEW_DIR + name, "utf8");
    for (const [, from] of source.matchAll(/from\s+"([^"]+)"/g)) {
      assert.match(from, /^\.\/|^\.\.\/\.\.\/router-v2\.js$/, name + " imports " + from);
    }
    assert.doesNotMatch(source, /\bbrowser\s*\.|\bchrome\s*\.|indexedDB|localStorage|sessionStorage|sendNativeMessage|console\.|fetch\s*\(|eval\s*\(|innerHTML/, name);
  }
});

test("A041 SEC recovery core additions keep P020 limits and never dispatch", async () => {
  const files = ["errors.js", "schema.js", "retention.js", "backup-restore.js", "preview.js"];
  const source = (await Promise.all(files.map((name) => readFile("extension/pcms/recovery/" + name, "utf8")))).join("\n");
  for (const forbidden of [/\bbrowser\s*\./, /\bchrome\s*\./, /sendNativeMessage/, /\bnativeMessaging\b/, /resolveForPrivilegedUse/,
    /secretValue/i, /\bpassword\b/i, /\bpassphrase\b/i, /\beval\s*\(/, /gate\.mutate|beginDispatch|markSucceeded|markFailed/]) {
    assert.equal(forbidden.test(source), false, String(forbidden));
  }
});

test("A041 shell wiring: Backup & restore and Modules management are mounted in Settings", async () => {
  const [html, app] = await Promise.all([readFile("extension/pcms/app/index.html", "utf8"), readFile("extension/pcms/app/app.js", "utf8")]);
  assert.match(html, /id="viewSettingsBackup"/);
  assert.match(html, /id="settingsBackup"/);
  assert.match(html, /id="settingsModulesManager"/);
  assert.match(html, /views\/settings\/settings\.css/);
  assert.match(app, /createPcmsSettingsView/);
  assert.match(app, /section==="backup"&&settingsBackup\) return "settingsBackup"/);
  // P040 superseded the inherited P026 restore form: restore is only the previewed,
  // typed-confirmation flow of Settings → Backup & restore, and the legacy form is gone.
  assert.doesNotMatch(html, /id="restoreApplyForm"|id="backupPayload"/);
  assert.match(html, /id="settingsBackup"/);
});
