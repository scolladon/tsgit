# ADR-119: Cancel-on-merge workflow scope

## Status

Accepted (at `62dc683`)

## Context

Every CI-eligible workflow already sets `cancel-in-progress: true`
keyed by `github.ref`, so a new commit on a PR branch cancels the
previous run on that branch. The remaining gap is **merge**: when a
PR squash-merges to `main`, the feature branch's last CI run keeps
spinning until self-completion. Wasted minutes per merge; reviewers
see stale state on the closed PR.

GitHub does not cancel pre-merge CI runs automatically when the PR
closes. Concurrency-group cancellation cannot reach across refs (the
post-merge run on `main` is a different group from the pre-merge run
on the feature branch).

The user asked for cancellation on both new-commit and merge events.
The new-commit case is solved. The merge case needs an explicit
workflow.

## Decision

- **Add `.github/workflows/cancel-on-merge.yml`** that listens to
  `pull_request: closed` and, when `merged === true`, cancels every
  in-progress workflow run whose `head_sha` equals the merged PR's
  head SHA.
- **Permissions:** `actions: write` only. No other scope needed.
- **Implementation:** inline `actions/github-script@v8` step, listing
  workflow runs with `head_sha` + `status: 'in_progress'` and calling
  `cancelWorkflowRun` per match.
- **Do not cancel on close-without-merge.** Closed-without-merge
  PRs occasionally need the run output as a record (e.g. the author
  is investigating why CI failed before deciding whether to reopen).
- **Do not cancel post-merge runs on `main`.** The merge commit's
  push event triggers a new ci.yml run on `main`, which is the run
  that decides "did this PR actually pass on main?". Cancelling it
  would defeat the point. Only the *pre-merge* feature-branch runs
  get cancelled.

## Consequences

### Positive

- **Stale CI minutes vanish.** A merge cleans up its own in-flight
  runs.
- **Reviewer signal is sharper.** A merged PR no longer shows a
  yellow spinner; it shows "cancelled" (intentional) or "completed"
  (race won by CI).
- **No reach into other workflow files.** Add one file, no edits to
  ci.yml / bench.yml / etc.

### Negative

- **One extra workflow** to maintain. Minimal: a single inline
  github-script step.
- **GitHub API call per merge** — within free quota for a hobby-
  scale repo; non-issue.
- **A merge during an already-finishing run can show "cancelled"**
  in the run list. Cosmetic; the run completed its work moments
  before the cancellation call.

### Neutral

- The workflow is intentionally narrow: only merged PRs, only the
  head SHA, only in-progress runs. Broader cancellation (e.g.
  "cancel everything older than N minutes") would need its own ADR.
- `npm-service.yml`, `pre-publish.yml`, `gh-pages.yml`, and
  `release.yml` keep their existing `cancel-in-progress: false` (or
  none) because publish/release flows must not be interrupted by
  this workflow either — the cancellation call only fires for
  runs whose head SHA matches the merged PR, which is the feature
  branch's tip, not the release-please tag.
