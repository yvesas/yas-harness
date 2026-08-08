# `src/workflows/`

**Boundary: several agents in order, and the places a person stands.**

The router hands a turn to one agent and the turn ends. That is right for a
question and wrong for work. A workflow is an ordered list of steps, each
naming an agent and carrying a prompt that may quote what an earlier step
answered.

What is here:

| File | Responsibility |
| --- | --- |
| `workflow-config.ts` | The shape of a declared workflow, and its validator |
| `load-workflows.ts` | Reading `config/workflows/*.json` |
| `template.ts` | `{{input}}` and `{{steps.<id>}}`, and nothing else |
| `workflow-run-store.ts` | Port: what a run has done, durably |
| `postgres-workflow-run-store.ts` | Adapter for that port |
| `workflow-runner.ts` | Walking the steps, and stopping for people |

What is **not** here, deliberately:

- **Branches, loops and parallel steps.** Sequential work with a gate is what
  the product needs first. A DAG that only ever runs in a line would be a
  larger thing to maintain and a smaller thing to trust.
- **A shared context between steps.** Each step runs in its own session. What
  crosses is only what a prompt quotes — visible in the config, reviewable in a
  diff. Merging the sessions would make a workflow the back door around agents
  asking each other for things.
- **A scheduler.** Something has to call `start`; the harness does not decide
  when. A cron, a webhook and a button are all products' business.
- **Any domain.** Ids, prose and a list of steps name nothing. The domain is
  what somebody writes into the prompts.
