# Six-round implementation plan — five agent slots per round

Bootstrap G0 is mandatory and serialized before R1. Each round is independent across its five Pxxx write paths. The operator launches five prompts manually and then a sixth gate-check prompt. Gate checker is not a permanent orchestrator.

## R1: Independent foundations

| Agent | Phase | Outcome | Prerequisites |
|---:|---|---|---|
| 1 | P101 | Pinned Firefox and PersonaMonkey regression harness | G0 |
| 2 | P102 | Generator/domain persistence and durability | G0 |
| 3 | P103 | Perchance contract adapter and emulator | G0 |
| 4 | P104 | GitHub private-repo adapter and safe paths | G0 |
| 5 | P105 | Static Alpha UI shell and visual foundation | G0 |

**Gate:** GATE-R1; detailed checklist in `docs/implementation/alpha/GATES.md` and corresponding paste-ready integration prompt.

## R2: Durable services and inventory

| Agent | Phase | Outcome | Prerequisites |
|---:|---|---|---|
| 1 | P201 | Background Core and durable alarms | P102, P103, P104 |
| 2 | P202 | Accounts and Persona enrollment | P102, P103 |
| 3 | P203 | GitHub source catalog and READY interpreter | P102, P104 |
| 4 | P204 | Generator inventory and drift facts | P102, P103 |
| 5 | P205 | Unified backup schema and safe exporter | P102 |

**Gate:** GATE-R2; detailed checklist in `docs/implementation/alpha/GATES.md` and corresponding paste-ready integration prompt.

## R3: Operational engines

| Agent | Phase | Outcome | Prerequisites |
|---:|---|---|---|
| 1 | P301 | Bulk reservations and account balancing | P202, P203, P204, P201 |
| 2 | P302 | Sleep-only Deployer and rollback | P203, P204, P201 |
| 3 | P303 | Native Perchance AI session and editor overlay | P103, P201, P105 |
| 4 | P304 | Individual Refresher scheduler and healthy clock | P204, P201 |
| 5 | P305 | Recent visibility and adaptive metrics | P204, P103 |

**Gate:** GATE-R3; detailed checklist in `docs/implementation/alpha/GATES.md` and corresponding paste-ready integration prompt.

## R4: Integrated workflows and recovery

| Agent | Phase | Outcome | Prerequisites |
|---:|---|---|---|
| 1 | P401 | Supply flow and two-sided reconciliation | P301, P203 |
| 2 | P402 | Release, approval, publication and GitHub writeback | P302, P303, P304, P203 |
| 3 | P403 | Refresh execution and visibility feedback | P304, P305, P201 |
| 4 | P404 | Notifications, attention, and tab ownership | P201, P202, P303 |
| 5 | P405 | Full backup restore and downloads retention | P205, P201, P202 |

**Gate:** GATE-R4; detailed checklist in `docs/implementation/alpha/GATES.md` and corresponding paste-ready integration prompt.

## R5: Operator interface

| Agent | Phase | Outcome | Prerequisites |
|---:|---|---|---|
| 1 | P501 | Bulk-first Overview and Supply UI | P401, P402, P404, P105 |
| 2 | P502 | Accounts and generator management UI | P202, P204, P105, P404 |
| 3 | P503 | AI approval and deployment review UI | P402, P404, P105 |
| 4 | P504 | Refresher, settings and backup UI | P403, P405, P105 |
| 5 | P505 | Attention and toolbar popup UI | P404, P105 |

**Gate:** GATE-R5; detailed checklist in `docs/implementation/alpha/GATES.md` and corresponding paste-ready integration prompt.

## R6: Production wiring and adversarial hardening

| Agent | Phase | Outcome | Prerequisites |
|---:|---|---|---|
| 1 | P601 | Production bootstrap and legacy runtime retirement | P201, P401, P402, P403, P404, P405, P501, P502, P503, P504, P505 |
| 2 | P602 | Fault injection and lifecycle verification | P401, P402, P403, P405 |
| 3 | P603 | Security and GitHub concurrency verification | P302, P402, P405 |
| 4 | P604 | Packaged restore and fleet-scale acceptance | P405, P403, P204 |
| 5 | P605 | End-to-end UI, accessibility and release artifacts | P501, P502, P503, P504, P505 |

**Gate:** GATE-R6; detailed checklist in `docs/implementation/alpha/GATES.md` and corresponding paste-ready integration prompt.
