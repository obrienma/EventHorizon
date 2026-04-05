# EventHorizon — Project Instructions

> **Authoritative context is in `CLAUDE.md` at the project root. Read that file before proceeding with any task.**
>
> In agent mode this file is auto-loaded — go read `CLAUDE.md` now.
> In chat mode, open `CLAUDE.md` manually or paste the relevant section.
>
> Do not maintain this file separately. `CLAUDE.md` is the single source of truth for both Claude Code and GitHub Copilot.

## Critical Behaviour Rule

**Answer questions directly and inline.** When the user asks a question — even a short one — respond with the answer in the chat. Do **not** invoke "Delegate to cloud agent", do not spin up a sub-agent, and do not use any external delegation tool just to answer a question. Delegation is only acceptable for long-running autonomous coding tasks explicitly requested by the user (e.g. "implement X", "refactor Y"), never for answering questions.
