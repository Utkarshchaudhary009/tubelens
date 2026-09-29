#!/usr/bin/env bash
# t3-worktree-delete.sh <ID|path> — delete a t3code worktree for good.
#
# Worktrees live under ~/.t3/worktrees/tubelens/t3code-<ID>; backup branches
# live on origin as backup/t3code/<ID> (never t3code/<ID> directly). This
# helper removes the worktree AND its backup branch so the work cannot be
# restored via `git worktree add -b ... origin/backup/...`. Delete is final.
#
# remote-t3.yml only ever restores work.patch/state.json — never worktrees —
# so nothing here can be undone by re-running that workflow.
#
# Usage:
#   scripts/t3-worktree-delete.sh <ID>
#   scripts/t3-worktree-delete.sh /home/runner/.t3/worktrees/tubelens/t3code-<ID>
#   ALLOW_SELF_DELETE=1 scripts/t3-worktree-delete.sh <ID>   # delete the
#     worktree you are currently inside (otherwise refused)
#
# Never touches main. Every destructive step is best-effort (fail-open) with
# a clear echo; the script exits 0 unless usage/guard checks fail.
set -u

fail_open() {
  echo "t3-worktree-delete: $1 (continuing)"
}

die() {
  echo "t3-worktree-delete: ERROR: $1" >&2
  exit "${2:-1}"
}

[ "${1:-}" != "" ] || die "usage: $0 <ID|path>  (e.g. $0 f2f16e1c)" 2
INPUT="$1"

# Resolve target path: full/relative paths pass through, bare IDs expand.
case "$INPUT" in
  */t3code-*|/*|.*|~*)
    TARGET="${INPUT/#\~/$HOME}"
    ;;
  *)
    TARGET="$HOME/.t3/worktrees/tubelens/t3code-$INPUT"
    ;;
esac
# Normalise trailing slash, then canonicalise (resolves symlinks so the
# guards below cannot be dodged by a non-canonical spelling).
TARGET="${TARGET%/}"
canon() {
  if command -v realpath >/dev/null 2>&1; then
    realpath -m "$1" 2>/dev/null || printf '%s\n' "$1"
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
  else
    printf '%s\n' "$1"
  fi
}
TARGET="$(canon "$TARGET")"
BASE="$(basename "$TARGET")"
SHORT="${BASE#t3code-}"
[ -n "$SHORT" ] || die "could not derive ID from '$INPUT'" 2

# Guard: never delete main, by path or by branch-ish name.
if [ "$SHORT" = "main" ] || [ "$SHORT" = "master" ]; then
  die "refusing to delete main/master" 2
fi
# Guard: never delete the main worktree. The main worktree is the listed
# worktree whose .git is a directory (linked worktrees carry a .git *file*);
# both sides are canonicalised, so ordering assumptions and symlinks cannot
# dodge the guard.
MAIN_WT=""
while IFS= read -r WT; do
  if [ -d "$WT/.git" ]; then
    MAIN_WT="$(canon "$WT")"
    break
  fi
done < <(git worktree list --porcelain 2>/dev/null | sed -n 's/^worktree //p')
if [ -n "${MAIN_WT:-}" ] && [ "$TARGET" = "$MAIN_WT" ]; then
  die "refusing to delete the main worktree ($MAIN_WT)" 2
fi

# Guard: refuse to delete the worktree you are currently inside unless
# explicitly overridden. Keep simple: compare toplevel, then PWD prefix.
CURRENT_TOP="$(git rev-parse --show-toplevel 2>/dev/null || true)"
CURRENT_PWD="$(pwd -P 2>/dev/null || pwd)"
if [ -n "${CURRENT_TOP:-}" ] && [ "$CURRENT_TOP" = "$TARGET" ]; then
  if [ "${ALLOW_SELF_DELETE:-}" != "1" ]; then
    die "you are inside $TARGET; re-run with ALLOW_SELF_DELETE=1 to delete it" 2
  fi
  echo "t3-worktree-delete: ALLOW_SELF_DELETE=1 — deleting current worktree."
elif case "$CURRENT_PWD" in "$TARGET" | "$TARGET"/*) true;; *) false;; esac; then
  if [ "${ALLOW_SELF_DELETE:-}" != "1" ]; then
    die "you are inside $TARGET; re-run with ALLOW_SELF_DELETE=1 to delete it" 2
  fi
  echo "t3-worktree-delete: ALLOW_SELF_DELETE=1 — deleting current worktree."
fi

echo "t3-worktree-delete: removing worktree $TARGET (id $SHORT)"

if [ -e "$TARGET" ] || git worktree list --porcelain 2>/dev/null | grep -qx "worktree $TARGET"; then
  git worktree remove --force "$TARGET" 2>&1 \
    && echo "t3-worktree-delete: worktree removed." \
    || fail_open "git worktree remove --force failed"
else
  echo "t3-worktree-delete: no worktree at $TARGET; skipping remove."
fi

for BR in "t3code/$SHORT" "backup/t3code/$SHORT"; do
  if git show-ref --verify --quiet "refs/heads/$BR" 2>/dev/null; then
    git branch -D "$BR" 2>&1 \
      && echo "t3-worktree-delete: deleted local branch $BR." \
      || fail_open "could not delete local branch $BR"
  else
    echo "t3-worktree-delete: no local branch $BR; skipping."
  fi
done

git push origin --delete "t3code/$SHORT" 2>&1 \
  && echo "t3-worktree-delete: deleted origin t3code/$SHORT." \
  || fail_open "could not delete origin t3code/$SHORT (may not exist)"
git push origin --delete "backup/t3code/$SHORT" 2>&1 \
  && echo "t3-worktree-delete: deleted origin backup/t3code/$SHORT." \
  || fail_open "could not delete origin backup/t3code/$SHORT (may not exist)"

git worktree prune 2>&1 || fail_open "git worktree prune failed"
git fetch -p origin 2>&1 || fail_open "git fetch -p failed"

echo "t3-worktree-delete: done. Delete is final — worktrees/backup branches are never auto-restored."
