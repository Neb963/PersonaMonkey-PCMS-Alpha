# Security

PersonaMonkey-PCMS is a private-use product developed in a public source repository.

## Never commit

- account passwords or recovery codes;
- browser cookies/session exports;
- Mullvad WireGuard private keys/config archives;
- private provider credentials;
- plaintext secret-store exports;
- live backup payloads containing secrets;
- diagnostic logs containing tokens/cookies/auth headers.

Operator-supplied inputs belong outside Git. `operator-inputs/` is ignored except for its README.

## Architectural boundary

PersonaMonkey owns routing, Personas, browser execution and its native Mullvad bridge. PCMS code must not bypass the Persona Broker or expand the native routing host into a generic RPC surface.

PCMS secrets use opaque SecretRefs and a separate narrow secret backend.

## Reporting

During this development stage, report security defects directly to the repository owner. Do not open a public issue containing secret material.
