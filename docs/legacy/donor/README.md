# PersonaMonkey-PCMS

PersonaMonkey-PCMS is the public implementation repository for the next PCMS architecture: a PersonaMonkey-derived Firefox Developer Edition extension with a separately owned, capability-bounded PCMS subsystem.

## Current state

- **Bootstrap:** P000 ACCEPTED
- **Next implementation phase:** P001 — hosted CI + pinned Firefox Developer Edition harness
- **PersonaMonkey import baseline:** `Neb963/persona-router@9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`
- **Source tree:** `9d59d800c3a687b2e7360c64d9dd859d701d6ba5`
- **Product feature implementation:** not started

## Start here

1. `AGENTS.md`
2. `docs/architecture/00-principles.md`
3. `docs/architecture/01-system-architecture.md`
4. `docs/adr/ADR-001-personamonkey-derivative.md`
5. `docs/implementation/v1/plan.json`
6. `docs/implementation/v1/policies.json`
7. `docs/progress/STATUS.md`

A fresh coding agent should normally be given:

> Implement the next eligible phase.

It must determine eligibility, ownership, acceptance and stop conditions from repository state.

## Architecture

PersonaMonkey remains authoritative for Personas, `personaUid`, Firefox contextual identities, routing/Mullvad, userscripts, workflows and browser execution. PCMS consumes those abilities only through a typed Persona Broker preserving Integration API semantics.

PCMS Core stays small: module lifecycle, sandbox broker, PCMS IndexedDB, RemoteOps, ProviderGate, SecretRefs, HumanTask/Attention, timers/services, minimal audit journal, recovery and diagnostics. Feature policy belongs in installable modules.

## Verification

```bash
npm run verify
```

The initial Actions workflow runs repository/plan/generated-view/claim verification on pushes, pull requests and merge groups. P001 extends this to an exact pinned Firefox Developer Edition runtime.

## Public repository / operator inputs

Operator credentials, browser sessions, account exports and Mullvad WireGuard material must not be committed. `operator-inputs/` is ignored except for its README and is reserved for local/final-live inputs.
