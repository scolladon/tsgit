---
subjects:
  - src/application/primitives/config-read.ts
  - src/application/commands/internal/fsck/read-configuration.ts
  - src/application/commands/internal/fsck/skip-list.ts
  - src/application/commands/fsck.ts
---
# 877 — The `[fsck]` configuration is read in one file-order pass

- **Status:** accepted
- **Date:** 2026-09-18
- **Design:** docs/design/fsck.md (Configuration read order) · **Supersedes/Refines:** refines ADR-876 (the composed msg-id it grades)

## Context

git reads `[fsck]` ONCE, acting on each entry as its config walk reaches it: a severity word is
graded against the msg-id catalogue on the spot, and a `fsck.skipList` path is handed to
`oidset_parse_file` on the spot. So the first fault in the FILE kills the audit, and neither kind of
fault has precedence over the other. Measured against git 2.55.0:

| `[fsck]` body, in order | refusal |
| --- | --- |
| `skipList = <absent>`, `badTree = bogus` | `fatal: could not open object name list: <absent>` |
| `badTree = bogus`, `skipList = <absent>` | `fatal: Unknown fsck message type: 'bogus'` |
| `skipList = <absent-one>`, `badTree = bogus`, `skipList = <absent-two>` | `fatal: could not open object name list: <absent-one>` |
| `badTree = bogus`, `skipList = <absent-one>`, `skipList = <absent-two>` | `fatal: Unknown fsck message type: 'bogus'` |
| `skipList = <absent>`, `noSuchThing = error` | `fatal: could not open object name list: <absent>` |
| `noSuchThing = error`, `skipList = <absent>` | `fatal: Unhandled message id: <folded key>` |
| `skipList = <list holding an abbreviation>`, `badTree = bogus` | `fatal: invalid object name: <abbreviation>` |
| `badTree = bogus`, `skipList = <list holding an abbreviation>` | `fatal: Unknown fsck message type: 'bogus'` |

The list's own **parse** fault obeys the same rule as its open fault: both happen at the entry.

tsgit read the whole severity table first and the list paths second, in two separate walks over the
same token stream, then opened every list. A severity fault therefore always won, whatever the file
said — measured as `CONFIG_INVALID_ENUM_VALUE` where git answers `could not open object name list`.

## Options considered

1. **A lazily-graded, file-ordered item walk the command drives** (recommended, chosen) — the
   config primitive yields one graded `[fsck]` entry per step; the command opens the list an item
   names before asking for the next. Pros: exactly git's interleave; the primitive stays pure over
   tokens, with no filesystem reach of its own; the two refusal families keep their own homes.
   Cons: the walk's laziness is load-bearing and must be pinned by a test, not assumed.
2. **Pass an `openSkipList` callback into the config primitive** — same ordering, but the primitive
   becomes an orchestrator that awaits injected I/O, and every caller must supply an opener.
3. **Two walks with a merged, line-numbered fault list: collect every candidate refusal, then throw
   the lowest-line one** — cons: it grades entries git never reaches, so a file whose FIRST fault is
   a list still runs the severity grammar over everything after it; any refusal that is expensive or
   has a side effect would be paid for nothing. It reproduces the ordering by simulation instead of
   by structure.

## Decision

**Option 1.** `readFsckConfigItems(ctx)` returns an `Iterable<FsckConfigItem>` over a generator:
each step walks to the next `[fsck …]` entry and grades it, yielding either
`{ kind: 'severity', msgId, severity }` or `{ kind: 'skip-list', path }`, and throwing that entry's
refusal in place. Because grading happens per `next()`, a caller that opens a yielded list inside
the loop body has already done so before the walk grades anything after it.

`readFsckConfiguration(ctx)` (`commands/internal/fsck/read-configuration.ts`) is that caller: it
folds the walk into `{ severities, skipped }`, opening each list through
`readFsckSkipListNames(ctx, path)` as it arrives. Filesystem access stays on the command side of
the boundary — the config primitive reads `.git/config` and nothing else — so the ordering is
reproduced by the structure of the iteration rather than by giving the config reader a second
filesystem dependency.

`readFsckSeverityTable` and `readFsckSkipListPaths` are replaced by this one walk;
`loadFsckSkipList` becomes the per-entry `readFsckSkipListNames`, with the union moving to the
walk's driver where the file order lives.

## Consequences

The first `[fsck]` fault in file order now refuses, in either direction, with git's own wording
reconstructed from the structured fields. A configuration carrying both kinds of fault reports the
one git reports.

The union semantics of a repeated `fsck.skipList` are unchanged — every entry's names are added to
one set — but they are now visibly a property of the walk's driver rather than of the list loader.

The walk's laziness is behaviour, not an implementation detail: materialising the items eagerly
(`[...walk]`) restores the old wrong ordering, which is what the pinned rows detect.

One row moves with this change: a subsectioned `[fsck "x"] skipList` sitting BEFORE a usable
`[fsck] skipList` now refuses as the unknown msg-id `x.<folded key>` rather than yielding the later
list, because the two reads are one walk. That is git's answer (ADR-876), which the previous
two-walk split could not express.
