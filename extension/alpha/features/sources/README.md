# P203 — GitHub source catalog

`createSourceCatalog({github,repository,mappings,paths,storage?,clock?,digest?})` consumes the frozen P104 GitHub adapter and P102 validators. Every mapping is explicit `{folder,slug}`; paths come from P104's literal safe templates and the single configured `main` ref. No branch checkout, provider mutation or alternate browser authority is introduced.

`scan({cursor?,limit?})` reads at most 32 mappings (128 configured file paths) per call and fences continuation to the same immutable Git commit; `get({key})` returns the pinned `SourceBinding`. `resolveRelease({key})` returns a P102-validated `ReleaseRecord` only when the status line is exactly recognized, READY, and all three deployable files are present and valid. A reserved `DEPLOYMENT.md`-only folder is BLOCKED/non-deployable. `bind(...)` optionally records observed provenance using P102 optimistic CAS and account-binding-epoch checks; it does not change any remote resources.

A release ID hashes the exact UTF-8 PJS/HTML bytes plus raw JPEG bytes using a deterministic named and length-framed SHA-256 stream. Documentation, Git commit identifiers and other files are not hashed. The public `hasNewDeployableRelease` check compares last *confirmed* adopted IDs; other deployment eligibility (sleep, ownership, drift, recovery hold) remains Deployer's responsibility.

Deterministic tests: `node --test tests/alpha/sources/*.test.mjs`. Source failures return typed, redacted `Result` values and never replay provider mutations. No provider-live claim.
