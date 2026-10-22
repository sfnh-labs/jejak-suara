#!/usr/bin/env bash
# One branch, one worktree, under .claude/worktrees/. See CLAUDE.md.
#
#   scripts/worktree.sh new kurasi/quote-speaker [--web]   branch off origin/main
#   scripts/worktree.sh finish kurasi/quote-speaker        after its PR is merged
#
# A new worktree links the main checkout's local-only files (.env, jejak.db,
# .venv, Claude's local settings) so the pipeline and /kurasi work on the one
# database, and gets its own web/.env.local pointing JEJAK_DB at it.
set -euo pipefail

# Git Bash's ln -s copies unless told otherwise, and a copied jejak.db forks
# the database. Make it a real symlink or fail (needs Developer Mode).
case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) export MSYS=winsymlinks:nativestrict ;; esac

ROOT=$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")
. "$(dirname "$0")/../.githooks/branch-name.sh"

usage() { sed -n '4,5s/^# *//p' "$0" >&2; exit 2; }
[ $# -ge 2 ] || usage
cmd=$1 branch=$2
check_branch "$branch" || exit 2
dir="$ROOT/.claude/worktrees/${branch//\//-}"

case "$cmd" in
  new)
    git -C "$ROOT" fetch -q origin main
    git -C "$ROOT" worktree add -q -b "$branch" "$dir" origin/main
    git -C "$dir" branch -q --unset-upstream 2>/dev/null || true
    for f in .env jejak.db .venv .claude/settings.local.json; do
      [ -e "$ROOT/$f" ] && ln -s "$ROOT/$f" "$dir/$f"
    done
    if [ -f "$ROOT/web/.env.local" ]; then
      sed "s|^JEJAK_DB=.*|JEJAK_DB=$ROOT/jejak.db|" "$ROOT/web/.env.local" > "$dir/web/.env.local"
    fi
    if [ "${3:-}" = --web ]; then
      (cd "$dir/web" && npm ci --prefer-offline --no-audit --no-fund)
    fi
    echo "$dir"
    echo "  on $branch, from origin/main."
    [ "${3:-}" = --web ] || echo "  web deps not installed; run npm ci in web/ (or pass --web) before tsc or next dev."
    ;;
  finish)
    git -C "$ROOT" fetch -q origin main
    if ! git -C "$ROOT" merge-base --is-ancestor "$branch" origin/main; then
      echo "$branch isn't merged into origin/main yet; merge its PR first." >&2
      exit 1
    fi
    [ -d "$dir" ] && git -C "$ROOT" worktree remove "$dir"
    git -C "$ROOT" branch -q -D "$branch"
    # The scheduled publish runs from the main checkout: bring it up to date.
    if [ "$(git -C "$ROOT" symbolic-ref --short -q HEAD)" = main ]; then
      git -C "$ROOT" merge -q --ff-only origin/main
    fi
    echo "finished $branch; main checkout at $(git -C "$ROOT" log --oneline -1)"
    ;;
  *) usage ;;
esac
