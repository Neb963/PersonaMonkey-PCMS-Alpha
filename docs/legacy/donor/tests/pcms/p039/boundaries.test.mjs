import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createPcmsUiClient} from '../../../extension/pcms/app/ui-client.js';

test('A039-01 observation paths have no second browser authority or guessed live selector profile',async()=>{
  for(const path of ['pcms-modules/p015/observations.js','pcms-modules/p015/verification-sweep.js',
    'extension/pcms/providers/perchance/execution-read-driver.js','extension/pcms/integration/deployer-observations.js']){
    const source=(await readFile(path,'utf8')).replace(/^\s*\/\/.*$/gm,'');
    assert.doesNotMatch(source,/\bbrowser\s*[.[]|\bchrome\s*[.[]|\bindexedDB\b|\beval\s*\(|new\s+Function\b|\bfetch\s*\(/,path);
  }
  const driver=await readFile('extension/pcms/providers/perchance/execution-read-driver.js','utf8');
  assert.match(driver,/profile = null/);assert.match(driver,/userscript\.artifact\.install/);assert.match(driver,/persona\.control\.release/);
  const live=await readFile('extension/pcms/background/core-factory.js','utf8');assert.doesNotMatch(live,/observationProfile/);
});
test('A039-02 Compare is an ephemeral UI query; choices are explicit commands',async()=>{
  const sent=[],receipts=[];
  const client=createPcmsUiClient({transport:{async send(request){sent.push(request);return {ok:true,requestId:request.requestId,result:{code:'in-memory only'}};},
    subscribeRevision(){return ()=>{};},readSession:async()=>null},newIdempotencyKey:()=> 'p039-choice'});
  client.subscribeReceipt(r=>receipts.push(r));
  await client.runtime.observations.compare('gen:alpha');
  assert.equal(sent[0].kind,'query');assert.equal(sent[0].idempotencyKey,undefined);assert.deepEqual(receipts,[]);
  await client.runtime.observations.keep('gen:alpha',{confirmation:'alpha'});assert.equal(sent[1].kind,'command');
  await client.runtime.observations.overwrite('gen:alpha',{confirmation:'alpha'});assert.equal(sent[2].kind,'command');client.close();
});
test('A039-02 observed HTML is displayed as text and downloaded as data, never executed',async()=>{
  const view=await readFile('extension/pcms/app/views/generators/generators-view.js','utf8');
  assert.doesNotMatch(view,/innerHTML|insertAdjacentHTML|document\.write|\beval\s*\(/);
  assert.match(view,/"pre",null,comparison\[key\]\[role\]/);assert.match(view,/input\.value!==slug/);
  assert.match(view,/expectedObservedAt:facet\.observation\.observation\.observedAt/);
});
