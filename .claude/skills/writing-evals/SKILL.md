---
name: writing-evals
description: Use when testing agent behaviour that depends on a model — routing accuracy, or whether context compression degrades answers. Covers the case format, how the two runners measure, when an eval is mandatory rather than optional, and why cases assert exact values instead of phrasing.
---

# Writing evals

A unit test asserts what the code does. An eval measures what the **model** does,
which is not the same thing and cannot be asserted the same way: the answer
varies between runs, so an eval reports a *rate* and you decide what rate is
acceptable.

The harness ships two runners. Both are mechanism — the **cases are yours**.

> **The harness holds runners; products hold cases.** A case names a module
> ("finance") or an expected value ("$1,234.56"), which is product domain. Case
> sets live in the product, not in `yas-harness`.

## When an eval is mandatory

Two places, and neither is optional:

1. **Adding a module.** The router decides between modules with a *cheap* model.
   A cheap model is only worth trusting once its hit rate is measured, and a new
   module changes every other module's routing — it is one more thing the model
   can confuse yours with. The `adding-a-module` skill requires this.
2. **Turning on a compression profile.** A profile enters a product's data path
   only once an eval says answers do not degrade
   ([ADR 0010](../../docs/adr/0010-context-compression.md)).

Everywhere else, an eval is a judgement call. Reach for one when the thing you
want to check is a model's *decision*, not your code's behaviour.

## Router evals

A case is an input and the module it should reach:

```ts
import { evaluateRouter, routerCaseSetSchema, failures } from 'yas-harness';

const cases = routerCaseSetSchema.parse([
  { input: 'how much did I spend on lunch?', expected: 'finance' },
  { input: 'move my 3pm to Thursday', expected: 'calendar' },
  { input: 'what did we agree with Acme?', expected: 'crm', note: 'not finance — no amount' },
]);

const report = await evaluateRouter(router, cases);
console.log(`${report.correct}/${report.total} — ${(report.accuracy * 100).toFixed(0)}%`);
for (const outcome of failures(report)) {
  console.log(`  ${outcome.input}\n    wanted ${outcome.expected}, got ${outcome.actual}`);
}
```

- **A case that throws counts as wrong, not as a crash.** Finding those is what
  the set is for; one bad case must not end the run.
- **`note` is for the reader of a failure**, not the runner. Use it for the cases
  that are deliberately near the line — those are the ones worth arguing about
  when the rate drops.
- **Write the confusable pairs.** Cases the router obviously gets right measure
  nothing. The set earns its keep on inputs that could plausibly go two ways.

## Compression evals

The sensitivity gate proves a value was not *corrupted*. It cannot prove the
model still **used** it — only asking the model does that. So each case runs
twice, uncompressed and compressed:

```ts
import { evaluateCompression, compressionCaseSetSchema, regressions, passesGate } from 'yas-harness';

const cases = compressionCaseSetSchema.parse([
  {
    input: 'what was the order total?',
    toolResults: [{ content: noisyOrderLog }],
    expect: ['$1,234.56'],
  },
]);

const report = await evaluateCompression(gateway, compressorFor('aggressive'), cases);
if (!passesGate(report)) {
  for (const outcome of regressions(report)) {
    console.log(`${outcome.input} lost ${outcome.missing.join(', ')}`);
  }
}
console.log(`saved ${(report.savedRatio * 100).toFixed(0)}% of tokens`);
```

Three things about the numbers:

- **Only a regression blocks a release** — a case the baseline got right and the
  compressed run got wrong. Savings never buy one: a wrong answer costs more
  than the tokens it saved.
- **A case both runs fail is `inconclusive`, not a regression.** That is a broken
  case or a bad prompt, and charging it to compression would let a bad case set
  veto a good engine.
- **A compressed call that throws *is* a regression.** A request the provider
  rejects is a way compression breaks an answer.

## Write cases that assert facts, never phrasing

This is the rule that decides whether an eval is useful or noise.

```ts
expect: ['$1,234.56']                     // ✅ a fact a correct answer must carry
expect: ['The order total is $1,234.56']  // ❌ phrasing — the model varies
```

Models word things differently between runs. An assertion on wording turns that
variance into a regression that isn't one, the rate becomes noise, and the next
person learns to ignore it. Assert the id, the total, the date — the thing that
would be *wrong*, not the sentence around it.

## Running them

Evals cost real model calls, so they are **not** part of `npm test`. Run them
deliberately: against a scripted gateway while building the runner, and against
the real gateway when the number is supposed to mean something.

Keep the case set versioned in Git next to the module it covers, so a change in
routing accuracy is reviewable as a diff.

## Before the pull request

- [ ] Cases are versioned in the product, not in the harness
- [ ] The set includes the confusable pairs, not only the obvious ones
- [ ] `expect` values are exact facts, never phrasing
- [ ] A new module ships with routing cases that name it
- [ ] A compression profile change ships with a run showing zero regressions
