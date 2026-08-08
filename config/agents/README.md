# `config/agents/` — agents you declare instead of write

One file per agent, named `<id>.json`. Versioned in Git like the rest of
`config/`, so a diff shows which agent changed and adding one does not touch the
others.

An agent needs no code because the harness already has the tools: the connector
contract reduced every source to six resource-shaped operations, and an agent's
toolset is those operations over the sources it was granted. Grant `read` on
GitHub and it gets `github_read`; grant nothing else and no other tool exists
for it to call.

```json
{
  "id": "research",
  "name": "Research",
  "description": "Reads the team wiki and answers questions from it. Does not write.",
  "instructions": "Answer only from what you read. Say so when you did not find it.",
  "task": "reasoning",
  "connections": [{ "connectorId": "github", "can": ["list", "read", "search"] }]
}
```

Three things are worth knowing.

**`description` is all the router reads** when deciding which agent answers. One
that does not distinguish this agent from its neighbours is the commonest cause
of a wrong route — say what it does *and* what it does not.

**Reading is the default.** A grant with no `can` gets `list`, `read` and
`search`. Granting a source should not silently grant the ability to change it.

**Writes pause for a person** unless `approveWrites` is `false`. An agent
assembled from a form by somebody who never opened this file should not be able
to delete things unattended.

The console's Agents page writes these files. Editing them by hand keeps
working — it is the same file either way.
