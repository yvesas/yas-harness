# `config/workflows/` — several agents in order

One file per workflow, named `<id>.json`. Versioned in Git like the agents
beside them: a diff shows which workflow changed, and adding one does not touch
the others.

The router hands a turn to one agent and the turn ends. That is right for a
question and wrong for work. A workflow is an ordered list of steps; each names
an agent and carries a prompt.

```json
{
  "id": "weekly-summary",
  "name": "Weekly summary",
  "description": "Reads the week's work, drafts a summary, waits before posting.",
  "steps": [
    { "id": "gather", "agent": "research", "prompt": "Find everything in: {{input}}" },
    { "id": "draft", "agent": "research", "prompt": "Summarise:\n\n{{steps.gather}}" },
    { "id": "post", "agent": "publisher", "approve": true, "prompt": "Post:\n\n{{steps.draft}}" }
  ]
}
```

## What a prompt can quote

Two things, and no more: `{{input}}`, what the run was started with, and
`{{steps.<id>}}`, what an earlier step answered. Anything else is refused when
the file is read — including a step quoting one that runs *after* it, which is
the mistake that reads as though it would work.

There is no expression language, and there will not be one. The step's prompt is
where judgement goes, and the model is what exercises it.

## What crosses between steps

**Only what a prompt quotes.** Each step runs in its own conversation, so one
agent's tool results never land in another agent's context. That is deliberate:
agents ask each other for things explicitly, and a shared context would make a
workflow the way around that rule.

## Where a person stands

`"approve": true` stops the run *before* the step, and what waits in the
approval queue is the prompt as it would be sent — not the template. That is the
gate for "let me see the draft before you post it": the draft is already in the
run when the decision is asked.

It is a different gate from an agent's `approveWrites`, which holds the tool
call once the step is already running. Both can fire in one run, and the run
records which one it is waiting on.

## What is not here

No branches, no loops, no parallel steps, and no schedule. Something has to call
`start` — a cron, a webhook, a button in the console — and when that happens is
the product's business, not the harness's.

## Trying it

Copy `weekly-summary.json.example` to `weekly-summary.json` and edit it. It
names two agents, `research` and `publisher`; a workflow naming an agent nobody
registered refuses to start, and says which one is missing.
