# ADR-207: `rm` implements git's full safety valve (three refusal categories)

## Status

Accepted (at `ab29483559bfb1b06f1d7810f084d89e3f84deef`)

## Context

`repo.rm` is unconditionally permissive — it removes any index-matched path with
no comparison to HEAD or the working tree. Canonical `git rm` runs
`check_local_mod`, which refuses to destroy un-recoverable changes. Verified
empirically (git 2.54.0), the valve has **three** refusal categories for a path
whose working file exists:

- **staged-only** (index ≠ HEAD, work = index): *"changes staged in the index"* —
  override `--cached` or `-f`.
- **local-only** (work ≠ index, index = HEAD): *"local modifications"* — override
  `--cached` or `-f`.
- **both** (work ≠ index and index ≠ HEAD): *"staged content different from both
  the file and the HEAD"* — override **`-f` only** (`--cached` still refuses).

A missing working file never refuses (the deletion is the goal). The backlog
entry's wording centres on the staged-only case.

## Decision

Implement the **full valve — all three categories** — with git's exact
override semantics (`--cached` suppresses staged-only and local-only but not
both; `-f` suppresses all three), atomic (nothing removed if any path refuses).
Add `force` to `RmOptions` (`cached` already exists). Surface three granular
error codes per the ADR-202 precedent: `RM_STAGED_CHANGES`,
`RM_LOCAL_MODIFICATIONS`, `RM_STAGED_AND_LOCAL_CHANGES`, each carrying the
refused `paths`. When refusals span buckets in one call, throw by precedence
**both → staged-only → local-only** (strongest required override first).

## Consequences

### Positive

- Faithful to `git rm` across every refusal case, not just the staged one.
- Closes the gap 21.2a's `rm-interop` flagged (it seeds via a commit to dodge the
  valve); the interop suite can now assert co-refusal directly.

### Negative

- More work than a staged-only valve: needs the work-vs-index comparison (see
  ADR-208) plus a HEAD-tree read.

### Neutral

- Multi-bucket single-call refusals surface one (most-severe) category where git
  prints all; behaviour (atomic refusal, exit ≠ 0) is identical. Cosmetic.

## Alternatives considered

- **Staged-change valve only** (the backlog's literal wording). Rejected: it
  diverges from git for the `local-only` case (would not refuse) and the `both`
  case (wrong message; wrongly accepts `--cached`). Faithfulness is the project's
  first principle.
