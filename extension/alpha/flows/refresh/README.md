# P403 — Refresh execution and visibility feedback

The single background Alpha Core should compose this P403 service with P304,
P305 and the P103 Persona-scoped Perchance adapter. P403 does not install alarms
or open tabs; it exposes a bounded pass for an existing Core timer. The caller
supplies the current trusted Persona context, the P102-backed P103 operation
journal and a strict durable P403 ledger.

An exact transient PJS suffix is never a GitHub release. Its UTF-8 insertion
offset and before/after SHA-256 are persisted before dispatch and verified after
an authoritative save readback. Only the precise tracked suffix is removable.
Unknown/mutated source, account rebind, unverified session or capability fails
closed. An ambiguous source save is held for read-only reconciliation and never
blindly replayed.

P305 renders are observational facts rather than a visibility guarantee.
Fresh observations, global staggering, exponential backoff, at most three
attempts, optional *already lease-authorized* PersonaMonkey reload per retry
and durable attention reasons bound repeated failure. The browser facade is an
injected trusted interface, not a new Perchance or raw browser command.
With no verified reload facility retries suspend for operator attention.
Actual Perchance, Firefox and Mullvad live acceptance remain unproven.

Deterministic tests: node --test tests/alpha/flows/refresh/*.test.mjs
