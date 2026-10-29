---
subjects:
  - src/application/commands/fsck.ts
  - src/application/commands/internal/fsck
supersedes:
  - adr: "919"
    scope: "auditing non-local object sources when full is false"
---
# 1108 — fsck `full: false` audits the local source only

- **Status:** accepted
- **Date:** 2026-10-29
- **Design:** docs/design/fsck-pack-entry-crc-git-256.md (F1, D-F1b) · **Supersedes/Refines:** supersedes ADR-919 (non-local sources under `full: false`); refines ADR-226

## Context

git 2.56's 485f5ae ("builtin/fsck: don't check alternates with --no-full") makes
`odb_source_files_fsck` return 0 for every non-local source unless `ODB_FSCK_FULL` is set. Under
`--no-full` a donor's loose objects, packs, reverse indexes, bitmaps and midx are not read at all.
Pinned on 2.56.0 in a scrubbed throwaway: a borrower whose tip is a valid commit living only in the
donor's loose store exits 2 with `missing commit <oid>`, where 2.55.0 audited the donor, reported
its bad object and exited 1. The donor's corrupt `.rev`, `.bitmap` and midx, which 2.55.0 reported
under `--no-full`, are silent on 2.56.0. ADR-919 made tsgit audit every source in every mode.

## Options considered

1. **Follow byte-for-byte** — pros: one expectation set, exit status pinned as git produces it /
   cons: a valid alternate-backed tip is reported missing under `full: false`, which reads as a
   git defect.
2. **Diverge with an ADR: keep reading alternates for presence under `full: false`, without
   auditing them** — pros: no spurious `missing` / cons: a standing divergence re-judged on every
   git bump; the prime directive binds exit status.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** Under `full: false` the audit universe
holds the local source only: its loose objects, its rev-index, bitmap and midx passes, and no
pack verification. A non-local source contributes nothing, not even presence, so a referent that
lives only there is `missing`. Default and `connectivityOnly` modes keep ADR-919's every-source
universe.

Superseded from ADR-919: the audit of non-local sources when `full` is false.

Carried forward from ADR-919: the every-source universe, content validation and
dangling/unreachable reporting in default mode, and the every-source enumeration under
`connectivityOnly`.

## Consequences

- `fsck({ full: false })` on a borrower never touches the donor; the alternates fsck rows that
  pinned donor findings under `no-full` are re-pinned to 2.56.0's silence or `missing`.
- Should a later git restore the presence read, this ADR is the one to supersede, and the CI git
  pin is what notices.
