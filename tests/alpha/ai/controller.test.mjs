import test from 'node:test';
import assert from 'node:assert/strict';
import {createAiSessionController,createAiIdentity,AI_TEST_PROMPT} from '../../../extension/alpha/features/ai/controller.mjs';
import {validateAiLedger,countAiSlots} from '../../../extension/alpha/features/ai/store.mjs';
import {reviewEditorState,createApprovalIntent} from '../../../extension/alpha/overlay/editor.mjs';

const HASH_A='a'.repeat(64),HASH_B='b'.repeat(64);
const clock=()=> '2026-10-10T12:00:00.000Z';
function memoryStore() {
  let state={schemaVersion:1,revision:0,tasks:[]};
  let serial=Promise.resolve();
  return {
    async read(){return structuredClone(validateAiLedger(state));},
    change(expected,update){
      const work=async()=>{
        if(state.revision!==expected)throw Object.assign(new Error('STALE_REVISION'),{code:'STALE_REVISION'});
        const next=structuredClone(state);const returned=update(next);
        assert.equal(returned?.then,undefined);next.revision++;validateAiLedger(next);state=next;
        return structuredClone(state);
      };
      const next=serial.then(work,work);serial=next.catch(()=>{});return next;
    }
  };
}
function fixture({store=memoryStore(),state='ACTIVE',startThrows=false,saveConfirmed=true}={}) {
  let launches=0,inspects=0,sourceRevision='r1',savedHash=HASH_B,savedRevision='r2',epoch=1;
  const identity={async verify({accountId,key,accountBindingEpoch}){
    if(accountBindingEpoch!==epoch)throw Object.assign(new Error('STALE_BINDING'),{code:'STALE_BINDING'});
    return {accountId,key,personaUid:'uid-001',epoch,sourceHash:HASH_A,sourceRevision,listing:'UNLISTED',revision:7};
  }};
  const native={async probe(){return {authority:'PERSONA_MONKEY',capability:'PERCHANCE_NATIVE_AI',available:true,origin:'https://perchance.org'};},
    async start({binding,task,prompt}){
      launches++;assert.equal(binding.personaUid,'uid-001');assert.match(prompt,/functional checks/);
      if(startThrows)throw new Error('timeout after possible dispatch');
      return {operationId:task.opId,sessionId:'native-1',key:task.key,accountId:task.accountId,personaUid:task.personaUid,bindingEpoch:task.bindingEpoch,state};
    },
    async inspect({task}){
      inspects++;return {operationId:task.opId,sessionId:task.sessionId??'native-1',key:task.key,accountId:task.accountId,
        personaUid:task.personaUid,bindingEpoch:task.bindingEpoch,state};
    }
  };
  const verifySaved=async()=>({confirmed:saveConfirmed,sourceHash:savedHash,sourceRevision:savedRevision,provenanceRefs:['history-1','readback-1']});
  const controller=()=>createAiSessionController({store,identity,native,verifySaved,now:clock});
  const params=(key,opId,options={})=>({accountId:'acct-1',key,accountBindingEpoch:epoch,
    expectedRevision:7,opId,options});
  return {store,controller,params,native,get launches(){return launches;},get inspects(){return inspects;},
    setState(v){state=v;},setSourceRevision(v){sourceRevision=v;},setSaveConfirmed(v){saveConfirmed=v;},
    setEpoch(v){epoch=v;}};
}

test('AP303-01 fail closed without a verified native Perchance execution authority',async()=>{
  const f=fixture();const c=createAiSessionController({store:f.store,identity:{verify:async()=>({accountId:'acct-1',key:'alpha',personaUid:'uid-001',epoch:1,sourceHash:HASH_A,sourceRevision:'r1',listing:'UNLISTED',revision:7})},now:clock});
  const r=await c.start(f.params('alpha','op-1'));
  assert.equal(r.ok,false);assert.equal(r.error.code,'UNSUPPORTED_CAPABILITY');
  assert.equal((await f.store.read()).tasks.length,0);
});

