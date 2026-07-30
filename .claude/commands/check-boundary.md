---
description: Check the golden rule on the current diff — the mechanical part and the part a word list cannot catch.
---

Check that no product domain has leaked into the harness.

1. Run the mechanical checks and report anything they flag:

```bash
npm run boundaries && npm run isolation
```

2. Then do the part the script cannot. `scripts/check-boundaries.mjs` matches a
   **fixed word list** — `customer`, `invoice`, `expense`, `vocabulary`,
   `appointment`, `lead`, `campaign`. A domain concept that is not on that list
   passes it untouched, so read the diff yourself:

```bash
git diff origin/main...HEAD -- src/
```

For every name added under `src/` — types, fields, functions, table columns,
config keys — apply the golden rule from `CLAUDE.md`:

> Would this work **identically** in a language tutor and a CRM?

If it would not, it belongs to a module in a product, not here. Report each
suspect with the file, the name, and why it reads as domain rather than
infrastructure. `examples/` and `tests/` are exempt — the rule is about `src/`.

Say plainly when nothing is wrong; do not invent findings to have output.
