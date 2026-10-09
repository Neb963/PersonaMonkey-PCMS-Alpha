# P000 — Bootstrap evidence

Status: **ACCEPTED**

## Repository state at start

- Target `Neb963/persona-monkey-pcms` was an empty public repository.
- Source `Neb963/persona-router` is private.
- Frozen source commit: `9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`.
- Frozen source tree: `9d59d800c3a687b2e7360c64d9dd859d701d6ba5`.

## Delivered

- authority hierarchy and AGENTS contract;
- explicit derivative ADR and upstream provenance;
- 27-phase machine-readable DAG through final two live phases;
- claim schema + conflict verifier;
- generated ROADMAP/STATUS views;
- requirements/acceptance catalogs;
- initial GitHub Actions repository verification;
- ignored operator-input path;
- security and contribution rules.

## Verification

Bootstrap authority commit: `8aed4dfa0bba9bcf5120c320d57fb3172c5eebd7`.

Actions run #1 (`37225861586`) correctly failed because the initially checked-in generated ROADMAP/STATUS did not byte-match the generator. No false-green acceptance was taken from that run.

The views were regenerated in `f351fafd17ebe0229680467c980ccabd4116c521`.

Actions run #2 (`37225945530`) passed the repository job, including:
- 27-phase / 81-gate authority validation;
- generated-view equality;
- active-claim conflict verification.

## Non-deliverables

PersonaMonkey runtime source is intentionally not imported in P000. P002 owns the exact-byte import after P001 establishes the pinned Firefox/hosted-CI browser environment.

No product feature is claimed implemented by P000.
