import assert from "node:assert/strict";
import test from "node:test";

import {
  PERSONA_BROKER_ADAPTER_ERROR_CODES,
  PERSONA_BROKER_INTEGRATION_EVENTS_PORT,
  PERSONA_BROKER_INTEGRATION_REQUEST_TYPE,
  createPersonaBroker
} from "../../extension/pcms/core/persona-broker.js";

function success(request,result={ok:true}){
  return {version:1,requestId:request.requestId,operationId:request.operationId??null,ok:true,bootId:"boot-1",revision:7,result};
}

function makeTransport(){
  const sent=[]; let handler=null; let disconnected=0;
  return {
    sent,
    transport:{
      async send(request){sent.push(request);return success(request,{echo:request.command});},
      openEvents(name,onEvent){assert.equal(name,PERSONA_BROKER_INTEGRATION_EVENTS_PORT);handler=onEvent;return{disconnect(){disconnected+=1;}};}
    },
    emit(event){handler?.(event);},
    get disconnected(){return disconnected;}
  };
}

test("A009-01 broker maps the transport-neutral contract to the Integration-v1 wire envelope",async()=>{
  const h=makeTransport(); const broker=createPersonaBroker({transport:h.transport});
  const response=await broker.request({command:"persona.get",requestId:"req-1",params:{personaUid:"11111111-1111-4111-8111-111111111111"}});
  assert.equal(response.result.echo,"persona.get");
  assert.equal(Object.isFrozen(response),true);
  assert.deepEqual(h.sent[0],{
    type:PERSONA_BROKER_INTEGRATION_REQUEST_TYPE,version:1,requestId:"req-1",command:"persona.get",
    params:{personaUid:"11111111-1111-4111-8111-111111111111"}
  });
  assert.equal(Object.isFrozen(h.sent[0]),true);
});

test("A009-02 control operations preserve operation/precondition and durable personaUid",async()=>{
  const h=makeTransport(); const broker=createPersonaBroker({transport:h.transport});
  await broker.request({
    command:"persona.control.acquire",requestId:"req-lease",operationId:"op-lease",
    precondition:{bootId:"boot-1",revision:6},
    params:{personaUid:"11111111-1111-4111-8111-111111111111",purpose:"pcms",ttlMs:60000}
  });
  assert.equal(h.sent[0].command,"persona.control.acquire");
  assert.equal(h.sent[0].operationId,"op-lease");
  assert.deepEqual(h.sent[0].precondition,{bootId:"boot-1",revision:6});
  assert.equal(h.sent[0].params.personaUid,"11111111-1111-4111-8111-111111111111");
});

test("A009-03 malformed responses and transport exceptions fail closed with fixed adapter errors",async()=>{
  const secret="do-not-leak";
  const bad=createPersonaBroker({transport:{
    async send(){throw new Error(secret);},openEvents(){return{disconnect(){}};}
  }});
  await assert.rejects(
    bad.request({command:"persona.get",requestId:"x",params:{}}),
    e=>e?.code===PERSONA_BROKER_ADAPTER_ERROR_CODES.TRANSPORT_UNAVAILABLE&&!e.message.includes(secret)
  );

  const mismatch=createPersonaBroker({transport:{
    async send(request){return {...success(request),requestId:"wrong"};},openEvents(){return{disconnect(){}};}
  }});
  await assert.rejects(
    mismatch.request({command:"persona.get",requestId:"x2",params:{}}),
    e=>e?.code===PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL
  );
});

test("A009-03 request data accessors are rejected before transport dispatch",async()=>{
  let calls=0;
  const broker=createPersonaBroker({transport:{async send(){calls+=1;},openEvents(){return{disconnect(){}};}}});
  const params={};Object.defineProperty(params,"secret",{enumerable:true,get(){throw new Error("getter ran");}});
  await assert.rejects(
    broker.request({command:"persona.get",requestId:"getter",params}),
    e=>e?.code===PERSONA_BROKER_ADAPTER_ERROR_CODES.PROTOCOL
  );
  assert.equal(calls,0);
});

test("A009-03 event stream validates boot/sequence and isolates listener failures",()=>{
  const h=makeTransport(); const broker=createPersonaBroker({transport:h.transport}); const seen=[];
  broker.subscribe((event)=>{seen.push(event.sequence);if(event.sequence===1)throw new Error("consumer");});
  h.emit({version:1,bootId:"boot-a",sequence:1,revision:1,type:"persona.changed",data:{}});
  h.emit({version:1,bootId:"boot-a",sequence:2,revision:2,type:"persona.changed",data:{}});
  assert.deepEqual(seen,[1,2]); assert.equal(h.disconnected,0);
  h.emit({version:1,bootId:"boot-a",sequence:2,revision:2,type:"persona.changed",data:{}});
  assert.equal(h.disconnected,1);
});

test("A009-03 an active event stream fails closed if boot identity changes",()=>{
  const h=makeTransport(); const broker=createPersonaBroker({transport:h.transport});
  broker.subscribe(()=>{});
  h.emit({version:1,bootId:"boot-a",sequence:1,revision:1,type:"state.changed",data:{}});
  h.emit({version:1,bootId:"boot-b",sequence:1,revision:0,type:"state.changed",data:{}});
  assert.equal(h.disconnected,1);
});
