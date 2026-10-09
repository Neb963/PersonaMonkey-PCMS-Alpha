import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";

import { SANDBOX_ERROR_CODES } from "../../extension/pcms/sandbox/protocol.js";
import { installSandboxControllerRuntime } from "../../extension/pcms/sandbox/controller-runtime.js";
import { createSandboxControllerHost } from "../../extension/pcms/runtime/sandbox-host.js";

function makeWindow(origin = "moz-extension://pcms-test") {
  const listeners=new Map();
  const parent={};
  return {
    parent,
    location:{ origin },
    addEventListener(type, listener) {
      const set=listeners.get(type) || new Set();
      set.add(listener);
      listeners.set(type,set);
    },
    removeEventListener(type, listener) {
      listeners.get(type)?.delete(listener);
    },
    emit(type, event) {
      for (const listener of [...(listeners.get(type) || [])]) listener(event);
    }
  };
}

function makeConnectedHarness({ capabilities = {} } = {}) {
  const windowRef=makeWindow();
  const runtime=installSandboxControllerRuntime({ windowRef, capabilityTimeoutMs:500 });
  const frame={
    contentWindow:{
      postMessage(data, targetOrigin, ports) {
        assert.equal(targetOrigin, "*");
        windowRef.emit("message", {
          source:windowRef.parent,
          origin:windowRef.location.origin,
          data,
          ports
        });
      }
    }
  };
  const host=createSandboxControllerHost({
    frame,
    capabilities,
    messageChannelFactory:() => new MessageChannel(),
    sessionIdFactory:() => "session-p004",
    timeoutMs:500
  });
  return { windowRef, runtime, host };
}

test("A004-01 sandbox bootstrap rejects wrong source and wrong parent origin", () => {
  const windowRef=makeWindow();
  const runtime=installSandboxControllerRuntime({ windowRef });
  const channel=new MessageChannel();
  const bootstrap={ type:"pcms.sandbox.bootstrap", version:1, sessionId:"probe" };

  windowRef.emit("message", {
    source:{},
    origin:windowRef.location.origin,
    data:bootstrap,
    ports:[channel.port1]
  });
  assert.equal(runtime.bootstrapped, false);

  windowRef.emit("message", {
    source:windowRef.parent,
    origin:"https://example.invalid",
    data:bootstrap,
    ports:[channel.port1]
  });
  assert.equal(runtime.bootstrapped, false);
  runtime.dispose();
  channel.port1.close();
  channel.port2.close();
});

test("A004-02/A004-03 dynamic controller receives only bounded capabilities and follows lifecycle", async () => {
  const { host }=makeConnectedHarness({
    capabilities:{
      "math.add":({a,b}) => a + b
    }
  });

  const source=`(api) => ({
    async start(input) {
      return {
        sum: await api.call("math.add", input),
        apiKeys: Object.keys(api).sort(),
        browserType: typeof browser,
        chromeType: typeof chrome
      };
    },
    async double(args) {
      return api.call("math.add", { a:args.value, b:args.value });
    },
    async denied() {
      return api.call("secret.raw", {});
    },
    async poisonIntrinsic() {
      const original = Number.isFinite;
      Number.isFinite = () => true;
      try {
        return await api.call("math.add", { a:Infinity, b:1 });
      } finally {
        Number.isFinite = original;
      }
    },
    async dispose() {
      return { disposed:true };
    }
  })`;

  const started=await host.start({ source, initial:{a:2,b:5} });
  assert.equal(host.state, "active");
  assert.equal(started.sessionId, "session-p004");
  assert.deepEqual(started.startResult, {
    sum:7,
    apiKeys:["call","version"],
    browserType:"undefined",
    chromeType:"undefined"
  });
  assert.deepEqual(host.capabilityNames, ["math.add"]);

  assert.equal(await host.invoke("double", {value:6}), 12);
  await assert.rejects(
    host.invoke("denied"),
    (error) => error?.code === SANDBOX_ERROR_CODES.CAPABILITY_DENIED
  );
  await assert.rejects(
    host.invoke("poisonIntrinsic"),
    (error) => error?.code === SANDBOX_ERROR_CODES.PROTOCOL
  );

  assert.deepEqual(await host.dispose(), {disposed:true});
  assert.equal(host.state, "disposed");
  await assert.rejects(
    host.invoke("double", {value:1}),
    (error) => error?.code === SANDBOX_ERROR_CODES.DISPOSED
  );
});

test("A004-03 malformed dynamic controller fails closed and disposes its host", async () => {
  const { host }=makeConnectedHarness();
  await assert.rejects(
    host.start({ source:"({ notAFactory:true })" }),
    (error) => error?.code === SANDBOX_ERROR_CODES.CONTROLLER_INVALID
  );
  assert.equal(host.state, "disposed");
});
