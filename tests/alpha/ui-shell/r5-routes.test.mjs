import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {SECTION_IDS,resolveRoute} from '../../../extension/alpha/ui/shell/shell.js';
import {FIXED_VIEWS,routeView,createViewCoordinator} from '../../../extension/alpha/ui/shell/mounts.js';
import {createUiClient} from '../../../extension/alpha/ui/shell/client.js';
import {checkStatus} from '../../../extension/alpha/popup/popup.js';

test('R5 fixed routes mount review inside Supply and point toolbar at actual resource',()=>{
  assert.equal(resolveRoute('#supply/review'),'supply');
  assert.equal(routeView('supply','#supply/review'),'review');
  assert.equal(resolveRoute('#supply/../../settings'),'overview');
  assert.equal(SECTION_IDS.length,7);
  assert.equal(new Set(FIXED_VIEWS).size,8);
  const m=JSON.parse(readFileSync('extension/manifest.json','utf8'));
  assert.equal(m.action.default_popup,'alpha/popup/index.html');
  assert.match(readFileSync('extension/alpha/popup/index.html','utf8'),/aria-live="polite"/);
});
test('R5 UI client sends only extension messages and rejects mixed request identities',async()=>{
  let envelope;
  const runtime={async sendMessage(message){
    envelope=message;return {ok:true,requestId:message.request.requestId,revision:5,result:[]};
  }};
  assert.equal((await createUiClient(runtime).request('accounts.list',{limit:1})).ok,true);
  assert.equal(envelope.type,'PCMS_UI_REQUEST');
  assert.equal(envelope.request.command,'accounts.list');
  assert.equal((await createUiClient(runtime).request('accounts.list',{},-1)).ok,false);
  assert.equal((await checkStatus(runtime)),'Core responding');
  const bad=createUiClient({async sendMessage(){return {ok:true,revision:5,requestId:'different'};}});
  assert.equal((await bad.request('accounts.list')).error.code,'UNAVAILABLE');
});
test('R5 mounted route cannot select arbitrary external module',async()=>{
  const c=createViewCoordinator({querySelector(){return null;}},{location:{hash:'#overview'}},
    {loaders:Object.create(null),client:{request:async()=>({})}});
  await c.activate('overview','#overview');
  await assert.rejects(()=>c.activate('private','#private'),TypeError);
  c.close();
});
