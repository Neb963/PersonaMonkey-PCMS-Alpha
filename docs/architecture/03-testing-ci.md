# 03 — Testing and CI

## Evidence classes

- U — unit
- I — integration
- C — contract/schema
- E — provider emulator
- FDE — real exact-pinned Firefox Developer Edition
- PKG — packaged XPI/install/restart/update (including background event-page continuity and runtime-module lifecycle without extension reload, driven by the repository Firefox harness)
- FAULT — deterministic fault injection
- SEC — security/redaction/static
- LIVE — operator-controlled real provider/routing acceptance

## Doctrine

P001–P024 closed through deterministic repository/Actions evidence; P025–P026 were the final live phases of the original v1 roadmap and are accepted history. For the extended roadmap, only the **final two phases** listed in `plan.json` `executionModel.finalLivePhases` require real operator-environment provider/routing evidence; every earlier phase closes through deterministic evidence, including packaged-XPI tests in the exact pinned Firefox Developer Edition. Unknown provider behaviour that can only be observed live stays capability-gated and fail-closed until a final live phase observes it; the observation is encoded as a deterministic regression fixture before any resulting fix is accepted.

Firefox Developer Edition in Actions is deterministic browser evidence, not LIVE provider evidence.

Never claim an inaccessible scenario passed.

When LIVE behavior disagrees with the emulator/fixture, encode the observation into deterministic regression evidence before continuing live debugging.

Required CI is independent of the implementation agent's local claims.
