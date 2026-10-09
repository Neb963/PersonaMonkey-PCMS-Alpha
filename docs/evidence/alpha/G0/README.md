# G0 — serialized Alpha bootstrap

Assignment: bootstrap G0 only. The operator approved the supplied seven normative
seed files on 2026-10-08. No Alpha feature or actual round claim is implemented.
The G0 lease is epoch 1, `agent/codex-g0/g0`; source/main/contract coordinates are
machine-readable in the plan, context, provenance and contract lock.

| G0 criterion | Executed evidence |
| --- | --- |
| Accepted authority | Seven original seed hashes verified; active Alpha authority and history-only donor records checked |
| Faithful donor source | All 726 frozen donor blobs/modes verified; inherited runtime/regressions byte exact |
| Working baseline | Actual donor `npm run verify`, upstream/native checks and reproducible XPI build executed in a reconstructed snapshot |
| Serialized concurrency | 19 governance tests, including five real-Git CLI acquisitions in disposable fixtures, stale-token rejection after reassignment, and competing non-forced ref rejection |
| No premature R1 | Actual registry has zero claims; all rounds/phases stay LOCKED while G0 is IN_PROGRESS; five-claim tests are isolated fixtures |
| Independent browser acceptance | Preserved exact-pin Firefox workflow runs against the active packaged derivative; Alpha PR/main run records are recorded only after actual completion |

Donor pin: `482dc9d9273dcdcd7d2ef4c4b0df8c7c6933d5ca`, tree
`07e005b7b5647215a10dc957c633aae2d76435cc`. Its two inspected main workflows
37833424339/37833424414 passed, including eleven Firefox jobs. These are donor
preflight evidence, not Alpha CI or live acceptance.

Local verification: `npm run verify` PASS; `npm run test:alpha-governance` 19/19
PASS; `node tools/alpha/ci.mjs` PASS; actual derivative build PASS. One inherited
CI-only browser test is skipped locally and runs in hosted CI. ZIP member/byte
comparison proves the derivative adds only `alpha/contracts/index.d.ts` and
`alpha/contracts/surface.json`, with no changed or removed donor XPI members.

The local donor XPI SHA-256 is
`bbe084a0f3495a1a505f87f69c5a29cfdfd538bf15ec35afee35d34b9ae6b5f1`;
the derivative XPI SHA-256 is
`c7245eb63cc075e0f5dcdf20d19f96d3aeb4adc4fb8b60a1afe8ce63f0ea991f`.
Firefox pin: Developer Edition 154.0b10, Mozilla archive checksum retained.

`independent-ci.json` is added by G0's acceptance PR only after the bootstrap
product merge and both exact merged-main workflows succeed. CI independently
checks the actual GitHub run coordinates before allowing R1 to become READY.
The acceptance record does not itself claim that a round feature was implemented.

Feasibility limits: real Perchance/Mullvad/Cloudflare and operator-sensitive backup
acceptance remain operator-controlled. P103's referenced discovery-v3 observations
are absent from the ZIP and donor; obtain that source evidence before asserting
its observation-dependent acceptance. Unknown provider capability remains gated.
