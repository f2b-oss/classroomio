#!/usr/bin/env bash
# Weekly upstream sync. Run by .github/workflows/fork-sync.yml.
#
# 1. Fast-forward `upstream` to upstream main.
# 2. Rebase `f2b` onto it on `sync/<sha>`, with rerere replaying recorded
#    resolutions. Conflicts that are upstream edits to workflows this fork deleted
#    are resolved by keeping them deleted.
# 3. Write the outcome to $GITHUB_OUTPUT for the workflow to act on:
#    result=up-to-date | exists | clean | conflict
set -euo pipefail

upstream_url="${UPSTREAM_URL:-https://github.com/classroomio/classroomio.git}"
out="${GITHUB_OUTPUT:-/dev/stdout}"

: "${RUNNER_TEMP:=$(mktemp -d)}"
git fetch --quiet origin f2b upstream
git fetch --quiet "$upstream_url" main
new="$(git rev-parse FETCH_HEAD)"
short="${new:0:12}"
echo "upstream_sha=$new" >>"$out"

if ! git merge-base --is-ancestor origin/upstream "$new"; then
  echo "::error::Upstream main is not a fast-forward of the upstream branch (history was rewritten upstream). Resolve by hand."
  exit 1
fi
git push --quiet origin "$new:refs/heads/upstream"

base="$(git merge-base origin/f2b "$new")"
echo "old_base=$base" >>"$out"
if [[ "$base" == "$new" ]]; then
  echo "result=up-to-date" >>"$out"
  exit 0
fi

branch="sync/$short"
echo "branch=$branch" >>"$out"
if git ls-remote --exit-code --heads origin "$branch" >/dev/null; then
  echo "result=exists" >>"$out"
  exit 0
fi

git config rerere.enabled true
git config rerere.autoupdate true
git switch --quiet -c "$branch" origin/f2b

deleted_here="$(git diff --name-only --diff-filter=D "$base" origin/f2b -- .github/workflows)"

conflicts=""
if ! git rebase --quiet --onto "$new" "$base" >"$RUNNER_TEMP/rebase.log" 2>&1; then
  for _ in $(seq 1 500); do
    [[ -d .git/rebase-merge || -d .git/rebase-apply ]] || break
    unresolved=()
    conflicted="$(git diff --name-only --diff-filter=U)"
    while IFS= read -r path; do
      [[ -z "$path" ]] && continue
      if grep -qxF "$path" <<<"$deleted_here"; then
        git rm --quiet -- "$path"
      else
        unresolved+=("$path")
      fi
    done <<<"$conflicted"

    if [[ ${#unresolved[@]} -gt 0 ]]; then
      commit="$(git log -1 --format='%h %s' REBASE_HEAD)"
      conflicts="$(printf -- '- `%s` in %s\n' "$commit" "$(printf '`%s` ' "${unresolved[@]}")")"
      git rebase --abort
      break
    fi
    GIT_EDITOR=true git rebase --continue >>"$RUNNER_TEMP/rebase.log" 2>&1 || true
  done
fi

if [[ -n "$conflicts" ]]; then
  {
    echo "result=conflict"
    echo "conflicts<<EOF_CONFLICTS"
    echo "$conflicts"
    echo "EOF_CONFLICTS"
  } >>"$out"
  exit 0
fi

git push --quiet origin "HEAD:refs/heads/$branch"
{
  echo "result=clean"
  echo "head=$(git rev-parse HEAD)"
  echo "patches=$(git rev-list --count "$new..HEAD")"
} >>"$out"
