# `src/memory/` — shared knowledge

## Boundary

**This is not a pool.** A pool (`src/pools/`) is one agent's own state: private
by decision, and shared only when its owner answers a request. This is
*knowledge* — documents somebody added, and what the connectors brought — read
by whichever agents were granted the source it lives in.

Two questions, two permission models, kept apart on purpose. Doc 13's decision 2
rejected "everybody sees everything" for pools, and it still holds. Adding a
shared knowledge layer does not reopen it: an agent still cannot read another
agent's *state*, and now it can read *documents* it was granted.

A **source** is the unit of permission. An agent is granted a source, never a
document — a grant enumerating documents would be out of date the moment
anything was ingested.

## The dimension is part of the schema

`memory_chunks` declares `vector(1536)`. That could not be configuration: the
column type is fixed when the table is created, and a mismatch discovered at
query time is a corpus half-embedded with two incompatible models. A deployment
whose model differs changes migration 0012 in its fork and re-embeds.

The harness checks what an adapter returned **before** it reaches the database,
because the database's complaint would be about a column and the thing that has
to change is the model.

## Why embeddings are not the model gateway

The same vendors sell both, and the ports are still separate. A completion is a
conversation with a cost per turn and a fallback chain; an embedding is a pure
function of a string that has to stay stable for the life of a corpus. Routing
an embedding to a fallback provider would silently make yesterday's vectors
uncomparable with today's — the one failure this separation prevents.

## Things worth knowing

- **A search has a distance ceiling.** A vector search always returns its
  nearest neighbours, however far away, so without one a question about nothing
  in the corpus comes back with the least irrelevant passage and a model treats
  it as an answer.
- **An unchanged document is not re-embedded.** The checksum decides, and
  embedding is the expensive part.
- **Chunks are replaced with their document in one transaction.** A failure half
  way would otherwise leave a document that exists and cannot be found.
- **Chunking follows the author's structure** — paragraphs, then sentences, then
  a hard cut — because a boundary somebody chose beats one arithmetic chose.
- **An empty grant searches nothing**, and does not mean everything.
