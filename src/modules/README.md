Module registry and the ModuleDefinition contract.

Contains the contract only. Business modules live in the products that fork this repo, never here.

## A module is a semi-autonomous agent

Doc 13, decision 3, on what holds from the start even under centralised
orchestration:

> *Módulos como agentes semi-autônomos — cada um sabe fazer seu trabalho; o
> central **delega, não microgerencia**.*

It did not, for a while. The router picked a module, the decision went into the
trace, and the turn then ran with **every** module's tools flattened together —
so a note-taking module could send an email because some other module could.

Now `Agent.run` takes the `moduleId` the router returned, and the turn runs
**as** that module:

| | Comes from |
| --- | --- |
| Tools | the module's own `ToolRegistry`, and only those |
| Instructions | the persona's, **plus** the module's, appended |
| Task kind | the module's, or the persona's |
| Tool iterations | the module's, or the persona's |

Three rules hold this together.

**Instructions are appended, never substituted.** A product's voice, its
language and its safety rules have to survive whichever module answers. A module
that could replace the whole system prompt could quietly undo them.

**A module that declares no `agent` block behaves exactly as before.** So does a
turn with no `moduleId`, and so does an agent built without a `ModuleRegistry`.
Delegation is additive; nothing that worked stopped working.

**An unknown module fails the turn.** Absorbing it and running with everything
would produce a plausible answer from the wrong thing, which is the failure
nobody notices. The router already validates its choice against the registry, so
reaching that error means a turn was built by hand.
