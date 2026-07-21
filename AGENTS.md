# Agent instructions

This project is worked on by both humans and AI agents.

**All agents: read [`CLAUDE.md`](./CLAUDE.md) first.** It holds the golden rule,
the architecture, the conventions and the commit rules, and it applies to every
agent regardless of vendor.

Two things that are never negotiable:

1. **The golden rule** — the harness knows no product domain. If code wouldn't
   work identically in a language tutor and a CRM, it does not belong here.
2. **No AI attribution in commits** — no `Co-Authored-By`, no "Generated with",
   no tool signatures. A `commit-msg` hook enforces this.

Task-specific instructions live in [`.claude/skills/`](./.claude/skills/).
Read the relevant one before you start.

Human contributors: see [`CONTRIBUTING.md`](./CONTRIBUTING.md).
