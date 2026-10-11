import test from 'node:test';
import assert from 'node:assert/strict';
import {validateUiRequest} from '../../../extension/alpha/core/ui.mjs';

const base={v:1,requestId:'supply-test',command:'supply.preview',
  params:{text:'hello-world\nother-slug'}};
test('R5 supply preview requires text and rejects unrelated capabilities',()=>{
  assert.equal(validateUiRequest(base).service,'supply');
  assert.equal(validateUiRequest(base).write,false);
  for(const params of [{key:'foo'}, {text:''}, {text:'valid',context:{personaUid:'secret'}},
    {text:'x'.repeat(24001)}, {text:'ghp_'+ 'a'.repeat(30)}])
    assert.throws(()=>validateUiRequest({...base,params}));
});
test('R5 bulk mutation has exact batch, per-batch bounds and Core optimistic fence',()=>{
  const request={...base,command:'supply.processBatch',expectedRevision:9,
    params:{expectedRevision:9,text:'alpha-one\nalpha-two',batchId:'r5_batch1',
      offset:0,limit:16,imports:[{key:'alpha-one',folder:'folder/example'}]}};
  const parsed=validateUiRequest(request);
  assert.equal(parsed.write,true);
  assert.equal(parsed.service,'supply');
  for(const params of [
    {...request.params,limit:17},
    {...request.params,offset:-1},
    {...request.params,batchId:'a'.repeat(33)},
    {...request.params,expectedRevision:8},
    {...request.params,imports:[{key:'one',folder:'../secrets'}]},
    {...request.params,imports:[{key:'one',folder:'a'},{key:'one',folder:'a'}]},
    {...request.params,accountBindingEpoch:1},
    {...request.params,opId:'user-forged'}
  ])assert.throws(()=>validateUiRequest({...request,params}));
  assert.throws(()=>validateUiRequest({...request,expectedRevision:8}),/STALE_REVISION/);
});
test('R5 release mutations still require standard binding and Core revision',()=>{
  const r={v:1,requestId:'review',command:'release.markReady',expectedRevision:12,
    params:{expectedRevision:12,accountBindingEpoch:3,opId:'op.review.1',
      key:'alpha-one',accountId:'account-1',options:{taskId:'t'}}};
  assert.equal(validateUiRequest(r).write,true);
  for(const p of [
    {...r.params,accountBindingEpoch:0},
    {...r.params,expectedRevision:10},
    {...r.params,context:{personaUid:'attack'}}
  ])assert.throws(()=>validateUiRequest({...r,params:p}));
});
