# `src/pools/` — a module's own data, and the way across the boundary

Two things that only make sense together: every module gets a private space, and
the only way out of it is to ask.

- **`pool-store.ts` — the private space.** A namespaced key-value store scoped by
  tenant *and* module. There is no read that spans either boundary. The harness
  does not define what a module stores; it defines that the space exists and is
  isolated.
- **`context.ts` / `context-broker.ts` — the way across.** A module that needs
  something another module holds **asks**, and the owner answers.

## Why the owner answers

The inversion is the whole design. If the requester could read, every module
would have to trust every other module forever, and the decision would sit far
from the data. Because the owner answers, each module keeps deciding — per
request, with the purpose in front of it — what leaves its pool. It can reveal a
summary instead of the rows ("comfortable", not the balance), or refuse with a
reason the requester can pass on to the user.

## What the broker does, and refuses to do

`ContextBroker` is thin on purpose. It does not decide, cache, merge, or widen a
request — each of those would move a judgement into a place the owner cannot
see. What it makes unskippable is:

- **Only the owner answers.** The requester never touches the other pool.
- **Fail closed.** A module that declares no `disclose` shares nothing. Silence
  is not consent, so the absence of a discloser is itself a decision.
- **A purpose is required.** It is what the owner judges; a request nobody can
  decide on gets no.
- **Every exchange is recorded** as a `context_request` trace step — granted or
  refused, with who asked, for what, and which keys came back. This is the only
  point where data crosses a module boundary, so it is the crossing worth having
  an audit trail for. The *values* are not copied into the trace: they are the
  owner's data and stay in the owner's pool.
- **A wiring mistake throws.** An unknown module, an empty purpose, a module
  asking itself — those are bugs, and reporting them as refusals would have the
  caller shrug at something it should be fixing.

What the harness cannot do is authenticate the requester: it discloses to
whoever the caller says is asking. Products that let untrusted code register
modules must gate that, not this.
