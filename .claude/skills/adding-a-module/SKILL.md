---
name: adding-a-module
description: Use when adding a business module to a product built on yas-harness — a unit the router can dispatch to, with its own tools and its own data pool. Covers the ModuleDefinition contract, the golden-rule boundary, pools, and the router eval a module must not skip.
---

# Adding a module

A module is how a product plugs a capability into the harness: the router
dispatches to it, it exposes tools, and it owns a private data pool.

> **This lives in the product, not in the harness.** Modules are the one place
> business domain belongs. If you are editing `yas-harness` itself and reach
> for a module, stop — the harness holds the *contract* (`src/modules/`), never
> a module.

## 1. Define it

```ts
import { ModuleRegistry, ToolRegistry } from 'yas-harness';

const tools = new ToolRegistry().register({
  name: 'record_expense',
  description: 'Record a spend against a category.',
  input: z.object({ amount: z.number().positive(), category: z.string() }),
  execute: async (input, ctx) => { /* ... */ },
});

modules.register({
  id: 'finance',
  // The router shows this to a cheap model to decide whether an input belongs
  // here. Write what the module *handles*, in plain language.
  description: 'Personal finances: spending, budgets, account balances.',
  tools,
});
```

- `id` is lowercase, digits, dashes/underscores. It appears in routing
  decisions and traces.
- `description` is routed on. A vague one costs you accuracy in the eval below;
  make it a description of the work, not a slogan.

## 2. Keep the boundary

The harness knows how to route, execute, store and record. It does not know
what an expense *is* — that is the module's job, and the module's alone.

- A module never reads another module's pool. To use another module's context,
  ask it (the cross-module permission flow), never query its rows.
- Business rules ("an expense over R$500 needs approval") live in the module's
  tools, not in the harness.

## 3. Store data in the pool, scoped

Every module gets a private key-value space, isolated by tenant *and* module:

```ts
const scope = { tenantId: ctx.tenantId, moduleId: 'finance' };
await pools.set(scope, `expense:${id}`, { amount, category, at: iso });
const entries = await pools.list(scope, 'expense:'); // this module's, this tenant's
```

The isolation is structural — the primary key is `(tenant_id, module_id, key)`
— so you cannot accidentally read across either boundary. Always pass the
module's own id in the scope; never another module's.

## 4. Write the eval — do not skip it

The router runs on a cheap model, and a cheap router is only worth trusting
once its hit rate is measured. Ship a versioned case set and run it:

```ts
import { evaluateRouter, failures } from 'yas-harness';

const cases = [
  { input: 'how much did I spend on food?', expected: 'finance' },
  { input: 'move my dentist appointment', expected: 'calendar' },
  // one or two per module boundary you care about, plus the ambiguous ones
];

const report = await evaluateRouter(router, cases);
if (report.accuracy < THRESHOLD) {
  console.error(failures(report)); // which inputs went where
  throw new Error(`router accuracy ${report.accuracy} below ${THRESHOLD}`);
}
```

Add cases whenever two modules could plausibly claim the same input — that is
where a cheap router fails, and where a good `description` earns its keep.

## 5. Before the pull request

- [ ] `id` and `description` set; description reads like the work it handles
- [ ] Tools declared with Zod schemas; destructive ones marked `requiresApproval`
- [ ] Pool access scoped to this module's own id, never another's
- [ ] A router eval covering this module's boundaries, wired into the test suite
- [ ] No harness file touched to make the module work (golden rule)

## Notes

- Register modules once, at startup, not per request.
- The router short-circuits when only one module is registered — no model call,
  confidence 1. The eval still matters the moment a second module joins.
- For tools, see `adding-a-tool`; for schema changes, `database-migrations`.
