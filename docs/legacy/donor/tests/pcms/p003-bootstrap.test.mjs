import assert from "node:assert/strict";
import test from "node:test";

import {
  PCMS_NAMESPACE_VERSION,
  createPcmsNamespace,
  getPcmsNamespace,
  installPcmsNamespace
} from "../../extension/pcms/core/bootstrap.js";

test("A003-02 PCMS bootstrap exposes an immutable namespaced broker contract", () => {
  const namespace=createPcmsNamespace();
  assert.equal(namespace.name, "PCMS");
  assert.equal(namespace.version, PCMS_NAMESPACE_VERSION);
  assert.equal(namespace.version, 1);
  assert.equal(namespace.phase, "P003");
  assert.equal(namespace.broker.contractVersion, 1);
  assert.equal(namespace.broker.durablePersonaIdentity, "personaUid");
  assert.equal(namespace.broker.commandCount, 55);
  assert.equal(namespace.broker.errorCodeCount, 43);
  assert.equal(namespace.broker.implementation, "integration-v1-adapter");
  assert.equal(Object.isFrozen(namespace), true);
  assert.equal(Object.isFrozen(namespace.broker), true);
});

test("A003-02 namespace installation is idempotent and fails closed on collision", () => {
  const target={};
  const first=installPcmsNamespace(target);
  const second=installPcmsNamespace(target);
  assert.equal(first, second);
  assert.equal(first, getPcmsNamespace());

  const descriptor=Object.getOwnPropertyDescriptor(target, "PCMS");
  assert.equal(descriptor?.writable, false);
  assert.equal(descriptor?.configurable, false);
  assert.equal(descriptor?.enumerable, true);

  assert.throws(() => installPcmsNamespace({ PCMS:{} }), /namespace collision/);
  assert.throws(() => installPcmsNamespace(null), /target must be an object/);
});
