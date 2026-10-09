> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.6.3

v0.6.3 fixes the remaining case where the Cookies workspace could show an empty managed persona even though Firefox/LibreWolf still had a persistent logged-in session in that container.

## Fixed

- Cookie enumeration now covers both Firefox first-party isolation and dynamic storage partitioning.
- Persona listing uses the exact selected `cookieStoreId` plus `firstPartyDomain: null` and `partitionKey: {}`.
- Partitioned and unpartitioned cookies can therefore appear together in the same persona view.
- Individual cookie edits/deletes continue to preserve exact first-party-domain and partition metadata.

## Why v0.6.2 was insufficient

v0.6.2 treated `firstPartyDomain: null` as a restrictive filter and removed it from listing. Current Firefox semantics use that null value as the `getAll()` wildcard for every first-party domain; hardened profiles may require it. v0.6.2 also did not explicitly request dynamically partitioned storage.

## Verification

The regression suite now models both isolation dimensions simultaneously. A dedicated browser smoke contains ordinary first-party-isolated cookies and a dynamically partitioned cookie in one persona, and requires all of them to render without exposing cookies from another persona.

The release gate remains:

- 29 extension regression/unit test files;
- Automations/package/diagnostics browser smoke;
- persona-cookie/data-management browser smoke with first-party isolation and dynamic partitioning semantics;
- release metadata validation;
- deterministic XPI build;
- workflow example package build;
- exact-head artifact upload and independent XPI inspection.

Gecko ID remains `persona-route-manager@local`, persisted state schema remains version 2, and routing/native/workflow compatibility boundaries are unchanged.

The automated cookie gate is intentionally closer to current Firefox semantics, but installed LibreWolf verification with the real browser cookie database is still required to confirm the original user report is resolved.