test('AP303-02 default one running AI per account, successful saved review releases slot',async()=>{
  const f=fixture(),c=f.controller();
  const first=await c.start(f.params('alpha','op-1'));
  assert.equal(first.ok,true);assert.equal(first.result.state,'ACTIVE');
  assert.equal(countAiSlots((await f.store.read()).tasks,'acct-1'),1);
  const denied=await c.start(f.params('beta','op-2'));
  assert.equal(denied.error.code,'RATE_LIMIT');assert.equal(f.launches,1);
  f.setState('COMPLETED');f.setSourceRevision('r2');
  const task=(await f.store.read()).tasks[0];
  const done=await c.recordReview(f.params('alpha','record-1',{taskId:task.id,expectedTaskRevision:task.revision}));
  assert.equal(done.ok,true);assert.equal(done.result.state,'COMPLETED');
  assert.deepEqual(done.result.provenanceRefs,['history-1','readback-1']);
  assert.equal(countAiSlots((await f.store.read()).tasks,'acct-1'),0);
  f.setState('ACTIVE');
  assert.equal((await c.start(f.params('beta','op-2'))).ok,true);
  assert.equal(f.launches,2);
});

test('AP303-02 concurrent requests cannot create two running sessions',async()=>{
  const f=fixture(),c=f.controller();
  const both=await Promise.all([c.start(f.params('alpha','parallel-1')),c.start(f.params('beta','parallel-2'))]);
  assert.equal(both.filter(r=>r.ok).length,1);
  assert.ok(['STALE_REVISION','RATE_LIMIT'].includes(both.find(r=>!r.ok).error.code));
  assert.equal(countAiSlots((await f.store.read()).tasks,'acct-1'),1);
  assert.equal(f.launches,1);
});

test('AP303-01 contract get uses generator key, not opaque task ID',async()=>{
  const f=fixture(),c=f.controller();
  const started=await c.start(f.params('alpha','read-1'));
  const fetched=await c.get({key:'alpha',accountId:'acct-1'});
  assert.equal(fetched.ok,true);assert.equal(fetched.result.id,started.result.id);
  assert.equal((await c.get({key:started.result.id,accountId:'acct-1'})).error.code,'INVALID_REQUEST');
  assert.equal((await c.get({key:'alpha',accountId:'foreign'})).error.code,'NOT_APPLIED');
});

test('AP303-03 ambiguous native dispatch persists UNCERTAIN; restart observes only, never dispatches again',async()=>{
  const store=memoryStore(),f=fixture({store,startThrows:true}),first=f.controller();
  const reply=await first.start(f.params('alpha','lost-1'));
  assert.equal(reply.error.code,'UNCERTAIN');
  const task=(await store.read()).tasks[0];
  assert.equal(task.state,'RECOVERING');assert.equal(task.dispatchPhase,'UNCERTAIN');
  assert.equal((await first.start(f.params('alpha','lost-1'))).error.code,'CONFLICT');
  assert.equal(f.launches,1);
  const afterRestart=f.controller();
  assert.equal((await afterRestart.reconnect({taskId:task.id})).result.state,'ACTIVE');
  assert.equal(f.launches,1);assert.equal(f.inspects,1);
});

test('AP303-03 stale Persona binding and missing sessions fail closed without releasing slot',async()=>{
  const f=fixture(),c=f.controller();const first=await c.start(f.params('alpha','lease-1'));
  f.setEpoch(2);
  assert.equal((await c.reconnect({taskId:first.result.id})).error.code,'STALE_BINDING');
  assert.equal(countAiSlots((await f.store.read()).tasks,'acct-1'),1);
});

