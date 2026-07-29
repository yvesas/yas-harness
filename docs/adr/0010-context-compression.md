# ADR 0010 — Context compression: gated, measured, and off until proven

- **Status:** accepted
- **Date:** 2026-07-29

## Context

A subscription product pays for every token it sends, and most of what it sends
is not prose a human wrote. It is context: tool output, command logs, fetched
documents, JSON listings, the same lines repeated because a retry ran twice.
Shrinking that before it reaches a model is direct margin, not a micro-
optimisation — the volume is large and it grows with every turn.

It is also the kind of optimisation that fails quietly. A prompt that is 30%
smaller and answers a question wrong costs far more than the tokens it saved,
and nothing in the response says which of the two happened. Three specific ways
it goes wrong shaped this decision:

- **A mangled value looks like a worse model.** If a price, an id, a date or a
  URL comes out subtly different, the answer is wrong for a reason no log shows.
- **A saving that was never measured is a story.** Compression ratios quoted as
  a fixed percentage are a formula, not a measurement; the billed unit is tokens
  and only a tokenizer knows how many there are.
- **A smaller prompt can cost more.** Providers bill a cached prefix at a
  fraction of the input rate. Rewriting bytes inside that prefix loses the match
  and re-writes the entry at a premium — a net loss dressed as a saving.

The harness therefore had to answer not "how do we compress" but "how do we
compress without being able to hurt anyone silently".

## Decision

**Compression is a pipeline of composable engines behind a sensitivity gate, and
the gate is enforced by the pipeline, not by the engines.** A
`ContextCompressor` takes a `ModelRequest` and returns a smaller one plus a
report. Each engine is a configured instance — its config validated by Zod at
construction, so a malformed profile fails at startup rather than mid-
conversation — and runs in priority order. The pipeline checks every engine's
output against a `SensitivityGuard` that protects exact values: money, numbers,
dates, ids, UUIDs, URLs, emails, and anything inside code or a fenced block. An
engine whose output would break one has that output **discarded** and the last
safe request carried forward. Enforcing this once, in the pipeline, is the point:
an engine author cannot forget it, and a buggy engine cannot slip past it — the
worst a broken engine can do is be skipped. **The floor is "no change", never
"a wrong value".** Gate patterns are linear, with no backtracking, so the guard
cannot itself become a denial of service.

**Lossy engines are allowed, and the gate applies in the matching direction.**
The largest real saving is in tool output, and capturing it needs *dropping* —
truncation, dedup — not just rewriting. So an engine declares whether it is
`lossy`, and the guard runs one of two ways: a lossless engine must **keep**
every protected value; a lossy one may drop content but must not **introduce**
a protected value that was not in its input. A mangled `$1,234.56 → $1` fails
the second check as surely as the first, because `$1` is a value the input did
not contain. Either way a value can never come out *wrong* — at worst, for a
lossy engine, absent. The one lossy engine ships in the `aggressive` profile
only; `light` and `medium` stay lossless.

**Savings are measured in tokens, through a port.** Tokens are the billed unit
and no single tokenizer is exact for Claude, GPT, Gemini and Llama at once — each
keeps its own vocabulary, and some only expose a counting API. So counting is a
`TokenCounter` port: a product injects an exact per-provider counter when it
needs one, and the harness ships a provider-neutral default that runs real BPE
offline. The pipeline still decides *whether an engine shrank the request* on
characters, which is cheap and exact; tokens are what it **reports**. Measured,
never assumed.

**The cacheable prefix is never compressed — not even losslessly.** A request may
declare a `CachePrefix`: the `system` prompt, the `tools`, and the first N
messages the caller knows are stable across turns. The pipeline splits that
region off before any engine runs and splices it back byte for byte, and the
Anthropic adapter marks its end with a single cache breakpoint. Downgrading the
prefix to lossless engines does not work, because *lossless* means meaning-
preserving while a cache match needs **byte-identical** — even a whitespace trim
loses it. The economics are asymmetric enough to settle it: a cached read bills a
fraction of the input rate while re-writing the entry bills above it, so
squeezing an already-discounted prefix wins a few percent of a small number
against a churn that costs an order of magnitude more. Compression can also push
a prefix under the provider's minimum cacheable size, which fails **silently** as
"no cache" rather than as an error. Only the declared prefix is marked, never the
tail: the tail changes every turn, so marking it would pay the write premium for
an entry nothing can read.

