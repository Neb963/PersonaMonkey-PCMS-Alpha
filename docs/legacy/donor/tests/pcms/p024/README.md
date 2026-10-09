# P024 focused hardening suite

This directory is the deterministic P024 acceptance suite.

Run from the repository root:

```text
node --test tests/pcms/p024/*.test.mjs
```

Coverage:

- **A024-01 / T024.1** — injected ambiguous provider dispatch, interrupted dispatch across restart, RECOVERY_HOLD fencing, reconciliation without replay, and opaque secret-error behavior.
- **A024-02 / T024.2** — executes the repository's current deterministic XPI reproducibility builder, verifies the SHA-256 sidecar, and proves the produced archive contains the current PCMS surface while excluding test sources.
- **A024-03 / T024.3** — uses the accepted immutable package registry, lifecycle service, sandbox runtime, generation fencing and recovery hold to exercise clean module install, update, abrupt restart recovery and reactivation.
- Static boundary checks confirm the suite remains deterministic and does not introduce live-provider, Firefox DevTools MCP, raw browser, or PersonaMonkey-internal authority.

P025 and P026 remain the only live acceptance phases.
