import assert from 'node:assert/strict';
import test from 'node:test';
import { packagedBroker } from '../../../tools/alpha/firefox/broker.mjs';
import {createPcmsInternalBrokerEndpointRegistry} from '../../../extension/lib/pcms-internal-broker-endpoint.js';

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

test('R4-ISSUE99 PersonaMonkey backup port is typed, consent-gated, bounded and isolated from Integration v1', async()=>{
  const registry=createPcmsInternalBrokerEndpointRegistry(),calls=[];
  registry.register({
    ready:async()=>{},handleRequest:async()=>({ok:true}),
    attachEvents:async()=>true,
    handleBackup:async req=>{calls.push(structuredClone(req));return req.command==='export'?
      {bytes:new Uint8Array([1,2]),includedItems:['personaMonkey.personas']} :
      req.command==='previewImport'?{authorizationId:'preview-0001',holdId:req.holdId}:
      {state:'APPLIED',holdId:req.holdId};}
  });
  const endpoint=registry.createEndpoint();
  const base={version:1,command:'export',consent:'EXPORT UNENCRYPTED BACKUP'};
  assert.equal((await endpoint.backup(base)).bytes.byteLength,2);
  for(const x of [{...base,consent:'wrong'},{...base,unexpected:true},
    {version:1,command:'rawNativeRpc',consent:'EXPORT UNENCRYPTED BACKUP'},
    {version:1,command:'commitImport',consent:'RESTORE UNENCRYPTED BACKUP',holdId:'restore-0001',
      authorizationId:'bad/identifier'}])
    await assert.rejects(()=>endpoint.backup(x));
  const preview=await endpoint.backup({version:1,command:'previewImport',
    consent:'RESTORE UNENCRYPTED BACKUP',holdId:'restore-0001',bytes:new Uint8Array([3])});
  assert.equal(preview.authorizationId,'preview-0001');
  await endpoint.backup({version:1,command:'commitImport',consent:'RESTORE UNENCRYPTED BACKUP',
    holdId:'restore-0001',authorizationId:preview.authorizationId});
  assert.deepEqual(calls.map(x=>x.command),['export','previewImport','commitImport']);
  assert.equal(await endpoint.send({command:'system.status'}).then(x=>x.ok),true);
});
