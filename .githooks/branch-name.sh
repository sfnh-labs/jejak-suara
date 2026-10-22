# Branch names are <area>/<slug>. Sourced by the hooks and scripts/worktree.sh.
AREAS="pipeline kurasi web img docs chore"
BRANCH_RE='^(pipeline|kurasi|web|img|docs|chore)/[a-z0-9]+(-[a-z0-9]+)*$'

check_branch() {
  if printf '%s\n' "$1" | grep -Eq "$BRANCH_RE"; then
    return 0
  fi
  echo "branch '$1' isn't <area>/<slug>: area is one of: $AREAS; slug is lowercase-with-dashes." >&2
  return 1
}
