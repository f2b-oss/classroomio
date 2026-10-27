# About this fork

This repository is a **modified version** of
[ClassroomIO](https://github.com/classroomio/classroomio), distributed under the
same licence, the GNU Affero General Public License v3.0 (see `LICENSE`). The
original copyright notices are unchanged. Every change made here is listed below
with the date it was made, and is offered back upstream where it is useful to
other users.

## Branches

| Branch     | What it is |
| ---------- | ---------- |
| `upstream` | An exact mirror of upstream `main`. Never edited by hand. |
| `f2b`      | The default branch: `upstream` plus the patches listed below, one self-contained commit per change, rebased (never merged) onto `upstream`. |
| `sync/<sha>` | Proposed rebase of `f2b` onto upstream commit `<sha>`, opened by the weekly sync. |

Release tags are `<upstream-short-sha>-f2b.<n>`: the upstream commit the release is
based on, and a counter for releases on that base.

## Patches

Changes to application code, newest last. Each entry has the date the patch landed
on `f2b` and a link to the corresponding upstream pull request, if one was opened.

| Date | Change | Upstream PR |
| ---- | ------ | ----------- |
| 2026-10-27 | Jobs image builds a minimal FFmpeg 9.0.2 (local files only, the codecs the media steps need) instead of Debian's; every ffmpeg/ffprobe call passes `-protocol_whitelist file`; AVI is no longer an accepted video upload type; api, dashboard and jobs images run as `node`. Image checks in `docker/jobs/check-image.sh`. | Not opened |
| 2026-10-27 | Auth: return 404 over HTTP for SSO provider management and anonymous sign-in and deletion (server-side `auth.api` only), and disable implicit OAuth account linking. Requests whose path does not start with the literal auth base path are rejected. | Not opened |
| 2026-10-27 | A "Source code" link (AGPL-3.0 section 13) in the user menu, on the sign-in pages and on public org pages; `/source` on the dashboard redirects to the running revision and `/source` on the API returns it as JSON. Set by `PUBLIC_SOURCE_CODE_URL`/`PUBLIC_SOURCE_CODE_REVISION` or the `SOURCE_CODE_URL`/`SOURCE_CODE_REVISION` image build args; defaults to the upstream repository. | Not opened |
| 2026-10-27 | Every ffmpeg/ffprobe call has a time budget (probe 30 s, thumbnail frame 60 s plus half the seek offset, audio extract 60 s plus half the duration, 30 min cap) and is SIGKILLed past it; a timeout fails the media job without retries. HLS playlists read for audio extraction keep only the tags our encoders write, reject any `URI=` attribute, and must name at most 20 000 distinct `.ts` segments directly beside the playlist. Fork CI checks that the api startup check fails on a broken image. | Not opened |
| 2026-10-27 | Audio extraction refuses an HLS playlist over 4 MiB: the S3 download stops at the cap (by `Content-Length`, or as soon as the stream passes it) and the file size is checked again before it is read. Playlist text quoted in a rejection is cut to 120 characters and JSON-escaped. | Not opened |

Repository maintenance commits (this file, `.github/fork/`, the `fork-*` workflows,
and the removal of upstream's publish, deploy and issue-bot workflows) are not
listed: they do not change the application.

## Keeping up with upstream

`.github/workflows/fork-sync.yml` runs weekly and on demand. It fast-forwards
`upstream`, rebases `f2b` onto it on a `sync/<sha>` branch with `git rerere`, runs
upstream's tests and builds the three images (without publishing), and then opens a
pull request, or an issue naming the patch that no longer applies.

A sync pull request is reviewed like any other, but it is **not merged with the
merge button**: a rebase is not a merge. After review, a maintainer moves `f2b` to
the reviewed head with a lease on the old one:

```sh
git push --force-with-lease=f2b:<old-f2b-sha> origin <sync-head-sha>:refs/heads/f2b
```

and closes the pull request.

## Checks on every pull request

- **gitleaks**: no credentials in the diff.
- **denylist**: the diff against `upstream`, the commit messages, the branch name and
  the pull request text must not contain terms from a private list. The list is a
  repository secret; the check reports which term number matched and where, never the
  term.
- **promotion-tree**: the pull request body carries a `Reviewed-tree: <sha>` line and
  the head commit's tree must equal it, so what lands is byte-for-byte what was
  reviewed. Sync pull requests are exempt.
- **workflow-allowlist**: every file in `.github/workflows/` is on the list in
  `.github/fork/workflows.allow`, so a workflow added upstream cannot start running
  here unreviewed.
- **build**: upstream's tests and build, and the API, dashboard and jobs images
  built from `docker/Dockerfile.*` (not pushed). It also runs on every push to a
  `wip/**` or `review/**` branch, so a patch is built and tested before its pull
  request is opened.

## Images

This repository publishes nothing and holds no registry or cloud credentials.
Images are built from release tags by the maintainers' own CI, and carry the OCI
labels `org.opencontainers.image.source` (this repository) and
`org.opencontainers.image.revision` (the tagged commit), so any running image can be
traced to its source here.

## Licence-gated features

Upstream's licence-gated features are not modified.
