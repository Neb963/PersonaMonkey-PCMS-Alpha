# Frozen PersonaMonkey baseline

P002 preserves PersonaMonkey v1.2.0 from `Neb963/persona-router@9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`
(tree `9d59d800c3a687b2e7360c64d9dd859d701d6ba5`) before PCMS changes runtime behavior.

Every one of the 223 upstream blobs is retained byte-for-byte. Runtime/build/test files
owned by P002 stay at their original root paths. Upstream files that would overwrite PCMS governance
or are outside P002 root ownership are stored at the corresponding path under
`docs/upstream/source/`. The exact upstream `package.json` is therefore available at
`docs/upstream/source/package.json`; the PCMS root package is deliberately composed so P001
governance/Firefox commands remain available.

`import-manifest.json` records every upstream path, destination, mode, size and Git blob SHA.
CI recomputes those blob identities from the checked-out bytes.

## Frozen release evidence

Upstream Actions run `36412342425`, job `108895260160`, passed at the frozen commit. Its release
gate recorded 62 extension test files passing, 63 native tests passing, extension validation over
137 source files, browser-smoke success in its pinned Chrome fixture, and reproducible XPI SHA-256
`928b94a871d70455e42c2a8269a7adec27c59b3c5937e7618f80da218fb126e1`.
Artifact `10966145159` had GitHub artifact digest
`sha256:18481aba740245f057772001e96d4a1f65ce1c7c5d227134afa886616a0fcf91`.

PCMS does not adopt Chrome as browser authority. The derived repository reconstructs the exact
upstream tree in a temporary workspace and re-runs upstream `npm test`, `npm run validate` and
`npm run build`; it then requires the rebuilt XPI bytes to match the frozen upstream XPI digest.
The prior upstream browser-smoke result is retained as provenance only. PCMS browser evidence remains
the repository-pinned Firefox Developer Edition harness from P001.
