---
subjects:
  - src/application/commands/grep.ts
---
# 1174 — grep's binary verdict is line-wise with the invert-aware matcher

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-blob-target.md · **Supersedes/Refines:** refines ADR-226

## Context

The blob target reuses `scanBlob`'s binary branch, which probes the first 64 KiB as one line
with a separate non-inverted matcher. Pinned against git 2.56: under `-v` git reports a binary
blob that has a non-matching line and skips one whose every line matches — tsgit does the
reverse; `^NEEDLE` matches a binary blob's second line in git and misses in tsgit. Both affect
every target.

## Decision

**adopted-as-recommended (no user judgment)** — ADR-226 and the fold rule: same file, same scan
path, exposed by this change's own probes, git pins the target behaviour. A binary blob matches
when any line of the bounded 64 KiB window is returned by the invert-aware matcher; the scan
stops at the first returned line; `binaryProbeMatcher` is removed.

## Consequences

### Positive

- `-v` and anchored patterns report binary blobs as git does, on every target.

### Negative

- Under `-v`, a window boundary cutting through a matching line can return the cut fragment; recorded as a residual in the grep doc.

### Neutral

- The 64 KiB bound stays.
