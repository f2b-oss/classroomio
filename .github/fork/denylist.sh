#!/usr/bin/env bash
# Usage: denylist.sh <base-ref> <head-ref>
#
# Scans, case-insensitively, against the extended regexes in $DENYLIST (one per
# line; blank lines and lines starting with # are ignored):
#   - lines added in `git diff <base>...<head>`
#   - commit messages in <base>..<head>
#   - $EXTRA_TEXT (branch name, pull request title and body)
#
# Reports the term's line number in the list and where it matched. Never prints
# the term or the matching text: the list is private and this log is public.
set -euo pipefail

base="$1"
head="$2"

if [[ -z "${DENYLIST:-}" ]]; then
  echo "::error::The denylist secret is not available to this run, so the check cannot pass."
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

git diff --unified=0 --no-color --no-ext-diff "$base...$head" |
  awk '
    /^\+\+\+ / { file = substr($0, 7); next }
    /^@@/ { split($3, a, ","); line = substr(a[1], 2) + 0; next }
    /^\+/ { print file ":" line ":" substr($0, 2); line++ }
  ' >"$work/diff"

for sha in $(git rev-list "$base..$head"); do
  git log -1 --format=%B "$sha" | awk -v c="${sha:0:12}" '{ print "commit " c ":" NR ":" $0 }'
done >"$work/commits"

printf '%s\n' "${EXTRA_TEXT:-}" | awk '{ print "pull request text:" NR ":" $0 }' >"$work/extra"

found=0
n=0
while IFS= read -r term || [[ -n "$term" ]]; do
  n=$((n + 1))
  [[ -z "${term// }" || "$term" == \#* ]] && continue
  for src in diff commits extra; do
    while IFS= read -r where; do
      echo "::error::Denylist term #$n matched in $where"
      found=1
    done < <(grep -E -i -e "$term" "$work/$src" | cut -d: -f1,2 | sort -u || true)
  done
done <<<"$DENYLIST"

if [[ "$found" -ne 0 ]]; then
  echo "Remove the matches above. The list is private; ask a maintainer which term a number refers to."
  exit 1
fi
echo "No denylist matches in $(wc -l <"$work/diff") added lines, $(git rev-list --count "$base..$head") commits and the pull request text."