**Redaction is not compression, and does not live here.** Scrubbing secrets also
destroys text, but everything else about it is opposite: it must always run, it
must never be discardable by a gate, and it protects a different path — what
gets persisted and logged, not what gets sent to a model. It is wired as an
unconditional decorator over the stores and the recorder. Putting it in this
pipeline would have made a security control optional.

**None of it is on by default, and the way to turn it on is an eval.** The
gateway accepts a compressor and, given one, compresses once before the fallback
chain, recording the saving alongside what the call cost. It takes none by
default. What promotes a profile into a product's data path is
`evaluateCompression`: every case runs twice, uncompressed and compressed, and
the only outcome that blocks a release is a case the baseline got right and the
compressed run got wrong. The sensitivity gate proves a value was not corrupted;
it cannot prove the model still *used* it, and only asking the model can.

## Consequences

**What this buys.** Compression can be turned on without a leap of faith: the
gate bounds the worst case to "no change", the eval bounds it to "no answer got
worse", and the recorded before/after says whether it was worth it. Engines are
independent and cheap to add, since none of them carries the safety argument.
Products dial aggressiveness with a profile name rather than a config tree, and
the prompt cache keeps working underneath.

**What it costs.** Every engine's output is rendered and checked, so a pass is
more work than the naive rewrite would be — deliberate, and small next to a model
call. A conservative gate means some safe compressions are refused: an engine
that legitimately reformats a number is indistinguishable from one that corrupts
it, and both are discarded. The recorded saving is the harness's own count over
rendered text, so it is an approximation for any provider whose tokenizer differs
and it excludes the provider's framing; with a cacheable prefix declared it is
two regions counted separately and can drift a token from counting the request
whole. Those numbers sit next to the provider's exact ones rather than mixed
into them, precisely so the difference stays visible.

**What is not solved here.** The eval needs cases, and cases are the product's —
the harness ships the runner, not the data, exactly as it does for the router.
Content-addressed dedup across a session is deferred: it removes repeated
occurrences of protected values, which a multiset gate rejects, and it needs a
reference-aware gate first. There is no semantic judgement of answer quality —
cases assert exact values a correct answer must carry, never phrasing, because
models vary between runs and asserting on wording would report that variance as
a regression. And nothing here compresses *history*: dropping or summarising old
turns is a memory-policy question, not a text-size one.

## Alternatives considered

**Trust engines to be safe, and skip the gate.** Simpler and faster: each engine
is individually reviewable. Rejected because the failure is silent and the
review is per-engine forever — one bad edge case in one engine ships a wrong
answer, and nothing downstream notices. A single enforcement point makes the
guarantee a property of the system rather than of everyone's diligence.

**A fixed compression ratio, as the reference implementation studied uses.**
Cheap to reason about and easy to report. Rejected: it is a formula, not a
measurement. Real savings vary by content by an order of magnitude, and a
reported number nobody measured is how "we saved 40%" survives being false.

**Compress the cacheable prefix with lossless engines only.** The obvious middle
ground, and the one this epic originally planned. Rejected on discovering it
does not work: lossless preserves meaning, caches match bytes. The reasoning is
in the decision above.

**Put secret redaction in the pipeline.** It is the same kind of transform, and
sharing the machinery would be less code. Rejected: the gate exists to discard
transforms, and a security control that a gate can discard is not a control. It
also guards a different path — persistence and logs, not the model call.

**Turn compression on by default with lossless profiles.** They cannot corrupt a
value, so the risk looks like zero. Rejected because "cannot corrupt" is not
"cannot degrade": a model can key on formatting the harness considers noise, and
the only way to know is to ask it. The eval is cheap; a silent quality
regression in production is not.
