import assert from "node:assert/strict";
import test from "node:test";

import {
  INTEGRATION_COMMAND_DESCRIPTORS,
  INTEGRATION_ERROR_CODES,
  INTEGRATION_PROTOCOL_VERSION
} from "../../extension/lib/management-integration-protocol.js";
import {
  PERSONA_BROKER_COMMAND_NAMES,
  PERSONA_BROKER_COMMANDS,
  PERSONA_BROKER_CONTRACT_VERSION,
  PERSONA_BROKER_ERROR_CODES,
  PERSONA_BROKER_IDENTITY_FIELD,
  assertPersonaBroker,
  createPersonaBrokerRequest,
  getPersonaBrokerCommand,
  isPersonaBrokerErrorCode,
  validatePersonaBrokerEvent,
  validatePersonaBrokerResponse
} from "../../extension/pcms/core/persona-broker-contract.js";

const SEMANTIC_KEYS=[
  "capability",
  "mutating",
  "sideEffecting",
  "destructive",
  "directAuthority",
  "externalAutomation",
  "executableInstall",
  "retry"
];

test("A003-01 Persona Broker v1 preserves Integration API v1 command semantics", () => {
  assert.equal(PERSONA_BROKER_CONTRACT_VERSION, INTEGRATION_PROTOCOL_VERSION);
  assert.equal(PERSONA_BROKER_IDENTITY_FIELD, "personaUid");

  const authoritative=Object.keys(INTEGRATION_COMMAND_DESCRIPTORS).sort();
  const broker=[...PERSONA_BROKER_COMMAND_NAMES].sort();
  assert.deepEqual(broker, authoritative);
  assert.equal(broker.length, 55);

  for (const command of authoritative) {
    const expected=INTEGRATION_COMMAND_DESCRIPTORS[command];
    const actual=PERSONA_BROKER_COMMANDS[command];
    assert.ok(actual, `missing broker command ${command}`);
    for (const key of SEMANTIC_KEYS) {
      assert.equal(actual[key], expected[key], `${command} ${key} drifted`);
    }
    assert.equal(
      actual.requiresOperation,
      expected.mutating === true || expected.sideEffecting === true,
      `${command} operation/precondition semantics drifted`
    );
  }

  assert.equal(INTEGRATION_COMMAND_DESCRIPTORS["persona.get"].identifiers.personaUid, "durable-persona-uid");
  assert.equal(INTEGRATION_COMMAND_DESCRIPTORS["persona.get"].params.personaUid.type, "uuid");
});

test("A003-03 Persona Broker error vocabulary stays exactly aligned", () => {
  const authoritative=Object.values(INTEGRATION_ERROR_CODES).sort();
  const broker=[...PERSONA_BROKER_ERROR_CODES].sort();
  assert.deepEqual(broker, authoritative);
  assert.equal(broker.length, 43);
  for (const code of authoritative) assert.equal(isPersonaBrokerErrorCode(code), true);
  assert.equal(isPersonaBrokerErrorCode("PCMS_FAKE_ERROR"), false);
});

test("A003-01 broker request envelope fences side effects and prototype names", () => {
  assert.equal(getPersonaBrokerCommand("constructor"), undefined);
  assert.equal(getPersonaBrokerCommand("__proto__"), undefined);
  assert.throws(
    () => createPersonaBrokerRequest({ command:"constructor", requestId:"read-1" }),
    /Unknown Persona Broker command/
  );

  const read=createPersonaBrokerRequest({
    command:"persona.get",
    requestId:"read-2",
    params:{ personaUid:"11111111-1111-4111-8111-111111111111" }
  });
  assert.equal(read.version, 1);
  assert.equal(read.command, "persona.get");
  assert.equal(Object.isFrozen(read), true);
  assert.equal(Object.isFrozen(read.params), true);
  assert.equal("precondition" in read, false);

  assert.throws(
    () => createPersonaBrokerRequest({
      command:"route.assign",
      requestId:"mut-1",
      params:{ personaUid:"11111111-1111-4111-8111-111111111111", routeId:"__block__" }
    }),
    /operationId/
  );

  const mutation=createPersonaBrokerRequest({
    command:"route.assign",
    requestId:"mut-2",
    operationId:"remote-op-2",
    precondition:{ bootId:"boot-1", revision:7 },
    params:{ personaUid:"11111111-1111-4111-8111-111111111111", routeId:"__block__" }
  });
  assert.deepEqual(mutation.precondition, { bootId:"boot-1", revision:7 });
  assert.equal(Object.isFrozen(mutation.precondition), true);

  assert.throws(
    () => createPersonaBrokerRequest({
      command:"persona.get",
      requestId:"read-3",
      precondition:{ bootId:"boot-1", revision:7 }
    }),
    /do not accept precondition/
  );
});

test("A003-01 broker response/event contracts preserve correlation and fail closed", () => {
  const request=createPersonaBrokerRequest({
    command:"persona.get",
    requestId:"read-response",
    params:{ personaUid:"11111111-1111-4111-8111-111111111111" }
  });
  const response={
    version:1,
    requestId:"read-response",
    operationId:null,
    ok:true,
    bootId:"boot-2",
    revision:9,
    result:{ personaUid:"11111111-1111-4111-8111-111111111111" }
  };
  assert.equal(validatePersonaBrokerResponse(response, request), response);
  assert.throws(
    () => validatePersonaBrokerResponse({ ...response, requestId:"other" }, request),
    /correlation/
  );
  assert.throws(
    () => validatePersonaBrokerResponse({
      ...response,
      ok:false,
      result:undefined,
      error:{ code:"PCMS_FAKE_ERROR", message:"no", retryable:false }
    }, request),
    /error response/
  );

  const event={
    version:1,
    bootId:"boot-2",
    sequence:1,
    revision:10,
    type:"persona.changed",
    entity:"persona",
    entityId:"11111111-1111-4111-8111-111111111111",
    data:{}
  };
  assert.equal(validatePersonaBrokerEvent(event), event);
  assert.throws(() => validatePersonaBrokerEvent({ ...event, sequence:0 }), /event metadata/);

  const broker={ request:async () => response, subscribe:() => ({ disconnect() {} }) };
  assert.equal(assertPersonaBroker(broker), broker);
  assert.throws(() => assertPersonaBroker({ request() {} }), /request\(\) and subscribe\(\)/);
});
