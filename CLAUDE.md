# Jejak Suara

## Git workflow

`main` is what ships. The main checkout (the repo folder itself) stays on
`main` with no edits in it: the scheduled publish (launchd, 05:00 / 11:00 /
18:00) runs `scripts/publish_local.sh` from there, and the `next dev` on :3000
serves it. Don't switch its branch or work in it.

Every change goes on a short-lived branch in its own worktree:

1. `scripts/worktree.sh new <area>/<slug>` (add `--web` to install web deps).
   It branches from `origin/main` into `.claude/worktrees/<area>-<slug>/` and
   links `.env`, `jejak.db` and `.venv` from the main checkout, so the pipeline
   and /kurasi work on the one database.
2. Claude sessions: enter it with EnterWorktree (`path:
   .claude/worktrees/<area>-<slug>`) and work only there. One session per
   worktree; two sessions never share one.
3. Commit there. Before opening a PR run what CI runs: `pytest -q`, and for
   web changes `cd web && npx tsc --noEmit && npm run lint`.
4. `gh pr create --fill`, wait for `gh pr checks --watch`, then
   `gh pr merge --merge` (GitHub deletes the remote branch).
5. `scripts/worktree.sh finish <area>/<slug>` removes the worktree and the
   local branch and fast-forwards the main checkout, so the next scheduled run
   uses the merged code.

Areas:

| Area | For |
|---|---|
| `pipeline/` | `jejak/`, the scheduler, Neon sync, tests |
| `kurasi/` | the /kurasi curation tools |
| `web/` | the public site |
| `img/` | ukiyo-e generation scripts and the images themselves |
| `docs/` | docs and skills only |
| `chore/` | tooling, CI, dependencies |

The slug is lowercase-with-dashes and says what changes
(`kurasi/quote-speaker`, not `kurasi/fixes`). Branches merge within days; one
that has lived a week gets merged or split, not kept as a standing area branch.

The hooks in `.githooks/` enforce this: no commits on `main`, no direct pushes
to `main`, and branch names that fit `<area>/<slug>`. Each clone turns them on
once with `git config core.hooksPath .githooks`. `--no-verify` is for a
deliberate one-off, not a habit.
