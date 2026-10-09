# PersonaMonkey documentation

This index is the entry point for current PersonaMonkey documentation. Current product and engineering documents below are authoritative for the topics they cover. Historical material under [`history/`](history/) records earlier releases and planning; it is non-authoritative and never overrides a current contract.

## Product documentation

These documents explain how to install, use, configure, and integrate the supported product.

- [Installation](getting-started/installation.md) — supported browsers, prerequisites, and installation.
- [Data portability](guides/data-portability.md) — backup, restore, import, and export behavior.
- [Workflow packages](guides/workflow-packages.md) — authoring and handling workflow packages.
- [PersonaMonkey Integration API v1](api/integration-v1.md) — the supported external extension contract. PCMS (Perchance Central Management System) is a separate product that consumes this API; this document is its canonical integration contract.
- [Compatibility policy](reference/compatibility.md) — stable v1 compatibility promises and their limits.

## Architecture and internal interfaces

These engineering documents are authoritative for system structure and internal interfaces.

- [Architecture overview](architecture/overview.md) — component ownership, dependencies, and trust boundaries.
- [Persona model](architecture/persona-model.md) — durable Persona identity, Firefox container identity, lifecycle, and persistence.
- [Persona OS API](api/persona-os.md) — typed internal domain/service interface.
- [PersonaMonkey Management API v1](api/management-v1.md) — the bundled same-extension management protocol. Its legacy `PCMS_*` names are compatibility identifiers; they do not identify or define the separate PCMS product.
- [Workflow package schema](reference/personamonkey-workflow-package.schema.json) — machine-readable package format.

PersonaMonkey Management and the external Integration API are distinct interfaces. The Management API is bundled for same-extension use; PCMS depends on the restricted Integration API v1. Their contracts are documented once in their respective canonical API documents and must not be duplicated as competing specifications.

## Development and release

- [Branching](development/branching.md) — branch and change practices.
- [Testing](development/testing.md) — repository, extension, native, browser, and acceptance checks, including their scope.
- [Release procedure](development/release.md) — versioning, validation, candidate freeze, and release steps.
- [External Automation implementation plan](development/external-automation-integration-plan.md) — compatibility boundaries, workstreams, and acceptance criteria for the additive Integration API v1 feature.

The repository's [development entry point](../DEVELOPMENT.md) covers engineering setup; [CONTRIBUTING.md](../CONTRIBUTING.md) covers contributor practice. [SECURITY.md](../SECURITY.md) governs private-data handling and vulnerability reports. [AGENTS.md](../AGENTS.md) records enforceable repository and security invariants.

The [extension source README](../extension/README.md) points maintainers back to the canonical product and installation guides.

## History and authority

- [`history/releases/`](history/releases/) contains prior release notes and version-specific records. They describe their own release context, not current behavior.
- [`history/planning/`](history/planning/) contains completed plans, specifications, audits, and handoffs. These are retained as historical evidence where useful.

Use the current API, compatibility, architecture, and guide documents for present-day behavior. A historical document may provide provenance or explain an earlier decision, but it cannot amend a current contract. When current documents disagree, the document explicitly named as the canonical source for that subject controls; unresolved conflicts should be corrected in the current authority rather than by relying on an archive.
