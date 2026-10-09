> **Historical record.** Preserved for release history; it is not current product authority.

# PersonaMonkey Route Manager v0.6.2

> **Erratum:** v0.6.2's cookie-enumeration explanation and regression model were incorrect. In Firefox `cookies.getAll()`, `firstPartyDomain: null` means all first-party domains, and `partitionKey: {}` requests both partitioned and unpartitioned cookie storage. v0.6.3 corrects the implementation and coverage. The v0.6.2 UI/workspace changes below remain valid.

v0.6.2 substantially improved persona-data controls and introduced the dedicated cookie-management workspace, but its attempted fix for empty cookie listings was incomplete.

## Cookie visibility status

- v0.6.2 changed listing to the selected contextual identity's `cookieStoreId` only.
- That preserved persona scoping but was insufficient for privacy-hardened Firefox/LibreWolf because first-party isolation may require an explicit `firstPartyDomain` selector and dynamically partitioned cookies require a `partitionKey` selector.
- v0.6.3 supersedes this behavior with `storeId + firstPartyDomain: null + partitionKey: {}` and a corrected regression model.

## New Cookies workspace

- Added a dedicated **Cookies** tab.
- Added a **Cookies** shortcut next to Edit/Test on every managed persona.
- Added cookie creation, editing, single/selected deletion, domain/subdomain clearing, and persona-wide clearing.
- Added explicit selected-cookie copy between managed personas.
- Added versioned `*.personamonkey-cookies.json` import/export with merge/replace modes.
- Direct cookie files are clearly treated as sensitive plaintext; encrypted PersonaMonkey backups remain the secure storage format.

## Profile/UI improvements

- Added simple **Export** next to Edit, Cookies, and Test for each managed persona. It produces a portable non-sensitive persona package with dependencies while excluding cookies and route credentials.
- Profiles and Cookies display Firefox contextual-identity icon/color metadata when available.
- Reduced the options-page header to the product name and protection state.
- Kept profile Edit focused on routing/domain policy instead of mixing cookie data into the same editor.

## Verification note

The v0.6.2 release used 29 extension regression/unit test files plus Automations and data-management browser gates. The cookie browser stub, however, modeled Firefox's `firstPartyDomain` semantics incorrectly and did not model dynamic partitioning. v0.6.3 replaces that model with first-party-isolated, partitioned, and unpartitioned cookies in the same persona.

Gecko ID remains `persona-route-manager@local`, persisted state schema remains version 2, and protected personas remain fail-closed.
