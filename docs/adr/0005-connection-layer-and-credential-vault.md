# ADR 0005 — Our own connection layer, credentials sealed by envelope encryption

- **Status:** accepted
- **Date:** 2026-07-22

## Context

The harness needs to connect external services — Google Drive, Confluence,
Notion, and more — so a product can read and edit a tenant's data through them.
That means holding OAuth tokens and other secrets, per tenant, and doing so in
a way that survives the security posture the harness is sold on: the agent
never sees a key, one tenant's compromise does not become another's, and a
master key can be rotated.

The plan already ruled out a third-party connection service (Corsair et al.) as
a dependency, for the same reason it ruled out a model-routing service: it would
be a party in the data path. So the connection layer is ours.

This ADR covers the foundation — how credentials are stored — not the connector
contract or OAuth, which follow in later slices of this phase.

## Decision

**Envelope encryption, with a per-tenant data key.** A master key (the KEK),
held by the operator outside the database, never encrypts a credential
directly. It wraps a per-tenant data key (a DEK); the DEK encrypts that
tenant's credentials. This is the shape the plan calls for, and it buys two
things a single key does not:

- **Isolation.** Compromising one tenant's DEK exposes only that tenant.
- **Rotation.** Rotating the master key re-wraps the DEKs — a handful of small
  blobs — without re-encrypting a single credential.

Everything is AES-256-GCM (authenticated encryption) over Node's own crypto, so
a tampered blob fails to open rather than decrypting to garbage. No dependency:
the surface used is four calls wide.

**Three tables, secrets apart from records.** A connection (`connections`) is
"this tenant authorised this connector" — a record with no secret, freely
readable to list what is connected or check status. The secret lives in
`credentials`, sealed, and the per-tenant wrapped DEK in `tenant_keys`. Keeping
the record and the secret in different tables means the common reads never
touch anything encrypted.

**One method returns plaintext.** `CredentialVault.resolve` is the only code
that decrypts, and the design is that only the connection layer calls it, at
the moment of an outbound call — never the agent, never the core. That is what
"the agent never sees API keys" means concretely: it sees method names and
results. The boundary check keeps `src/core/` from importing the vault at all.

**Isolation is the schema's, not the query's.** A credential can only attach to
a connection of the same tenant, via a composite foreign key — a cross-tenant
credential cannot be inserted, not merely should not be. Deleting a tenant, or
a connection, cascades to its keys and credentials.

## Consequences

**What this buys.** Secrets are unreadable without the master key the operator
holds outside the database — an integration test reads the raw column and
proves the token is not in it, in any encoding. Tenants are cryptographically
isolated. The master key can be rotated without a credential migration. And the
vault is the single, testable choke point for anything sensitive.

**What it costs.** Key management is now real: the master key must be provisioned
and kept safe, and a deployment that connects nothing still has to decide it
does not need one (the vault is simply not built without it). The DEK is cached
in process memory for the lifetime of a run — necessary to avoid unwrapping it
on every call, but it means a memory dump of the process contains data keys, as
any crypto system's working keys do.

**What is not solved here.** The connector contract (what "read a document",
"edit a page" mean across sources), the OAuth flow and token refresh, and the
cache of connected data are later slices of this phase. This ADR is only the
vault and the connection registry they will build on.

## Alternatives considered

**A single application-wide key.** Simpler — no per-tenant DEK, no wrapping.
Rejected: rotation would mean re-encrypting every credential, and one key
compromise would expose every tenant. The plan asks for per-tenant envelope
encryption specifically.

**Postgres `pgcrypto` / column encryption.** Push encryption into the database.
Rejected: the key would have to be reachable by the database, which puts it in
the same trust zone as the data — the opposite of holding the master key
outside. Doing it in the application keeps the key out of the database entirely.

**A managed secrets service (KMS, Vault) from day one.** Stronger key custody.
Not rejected in principle — the `EnvelopeCipher` is small and could be backed by
a KMS later — but pulling in that dependency and its operational weight now, for
a single-operator project, is more than the phase needs. The envelope shape is
chosen so a KMS can wrap the master key later without touching the schema.
