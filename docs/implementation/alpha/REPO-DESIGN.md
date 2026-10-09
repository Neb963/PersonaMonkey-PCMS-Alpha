# Repository blueprints — Alpha and per-gens

## 1. Repositories and source authority

- **Alpha:** `https://github.com/Neb963/PersonaMonkey-PCMS-Alpha` — currently empty public repository. Bootstrap from a pinned current commit of `Neb963/persona-monkey-pcms` preserving PersonaMonkey's working tree and tests. Record donor commit/tree and provenance. New Alpha architecture, plan and contracts override legacy PCMS design; preserve old accepted evidence only as historical/reference, not Alpha authority.
- **per-gens:** `https://github.com/Neb963/per-gens` — currently empty private repository. PCMS is allowed to create folders and commit approved live corrections; development agents work on per-generator branches. Only specify the contract Alpha needs; do **not** design a full generator-development framework in this project.
- No GitHub repository is modified by this design pack.

## 2. Alpha repository layout (target)

```text
AGENTS.md                            # Alpha agent constitution
README.md
SECURITY.md
package.json                         # existing build scripts adapted, no dependency churn
.github/workflows/                   # claims, unit, integration, packaged Firefox, merge queue
extension/
  ...                                # original PersonaMonkey code preserved
  alpha/
    contracts/                       # stable interfaces, pre-frozen before parallel coding
    domain/ storage/ core/           # durable authority, event-page bootstrap, alarms
    providers/{perchance,github}/    # narrow provider adapters, fixtures
    features/{accounts,sources,inventory,reservation,deployer,ai,refresher,visibility,attention,tabs}/
    flows/{supply,release,refresh}/  # concrete compositions; NOT generic workflow runtime
    backup/                          # integrated backup and restore
    ui/{shell,styles,views}/         # static native-feeling UI; no dynamic module contributions
    overlay/ popup/                  # small native context affordances
  pcms/                              # pre-existing PCMS (retire unused paths only after tests)
native/                              # original native PersonaMonkey host; any expansion separately reviewed
tests/alpha/<feature>/              # isolated paths per phase
fixtures/alpha/                     # Perchance/generator/recovery deterministic fixtures
tools/alpha/                        # governance + release tooling
docs/
  specs/alpha/SPEC.md                # accepted product specification
  implementation/alpha/{plan.json,policies.json,CONTRACTS.md,GATES.md,ACCEPTANCE.md}
  evidence/alpha/<phase-id>/         # immutable acceptance records per phase
  progress/alpha/STATUS.md           # generated, never edited directly
  legacy/                            # optional archived inherited docs/provenance
```

**No runtime plug-in manifest, module store, plugin install UI, cohort model, or shared UI descriptor registry.** Feature boundaries are code organization, not extensibility points. Migrate working correctness infrastructure rather than reimplement it for cosmetic simplification. Avoid dual-authority legacy/Alpha execution during transition: at P201 Alpha is wired as the sole operational background Core and the legacy PCMS Core is explicitly disabled; verified dead legacy code is retired at P601. Only one Core runs in production.

## 3. Bootstrap prerequisite (outside the six concurrent rounds)

Because the new repository is empty, one serialized repository-preparation step must:

1. Read donor `AGENTS.md`, architecture, progress, PRs, CI, current `main` SHA, pinned Firefox.
2. Import the latest verified donor source tree (not an invented SHA), preserve full PersonaMonkey functionality and regression suite; record donor provenance.
3. Seed **accepted** Alpha spec, contracts, plan, policies, acceptance IDs, these prompt instructions and generated views. The user approves the design before seeding.
4. Adapt/verify the claim validator for Alpha phases, epoch fencing and non-overlapping write paths. Create isolated branch conventions and seed CI to reject stale claims. This bootstrap is a serialized governance task; agents must not attempt R1 while it is incomplete.
5. Verify startup/basic build, serialize bootstrap changes into a commit/PR, merge only after CI (or explicitly document unavailable checks), confirm R1 READY. Do not claim live Perchance acceptance.

This is not an 'extra round' or a sixth permanent orchestrator. It is the minimal foundation to make five-way parallel implementation safe.

## 4. Core contract freeze before R1

Contracts listed in `docs/implementation/alpha/CONTRACTS.md` are normative. Changes to shared contracts in a phase require an explicit gate amendment or a separate non-conflicting contract claim; never quietly change a consumer's assumptions. Contracts must describe import paths, records, message envelopes, permitted side effects, failure codes, migrations, and durable identity.

A phase's claim defines `writePaths`, `contractReads`, `contractWrites`, exclusive resources and acceptance IDs. Five phases within one round have separate write paths. Tests and evidence also have separate directories. Integration checking has its own gate-only ownership; it cannot casually rewrite feature code.

## 5. per-gens — minimal contract, no premature repo design

```text
AGENTS.md                    # short repo safety/READY/branch rules
README.md                    # paths and status syntax
(optional other shared docs)
generators/
  <folder>/
    DEPLOYMENT.md             # first file created by reservation; strict Status: field
    main.pjs                  # deployment payload when READY
    index.html                # deployment payload when READY
    thumbnail.jpeg            # configured thumbnail name (case-sensitive)
    ...                       # arbitrary agent docs/source, ignored by PCMS
```

Valid exact readiness line: `Status: BLOCKED`, `Status: IN_DEVELOPMENT`, or `Status: READY`. If missing or ambiguous, fail closed. PCMS sees a single repo/ref/root and configurable **literal path templates** `{folder}`, `{slug}`; never recursively scan unrelated developer docs as deployable input. Repo HEAD never proves release identity: use exact commit+blob/content SHA. READY is persistent and permits changed content, but it does not bypass Perchance AI/manual release approval. A live-fix commit is an atomic conditional write to `main.pjs` and/or `index.html` with existing HEAD precondition; concurrent main change → conflict/attention. No force push. Agents merging their own generator branches must rebase/update from latest main so they retain PCMS live changes. No automated PR creation by PCMS unless user explicitly changes its contract.

## 6. Round workflow without orchestrator

Operator launches up to **five agents**, each with one Pxxx prompt from the HTML pack. Each independently validates the claim and produces evidence/commit/PR. Agents may auto-merge their own PRs only when repository policy, required CI and serialized current-main concurrency fencing permit it; they do not mark the round accepted. After all five finish or are explicitly blocked, operator sends the single **GATE-Rn** prompt to a checking agent. This is a bounded integration session, not an orchestrator. Gate checks actual current main, no cross-claim conflict, merge-group/combined CI, running tests, diffs, stale claims, contract and migration integrity, accepted IDs, next-round eligibility; it repairs only within an explicit integration-only claim or returns changes to phase owner. Only when verified may it mark the round accepted and unlock next phase set. No silent task advance. P043/P044 of donor are historical and must not be mistaken for Alpha phase IDs.

The final provider-live/manual acceptance is a separate gate after R6; provider conditions and Cloudflare should never be claimed as CI-tested. Five-agent round count stays at six, below the ten-round maximum. If a phase is blocked or oversized, amend plan through gate governance rather than starting successor prematurely.
