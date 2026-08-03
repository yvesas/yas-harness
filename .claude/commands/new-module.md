---
description: Scaffold a business module for a product built on the harness, with its pool, tools and the eval it must not skip.
argument-hint: <module-id>
---

Create the module `$1` for **this product** — never inside `yas-harness` itself.

First read `.claude/skills/adding-a-module/SKILL.md` and follow it. In order:

1. Confirm we are in a product repo, not the harness. If `package.json` names
   `yas-harness`, stop and say why: the harness holds the contract, products
   hold modules.
2. Write the `ModuleDefinition` — `id`, a `description` written for the router
   to read (a description of the work, not a slogan), and its tools.
3. Give each tool a Zod input schema, and mark `requiresApproval` on anything
   destructive or outbound.
4. Store state through the pool, scoped by `{ tenantId, moduleId: '$1' }` —
   never reach into another module's pool.
5. Add `disclose` only if this module should answer others' context requests,
   and make it decide per request from `request.purpose`. Leaving it out means
   it shares nothing, which is the safe default.
6. Write the router eval cases — `.claude/skills/writing-evals/SKILL.md`. A new
   module changes how every other module routes, so include the pairs it could
   plausibly be confused with, not just the obvious inputs.

Finish by running the module's tests and the router eval, and report the
routing accuracy.
