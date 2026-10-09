import { load, validateSnapshot } from './alpha/governance.mjs';
console.log(JSON.stringify(validateSnapshot(load(), { root: '.' })));
