# ADR-001 — Derive PCMS from PersonaMonkey while preserving a broker boundary

Status: **ACCEPTED**

## Context

Earlier PCMS designs planned a separate Firefox extension and substantial browser/runtime integration. PersonaMonkey now already provides durable Persona identity, routing/Mullvad, userscripts, workflows, external executable artifacts, transient inputs/secrets, control leases and owned execution.

Building those mechanisms again would duplicate the highest-risk Firefox code.

## Decision

Build the new product from the PersonaMonkey source baseline, in one Firefox Developer Edition extension.

PCMS remains a separately owned subsystem and consumes PersonaMonkey only through a typed Persona Broker preserving the behavioral semantics of Integration API v1.

Keep the external Integration API available.

Do not permit PCMS modules to call raw PersonaMonkey state/services, raw `browser.*` or the Mullvad native host.

## Consequences

Advantages:
- quickest path to working Personas/routing/browser state;
- one browser-execution authority;
- no second-extension startup/authorization dependency;
- existing Persona data/identity can remain compatible;
- fallback to a separate PCMS extension remains possible because the broker mirrors the external contract.

Costs:
- upstream PersonaMonkey merges must be maintained deliberately;
- PCMS changes touching PersonaMonkey-owned paths require extra regression evidence;
- ownership boundaries must be mechanically enforced.

## Fallback trigger

If P003/P009 cannot preserve the broker boundary without pervasive PersonaMonkey-internal coupling, split PCMS back into a separate extension consuming Integration API v1. Module/Core contracts should not otherwise change.
