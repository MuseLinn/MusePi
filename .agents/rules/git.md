# Commits, Branches and Worktrees

Load when a change reaches a checkpoint, before handing work to another session, and before creating or removing a branch or worktree.

## Commits are the checkpoint

A request to change the repository authorizes local commits for that change; do not ask whether to commit. Commit when the scoped change is complete and its focused checks pass, before a long investigation, a handoff, or a switch to another task. Several small logical commits beat one drop at the end.

- Stage only the paths this change owns, by name. Another session's uncommitted files stay untouched and are reported; never `git add -A` over a tree someone else is editing.
- Leave work uncommitted only when the user says not to, when it is a throwaway spike, or when the change is not yet coherent. Report exactly what remains uncommitted and why.
- One logical change per commit. Subject: Conventional Commits, at most 72 characters; body says what and why, not process narration. Do not amend, rebase, or rewrite history already on the shared branch without an explicit instruction.
- Push, open a PR, merge, publish, and discard stay explicit. A commit is not permission to push, and green checks grant neither. After a push, CI is asynchronous confirmation — see `.agents/rules/testing.md`.
- Work in a repository you don't own starts at its tracker: search issues and pull requests for the symptom before implementing or opening a PR; an existing patch is reviewed or improved, never duplicated.
- Subagents commit inside the worktree they own and report the commit; the parent integrates and commits the merged result. A subagent must not commit in a checkout it does not own.

## Branches and worktrees

- Default: work in the current checkout on its current branch. Create a branch or worktree only when the user asks, when parallel missions need isolation, or when a long task must not disturb the shared checkout. One mission per worktree, branch named `feat/<mission>`, worktree under the location the mission's tooling uses.
- Never `git stash`: every worktree shares one stash list, so a pop can apply another session's work. Never overlay a tree with `git checkout <ref> -- .` or `git restore --source <ref> .`; both overwrite local edits without moving HEAD.
- Bring the main checkout current with `git fetch` and `git merge --ff-only`; stop and report when it has diverged or local edits would be overwritten. Never reset, clean, or switch another session's checkout.
- A handoff or cleanup requires the worktree's scoped work to be committed and its tree clean, including untracked files. Before removing it, confirm its content is in the target branch by comparing files/blobs — ancestry alone is not evidence when the history is squashed — and confirm no other session owns it. Never delete a branch or worktree another session owns; report it instead.
- After the work is merged, remove its worktree. Keep the audit record the mission tooling owns (for example `.tower/comms/`).

These are the session's own git commands. Product code that spawns git or jj keeps using the central utilities named in `.agents/rules/code-quality.md`.

Closed execution plans and specs under `docs/superpowers/` are historical records. Where one disagrees with this rule, this rule wins.