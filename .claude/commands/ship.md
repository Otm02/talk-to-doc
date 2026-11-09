---
description: Verify, log, commit, push and open a PR for the current milestone
---
1. Run pnpm check, plus pnpm test:e2e if anything under src/app or src/features changed. If anything fails, stop and report. Do not ship.
2. Show me git status and a one-paragraph summary of the diff. Ask me for one line on what I corrected or verified by hand. Wait for my answer.
3. Append to docs/AI_LOG.md: YYYY-MM-DD | <milestone> | <model + effort> | what Claude did | <my line>.
4. Commit with a conventional message (feat|fix|test|docs|chore(scope): summary) ending with "Closes #N" for the milestone issue.
5. Push the branch and run gh pr create. PR body sections: What changed, Why, How it was verified (commands and results), Manual test steps, AI notes.
6. Print the PR URL.
