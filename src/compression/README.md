# `src/compression/` — context compression (E5)

Compresses a `ModelRequest`'s context before it reaches a model, so a
subscription product sends fewer tokens without sending a worse prompt. It is a
**pipeline of composable engines** behind a **sensitivity gate**.

## Boundary

- **Mechanism, not policy on the hot path.** This is a `ContextCompressor` port
  (`compress(request) → {request, report}`). The report now carries each engine's
  **real token saving**, measured through a `TokenCounter` (E5.4), not a character
  proxy. It is still **not** wired into the model gateway — compression goes into
  the data path only once an eval confirms answers don't degrade (E5.5).
- **Safe by construction.** Every engine's output is checked by the
  `SensitivityGuard`: an exact value — a price, a date, an id, a URL, an email,
  anything in code or a fenced block — that comes out **wrong** causes the
  engine's output to be **discarded**. A *lossless* engine may not drop a value
  at all; a *lossy* one (truncation, dedup) may drop content but still may not
  invent or mangle one. Either way the floor is never "a wrong value".
- **Provider-neutral, no product domain.** Works on the ADR-002 `ModelRequest`
  shape; nothing here names a provider or a product concept.

## Pieces

- `context-compressor.ts` — the port and the `CompressionEngine` contract.
- `sensitivity-gate.ts` — what must stay byte-perfect (linear patterns, no ReDoS).
- `compression-pipeline.ts` — runs a profile's engines in priority order, each
  under the gate, and reports per-engine savings in both characters (the cheap
  signal it decides "did it shrink?" on) and **tokens** (measured through a
  `TokenCounter` — the billed cost). The counter is injectable; the default is
  `GptTokenizerCounter` (real BPE, `src/models/`).
- `engines/` — concrete engines. Lossless: `whitespace` (trailing-space and
  blank-line trim only — never touches whitespace inside a line) and `json-table`
  (a homogeneous JSON array of objects → a compact `{columns, rows}` table,
  dropping repeated keys while keeping every value). Lossy: `tool-result` (strips
  ANSI, collapses repeated consecutive lines, and truncates a long result to its
  head and tail while keeping error lines — an `isError` result is never
  truncated). It acts only on tool-result parts.
- `profiles.ts` — named engine subsets. `light`/`medium` are lossless only;
  `aggressive` adds the lossy `tool-result` engine. `none` is the off-by-default
  identity.

See `docs/decisions.md`; the strategy ADR is E5.8, a later slice.
