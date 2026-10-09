# P104 — scoped GitHub Contents adapter

The frozen GitHubAdapter boundary is implemented by createGitHubAdapter in adapter.mjs. Its configuration requires a single repository (default Neb963/per-gens), an opaque secretRef, a resolveSecret callback and explicit folder/slug bindings. The adapter never stores the token or includes it in results/logs.

createGitHubPathTemplates in paths.mjs accepts only literal folder/slug templates with strict segment checking. The exact resolved files form the complete allowlist. The defaults are generators/{folder}/DEPLOYMENT.md, main.pjs, index.html and thumbnail.jpeg. Folder and slug remain distinct. Source-status interpretation belongs to a later phase and is deliberately absent.

snapshot pins GitHub Contents requests to one immutable commit SHA; readBlob verifies immutable blob identity/size. commit requires an externally durably PREPARED operation, a caller-supplied expected head and exact expected blobs. It stages blob(s), one tree and one commit, rechecks HEAD, and performs one non-forced ref update with subsequent readback. A conflict never forces over developer commits. An ambiguous outcome returns UNCERTAIN and must be reconciled before any retry.

Only deterministic fixture acceptance is claimed, not provider-live acceptance.
