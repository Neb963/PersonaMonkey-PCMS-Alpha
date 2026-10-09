import assert from 'node:assert/strict';
import test from 'node:test';
import { packagedBroker } from '../../../tools/alpha/firefox/broker.mjs';

test('AP101-02 browser driver requires typed operation/boot/revision fencing before dispatch', async () => {
  const calls = [], h = { async pageScript(_script, args) {
    const message = args[0]; calls.push(message);
    return { ok: true, value: { version: 1, requestId: message.request.requestId,
      operationId: message.request.operationId, bootId: 'boot', revision: 7, ok: true, result: {} } };
  } };
  const broker = packagedBroker(h);
  try {
    await assert.rejects(() => broker.request({ command: 'persona.create', requestId: 'missing-operation', params: {} }));
    await assert.rejects(() => broker.request({ command: 'SAVE_STATE', requestId: 'unknown', params: {} }));
    assert.equal(calls.length, 0);
    await broker.request({ command: 'persona.create', requestId: 'valid', operationId: 'fixture-operation',
      precondition: { bootId: 'boot', revision: 6 }, params: { name: 'fixture' } });
    assert.equal(calls.length, 1); assert.equal(calls[0].type, 'PCMS_PERSONA_BROKER_REQUEST');
    assert.equal(calls[0].request.type, 'PERSONAMONKEY_INTEGRATION_REQUEST');
    assert.deepEqual(calls[0].request.precondition, { bootId: 'boot', revision: 6 });
  } finally { broker.close(); }
});

test('AP101-02 rejected senders and malformed correlation fail closed with bounded adapter errors', async () => {
  const rejected = packagedBroker({ async pageScript() { return { ok: false }; } });
  try { await assert.rejects(() => rejected.request({ command: 'system.describe', requestId: 'rejected' }),
    e => e.code === 'PCMS_PERSONA_BROKER_TRANSPORT_UNAVAILABLE'); } finally { rejected.close(); }
  const malformed = packagedBroker({ async pageScript() { return { ok: true, value: {
    version: 1, requestId: 'wrong', bootId: 'boot', revision: 1, ok: true, result: {} } }; } });
  try { await assert.rejects(() => malformed.request({ command: 'system.describe', requestId: 'expected' }),
    e => e.code === 'PCMS_PERSONA_BROKER_PROTOCOL'); } finally { malformed.close(); }
});
