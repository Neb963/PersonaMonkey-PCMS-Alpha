import assert from "node:assert/strict";
import test from "node:test";

import {
  SANDBOX_BOOTSTRAP_TYPE,
  SANDBOX_ERROR_CODES,
  SANDBOX_PROTOCOL_VERSION,
  cloneSandboxJson,
  safeSandboxError,
  validateSandboxBootstrap,
  validateSandboxPortMessage
} from "../../extension/pcms/sandbox/protocol.js";

test("A004-01 bounded JSON clone accepts data and rejects executable/exotic structure", () => {
  const source={ ok:true, nested:{ values:[1,"two",null] } };
  assert.deepEqual(cloneSandboxJson(source), source);

  const cycle={};
  cycle.self=cycle;
  assert.throws(() => cloneSandboxJson(cycle), (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL);

  const accessor={};
  Object.defineProperty(accessor, "value", { enumerable:true, get() { return "secret"; } });
  assert.throws(() => cloneSandboxJson(accessor), (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL);

  const polluted=Object.create(null);
  Object.defineProperty(polluted, "__proto__", { enumerable:true, value:{admin:true} });
  assert.throws(() => cloneSandboxJson(polluted), (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL);

  assert.throws(
    () => cloneSandboxJson("x".repeat(70 * 1024)),
    (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL
  );
});

test("A004-02 bootstrap and private-port envelopes are version/session fenced", () => {
  const sessionId="session-004";
  assert.deepEqual(
    validateSandboxBootstrap({
      type:SANDBOX_BOOTSTRAP_TYPE,
      version:SANDBOX_PROTOCOL_VERSION,
      sessionId
    }),
    { type:SANDBOX_BOOTSTRAP_TYPE, version:SANDBOX_PROTOCOL_VERSION, sessionId }
  );

  assert.throws(
    () => validateSandboxBootstrap({
      type:SANDBOX_BOOTSTRAP_TYPE,
      version:SANDBOX_PROTOCOL_VERSION,
      sessionId,
      extra:true
    }),
    (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL
  );

  const request={
    version:SANDBOX_PROTOCOL_VERSION,
    sessionId,
    type:"request",
    requestId:"req-1",
    method:"controller.invoke",
    params:{ method:"ping", args:{value:1} }
  };
  assert.deepEqual(validateSandboxPortMessage(request, sessionId), request);

  assert.throws(
    () => validateSandboxPortMessage({ ...request, sessionId:"stale" }, sessionId),
    (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL
  );
  assert.throws(
    () => validateSandboxPortMessage({ ...request, type:"unknown" }, sessionId),
    (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL
  );
});

test("A004-02 sandbox errors expose only the fixed public vocabulary", () => {
  assert.deepEqual(
    safeSandboxError(SANDBOX_ERROR_CODES.CAPABILITY_DENIED),
    { code:SANDBOX_ERROR_CODES.CAPABILITY_DENIED, message:"Capability is not granted" }
  );
  assert.deepEqual(
    safeSandboxError("PRIVATE_STACK_OR_SECRET"),
    { code:SANDBOX_ERROR_CODES.PROTOCOL, message:"Sandbox protocol violation" }
  );
  assert.equal(Object.keys(SANDBOX_ERROR_CODES).length, 9);
});
