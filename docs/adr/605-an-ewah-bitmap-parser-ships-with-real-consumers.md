# 605 — An EWAH bitmap parser ships, with real consumers

- **Status:** accepted (ratified — deviates from the design's recommendation)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (DC-3, Pins D/E/J) · **Refines:** ADR-603

## Context

`git fsck`'s entire obligation for a `.bitmap` is the file's trailing checksum: with the
trailer restamped, a flipped magic, a bad version, an entry count of 99 in a two-entry
file, a truncated body and an EWAH word count of 2³¹ all exit **0** (design Pin J rows
B14–B19, independently re-verified this run). A structural parser therefore buys **zero**
faithfulness, and a parser that refused any of those files would make tsgit *stricter*
than git — itself a divergence. The design recommended shipping none.

That argument holds only while nothing *consumes* a bitmap. ADR-603 rules that something
will.

## Options considered

1. **No parser** (designer's recommendation) — hash the file and nothing more / forecloses
   every bitmap-enabled capability.
2. **Ship the parser dark** — exercised only by its own unit tests / dead code by the
   project's own guardrail, with the allocation hazard and no gain.
3. **Ship it and use it** — a full header + EWAH reader feeding real consumers / the
   largest scope, and the allocation hazard becomes live.

## Decision

Option 3. A bitmap reader ships covering the header (magic, u16 version, u16 option
flags, entry count, embedded checksum), the four type streams in order
(commits, trees, blobs, tags), XOR-chained per-commit entries, and the flag-selected
trailing extensions. Its consumers are ADR-613's and ADR-614's commands.

**The parser is used for consumption, never for `fsck` verdicts.** The `fsck` bitmap pass
hashes the file and stops — it does not parse, so no structural fault can produce a
finding git would not produce. This separation is what keeps ADR-603's expanded scope
from silently making tsgit stricter than git, and it is load-bearing: the restamped-
corruption rows are interop rows precisely so a future refactor cannot fuse the two paths.

`0x2` in the flag word was not produced by any probed git configuration; it is recorded as
**unobserved**, not as reserved, and the parser must not assume a meaning for it.

git's abort on a bitmap lacking the mandatory full-DAG flag (`BUG:`, exit 134) is not
replicable by a library and is not replicated; tsgit declines such a bitmap and falls back
per ADR-616.

## Consequences

Makes the EWAH allocation mitigations binding (ADR-611): streams are decoded by lazy run
iteration, never materialised, and every declared length is validated against the
remaining buffer before allocation — git's own `eof in data` check. This is the highest-
severity item in the threat model and it exists only because this ADR chose option 3.
