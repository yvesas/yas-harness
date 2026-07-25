# ADR 0006 — One resource-shaped contract for every connector

- **Status:** accepted
- **Date:** 2026-07-22

## Context

With the credential vault in place ([ADR 0005](./0005-connection-layer-and-credential-vault.md)),
the connection layer needs a way to actually reach a source — to list, read,
search, create, edit and delete a tenant's data in Google Drive, Confluence,
Notion, and whatever comes next. The goal stated for this phase is plug and
play: adding a source should be adding a connector and nothing else, and every
connector should support editing, not just reading.

The question is what contract every source has to fit, given that they agree on
almost nothing at the level of their APIs.

## Decision

**One shape: resources.** Every source is modelled as named things — a file, a
page, a document, a folder — that you can list, read, search, create, update
and delete. A connector translates its source into that shape; the harness and
the products on it speak only the shape. A `Resource` carries the fields all
sources share (id, title, content, parent, url, timestamps), a `type` that is
the connector's own word for the kind, and a `metadata` bag for whatever a
source has that the shape does not name — so translation loses nothing.

**Capabilities are declared, and gated on.** Not every source does everything;
a read-only one exists. A connector declares its `capabilities`, and the
manager refuses an operation a connector did not declare. The operation methods
are optional on the interface, and the registry checks that every declared
capability has its method — a capability whose method is missing fails at
registration, not against a live source. The reverse is allowed on purpose: a
full connector run in read-only mode still has its write methods but declares
only reads.

**The manager is the credential seam.** `ConnectionManager` is where the pieces
meet: given a tenant and a connection, it finds the connection record, checks
it is active and the operation is supported, resolves the credential from the
vault, and hands it to the connector for the length of the call. The credential
lives in the clear on that stack and nowhere else — not returned, not logged,
not passed upward. The agent asks to read or edit a resource and gets the
resource; it never touches the key. The status and capability gates run before
the credential is ever decrypted.

**A reference connector ships in `src/`.** `MemoryConnector` implements the
whole contract over process memory. It is the double the layer is tested
against and the worked example a real connector is written from — the same
reason `ScriptedGateway` and the in-memory stores live in `src/`, not `tests/`.

## Consequences

**What this buys.** Adding a source is one file — a connector — plus a row in
the connector registry; the manager, vault and schema do not change. Editing is
first-class, not bolted on: create/update/delete are in the contract from the
start. And the credential boundary is enforced in one place, so no connector
can accidentally leak a key upward — it only ever receives one.

**What it costs.** The common shape cannot express everything every source can
do. Notion's block tree, Drive's revisions, Confluence's labels — these live in
`metadata` and in what a connector chooses to do with a `type`, not in named
methods. A product that needs a source-specific capability the shape does not
model will have to reach past the contract, and that is a deliberate seam, not
an accident. Pagination is a single opaque cursor, which every source can
implement but some could do richer.

**What is not solved here.** OAuth and token refresh (slice 5c) — the manager
resolves whatever credential is stored, and does not yet refresh an expired
one. The data cache (slice 5e). And exposing connector operations to the agent
as tools, so the model can drive them — that is a later slice; this ADR gives
the manager a product calls directly.

## Alternatives considered

**A method-per-source-concept contract.** Model Drive files, Confluence pages
and Notion blocks as distinct shapes. Rejected: it defeats plug and play — every
product would learn three vocabularies, and a fourth source would be a fourth.
The resource shape trades some fidelity for one vocabulary.

**Expose each source's raw API through a thin passthrough.** Maximum fidelity,
no translation. Rejected: it puts the source's API in the agent's and product's
face, which is exactly what the connector is meant to hide, and it makes the
credential boundary impossible to hold — a passthrough is the key.

**Read-only first, editing later.** Simpler contract now. Rejected against the
explicit goal: the dogfooding case (bringing tool knowledge to the agent) and
the products both need to write back, and retrofitting write into a read-shaped
contract is worse than designing for it once.
