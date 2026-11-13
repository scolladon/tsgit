---
subjects:
  - src/application/commands/grep.ts
---
# 1182 — an attribute-forced binary blob is scanned whole

- **Status:** accepted
- **Date:** 2026-11-12
- **Design:** docs/design/grep-diff-attribute-binary.md · **Supersedes/Refines:** refines ADR-1174

## Context

ADR-1174 bounds the binary match scan to the first 64 KiB. Pinned against git 2.56: a
108 KB text file under `binary` with its only match near line 9001 prints
`Binary file big matches`. A `-diff` lock file or minified bundle over 64 KiB is a plausible
input.

## Decision

**Ratified by the user.** When the `diff` attribute forced the binary verdict, the
invert-aware line scan covers the whole buffer; when the NUL sniff decided, the 64 KiB window
of ADR-1174 stays.

Rejected: keeping the window everywhere (misses matches past 64 KiB in forced-binary files)
and dropping it for NUL-sniffed blobs too (removes ADR-1174's safety bound).

## Consequences

### Positive

- Forced-binary files report matches as git does at any offset.

### Neutral

- A forced-binary file costs the same line scan the text path already does uncapped.
