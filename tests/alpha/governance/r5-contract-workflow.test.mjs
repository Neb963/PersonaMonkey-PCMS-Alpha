import test from 'node:test';
import assert from 'node:assert/strict';
import {R5_FOUNDATION,MAINTENANCE,owns} from '../../../tools/alpha/governance.mjs';

test('contract workflow is the only new R5 workflow scope',()=>{
  const path='.github/workflows/alpha-contract-amendment.yml';
  assert.equal(R5_FOUNDATION.writePaths.filter(p=>p.startsWith('.github/workflows/')).length,1);
  assert.equal(R5_FOUNDATION.writePaths.includes(path),true);
  assert.equal(R5_FOUNDATION.writePaths.some(x=>owns(x,'.github/workflows/firefox.yml')),false);
  assert.equal(MAINTENANCE.writePaths.includes(path),false);
  assert.equal(R5_FOUNDATION.authorization,'MAINT-R5-FOUNDATION-SCOPE-016');
});
