---
name: adding-a-connector
description: Use when adding a connector to a product built on yas-harness — a plug for an external source (Google Drive, Confluence, Notion, …) that the connection layer can list, read, search, create, edit and delete through. Covers the Connector contract, capabilities, the credential boundary, and the reference implementation to copy.
---

# Adding a connector

A connector plugs one external source into the harness's resource shape. Once
registered, the connection layer can run operations against a tenant's
connection to that source — and the manager resolves the credential, so the
connector never fetches or stores it, only receives it per call.

> Connectors are infrastructure, not product domain. A "document" or a "page"
> means the same in a language tutor and a CRM, so a connector belongs in the
> harness (or a product's own connection setup) — but never business rules.

## 1. Implement the contract

```ts
import type { Connector, ConnectorContext, Resource } from 'yas-harness';

export class ConfluenceConnector implements Connector {
  readonly id = 'confluence';
  readonly description = 'Confluence spaces and pages.';
  readonly capabilities = ['list', 'read', 'search', 'create', 'update', 'delete'] as const;

  async read(ctx: ConnectorContext, id: string): Promise<Resource> {
    const token = credentialToken(ctx.credential); // your shape of the stored secret
    const page = await fetchPage(token, id);
    return toResource(page); // translate the source's shape into a Resource
  }
  // list, search, create, update, delete — the same pattern
}
```

- `id` is lowercase, digits, dashes/underscores. It matches a connection's
  `connectorId`.
- `description` is for operators; keep it a plain description of the source.
- `capabilities` declares what the connector does. **Declare only what you
  implement** — the registry checks every declared capability has its method,
  and the manager refuses an operation you did not declare. A read-only source
  declares `['list', 'read', 'search']`.

## 2. Map the source to a Resource

A `Resource` is the common shape: `id`, `type`, `title`, `content`, `mimeType`,
`parentId`, `url`, `metadata`, `createdAt`, `updatedAt`.

- `type` is your own word for the kind — `"page"`, `"file"`, `"folder"`.
- Put whatever the shape does not name into `metadata`, so nothing is lost —
  Confluence labels, Drive revisions, Notion properties.
- Return `content: null` in `list` and `search` results; populate it in `read`.
- For editing, `create` takes a `ResourceDraft` (title required) and `update`
  takes a `ResourcePatch` (only the named fields change).

## 3. Respect the credential boundary

The credential arrives on `ctx.credential`, resolved from the vault for this
call. Use it to authenticate the outbound request and nothing else:

- Do not log it, store it, or return it in a `Resource` or its `metadata`.
- Do not fetch it yourself — the manager resolves it; you receive it.

This is what keeps the agent from ever seeing a key. A connector that leaks the
credential upward breaks the one property the connection layer exists to hold.

## 4. Register it

```ts
connectors.register(new ConfluenceConnector());
```

Register once, at startup. The manager then routes any connection whose
`connectorId` is `"confluence"` to it.

## 5. Before the pull request

- [ ] `capabilities` lists only what is implemented; the registry check passes
- [ ] Every operation maps the source's shape to a `Resource`, with extras in
      `metadata`
- [ ] Editing works if the source supports it — `create`/`update`/`delete`
- [ ] The credential is used only to authenticate; never logged, stored, or
      returned
- [ ] Tests against a mocked source (no live network), covering read and, if
      supported, an edit round-trip
- [ ] No business/product domain in the connector

## OAuth connectors

If the source authenticates with OAuth, you do **not** write the flow — the
connection layer does the mechanics and refreshes tokens transparently:

1. Declare the provider in `config/connectors.json`, keyed by the connector id
   (`config/connectors.example.json` shows Atlassian and Google Drive). Put the
   client secret's *environment variable name* in `clientSecretEnv`, never the
   secret.
2. A product wires two endpoints using the harness: one that redirects the user
   to `OAuthClient.buildAuthorizationUrl(...)`, and a callback that calls
   `exchangeCode(...)` and stores the token in the vault against a new
   connection. The product mints and checks the `state` (CSRF defence).
3. From then on, your connector just reads `ctx.credential` — it is an
   `OAuthToken`, always fresh. The manager refreshed it if needed before the
   call; you never handle refresh.

A connector for a source that uses a static API key needs none of this — the
key is stored in the vault and passed through untouched.

## Notes

- The reference implementation is `MemoryConnector` (`src/connections/
  memory-connector.ts`) — it implements the whole contract and is the shape to
  copy.
- The manager checks the connection is active and the capability is supported
  *before* resolving (and refreshing) the credential.
