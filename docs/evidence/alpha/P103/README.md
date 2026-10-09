# P103 acceptance record

Phase P103, `slot-three-p103`, claim `CLM-P103-001`, epoch 1,
revision-2 `alpha.contracts.v1`.

- **AP103-01:** `extension/alpha/providers/perchance/adapter.mjs` and
  `fixtures/alpha/perchance/discovery-v3.json` implement a narrow, fully injected
  capability/identity boundary from the observed account inventory and
  save/privacy evidence. No guessed server pagination or public-feed ownership.
- **AP103-02:** `emulator.mjs` plus regression tests simulate keyed discovery,
  pagination drift/duplicates, exact source, challenge, stale, uncertain
  post-apply timeout, rate limit, source drift, listing positions and AI saved vs
  unsaved source. Mutations cannot start without externally durable operation
  PREPARED evidence; UNCERTAIN is never auto-retried.
- **AP103-03:** static negative tests and code review confirm no independent
  network/native/browser mutation authority or credentials. Production executor
  wiring, a durable production journal, actual Perchance behavior and operator
  Firefox/Cloudflare/Mullvad live acceptance are intentionally unclaimed.

The exact verification commands, results, source SHA, and independent hosted CI
are recorded in `acceptance.json`. Current Alpha product and provider-live gates
are **not accepted** by P103; combined R1 approval belongs to `GATE-R1`.