test('AP303-02 challenge occupies slot until verified saved review; transcript alone never releases slot',async()=>{
  const f=fixture({state:'WAITING_HUMAN',saveConfirmed:false}),c=f.controller();
  const first=await c.start(f.params('alpha','challenge-1'));
  assert.equal(first.result.state,'WAITING_HUMAN');
  f.setState('COMPLETED');f.setSourceRevision('r2');
  const task=(await f.store.read()).tasks[0];
  const denied=await c.recordReview(f.params('alpha','record-1',{taskId:task.id,expectedTaskRevision:task.revision}));
  assert.equal(denied.error.code,'SOURCE_DRIFT');
  assert.equal(countAiSlots((await f.store.read()).tasks,'acct-1'),1);
  f.setSaveConfirmed(true);
  const accepted=await c.recordReview(f.params('alpha','record-2',{taskId:task.id,expectedTaskRevision:task.revision}));
  assert.equal(accepted.ok,true);assert.equal(countAiSlots((await f.store.read()).tasks,'acct-1'),0);
});

test('AP303-01 approval is a durable revision-fenced intent, not a remote save or public switch',async()=>{
  const f=fixture(),c=f.controller();const taskId=(await c.start(f.params('alpha','review-1'))).result.id;
  f.setState('COMPLETED');f.setSourceRevision('r2');
  const t=(await f.store.read()).tasks[0];
  assert.equal((await c.recordReview(f.params('alpha','record-1',{taskId,expectedTaskRevision:t.revision}))).ok,true);
  const approvedTask=(await f.store.read()).tasks[0];
  const options={taskId,expectedTaskRevision:approvedTask.revision,sourceHash:HASH_B,sourceRevision:'r2',
    editorUrl:'https://perchance.org/alpha#edit'};
  const accepted=await c.approveIntent(f.params('alpha','approve-1',options));
  assert.equal(accepted.ok,true);assert.equal(accepted.result.approvalRevision,approvedTask.revision+1);
  assert.equal((await f.store.read()).tasks[0].approvalOpId,'approve-1');
  assert.equal((await c.approveIntent(f.params('alpha','approve-2',options))).error.code,'CONFLICT');
  assert.equal(f.launches,1);
});

test('AP303-03 stale saved revision and stale task revision reject approval',async()=>{
  const f=fixture(),c=f.controller(),id=(await c.start(f.params('alpha','approvals-1'))).result.id;
  f.setState('COMPLETED');f.setSourceRevision('r2');
  let t=(await f.store.read()).tasks[0];
  await c.recordReview(f.params('alpha','record-1',{taskId:id,expectedTaskRevision:t.revision}));
  t=(await f.store.read()).tasks[0];
  const options={taskId:id,expectedTaskRevision:t.revision,sourceHash:HASH_B,sourceRevision:'r2',editorUrl:'https://perchance.org/alpha#edit'};
  assert.equal((await c.approveIntent(f.params('alpha','bad-1',{...options,expectedTaskRevision:t.revision-1}))).error.code,'STALE_REVISION');
  f.setSourceRevision('r3');
  assert.equal((await c.approveIntent(f.params('alpha','bad-2',options))).error.code,'SOURCE_DRIFT');
  assert.equal((await f.store.read()).tasks[0].approvalRevision,null);
});

test('AP303-03 editor origin, slug, saved revision, epoch and review state are strictly fenced',()=>{
  const task={id:'ai:one',key:'alpha',accountId:'acct-1',personaUid:'uid-001',bindingEpoch:1,revision:4,state:'COMPLETED',
    reviewPending:true,approvalRevision:null,savedSourceHash:HASH_B,savedSourceRevision:'r2'};
  const binding={accountId:'acct-1',personaUid:'uid-001',epoch:1};
  const base={url:'https://perchance.org/alpha#edit',task,binding,sourceRevision:'r2'};
  assert.equal(reviewEditorState(base).enabled,true);
  for(const patch of [{url:'https://evil.org/alpha#edit'},{url:'https://perchance.org/beta#edit'},
    {url:'http://perchance.org/alpha#edit'},{url:'https://perchance.org/alpha?x=1#edit'},
    {binding:{...binding,epoch:2}},{sourceRevision:'r3'},{task:{...task,approvalRevision:4,reviewPending:false}}]){
    assert.equal(reviewEditorState({...base,...patch}).enabled,false);
  }
  const intent=createApprovalIntent({...base,opId:'approve-1',expectedRevision:7});
  assert.equal(intent.command,'aiReview.approveIntent');
  assert.deepEqual(Object.keys(intent.params.options).sort(),['editorUrl','expectedTaskRevision','sourceHash','sourceRevision','taskId'].sort());
  assert.equal(JSON.stringify(intent).includes('github'),false);
});

