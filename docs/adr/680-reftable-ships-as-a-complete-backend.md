# 680 — Reftable ships as a complete read+write backend, compaction included

- **Status:** accepted
- **Date:** 2026-08-19
- **Design:** docs/design/reftable-ref-storage.md (candidates DC-1, DC-5) · **Refines:** ADR-667

## Context

ADR-667 accepts `extensions.refStorage` at the gate and requires that acceptance not be a lie.
Measured against a real `git init --ref-format=reftable` repository, tsgit today does far worse
than read ref-less: `enumerateRefs` returns a phantom ref (the `.git/refs/heads` stub file read
as a ref name), `resolveRef` throws `INVALID_REF` / `NOT_A_DIRECTORY` — an unsupported
repository misreported as the caller's mistake — `tagList` and `listReflogs` silently return
empty while 2 tags and 3 reflogs exist, and `updateRef` **writes the loose ref and its reflog to
disk and then throws**, because `logCoupledHead` reads `HEAD` after `atomicWriteRef` has already
committed. `git for-each-ref` is unchanged afterwards and `git fsck` / `git refs verify` report
nothing: the divergence is invisible to git's own integrity checks.

## Options considered

1. **Read-only + precise write refusal** (design recommendation) — pros: closes both measured
   defects, since the corruption comes from writes that should never be attempted; no binary
   writer, no transaction protocol / cons: tsgit cannot update refs in a reftable repository.
2. **Read + write, no compaction** — pros: full ref read/write; makes the parse/serialize
   round-trip property applicable / cons: unbounded stack growth — tsgit appends tables only git
   ever compacts.
3. **Read + write + compaction** — the complete backend.

## Decision

**Option 3 — ratified by the user.**

tsgit implements the reftable backend completely: stack parsing, ref/obj/log blocks, tombstones,
symbolic refs, peeled tags, reflogs, the `tables.list` rewrite and lock protocol, writing, and
compaction (including auto-compaction policy).

**Adapter reach (DC-5) follows mechanically and is settled here:** all three adapters. A backend
this complete has no read/write asymmetry to split along adapter lines, so memory and browser
carry it too, exercised by the parity fleet.

## Consequences

- This is the largest single subsystem in the change. Compaction is where reftable's concurrency
  and durability edge cases concentrate, and it has the least externally observable behaviour to
  pin against git — the interop suite must lean on on-disk state comparison, not stdout.
- The write side makes the binary parse/serialize round-trip a genuine property-test candidate
  (CLAUDE.md lens 1); the design's test strategy takes it.
- Two documentation errors in git's shipped reftable spec were measured and must be honoured over
  the spec text: reflog `tz_offset` is the raw `±HHMM` integer, not minutes (6 of 6 timezones),
  and the "first `restart_offset` is 28" rule is v1-only — it is 32 for v2.
- The `updateRef` write-then-throw ordering bug is fixed as part of this work, not merely avoided.
