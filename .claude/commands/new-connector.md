---
description: Scaffold a connector for an external source, with its capabilities, credential handling and deadline.
argument-hint: <service>
---

Create a connector for `$1`.

First read `.claude/skills/adding-a-connector/SKILL.md` and follow it. Then, in
order:

1. Find out how `$1` authenticates — OAuth or a static key. For OAuth you write
   **no** flow: declare the provider in `config/connectors.json` and read
   `ctx.credential`, which arrives fresh.
2. Map its shape onto `Resource`, putting whatever the shape does not name into
   `metadata` so nothing is lost.
3. Declare only the capabilities actually implemented — the registry checks
   each declared one has its method, and a read-only source declares
   `['list', 'read', 'search']`.
4. Pass `ctx.signal` to every `fetch`. A test reads the sources and fails
   without it.
5. Use the credential to authenticate and nothing else: never log it, store it,
   or return it in a `Resource` or its `metadata`.
6. Write tests against a stubbed source — no live network — covering a read and,
   if the source supports it, an edit round trip.

Use `MemoryConnector` (`src/connections/memory-connector.ts`) as the shape to
copy, and an existing connector of the same auth style as the closest example.
