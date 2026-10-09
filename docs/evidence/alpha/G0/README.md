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
| Serialized concurrency | Final 21/21 governance tests, including five real-Git CLI acquisitions in disposable fixtures, stale-token rejection after reassignment, competing non-forced ref rejection and automatic phase-test discovery |
| No premature R1 | Actual registry has zero claims and zero epochs; only P101–P105 become READY in this separate acceptance control PR; R2–R6 stay LOCKED |
| Independent browser acceptance | Preserved exact-pin Firefox workflow runs against the active packaged derivative; Alpha PR/main run records are recorded only after actual completion |

Final bootstrap review found that disjoint phase owners cannot edit shared CI to
register their tests. A bounded G0 repair adds automatic discovery of feature-owned
`.test`/`.spec` JavaScript suites under `tests/alpha/`, with failing-suite and empty
G0 regressions. Governance already runs separately. This adds no Alpha feature.
The final governance suite passed 21/21 locally and on repaired merged main.
Its actual results and independent CI are recorded in the acceptance ledger.

Donor pin: `482dc9d9273dcdcd7d2ef4c4b0df8c7c6933d5ca`, tree
`07e005b7b5647215a10dc957c633aae2d76435cc`. Its two inspected main workflows
37833424339/37833424414 passed, including eleven Firefox jobs. These are donor
preflight evidence, not Alpha CI or live acceptance.

Initial local verification: `npm run verify` PASS; initial governance 19/19 PASS.
Final local governance 21/21 PASS; `node tools/alpha/ci.mjs` PASS; actual derivative
build PASS. One inherited
CI-only browser test is skipped locally and runs in hosted CI. ZIP member/byte
comparison proves the derivative adds only `alpha/contracts/index.d.ts` and
`alpha/contracts/surface.json`, with no changed or removed donor XPI members.

The local donor XPI SHA-256 is
`bbe084a0f3495a1a505f87f69c5a29cfdfd538bf15ec35afee35d34b9ae6b5f1`;
the derivative XPI SHA-256 is
`c7245eb63cc075e0f5dcdf20d19f96d3aeb4adc4fb8b60a1afe8ce63f0ea991f`.
Firefox pin: Developer Edition 154.0b10, Mozilla archive checksum retained.

Bootstrap PR [#1](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/1)
and bounded test-discovery repair [#2](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/pull/2)
were independently verified and merged through exact tested candidates with
non-forced expected-main ref updates. Repaired merged main is
`95c925d17f175edf53554a6f6781caf1c14667d9`.

| Exact merged-main workflow | Result |
| --- | --- |
| [alpha-governance 37866977719](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37866977719) | PASS; 21/21 governance cases, actual frozen donor verification/build, actual derivative build, final current-main guard |
| [firefox-developer-edition 37866977710](https://github.com/Neb963/PersonaMonkey-PCMS-Alpha/actions/runs/37866977710) | PASS; all eleven pinned Firefox jobs |

The separate acceptance control PR adds [independent-ci.json](independent-ci.json)
only after those product merges and both exact merged-main workflows succeeded.
CI independently checks the real GitHub run coordinates before allowing R1 to
become READY. No Alpha feature or round claim was acquired, implemented or accepted.
G0 stops after this evidence and eligibility transition are verified and merged.

Feasibility limits: real Perchance/Mullvad/Cloudflare and operator-sensitive backup
acceptance remain operator-controlled. P103's referenced discovery-v3 observations
are absent from the ZIP and donor; obtain that source evidence before asserting
its observation-dependent acceptance. Unknown provider capability remains gated.
