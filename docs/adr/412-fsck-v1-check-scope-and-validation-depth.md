# 412 — fsck v1 check scope: full refs-verify pass and full object msg-id catalogue

- **Status:** accepted
- **Date:** 2026-06-23
- **Design:** docs/design/fsck.md · **Refines:** ADR-226 (git-faithfulness)
- **Decision class:** D-SCOPE user-ratified

## Context

`git fsck`'s check space splits into three passes: object-content validation (is each object
well-formed?), connectivity/reachability (dangling / unreachable / missing / broken links), and a
separate `git refs verify` ref-content pass (`badRefContent`, exit-bit 10). Content validation
itself ranges from the structural faults a parser already rejects (bad header, unknown type, size
mismatch, bad mode/identity, hash mismatch) up to git's full named **msg-id catalogue**
(`treeNotSorted`, `zeroPaddedFilemode`, `missingSpaceBeforeEmail`, …) with a WARN/ERROR severity
table that `--strict` upgrades.

The design recommended the conservative slice — defer the refs-verify pass (**D1**) and defer the
msg-id catalogue + `--strict` (**D2**) as self-contained follow-ups. The user chose **full
coverage of both** so v1 reproduces git's complete finding and exit-code space.

## Options considered

**D1 — pass scope:** (1) content + connectivity, defer refs-verify *(designer rec)*; (2) **full,
incl. the refs-verify pass**; (3) connectivity-only first.
**D2 — content depth:** (1) parser-level structural faults only *(designer rec)*; (2) **full git
msg-id catalogue + `--strict`**; (3) parser faults + a curated subset.

## Decision

**Ship full. D1 → option 2; D2 → option 2** (both overriding the designer's deferral
recommendation — user-ratified).

- **Refs-verify pass is IN v1.** fsck runs the ref-content verification: a ref with malformed
  content yields a `bad-ref` finding (`badRefContent`), contributing exit-bit 10 to the composite
  bitmask; a ref pointing at a syntactically-valid but absent oid yields the `invalid sha1
  pointer` finding (exit-bit 2). Composite faults OR (e.g. malformed-content + zero-oid = 10).
- **Full object msg-id catalogue is IN v1.** `bad-object` reproduces git's named tree/commit/tag
  fsck checks with faithful msg-ids and git's WARN/ERROR severity classification. `--strict`
  ships as a verdict toggle that upgrades the WARN-class msg-ids to ERROR (and the exit bit),
  byte-faithful to git's `warning in …` → `error in …` flip.
- v1 `fsck` reproduces git's full default finding set, the msg-id catalogue, `--strict`, the
  refs-verify pass, and the complete exit-code severity bitmask (0/1/2/3/10 and their ORs).

## Consequences

- Net-new `domain/fsck/` validator module: the msg-id catalogue (per-object-kind checks) + the
  severity table + the strict-upgrade map. This is the bulk of the implementation weight.
- `strict` and `checkReferences` are live options in `FsckOptions` (ADR-411's kept-set).
- The interop matrix gains the `badRefContent`/exit-10 scenarios and the msg-id-catalogue
  warning/error/strict scenarios, pinned byte-for-byte against real git.
- Remaining out-of-scope narrows to: `--lost-found` write side (fsck stays read-only), alternate
  object stores (tsgit has no alternates), gitlink/submodule descent (git does not follow them).
- The design doc's "out of scope: refs-verify pass / msg-id catalogue" items move in-scope; the
  design is revised under the scope-fold rule before planning.
