# PersonaMonkey upstream baseline

PCMS is being restarted as a PersonaMonkey-derived product.

## Upstream

Repository: `Neb963/persona-router`

Frozen import candidate:
`9995f6eadfa54be6cc0001f4e04f2a2d9b9401bf`

Commit subject:
`Merge pull request #29 from Neb963/fix/reproducible-release-xpi`

Source tree:
`9d59d800c3a687b2e7360c64d9dd859d701d6ba5`

The source repository is private while this repository is public, so GitHub does not represent this repository as a native public fork. Provenance is therefore recorded explicitly.

## Rule

P002 imports the exact frozen source bytes and proves the inherited PersonaMonkey test/release baseline before PCMS modifies runtime behavior.

Any later upstream synchronization must record:
- upstream commit SHA;
- imported range;
- conflicts;
- PersonaMonkey regression results;
- PCMS compatibility impact.

Do not silently copy individual upstream files without provenance.