test('AP303-01 account binding uses P102 and P103 readback, never public feed or history',async()=>{
  const accesses=[];
  const account={accountId:'acct-1',personaUid:'uid-001',epoch:1,sessionState:'VERIFIED'};
  const generator={key:'alpha',accountId:'acct-1',personaUid:'uid-001',accountBindingEpoch:1,releaseId:HASH_A};
  const identity=createAiIdentity({storage:{async read(kind){accesses.push(kind);return {revision:7,item:{record:kind==='account'?account:generator}};}},
    perchance:{async read({targetKey}){accesses.push('perchance:'+targetKey);return {ok:true,result:{ownership:'CONFIRMED',listing:'UNLISTED',sourceRevision:'r1'}};}},
    contextForAccount:async ()=>({accountId:'acct-1',personaUid:'uid-001',epoch:1})});
  assert.equal((await identity.verify({accountId:'acct-1',key:'alpha',accountBindingEpoch:1})).sourceHash,HASH_A);
  assert.deepEqual(accesses,['account','generator','perchance:alpha','account']);
  assert.match(AI_TEST_PROMPT,/human-readable code comments/);
});

test('AP303-03 identity rejects account/generator snapshots separated by a concurrent commit',async()=>{
  let revision=4,reads=0;
  const account={accountId:'acct-1',personaUid:'uid-001',epoch:1,sessionState:'VERIFIED'};
  const generator={key:'alpha',accountId:'acct-1',personaUid:'uid-001',accountBindingEpoch:1,releaseId:HASH_A};
  const identity=createAiIdentity({storage:{async read(kind){reads++;return {revision,item:{record:kind==='account'?account:generator}};}},
    perchance:{async read(){revision++;return {ok:true,result:{ownership:'CONFIRMED',listing:'UNLISTED',sourceRevision:'r1'}};}},
    contextForAccount:async()=>({accountId:'acct-1',personaUid:'uid-001',epoch:1})});
  await assert.rejects(identity.verify({accountId:'acct-1',key:'alpha',accountBindingEpoch:1}),e=>e.code==='STALE_REVISION');
  assert.equal(reads,3);
});

test('AP303-03 overlay reconnects on reload and invalidates stale or foreign editors before approval',async()=>{
  const {mountAiReviewOverlay}=await import('../../../extension/alpha/overlay/editor.mjs');
  class Element {
    constructor(name){this.tagName=name;this.children=[];this.listeners=new Map();this.disabled=false;}
    appendChild(c){this.children.push(c);return c;}
    setAttribute(k,v){this[k]=v;}
    addEventListener(k,fn){this.listeners.set(k,fn);}
    removeEventListener(k){this.listeners.delete(k);}
    attachShadow(){this.shadow=new Element('shadow');return this.shadow;}
    remove(){this.removed=true;}
    click(){this.listeners.get('click')?.();}
  }
  const listeners=new Map(),doc=new Element('doc'),host=new Element('host');
  doc.createElement=tag=>new Element(tag);
  const view={location:{href:'https://perchance.org/alpha#edit'},
    addEventListener(k,fn){listeners.set(k,fn);},removeEventListener(k){listeners.delete(k);}};
  let sourceRevision='r2',approved=0,loaded=0;
  const task={id:'ai:review',key:'alpha',accountId:'acct-1',personaUid:'uid-001',bindingEpoch:1,revision:4,
    state:'COMPLETED',reviewPending:true,approvalRevision:null,savedSourceHash:HASH_B,savedSourceRevision:'r2'};
  const binding={accountId:'acct-1',personaUid:'uid-001',epoch:1};
  const overlay=mountAiReviewOverlay({document:doc,view,host,
    async loadContext(){loaded++;return {task,binding,sourceRevision,expectedRevision:7};},
    async requestApproval(envelope){assert.equal(envelope.command,'aiReview.approveIntent');approved++;return {ok:true};},
    createOpId:()=> 'approval-1'});
  const panel=host.shadow.children[1],button=panel.children[3];
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.disabled,false);
  button.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(approved,1);assert.ok(loaded>=3);
  sourceRevision='r3';listeners.get('pageshow')();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.disabled,true);
  button.click();await new Promise(resolve=>setImmediate(resolve));assert.equal(approved,1);
  view.location.href='https://perchance.org/beta#edit';listeners.get('hashchange')();
  await new Promise(resolve=>setImmediate(resolve));assert.equal(button.disabled,true);
  overlay.dispose();assert.equal(host.removed,true);assert.equal(listeners.size,0);
});

