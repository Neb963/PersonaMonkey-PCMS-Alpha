import assert from "node:assert/strict";
import test from "node:test";

import { SECRET_ERROR_CODES } from "../../extension/pcms/secrets/errors.js";
import { createFirefoxNativeSecretTransport, createNativeSecretBackend } from "../../extension/pcms/secrets/native-secret-backend.js";
import {
  MAX_SECRET_BYTES,
  SECRET_HOST_NAME,
  SECRET_HOST_PROTOCOL_VERSION
} from "../../extension/pcms/secrets/protocol.js";
import {
  SECRET_REF_PREFIX,
  assertSecretRef,
  createSecretRef,
  isSecretRef
} from "../../extension/pcms/secrets/secret-ref.js";
import { createSecretStore } from "../../extension/pcms/secrets/secret-store.js";

const UUIDS = [
  "11111111-1111-4111-8111-111111111111",
  "22222222-2222-4222-8222-222222222222",
  "33333333-3333-4333-8333-333333333333",
  "44444444-4444-4444-8444-444444444444",
  "55555555-5555-4555-8555-555555555555",
  "66666666-6666-4666-8666-666666666666",
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888"
];

function uuidFactory(values = UUIDS) {
  let index=0;
  return () => values[index++] || values.at(-1);
}

function makeHost() {
  const secrets=new Map();
  const requests=[];
  return {
    secrets,
    requests,
    async sendNativeMessage(hostName, request) {
      assert.equal(hostName, SECRET_HOST_NAME);
      requests.push(structuredClone(request));
      assert.equal(request.version, SECRET_HOST_PROTOCOL_VERSION);
      const base={version:SECRET_HOST_PROTOCOL_VERSION,id:request.id,ok:true};
      if (request.op==="probe") return {...base,result:{ready:true}};
      if (request.op==="put") {
        secrets.set(request.secretRef, request.value);
        return {...base,result:{stored:true}};
      }
      if (request.op==="get") {
        if (!secrets.has(request.secretRef)) {
          return {...base,ok:false,error:{code:"NOT_FOUND"}};
        }
        return {...base,result:{value:secrets.get(request.secretRef)}};
      }
      if (request.op==="delete") {
        const deleted=secrets.delete(request.secretRef);
        return {...base,result:{deleted}};
      }
      return {...base,ok:false,error:{code:"INVALID_REQUEST"}};
    }
  };
}

test("A006-01 SecretRef is opaque, versioned and value-free", () => {
  const secret="correct horse battery staple";
  const ref=createSecretRef({randomUUID:()=>UUIDS[0]});

  assert.equal(ref, SECRET_REF_PREFIX+UUIDS[0]);
  assert.equal(isSecretRef(ref),true);
  assert.equal(assertSecretRef(ref.toUpperCase()),ref);
  assert.equal(ref.includes(secret),false);
  assert.equal(JSON.stringify({passwordRef:ref}).includes(secret),false);

  assert.throws(
    () => assertSecretRef("secret-password"),
    (error) => error?.code===SECRET_ERROR_CODES.INVALID_REF
  );
  assert.throws(
    () => createSecretRef({randomUUID:()=> "not-a-uuid"}),
    (error) => error?.code===SECRET_ERROR_CODES.UNAVAILABLE
  );
});

test("A006-02 Firefox transport can address only the dedicated PCMS secret host", async () => {
  const calls=[];
  const runtime={
    async sendNativeMessage(hostName, request) {
      calls.push({hostName,request});
      return {ok:true};
    }
  };
  const transport=createFirefoxNativeSecretTransport(runtime);
  const request={version:1,id:UUIDS[0],op:"probe"};

  assert.deepEqual(await transport(SECRET_HOST_NAME,request),{ok:true});
  assert.deepEqual(calls,[{hostName:SECRET_HOST_NAME,request}]);
  await assert.rejects(
    transport("com.persona.mullvad_router",request),
    (error) => error?.code===SECRET_ERROR_CODES.PROTOCOL
  );
  assert.equal(calls.length,1);

  const failing=createFirefoxNativeSecretTransport({
    async sendNativeMessage() { throw new Error("raw native failure"); }
  });
  await assert.rejects(
    failing(SECRET_HOST_NAME,request),
    (error) => error?.code===SECRET_ERROR_CODES.UNAVAILABLE
  );
});

test("A006-02 dedicated native backend performs put/get/delete without using routing host authority", async () => {
  const host=makeHost();
  const backend=createNativeSecretBackend({
    sendNativeMessage:host.sendNativeMessage,
    randomUUID:uuidFactory(UUIDS.slice(1)),
    timeoutMs:500
  });
  const store=createSecretStore({backend,randomUUID:()=>UUIDS[0]});
  const secret="provider-password-α";

  assert.deepEqual(await store.probe(),{ready:true});
  const ref=await store.create(secret);
  assert.equal(ref,SECRET_REF_PREFIX+UUIDS[0]);
  assert.equal(host.secrets.get(ref),secret);

  assert.equal(await store.resolveForPrivilegedUse(ref),secret);
  assert.deepEqual(store.describeRef(ref),{ref:"pcms-secret:v1:[opaque]"});

  const replacement="replacement-password";
  assert.equal(await store.replace(ref,replacement),ref);
  assert.equal(await store.resolveForPrivilegedUse(ref),replacement);

  assert.deepEqual(await store.delete(ref),{deleted:true});
  await assert.rejects(
    store.resolveForPrivilegedUse(ref),
    (error) => error?.code===SECRET_ERROR_CODES.NOT_FOUND
  );

  const putRequests=host.requests.filter((request)=>request.op==="put");
  const nonPutRequests=host.requests.filter((request)=>request.op!=="put");
  assert.equal(putRequests.some((request)=>request.value===secret),true);
  assert.equal(nonPutRequests.some((request)=>Object.hasOwn(request,"value")),false);
  assert.equal(host.requests.some((request)=>JSON.stringify(request).includes("com.persona.mullvad_router")),false);
});

