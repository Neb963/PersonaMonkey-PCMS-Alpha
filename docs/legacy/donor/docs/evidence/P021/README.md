# P021 — PCMS UI shell / notifications / search evidence

Phase state: **ACCEPTED**.

## Implemented scope

P021 turns the derivative PCMS entry page into a bounded, read-only shell without creating a second operational authority.

- semantic Overview / Attention / Accounts / Search navigation;
- Attention notifications projected only from accepted P012 `HumanTask.listAttention()`;
- Account projection sourced only from accepted P014 `Accounts.listAccounts()`;
- deterministic bounded search across non-secret Account identity fields and open HumanTask title/kind/priority/subject metadata;
- HumanTask instructions and arbitrary operator payloads are not indexed or rendered by search;
- no `cookieStoreId` is retained or searched as account identity;
- internal deep links use an explicit fragment grammar for Overview, Attention, Accounts, and Search;
- entity deep links are canonical, percent-encoded, and validated against the current projection before display;
- stale entity links fail closed to Overview rather than authorizing an operation;
- unknown routes, external URLs, extra query parameters, controls, and malformed encodings are rejected;
- dynamic UI content is assigned with DOM text nodes/`textContent`, not `innerHTML`;
- the shell performs no HumanTask resolution, Account mutation, browser/native/network operation, raw IndexedDB access, or PersonaMonkey-internal access.

The accepted repository does not yet have the P023 cross-module composition root that supplies live Accounts/HumanTask instances to the extension page. P021 therefore keeps data sources injectable and the standalone P021 entry page mounts the same shell against empty read-only sources. P023 owns the later cross-module wiring; P021 does not invent an interim privileged transport.

Implementation files:

- `extension/pcms/app/errors.js`
- `extension/pcms/app/deep-links.js`
- `extension/pcms/app/projections.js`
- `extension/pcms/app/app.js`
- `extension/pcms/app/index.html`
- `extension/pcms/app/app.css`

Focused tests:

- `tests/pcms/p021/harness.mjs`
- `tests/pcms/p021/projections.test.mjs`
- `tests/pcms/p021/deep-links.test.mjs`
- `tests/pcms/p021/boundary.test.mjs`

## Acceptance mapping

### A021-01 — navigation / attention shell

Covers semantic navigation, deterministic priority ordering, notification/account badges, critical count, read-only P012/P014 source boundaries, and shell DOM structure.

### A021-02 — search / projections

Covers AccountId/display name/personaUid/provider search, open HumanTask title/kind/priority/subject search, deterministic ranking and result bounds, omission of HumanTask instructions, rejection of malformed/accessor-shaped source data, and fixed projection failure errors.

### A021-03 — deep-link safety

Covers canonical internal fragment construction/parsing, percent-encoded entity IDs, stale-entity rejection, bounded query normalization, and rejection of external/unknown/injection-like links and extra parameters.

## Focused verification actually run

The available execution environment does not provide a local repository checkout, so no local Node command is claimed.

The exact P021 product and committed test sources from checkpoint `221678f60cdc7e45859ce835e0c03b893f60a233` were fetched through the GitHub connector and executed in its JavaScript isolate:

- **9/9** committed projection/deep-link behavior test bodies passed;
- **3/3** committed static authority/UI-boundary assertions passed against the exact product sources;
- combined focused U/I/C result: **12 checks passed, 0 failed**.

The isolate does not provide Node's `structuredClone`; a deterministic JSON clone shim was supplied only to the committed test harness/test bodies. Product code was not modified.

Independent branch checkpoint `221678f60cdc7e45859ce835e0c03b893f60a233` passed:

- repository `verify`, run **567** / run id **37305090634** — **success**;
- pinned Firefox Developer Edition, run **562** / run id **37305090648** — **success**.

The repository root `npm run verify` does not auto-discover `tests/pcms/p021/*.test.mjs`; root Actions are independent repository/claim/upstream/Firefox evidence rather than the focused P021 behavior run.

No P025/P026 LIVE evidence is claimed.

## Pull request / merged integration

Final PR head `00ebea6ea3e72956ad728ca0ff3049e5362354a8` passed:

- push repository `verify`, run **572** / run id **37305663034** — **success**;
- push pinned Firefox Developer Edition, run **567** / run id **37305663072** — **success**;
- pull-request repository `verify`, run **573** / run id **37305708231** — **success**;
- pull-request pinned Firefox Developer Edition, run **568** / run id **37305708230** — **success**.

Pull request #21 merged as `8b69f42565ebcbf1a401dd983ffd0efaf8eba13b`.

The exact merged main commit passed:

- repository `verify`, run **574** / run id **37305872795** — **success**;
- pinned Firefox Developer Edition, run **569** / run id **37305872831** — **success**.

## Acceptance decision

The MERGED governance checkpoint `582c3ae1a593629f1824e5c5e7c89a1b3f81e851` passed:

- repository `verify`, run **575** / run id **37306103789** — **success**;
- pinned Firefox Developer Edition, run **570** / run id **37306103812** — **success**.

Together with the 12 exact-source focused U/I/C checks, accepted P012/P014 dependencies, final PR-head CI, and exact merged-main CI, this satisfies **A021-01**, **A021-02**, and **A021-03**. P021 is **ACCEPTED**.
