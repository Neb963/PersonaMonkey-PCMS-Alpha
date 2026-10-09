# AGENTS.md — PersonaMonkey-PCMS Implementation Contract

This file is normative for every implementation agent.

## 1. Mission

Implement exactly one currently claimed task at a time. Multiple agents may work concurrently only when the repository claim validator says their claims do not conflict.

Do not redesign accepted architecture inside an implementation task merely because another design is easier.

## 2. Authority

When instructions conflict:
1. explicit current user instruction;
2. safety/security constraints;
3. accepted ADRs and architecture specs;
4. `docs/implementation/v1/plan.json` and `policies.json`;
5. versioned contracts;
6. the active claim;
7. implementation/tests;
8. convenience.

Generated roadmap/status files are views, not authority.

## 3. Start procedure

Before editing:
1. fetch latest `origin/main`;
2. read this file, plan and policies;
3. identify an eligible phase/task;
4. acquire or verify an ACTIVE claim;
5. verify its `baseMainSha`, `claimEpoch`, branch, ownership and contract SHAs;
6. create/use only its isolated branch/worktree.

No valid claim means no product-code changes.

## 4. Claim scope

The claim defines writable paths, contract reads/writes, resources, migration slots, acceptance IDs and merge wave. Do not write outside it. Never invent a migration ID.

A stale claim epoch is invalid.

## 5. Parallel safety

Claims conflict on overlapping write paths, shared contract writes, stale contract assumptions, exclusive resources, migration slots or manually authoritative files.

Read/read overlap is allowed.

Before changing a shared/manual authority, re-read current main. Never overwrite another agent's work merely to resolve a conflict.

## 6. Product boundaries

PersonaMonkey remains authoritative for Persona/contextual identity, `personaUid`, routing/Mullvad, browser state, userscripts/workflows, browser execution, control leases, its own storage and compatibility formats.

PCMS reaches PersonaMonkey only through the Persona Broker / Integration-semantics boundary.

Modules never receive raw `browser.*`, raw IndexedDB, raw PersonaMonkey service objects or raw native-host RPC.

Browser/page automation uses PersonaMonkey execution artifacts. Do not create a second PCMS `userScripts` authority.

## 7. External mutation

A durable RemoteOperation exists before dispatch. `UNCERTAIN` requires reconciliation before retry. A PersonaMonkey control lease is short runtime exclusivity, not durable mutation correctness. Unknown provider behavior fails closed.

## 8. Secrets

Secret values never enter normal PCMS DB rows, audit events, logs, reports, snapshots or generated artifacts. Use SecretRefs and the dedicated secret host.

Operator inputs in a public repository are never duplicated, printed, snapshotted or uploaded as CI artifacts.

## 9. Browser policy

Firefox Developer Edition is the normal browser target. Required CI uses the exact repository-pinned build. Do not infer behavior from Chromium.

Firefox DevTools MCP is not part of development, CI or acceptance architecture.

## 10. Testing

Every behavior change needs the narrowest useful automated regression mapped to acceptance IDs.

Evidence names the exact commit SHA and workflow run. COMMITTED, CI_VERIFIED, INTEGRATION_VERIFIED, MERGED and ACCEPTED are distinct states.

When final live behavior disagrees with a fixture/emulator, first encode the observation as a deterministic regression, then fix it, then return to live acceptance.

## 11. Git durability

Branch format:
`agent/<agent-id>/<phase-id>-<task-id>`

Push coherent checkpoints after each acceptance slice, before risky refactors/migrations, after isolating a meaningful regression, and before handoff/task switch/tool reset.

Never force-push or rewrite published shared history.

## 12. Integration

Before marking a PR ready: update to latest main, verify claim epoch/current contracts, run focused verification, push, and wait for required independent CI. Integration-wave/merge-group CI must pass when required.

## 13. Live testing

Only the final two roadmap phases require real operator-environment provider/routing acceptance. Real pinned Firefox Developer Edition in hosted CI is deterministic browser evidence, not provider-live testing.

## 14. Abandoned agents

If a claim is reassigned, its epoch increments. An old branch/epoch cannot merge. A replacement starts from latest main plus any explicitly reusable pushed checkpoint.

## 15. Stop/escalate

Stop rather than guess if implementation would require bypassing the Persona Broker, an external mutation cannot be reconciled safely, a sandbox would gain privileged extension authority, a migration cannot preserve accepted state, plaintext secret persistence would be required, or current Mozilla documentation contradicts a browser security assumption.

Otherwise implement the claim, verify it, publish it, report it and stop.
