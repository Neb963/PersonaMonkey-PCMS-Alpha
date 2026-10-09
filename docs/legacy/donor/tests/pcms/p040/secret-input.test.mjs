import test from "node:test";
import assert from "node:assert/strict";
import {
  PCMS_UI_INPUT_KINDS, PCMS_UI_SETTING_KINDS, normalizePcmsUiDescriptor, normalizePcmsUiInput, redactPcmsUiSecrets, wrapPcmsUiSecret
} from "../../../extension/pcms/integration/ui-contribution-contract.js";
import { PCMS_UI_RECEIPT_NAMESPACE, createPcmsUiDispatcher } from "../../../extension/pcms/background/ui-dispatcher.js";
import { BASE_URL, PCMS_SENDER, RUNTIME_ID, makeDurable } from "../p028/harness.mjs";

const SECRET_ACTION = { id:"start", label:"Start", appliesTo:"module", risk:"LOCAL",
  input:[{ key:"credential", label:"Password", kind:"secret", required:true }] };
const descriptor = (actions, kind = "builtin") => normalizePcmsUiDescriptor({ contractVersion:1, moduleId:"demo", title:"Demo", actions }, { moduleId:"demo", kind });

test("A040-01 pcms.ui-contribution/v1 secret input is additive, built-in only and never a setting or preview", () => {
  assert.ok(PCMS_UI_INPUT_KINDS.includes("secret"));
  assert.equal(PCMS_UI_SETTING_KINDS.includes("secret"), false);
  const spec = descriptor([SECRET_ACTION]).actions[0].input;
  assert.equal(normalizePcmsUiInput(spec, { credential:wrapPcmsUiSecret("hunter2") }).credential, "hunter2");
  assert.throws(() => normalizePcmsUiInput(spec, { credential:"hunter2" }), /invalid/, "plain strings are refused");
  assert.throws(() => normalizePcmsUiInput(spec, { credential:wrapPcmsUiSecret("") }), /invalid|required/);
  assert.throws(() => normalizePcmsUiInput(spec, {}), /required/);
  assert.throws(() => descriptor([SECRET_ACTION], "runtime"), /only built-in modules may take secret input/);
  assert.throws(() => descriptor([{ ...SECRET_ACTION, preview:true }]), /cannot have a preview/);
  assert.throws(() => descriptor([{ ...SECRET_ACTION, input:[{ ...SECRET_ACTION.input[0], default:"x" }] }]), /not allowed/);
  assert.throws(() => normalizePcmsUiDescriptor({ contractVersion:1, moduleId:"demo", title:"Demo",
    settings:[{ key:"token", label:"Token", kind:"secret" }] }, { moduleId:"demo" }), /invalid/);
  assert.deepEqual(redactPcmsUiSecrets(["demo", "start", null, { credential:wrapPcmsUiSecret("hunter2"), name:"Carol" }]),
    ["demo", "start", null, { credential:{ $pcmsSecret:"[redacted]" }, name:"Carol" }]);
});

test("A040-01 a UI command carrying a secret leaves no secret-derived data in its durable receipt", async () => {
  const durable = makeDurable();
  const seen = [];
  const core = {
    storageBroker:durable.storageBroker,
    ui:{ async invoke(moduleId, actionId, target, input) { seen.push(input.credential.$pcmsSecret); return { status:{ token:"OK", label:"Started" }, message:"Started." }; } }
  };
  const dispatcher = createPcmsUiDispatcher({ ensureCore:async () => core, readStatus:async () => ({ state:"RUNNING" }), runtimeId:RUNTIME_ID, extensionBaseUrl:BASE_URL, clock:durable.clock });
  const message = (secret, key = "ui-secret-0001") => ({ type:"PCMS_UI_REQUEST", version:1, requestId:"req-" + key, kind:"command", name:"ui.invoke",
    idempotencyKey:key, params:{ args:["provisioning", "start", null, { name:"Carol", credential:wrapPcmsUiSecret(secret) }, { idempotencyKey:"uia-0000000000000001" }] } });
  const first = await dispatcher.handle(message("hunter2"), PCMS_SENDER);
  assert.equal(first.ok, true);
  assert.deepEqual(seen, ["hunter2"], "the background module receives the value once");
  const rows = await durable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE).list();
  assert.equal(rows.length, 1);
  const stored = JSON.stringify(rows[0].value);
  assert.equal(stored.includes("hunter2"), false);
  // The receipt hash is over the redacted request: two different secrets hash identically, so
  // the stored hash cannot be used to test guesses of the secret.
  const otherDurable = makeDurable();
  const second = createPcmsUiDispatcher({ ensureCore:async () => ({ ...core, storageBroker:otherDurable.storageBroker }),
    readStatus:async () => ({ state:"RUNNING" }), runtimeId:RUNTIME_ID, extensionBaseUrl:BASE_URL, clock:durable.clock });
  await second.handle(message("a different secret"), PCMS_SENDER);
  const [other] = await otherDurable.storageBroker.namespace(PCMS_UI_RECEIPT_NAMESPACE).list();
  assert.equal(other.value.requestHash, rows[0].value.requestHash);
  // A replay of the same key returns the receipt without running the command again.
  const replay = await dispatcher.handle(message("hunter2"), PCMS_SENDER);
  assert.equal(replay.receipt.replayed, true);
  assert.equal(seen.length, 2, "only the two original executions ran");
});