test("A006-03 backend exceptions and hostile error payloads never echo secret material", async () => {
  const secret="TOP-SECRET-PASSWORD";
  const ref=createSecretRef({randomUUID:()=>UUIDS[0]});
  const throwing=createNativeSecretBackend({
    sendNativeMessage:async () => { throw new Error("native exploded with "+secret); },
    randomUUID:uuidFactory(UUIDS.slice(1)),
    timeoutMs:500
  });

  await assert.rejects(
    throwing.put(ref,secret),
    (error) => {
      assert.equal(error.code,SECRET_ERROR_CODES.UNAVAILABLE);
      assert.equal(error.message.includes(secret),false);
      assert.equal(JSON.stringify(error).includes(secret),false);
      return true;
    }
  );

  const hostile=createNativeSecretBackend({
    sendNativeMessage:async (_host, request) => ({
      version:SECRET_HOST_PROTOCOL_VERSION,
      id:request.id,
      ok:false,
      error:{code:"UNAVAILABLE",message:secret}
    }),
    randomUUID:uuidFactory(UUIDS.slice(2)),
    timeoutMs:500
  });
  await assert.rejects(
    hostile.get(ref),
    (error) => error?.code===SECRET_ERROR_CODES.PROTOCOL && !error.message.includes(secret)
  );
});

test("A006-03 ambiguous secret mutations return a reconcilable opaque ref without secret material", async () => {
  const secret="UNCERTAIN-SECRET-VALUE";
  const backend=createNativeSecretBackend({
    sendNativeMessage:async () => { throw new Error("disconnect after dispatch "+secret); },
    randomUUID:()=>UUIDS[1],
    timeoutMs:500
  });
  const store=createSecretStore({backend,randomUUID:()=>UUIDS[0]});

  await assert.rejects(
    store.create(secret),
    (error) => {
      assert.equal(error.code,SECRET_ERROR_CODES.UNCERTAIN);
      assert.equal(error.secretRef,SECRET_REF_PREFIX+UUIDS[0]);
      assert.equal(error.operation,"create");
      assert.equal(error.message.includes(secret),false);
      assert.equal(JSON.stringify(error).includes(secret),false);
      return true;
    }
  );
});

test("A006-03 malformed/cross-request native responses fail closed", async () => {
  const ref=createSecretRef({randomUUID:()=>UUIDS[0]});
  const backend=createNativeSecretBackend({
    sendNativeMessage:async (_host, request) => ({
      version:SECRET_HOST_PROTOCOL_VERSION,
      id:UUIDS[7],
      ok:true,
      result:{value:"should-not-be-accepted"}
    }),
    randomUUID:()=>UUIDS[1],
    timeoutMs:500
  });

  await assert.rejects(
    backend.get(ref),
    (error) => error?.code===SECRET_ERROR_CODES.PROTOCOL
  );
});

test("A006-03 synchronous backend traps are contained without leaking backend text", () => {
  const secret="SYNC-SECRET-TEXT";
  assert.throws(
    () => createSecretStore({
      backend:{
        get put() { throw new Error(secret); }
      }
    }),
    (error) => error?.code===SECRET_ERROR_CODES.UNAVAILABLE && !error.message.includes(secret)
  );

  const store=createSecretStore({
    backend:{
      async probe(){ return {ready:true}; },
      async put(){ return {stored:true}; },
      async get(){ return "value"; },
      async delete(){ return {deleted:true}; },
      close(){ throw new Error(secret); }
    }
  });
  assert.doesNotThrow(() => store.close());
});

test("A006-03 timeout, close and size bounds fail with fixed safe errors", async () => {
  const ref=createSecretRef({randomUUID:()=>UUIDS[0]});
  const timeoutBackend=createNativeSecretBackend({
    sendNativeMessage:async () => new Promise(()=>{}),
    randomUUID:()=>UUIDS[1],
    timeoutMs:100
  });
  await assert.rejects(
    timeoutBackend.get(ref),
    (error) => error?.code===SECRET_ERROR_CODES.TIMEOUT
  );

  const host=makeHost();
  const backend=createNativeSecretBackend({
    sendNativeMessage:host.sendNativeMessage,
    randomUUID:uuidFactory(UUIDS.slice(2)),
    timeoutMs:500
  });
  const store=createSecretStore({backend,randomUUID:()=>UUIDS[0]});
  store.close();
  await assert.rejects(
    store.create("after-close"),
    (error) => error?.code===SECRET_ERROR_CODES.CLOSED
  );

  const oversized="x".repeat(MAX_SECRET_BYTES+1);
  const liveStore=createSecretStore({
    backend:createNativeSecretBackend({
      sendNativeMessage:host.sendNativeMessage,
      randomUUID:uuidFactory(UUIDS.slice(3)),
      timeoutMs:500
    }),
    randomUUID:()=>UUIDS[0]
  });
  await assert.rejects(
    liveStore.create(oversized),
    (error) => error?.code===SECRET_ERROR_CODES.INVALID_VALUE
  );
  assert.equal(host.requests.some((request)=>request.value===oversized),false);
});
