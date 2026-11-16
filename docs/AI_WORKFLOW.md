# AI workflow

How Claude Code was set up and used on this project. The dated record of what happened is [AI_LOG.md](AI_LOG.md); this file is the process behind it. Everything described here is in the repo under `.claude/` and `CLAUDE.md`.

## The loop

One milestone at a time, each from [PLAN.md](PLAN.md), each on its own branch and PR:

1. **Plan, in plan mode.** Claude reads the milestone, `docs/SPEC.md`, `docs/ARCHITECTURE.md` and the relevant `docs/reference/*.md`, asks questions, and writes a plan. Nothing is edited until I approve it. For the riskier milestones (M6 realtime engine, M9 network resilience) the plan ran on Opus or Fable.
2. **Build.** Sonnet 5.5 at medium or high effort builds against the plan, with tests next to the code. Anything that would call the live OpenAI API stops and asks me first (CLAUDE.md, budget rules).
3. **Check.** `pnpm check` (lint, Prettier, typecheck, unit tests with coverage gates), plus `pnpm test:e2e` when UI changed, plus screenshots at 390x844 through the Playwright MCP. A task is not done until these pass and Claude has looked at the screenshots.
4. **Review.** `/review-milestone` runs the read-only `reviewer` subagent on the branch. I read its findings and give the go before anything is edited.
5. **Fix.** Claude fixes the Blockers and Should-fix items, each with a test that fails when the fix is removed (checked by reverting the source file).
6. **Ship.** `/ship` verifies, asks me for one line on what I verified by hand, writes the AI log row, commits, pushes and opens the PR.
7. **By hand.** Voice, microphone permission, keyboard and network behavior are checked on a real phone (a Galaxy S24+ over USB port forwarding). A unit test cannot show these.

Model and effort were chosen per task, not per project: Opus or Fable for planning, resilience design and review (where a wrong first design is expensive); Sonnet for builds and for fixing a reviewer's list (where the plan is already fixed). The `model` column of the log shows the choice for each row.

## The files

### `CLAUDE.md`

The standing instructions, loaded every session. It holds what would otherwise be repeated in every prompt: the product, the stack, the budget rules (the OpenAI key has a hard $20 limit, so tests and CI never call the live API and live sessions need my approval), the architecture rules (secrets read in one file, thin route handlers, two state adapters, no middleware), the mobile UX rules, the code style, the definition of done and a short `Never` list. The brief itself stays out of public files; CLAUDE.md only points at it.

### `.claude/settings.json`

Sets the default model and a permission list. Allowed without asking: `pnpm *`, `npx playwright *`, read-only git, `git add`, `git commit`, plain `git push`, `gh issue *`, `gh pr *`, and the OpenAI Docs and Playwright MCP servers. Denied: reading `.env` files, `vercel env *` (it can print secrets), force pushes and `rm -rf *`. The point is that routine work does not prompt, and the two ways to leak the key or lose history cannot happen by accident.

### `.claude/agents/reviewer.md`

A subagent that cannot edit: its tools are `Read`, `Grep`, `Glob` and `Bash`, and its instructions forbid writing, committing and pushing. It runs on Opus at high effort, a different model from the Sonnet that wrote the code, so it does not share the builder's blind spots. It plays a skeptical staff engineer on the hiring panel and checks in a fixed order: spec coverage against `docs/SPEC.md`, security and cost, realtime correctness (races and cleanup), mobile UX at 390x844, whether tests assert behavior, and code quality. Output is a numbered list under Blockers, Should fix and Nice to have, each with `file:line`, the problem and the fix, ending in "Ship" or "Do not ship".

### `.claude/commands/review-milestone.md` (`/review-milestone`)

One instruction: run the reviewer on `git diff origin/main...HEAD`, show its Blockers and Should-fix items as a checklist with a proposed fix order, and **wait for my go before editing anything**. The wait is the point. It keeps me deciding which findings are real, and several were not (see AI_LOG, where items were left undone on purpose).

### `.claude/commands/ship.md` (`/ship`)

Six steps, in order, and it stops at the first failure:

1. Run `pnpm check`, and `pnpm test:e2e` if `src/app` or `src/features` changed. If anything fails, report and do not ship.
2. Show `git status` and a one-paragraph diff summary, then **ask me for one line on what I corrected or verified by hand** and wait.
3. Append a row to `docs/AI_LOG.md`: date, milestone, model and effort, what Claude did, my line. The last column is mine, not the model's.
4. Commit with a conventional message ending in `Closes #N` for the milestone issue.
5. Push and `gh pr create`, with the sections What changed, Why, How it was verified (commands and results), Manual test steps, AI notes.
6. Print the PR URL.

### MCP servers

- **OpenAI Docs MCP.** CLAUDE.md says Realtime API shapes come from `docs/reference/openai-realtime.md` or this server, never from memory. Two facts the reference marked UNVERIFIED (where `output_modalities` goes on `response.create`, and client-supplied item ids) were checked here before M6 was built.
- **Playwright MCP.** Claude drives the app at 390x844, takes screenshots and looks at them before reporting UI work done. It also made the README screenshots.

## The second reviewer

Besides the in-repo reviewer, one independent review ran outside Claude Code: Gemini 4 Argon in Antigravity, on its own branch, in parallel with a Claude review (P16). Argon reviewed and fixed on its branch, then Fable 5.2 reviewed Argon's PR before it merged. The report is [reviews/argon-review.md](reviews/argon-review.md); what each reviewer caught that the other did not is in the last AI_LOG row.

## What this setup did not do

- It did not remove the need to run the app. The worst bugs (the microphone retry that burned the rate limit, the keyboard crushing the transcript) were found on a phone, not by a reviewer or a test.
- It did not make "done" trustworthy on its own. Claims such as "the CI jobs ran" or "the fixtures exist" were wrong more than once until a guard test (`scripts/spec-proofs.test.ts`) or my own run checked them.
