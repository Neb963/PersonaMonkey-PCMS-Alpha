# P104 local implementation evidence

Claim: CLM-P104-001, epoch 1, owner slot-four, frozen contract alpha.contracts.v1 9b379980e16fdd557e0ea8a7f8273421f4a581c1c1563fe7661308038e29ee12.

Local command: node --test tests/alpha/providers/github/*.test.mjs
Observed result: 14 passed, 0 failed, 0 skipped.
Syntax checks: node --check extension/alpha/providers/github/adapter.mjs and node --check extension/alpha/providers/github/paths.mjs — passed.

AP104-01: traversal, percent aliases, ambiguous filenames and unknown bindings rejected; Contents read pinned; binary blob identity checked; multi-file atomic commit.
AP104-02: branch-head and blob conflicts fail closed; pre-PATCH race and 422 non-fast-forward prevent overwrite; ambiguous PATCH returns UNCERTAIN.
AP104-03: token is resolved only for the request, never returned; rate-limit and auth denial fixtures assert redacted typed failures.

Independent PR CI, current-main merging, merged-main CI and combined GATE-R1 are separate subsequent verification stages. Provider-live: not established.
