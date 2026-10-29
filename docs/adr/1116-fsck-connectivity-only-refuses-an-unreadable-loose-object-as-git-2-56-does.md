---
subjects:
  - src/application/commands/fsck.ts
---
# 1116 — fsck `connectivityOnly` refuses an unreadable loose object, as git 2.56 does

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F12, D-F12) · **Supersedes/Refines:** refines ADR-226 and ADR-590

## Context

Pinned on 2.56.0 against 2.55.0 in scrubbed throwaways: `fsck --connectivity-only` over an
unreferenced empty loose object prints `error: object file <path> is empty` three times and dies
`fatal: loose object <oid> (stored in <path>) is corrupt`, exit 128; over a loose object with
mode 000 it prints `error: unable to open loose object <oid>: Permission denied` three times and
the same fatal line. 2.55.0 printed `dangling unknown <oid>` and exited 0 in both cases. Default
mode is unchanged at exit 1. The change rides on the 2.56 `odb_for_each_object` path the
connectivity walk now goes through; the attributing commit is confirmed from
`odb/source-loose.c` before the red row is written. tsgit classifies such an object under
`connectivityOnly` (`unreadable: 'classify'`) and reports it dangling.

## Options considered

1. **Follow: refuse (new code `LOOSE_OBJECT_CORRUPT` for the empty/unopenable shapes)** — pros: one expectation set; git has the crash,
   so lesson 017 holds / cons: a read error that 2.55 tolerated now aborts the whole check.
2. **Diverge with an ADR and keep the 2.55 classification** — pros: a more useful report / cons: a
   standing divergence that a later git may invalidate either way.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** Under `connectivityOnly`, an unreadable
loose object that the enumeration reaches refuses instead of being classified. git prints one
fatal (`loose object <oid> (stored in <path>) is corrupt`, exit 128) for every loose fault, but
tsgit keeps one code per cause: the new `LOOSE_OBJECT_CORRUPT` for an empty or unopenable copy
(`looseCopyYieldsNoBytes`), the pre-existing `DECOMPRESS_FAILED` for bytes that fail to inflate
and `INVALID_OBJECT_HEADER` for a header that does not parse, because existing rows pin those
two. Default mode keeps its findings-based report.

## Consequences

- The two fsck-pack-accessibility rows pin git's exit 128 and fatal line beside tsgit's typed
  refusal; their `dangling unknown` assertions go away.
- A caller branching on the refusal matches three codes, not one; the message and `.data.id`
  carry the object either way.
- If a later git restores the tolerant walk, this ADR is the one to supersede.
