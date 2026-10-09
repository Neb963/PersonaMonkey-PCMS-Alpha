import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { contractHash, json, load, validateSnapshot } from '../../../tools/alpha/governance.mjs';
import { PERSONA_BROKER_COMMANDS } from '../../../extension/pcms/core/persona-broker-contract.js';
import { renderViews } from '../../../tools/alpha/views.mjs';

test('frozen declarations and surface hash match the actual broker and ten services', () => {
  const surface = json('.', 'extension/alpha/contracts/surface.json');
  const declarations = readFileSync('extension/alpha/contracts/index.d.ts', 'utf8');
  assert.equal(surface.runtimeImplementation, false);
  assert.equal(Object.keys(surface.services).length, 10);
  assert.deepEqual(surface.personaBroker.commands, Object.entries(PERSONA_BROKER_COMMANDS).map(([name, d]) => ({ name, requiresOperation: d.requiresOperation })));
  for (const [name, methods] of Object.entries(surface.services)) {
    const body = declarations.match(new RegExp(`export interface ${name} \\{([^\\n]+)\\}`))?.[1];
    assert.ok(body, name);
    for (const method of methods) assert.ok(body.includes(`${method}(`), `${name}.${method}`);
  }
  for (const [name, values] of Object.entries(surface.enums)) {
    const body = declarations.match(new RegExp(`export type ${name} = ([^;]+);`))?.[1];
    assert.ok(body);
    assert.deepEqual([...body.matchAll(/'([^']+)'/g)].map(m => m[1]), values);
  }
  assert.equal(contractHash(), load().lock.contracts['alpha.contracts.v1']);
  validateSnapshot(load(), { root: '.' });
});
test('generated Alpha views never announce an unassigned next task or donor acceptance', () => {
  const views = renderViews(load().plan);
  for (const text of Object.values(views)) {
    assert.equal(text.includes('Implement the next eligible phase'), false);
    assert.equal(text.includes('P043'), false);
  }
  assert.ok(views['docs/progress/alpha/STATUS.md'].includes('Provider-live acceptance: **not established**'));
});
