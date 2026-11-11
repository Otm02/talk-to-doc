# AI log

How AI tools were used on this project, one row per milestone or notable session. The last column is written by me, not by the model.

| date | milestone | model + effort | what Claude did | what I corrected or verified |
|---|---|---|---|---|
| 2026-11-09 | M0 planning | Opus 5.5, high | Read the brief, CLAUDE.md and docs/reference; listed the top 5 review risks; wrote SPEC, ARCHITECTURE and PLAN; checked docs for brief quotes and parsed the Mermaid blocks; created 13 milestone issues | Set the locked decisions; approved the risk list and plan; chose to add SPEND_LIMIT_USD and Vercel previews from M1; read SPEC, ARCHITECTURE and PLAN before push |
| 2026-11-09 | M1 foundations | Sonnet 5.5, medium | Planned with questions, then built tooling, env, errors, state adapters with a shared contract suite, CSP headers, shell, health route, CI | Chose the env list over the docs; refused memory state on Vercel; shadcn init added an unknown `cn` package, replaced with clsx + tailwind-merge; `pnpm format` touched CLAUDE.md, reverted |
| 2026-11-11 | M1 foundations | Sonnet 5.5, low | Ran pnpm check and pnpm test:e2e (32 unit, 6 e2e passing), summarized the diff, committed, pushed and opened the M1 PR | Verified 390x844 app shell screenshot, lazy env validation on build, and /api/health returning ok with upstash state |
