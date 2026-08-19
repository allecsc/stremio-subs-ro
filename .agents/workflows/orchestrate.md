---
description: Execute an approved GitHub orchestration issue on allecsc/stremio-subs-ro and report evidence back.
---

# GitHub Orchestration Workflow (`/orchestrate <issue-number>`)

Execute a task authored and approved as a GitHub issue on `allecsc/stremio-subs-ro`.

## 1. Input Validation

Require the issue number:
- If no issue number was provided in the prompt, ask for the issue number or check for the target issue.
- Target repository: `allecsc/stremio-subs-ro`.

## 2. Fetch Authoritative Task Instructions

Retrieve the full issue description, title, labels, and all existing comments:

```bash
gh issue view <issue-number> --repo allecsc/stremio-subs-ro --comments
```

Treat the issue content and orchestrator instructions as the **authoritative** task definition.

## 3. Preparation & Context Loading

1. **Read Named Files/Docs/Specs/ADRs**:
   - Read all project instructions, ADRs, context docs, or source files explicitly referenced in the issue.
2. **Invoke Explicitly Requested Skills**:
   - If the issue explicitly names skills (e.g. `trace-code`, `tdd`, `code-review`, etc.), load and follow their respective `SKILL.md` before acting.
3. **Inspect Git State**:
   - Check `git status` and `git diff` before modifying anything.
   - Preserve all unrelated, untracked, or in-progress user work.
4. **Confirm Operating Invariants**:
   - Adhere strictly to the task's defined **MODE** (e.g., INVESTIGATION, PLAN, IMPLEMENTATION, TEST ONLY, BENCHMARK).
   - Identify frozen architectural decisions and explicit out-of-scope boundaries.

## 4. Execution Discipline

1. **Strict Scope Enforcement**:
   - Implement only the approved behavior.
   - Do NOT perform opportunistic refactors, cleanup, premature optimizations, or adjacent feature work unless correctness strictly requires it.
   - Do NOT independently start adjacent tickets, workflows, or redesigns.
2. **Delivery Authorization Check**:
   - Do NOT assume branch, commit, push, PR, or deployment authorization unless explicitly granted by the issue.
   - **If branch/commit/push/PR delivery IS explicitly authorized:**
     1. Create a focused task branch: `git checkout -b <branch-name>`
     2. Implement and validate the requested changes.
     3. Stage and commit only the intended files: `git commit -m "..."`
     4. Push the task branch: `git push -u origin <branch-name>`
     5. Open a Pull Request linking the issue:
        ```bash
        gh pr create --repo allecsc/stremio-subs-ro --title "..." --body "Closes #<issue-number>\n\n..."
        ```
     6. **DO NOT merge the PR.**

## 5. Verification & Testing

- Execute the focused validation required by the issue (e.g. `npm test`, specific test harness).
- Collect raw command outputs, timing, memory/resource metrics, and PASS/FAIL counts.
- Never substitute raw evidence with assertions like "all tests passed".

## 6. Report Evidence Back to GitHub Issue

When execution and verification are complete, post a structured, concise completion report as a comment to the GitHub issue:

```bash
gh issue comment <issue-number> --repo allecsc/stremio-subs-ro --body "..."
```

### Required Report Format:
1. **Summary of Actions & Status**: Clear statement of task completion and delivery mode.
2. **Exact Files Changed**: Clickable or listed relative file paths.
3. **Concise Diff Summary**: Key additions, deletions, or structural changes.
4. **Commands Executed**: Exact validation commands run.
5. **Raw Test Evidence**: Relevant snippets of raw terminal output, assertions, PASS/FAIL counts.
6. **State & Evidence Classification**:
   - `VERIFIED`: Directly proved by deterministic test output.
   - `INFERRED`: Derived from code logic or environment state.
   - `PRODUCTION-ONLY`: Applicable to deployed environments only.
   - `NOT TESTED`: Out of scope or untestable locally.
7. **PR Link**: Pull request URL (if branch/PR creation was authorized).
8. **Blockers / Limitations**: Any blockers or unresolved anomalies encountered.

## 7. Stop Condition

Once the verification evidence is posted back to the GitHub issue (and PR opened if authorized), **STOP** and await orchestrator review. Do not proceed to adjacent tasks or merge PRs.