test('AP303-03 editor navigation during asynchronous approval recheck never submits intent',async()=>{
  const {mountAiReviewOverlay}=await import('../../../extension/alpha/overlay/editor.mjs');
  class Element {
    constructor(){this.children=[];this.listeners=new Map();this.disabled=false;}
    appendChild(c){this.children.push(c);return c;}setAttribute(){}
    addEventListener(k,fn){this.listeners.set(k,fn);}removeEventListener(k){this.listeners.delete(k);}
    attachShadow(){this.shadow=new Element();return this.shadow;}remove(){this.removed=true;}
    click(){this.listeners.get('click')?.();}
  }
  const doc=new Element(),host=new Element();doc.createElement=()=>new Element();
  const view={location:{href:'https://perchance.org/alpha#edit'},addEventListener(){},removeEventListener(){}};
  const task={id:'ai:one',key:'alpha',accountId:'acct-1',personaUid:'uid-001',bindingEpoch:1,
    revision:4,state:'COMPLETED',reviewPending:true,approvalRevision:null,savedSourceHash:HASH_B,savedSourceRevision:'r2'};
  const current={task,binding:{accountId:'acct-1',personaUid:'uid-001',epoch:1},sourceRevision:'r2',expectedRevision:7};
  let load=0,approved=0;
  const overlay=mountAiReviewOverlay({document:doc,view,host,
    async loadContext(){load++;if(load===2)view.location.href='https://perchance.org/beta#edit';return current;},
    createOpId:()=> 'intent-one',async requestApproval(){approved++;return {ok:true};}});
  const button=host.shadow.children[1].children[3];await new Promise(resolve=>setImmediate(resolve));
  assert.equal(button.disabled,false);button.click();await new Promise(resolve=>setImmediate(resolve));
  assert.equal(approved,0);assert.equal(button.disabled,true);
  overlay.dispose();
});

test('AP303-03 no injected trusted review bridge disables overlay without runtime/browser calls',async()=>{
  const {mountAiReviewOverlay}=await import('../../../extension/alpha/overlay/editor.mjs');
  class Element {
    constructor(){this.children=[];this.listeners=new Map();this.disabled=false;}
    appendChild(c){this.children.push(c);return c;}
    setAttribute(){}addEventListener(k,f){this.listeners.set(k,f);}removeEventListener(k){this.listeners.delete(k);}
    attachShadow(){this.shadow=new Element();return this.shadow;}remove(){this.removed=true;}
  }
  const doc=new Element(),host=new Element();doc.createElement=()=>new Element();
  const view={location:{href:'https://perchance.org/alpha#edit'},addEventListener(){},removeEventListener(){}};
  const overlay=mountAiReviewOverlay({document:doc,view,host});
  await new Promise(resolve=>setImmediate(resolve));
  const panel=host.shadow.children[1];assert.equal(panel.children[3].disabled,true);
  assert.match(panel.children[4].textContent,/authorized PersonaMonkey/);
  overlay.dispose();
});
