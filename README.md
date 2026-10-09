# PersonaMonkey-PCMS Alpha

One Firefox extension derived from PersonaMonkey-PCMS. PersonaMonkey remains the
authority for Personas, protected routing, browser execution and control leases.
Alpha consumes the typed Persona Broker boundary.

The operator-approved Alpha design is under `docs/specs/alpha/SPEC.md` and
`docs/implementation/alpha/`. Read `AGENTS.md`, the current main plan, policies,
contracts, gates and acceptance matrix before acting on an explicit assignment.
Current eligibility is generated in [Alpha status](docs/progress/alpha/STATUS.md).
No phase starts before serialized G0 is merged, independently verified and accepted.

The pinned donor is `Neb963/persona-monkey-pcms` at
`482dc9d9273dcdcd7d2ef4c4b0df8c7c6933d5ca`, tree
`07e005b7b5647215a10dc957c633aae2d76435cc`. Source/license/CI provenance and exact
blob inventory are in `docs/provenance/alpha-donor.json`. Inherited roadmap and
acceptance records are history only; see `docs/legacy/README.md`.

```sh
npm run verify
node scripts/build-extension.mjs
```

Verification preserves the frozen donor regression suite, checks Alpha governance
and contracts, and uses the exact pinned Firefox Developer Edition in hosted CI.
G0 materializes declarations and governance only. Alpha feature and provider-live
acceptance remain unestablished. Real Perchance/Mullvad acceptance is operator-owned.

Serialized claim and merge procedures: [GOVERNANCE.md](docs/implementation/alpha/GOVERNANCE.md).
Credentials, sessions and local backup archives must never enter this repository.
