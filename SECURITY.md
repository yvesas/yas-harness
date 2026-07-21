# Security Policy

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Report it privately through
[GitHub Security Advisories](https://github.com/yvesas/yas-harness/security/advisories/new),
or by email to **security@yaslabs.com.br**.

Please include:

- What the problem is and where it lives (file, endpoint, flow)
- How to reproduce it — a minimal proof of concept helps a lot
- What an attacker could achieve with it

### What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement of your report | within 3 business days |
| Initial assessment and severity | within 7 business days |
| Fix or mitigation plan | depends on severity, communicated with the assessment |

This project is maintained by a small team, so those are honest targets rather
than a contractual SLA. You will be told if something takes longer.

We ask that you give us reasonable time to fix an issue before disclosing it
publicly. Reporters are credited in the advisory unless they prefer otherwise.

## Supported versions

The project is in early development. Only the `main` branch receives security
fixes. This section will list supported releases once v1 ships.

## Sensitive areas

Extra care is warranted around:

- `src/connections/` — OAuth flows, token storage, credential encryption
- `src/models/` — provider credentials and what leaves the system in a prompt
- `src/approval/` — the gate in front of destructive actions
- `src/pools/` — cross-module data access and tenant isolation
- `migrations/` — tenant isolation constraints

## Security properties of the harness

These are design commitments; a break in any of them is a vulnerability:

- Credentials are encrypted at rest (envelope encryption) and **the agent never
  sees API keys** — it sees method names and results only
- Tenant isolation is enforced by database constraints, not only by application
  code
- Inbound messages from any channel are treated as untrusted input
- Destructive or external actions require explicit human approval
- Secrets never appear in code, logs, traces or tests

## Scope

In scope: this repository's code and its default configuration.

Out of scope: vulnerabilities in third-party providers (report those to the
provider), and findings that require an already-compromised host or database.
