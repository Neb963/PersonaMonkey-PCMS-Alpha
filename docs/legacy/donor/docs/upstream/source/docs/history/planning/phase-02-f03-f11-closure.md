# Phase 02 — F-03/F-11 state authority and imports

Date: 2026-09-25. Audit baseline: `main` at `e33272a7d4ff49623d613d11fbb65da806d7f869`. Starting point: Phase 01 branch at `c6493b295d3db09b686fc7856f8fd38686452f50`. Scope is Phase 02 only.

## Disposition

**F-03 and F-11: remediated at the state-commit boundary, with local and Firefox UI evidence below.** The central security delta compares normalized old/proposed state, lists exact trusted extension IDs and route scheme/host/port without credentials, and rejects unapproved trust expansion or weakening. A preview binds the exact proposal and delta to one boot ID, revision, and expiring one-use authorization. Commit repeats the comparison inside the mutation queue. Whole-state saves, Integration policy updates, modern/legacy imports, and new route creation use this boundary. Granular Persona operations only receive a narrow Direct grant after explicit `allowDirect` validation. The service also rejects sensitive external storage notifications and restores the last authorized state.

Imports retain the destination Integration API policy. Automatic Sync recovery discards imported Integration authority, quarantines unmanaged traffic and all recovered Personas to Block, disables recovered routes, and restores speculative-request blocking, network-prediction disabling, strict verification, privacy enforcement, and disabled WebRTC. Persona package imports and clones force the new Persona's kill switch and LAN blocking on. Managed profile deletion under unmanaged Direct and disabled/deleted route fallback with `killSwitch:false` require review; legitimate removal/rotation quarantines unmanaged traffic instead.

## GitHub branch commits

Branch: `phase-02-state-authority-imports`. These GitHub commit IDs correspond to the verified local commits; the local checkout was reconstructed from the Phase 01 GitHub tree and therefore has different synthetic parent hashes.

| GitHub commit | Change |
| --- | --- |
| `66c5479bcdf332dc44ae08c6f8c7a20f4217cdd6` | Central security-delta/state-manager authorization and tests. |
| `345f927b4c6f68d73eaf803c428547d175d10209` | Strip imported Integration authority from modern backup proposals. |
| `38a4aed7f662bb49c929c5b35cf178dc81c627a9` | Quarantine Sync recovery and Persona unmanage; route classifier through the commit guard. |
| `23f103aad7a5777d04391321038ef7e785d99246` | Gate legacy/state writers, Direct routes, managed-profile removal, route fallback, and Persona packages/clones. |
| `5d7829fa52e410a4df0164d690c7fd6399eb4645` | Exact-delta review in Options, legacy/advanced imports, Integration settings, and route creation. |
| `6b4fde267397437b587fce42889f8c65623ac756` | Restore safe privacy controls from Sync and restrict approval/preview commit to the Options page. |
| `bad2753844579fe0a71e82b55bc754175cccc991` | Restore focus after cancelling or failing a security review and reloading state. |
| `92c1c5f90e328749eb03603c761fc7a2013de314` | Extract focus restoration helper and add regression coverage for the re-rendered control. |

## Verification

Passed locally after the final code changes: all 53 extension test files (`npm run test:extension`), 22 native tests (`npm run test:native`), `npm run test:repository`, `npm run validate` (121 extension source files), and `npm run build`. The final candidate XPI SHA-256 is `52fe954279d1f70d1966338edcf2d859b251e648fbe0bc6607cf6601a3982332`. Regression tests cover modern merge/replace import authority stripping; legacy import; exact trusted-ID/endpoint delta; Direct, kill-switch, privacy and route fallback; stale/mismatched/one-use approval; typed failures from state writers; storage-event rejection; safe recovery; a second extension page's inability to approve a security preview; and focus restoration to the replacement Save route button after cancellation. No Chromium browser test or aggregate `release:check` was run under the Phase 02 browser policy. No GitHub Actions run was dispatched.

## Firefox 157 UI evidence

The final candidate XPI (`52fe954279d1f70d1966338edcf2d859b251e648fbe0bc6607cf6601a3982332`) was installed as the temporary `persona-route-manager@local` extension in Firefox 157 through Firefox Dev MCP. Editing the configured SOCKS host from `10.124.1.240` to `10.124.1.241` and saving displayed the exact delta `routes["mullvad-5effe095"].endpoint: socks://10.124.1.240:1080 → socks://10.124.1.241:1080`. Clicking Cancel closed the review, storage retained `10.124.1.240`, and focus returned to the re-rendered `#saveRouteEditor` (“Save route”) button. An earlier in-place replacement attempt timed out and disconnected the MCP Marionette listener; after the user restored Firefox, this candidate was installed into the fresh session and verified. No Firefox restart or session-close command was called during this verification. Earlier Firefox evidence on candidate `8515f3de864c07764b26e7263161cf90ffbe8cc90b4a1e5ac7a2bee1b2eb8696` verified strict-verification cancellation and Integration approve/revoke persistence. These are UI/state checks, not packet-level routing tests.

## Remaining trust boundary

Approval messages now require the exact extension Options page sender. A normal content script, external extension, or alternate extension page cannot approve. Code already executing inside the trusted Options page can still call the approval API directly without displaying its own dialog; this implementation relies on the integrity of that extension page, because a runtime message cannot prove a human clicked the dialog. No bypass was found for untrusted external senders or whole-state/import writers after the rescan. Phase 08 should include broader browser acceptance and the remaining audit closure gates; later findings remain outside Phase 02.
