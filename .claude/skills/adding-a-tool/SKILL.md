---
name: adding-a-tool
description: Use when adding a tool an agent can call — in the harness or in a product module. Covers the Zod input schema, when to mark requiresApproval, how errors reach the model, and the approval pause a gated tool triggers.
---

# Adding a tool

A tool is an action the agent can take beyond producing text. It declares its
input with a Zod schema; the registry derives the JSON Schema the model sees
from that, so what is advertised cannot drift from what is validated.

```ts
import { ToolRegistry, ok, failed } from 'yas-harness';
import { z } from 'zod';

tools.register({
  name: 'send_email',
  // Read by the model to decide when to call. Say when to use it, not just
  // what it does.
  description: 'Send an email to a recipient. Use when the user asks to email someone.',
  input: z.object({
    to: z.string().email(),
    subject: z.string().min(1),
    body: z.string().min(1),
  }),
  requiresApproval: true, // outward-facing — see below
  execute: async (input, ctx) => {
    // ctx carries tenantId and sessionId; scope any storage by them.
    const id = await mailer.send(input);
    return ok(`sent, message id ${id}`);
  },
});
```

## The name and description

- `name` is lowercase, digits and underscores. It is what the model calls.
- `description` is how the model decides to call it. Be prescriptive about
  *when*, not just what — a vague description makes the model over- or
  under-call.

## When to mark `requiresApproval`

Mark it when the action is hard to reverse or outward-facing: deleting data,
sending a message, moving money, calling an external API with side effects.
Reversible, read-only actions (reading a file, listing records) should not be
gated — gating everything trains operators to approve on autopilot.

A gated tool does **not** run when the model calls it. The agent records a
pending approval and returns `stopReason: 'awaiting_approval'`; the turn
continues only after `agent.resume(...)`, once the approval is decided. If no
approval store is wired, a gated tool fails closed — it refuses to run. See
[ADR 0004](../../docs/adr/0004-human-approval.md).

## Errors are results, not exceptions

Return `failed('...')` for an expected failure, or just throw — the registry
turns both, and invalid input, into an error result the model can see and
correct. Do not swallow the real error; the trace keeps it.

```ts
execute: async (input) => {
  if (!(await exists(input.path))) return failed(`no such file: ${input.path}`);
  return ok(await read(input.path));
};
```

## Before the pull request

- [ ] `input` is a Zod schema; the model cannot send a shape you did not allow
- [ ] `description` says when to call the tool
- [ ] `requiresApproval` set for anything destructive or outward-facing
- [ ] Errors returned as results (`failed`) or thrown, never swallowed
- [ ] Any storage the tool does is scoped by `ctx.tenantId` (and, in a module,
      the module's own id)
- [ ] A test covering the tool's success and its main failure

## Notes

- Register tools once, at startup.
- The model may call several tools in one turn; the agent runs them and returns
  all results together. A gated call pauses the whole turn — nothing in it runs
  until every gate is decided.
- For a whole module (a router-dispatched unit with its own tools and data),
  see `adding-a-module`.
