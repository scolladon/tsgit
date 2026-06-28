# 425 — bundle verify reports missing prerequisites as a query, not a throw

- **Status:** accepted
- **Date:** 2026-06-27
- **Design:** docs/design/bundle.md · **Relates:** ADR-414 (fsck repository-state gate), ADR-226 (git-faithfulness)
- **Decision class:** D-API adopted-as-recommended (no user judgment)

## Context

`git bundle verify` answers two different kinds of question. A *malformed* bundle (bad
magic, truncated header) is an error — git exits non-zero with `fatal:`. A *well-formed*
bundle whose prerequisite commits are simply absent from the current repository is a
reportable state, not a malformation — git lists the missing prerequisites and reports
that the repository lacks them. CQS and the `fsck` precedent (a structured report rather
than a throw for a "the repo is in state X" answer) both bear on which shape `verify`
returns.

## Options considered

1. **CQS query** — return `{ prerequisitesPresent: false, missingPrerequisites: […] }` for
   a well-formed bundle with absent prerequisites; throw only on malformation *(designer
   recommendation)* — pros: matches CQS and the `fsck` structured-report precedent;
   missing-prereq is data the caller inspects, not an exception; cons: callers must read
   the boolean rather than rely on a throw.
2. **Throw on missing prerequisites** — pros: a single failure channel; cons: conflates a
   reportable state with a malformation; loses the structured `missingPrerequisites` list;
   diverges from `fsck`.

## Decision

**Option 1 — adopted as the design recommended.** `verify` returns a structured query
result; `prerequisitesPresent` and `missingPrerequisites` carry the answer for a
well-formed bundle. A malformed header still throws (`BUNDLE_BAD_HEADER`, ADR-426). The
interop test reconstructs git's `verify` output from these fields.

## Consequences

- `verify` is a pure query (CQS): it never mutates and reports via its return value.
- Missing-prerequisite reporting and the malformed-header refusal are tested on distinct
  channels (return value vs thrown `.data.code`).
