import test from "node:test";
import assert from "node:assert/strict";

import {
  PCMS_INTERNAL_BROKER_ENDPOINT_CONTRACT,
  createPcmsInternalBrokerEndpointRegistry
} from "../../../extension/lib/pcms-internal-broker-endpoint.js";
import { createFirefoxPersonaBrokerTransport } from "../../../extension/pcms/platform/firefox-persona-broker-transport.js";
import { createPersonaBroker, PERSONA_BROKER_INTEGRATION_EVENTS_PORT } from "../../../extension/pcms/core/persona-broker.js";
import { integrationHandler } from "./harness.mjs";

test("A028-01 internal endpoint waits for registration and PersonaMonkey readiness before dispatch",async()=>{
  const registry=createPcmsInternalBrokerEndpointRegistry();
  const endpoint=registry.createEndpoint();
  assert.equal(endpoint.contract,PCMS_INTERNAL_BROKER_ENDPOINT_CONTRACT);
  const order=[];
  let releaseReady;
  const ready=new Promise((resolve)=>{releaseReady=resolve;});
  const pending=endpoint.send({requestId:"r1",command:"system.status",params:{}});
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(registry.isRegistered(),false);
  registry.register({
    ready:async()=>{order.push("ready-wait");await ready;order.push("ready");},
    handleRequest:async(request)=>{order.push("handle:"+request.requestId);return {ok:true,requestId:request.requestId};},
    attachEvents:async()=>true
  });
  await new Promise((resolve)=>setImmediate(resolve));
  assert.deepEqual(order,["ready-wait"],"no request may reach PersonaMonkey before initialize() resolves");
  releaseReady();
  assert.deepEqual(await pending,{ok:true,requestId:"r1"});
  assert.deepEqual(order,["ready-wait","ready","handle:r1"]);
  assert.throws(()=>registry.register({ready(){},handleRequest(){},attachEvents(){}}),/already registered/);
  assert.throws(()=>createPcmsInternalBrokerEndpointRegistry().register({ready(){}}),TypeError);
});

test("A028-01 internal endpoint structured-clones like runtime messaging and sanitizes failures",async()=>{
  const registry=createPcmsInternalBrokerEndpointRegistry();
  const response={ok:true,result:{items:[1]}};
  let received=null;
  registry.register({
    ready:async()=>{},
    handleRequest:async(request)=>{received=request;if(request.command==="boom"){const e=new Error("bounded failure");e.secret="x";throw e;}return response;},
    attachEvents:async()=>true
  });
  const endpoint=registry.createEndpoint();
  const envelope={requestId:"r2",command:"system.status",params:{nested:{a:1}}};
  const result=await endpoint.send(envelope);
  assert.deepEqual(result,response);
  assert.notEqual(result,response,"responses cross the boundary as copies");
  assert.notEqual(received,envelope,"requests cross the boundary as copies");
  envelope.params.nested.a=2;
  assert.equal(received.params.nested.a,1);
  const error=await endpoint.send({requestId:"r3",command:"boom",params:{}}).catch((caught)=>caught);
  assert.equal(error.message,"bounded failure");
  assert.equal(error.secret,undefined);
  await assert.rejects(endpoint.send({requestId:"r4",command:"system.status",params:{fn(){}}}),TypeError);
});

test("A028-01 in-process and runtime-message transports are Integration-v1 parity for envelopes, errors and preconditions",async()=>{
  const viaMessage=integrationHandler();
  const runtime={
    async sendMessage(message){
      assert.equal(message.type,"PCMS_PERSONA_BROKER_REQUEST");
      return structuredClone(await viaMessage.handleRequest(structuredClone(message.request)));
    },
    connect(){throw new Error("unused");}
  };
  const messageBroker=createPersonaBroker({transport:createFirefoxPersonaBrokerTransport({runtime})});

  const inProcess=integrationHandler();
  const registry=createPcmsInternalBrokerEndpointRegistry();
  registry.register({ready:async()=>{},handleRequest:(request)=>inProcess.handleRequest(request),attachEvents:async()=>true});
  const endpointBroker=createPersonaBroker({transport:registry.createEndpoint()});

  const requests=[
    {requestId:"p1",command:"system.status",params:{}},
    {requestId:"p2",command:"persona.open",operationId:"op-open-1",precondition:{bootId:"boot-1",revision:7},
      params:{personaUid:"11111111-1111-4111-8111-111111111111",url:"https://example.test/",active:true,allowDirect:false}},
    {requestId:"p3",command:"persona.open",operationId:"op-open-2",precondition:{bootId:"boot-1",revision:7},
      params:{personaUid:"11111111-1111-4111-8111-111111111111",url:"https://example.test/",active:true,allowDirect:false}},
    {requestId:"p4",command:"persona.open",operationId:"op-open-3",precondition:{bootId:"boot-stale",revision:8},
      params:{personaUid:"11111111-1111-4111-8111-111111111111",url:"https://example.test/",active:true,allowDirect:false}}
  ];
  for(const request of requests){
    const [a,b]=await Promise.all([
      messageBroker.request(structuredClone(request)).then((value)=>({value}),(error)=>({error:error.code||error.message})),
      endpointBroker.request(structuredClone(request)).then((value)=>({value}),(error)=>({error:error.code||error.message}))
    ]);
    assert.deepEqual(b,a,"parity for "+request.requestId);
  }
  assert.deepEqual(inProcess.seen,viaMessage.seen,"PersonaMonkey receives identical envelopes");
  const results=await Promise.all(requests.map((request)=>endpointBroker.request({...structuredClone(request),requestId:request.requestId+"-again"}).catch((error)=>error)));
  assert.equal(results[0].ok,true);
  assert.equal(results[3].ok,false);
  assert.equal(results[3].error.code,"STATE_CONFLICT","stale bootId precondition fails closed on the in-process path");
});

test("A028-01 in-process event subscription attaches after readiness and disconnects both ways",async()=>{
  const registry=createPcmsInternalBrokerEndpointRegistry();
  let attached=null;
  registry.register({
    ready:async()=>{},
    handleRequest:async()=>({ok:true}),
    attachEvents:async(port)=>{attached=port;return true;}
  });
  const endpoint=registry.createEndpoint();
  assert.throws(()=>endpoint.openEvents("wrong",()=>{}),TypeError);
  const events=[];
  const subscription=endpoint.openEvents(PERSONA_BROKER_INTEGRATION_EVENTS_PORT,(event)=>events.push(event));
  await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(attached.name,"PCMS_PERSONA_BROKER_EVENTS");
  let notified=0;
  attached.onDisconnect.addListener(()=>{notified+=1;});
  const event={sequence:1,bootId:"boot-1"};
  attached.postMessage(event);
  assert.deepEqual(events,[event]);
  assert.notEqual(events[0],event);
  subscription.disconnect();
  assert.equal(notified,1,"PersonaMonkey releases the subscriber when PCMS disconnects");
  attached.postMessage({sequence:2});
  assert.equal(events.length,1);
});
