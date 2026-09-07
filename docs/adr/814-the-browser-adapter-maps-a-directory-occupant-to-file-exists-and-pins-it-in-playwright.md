---
subjects:
  - src/adapters/browser/browser-file-system.ts
  - test/browser/opfs-roundtrip.spec.ts
---
# 814 — The browser adapter maps a directory occupant to FILE_EXISTS and pins it in Playwright

- **Status:** accepted
- **Date:** 2026-09-05
- **Design:** docs/design/memory-write-exclusive-directory.md (DC-E) · **Supersedes/Refines:** none

## Context

`BrowserFileSystem.writeExclusive` probes the leaf with `getFileHandle(leaf, { create: false })`
and treats every non-`TsgitError` rejection as "not found, safe to create". The WHATWG File
System Standard rejects that call with `TypeMismatchError` when the child is a directory, so a
directory occupant is read as absent, and the following `create: true` call rejects with the same
`TypeMismatchError`, which escapes unmapped. A caller sees a bare `DOMException`; `errorDataCode`
returns `undefined`, and `writeOrKeepArtifact` rethrows instead of raising
`PACK_ARTIFACT_MISMATCH`. This was derived from the adapter source plus the normative spec and
not executed: there is no OPFS fake, so Playwright is the only oracle. The browser adapter sits
outside both the coverage and the mutation gates.

## Options considered

1. **Out of scope; record the derivation and change nothing** — pros: the brief names only the
   memory adapter / cons: the same defect at the same seam ships in the adapter with the worse
   failure mode.
2. **Fix in this change and pin it with one case in `test/browser/opfs-roundtrip.spec.ts`**
   (designer's recommendation) — pros: a few lines in one method, no gate cost, the spec file
   already exists / cons: real scope growth and the only part of the change needing a Playwright
   run.
3. **Fix with no end-to-end pin** — cons: an unverified behaviour change on the one adapter with
   no automated safety net.

## Decision

**Ratified by the user: option 2.** `assertDoesNotExist` narrows its catch so a
`TypeMismatchError` from a directory occupant becomes `fileExists(path)`, and every other
non-`NotFoundError` rejection propagates rather than being read as absence. One new case in
`test/browser/opfs-roundtrip.spec.ts` plants a directory at the target and asserts `FILE_EXISTS`
against real OPFS on the browsers that file already runs.

## Consequences

All three first-party adapters refuse a directory occupant with the same code. The change
requires a Playwright run before merge. The browser adapter's non-exclusive `write` and `rename`
over a directory are not covered by this record; the revised design derives them alongside
ADR-815 and surfaces a candidate if the same gap exists there.
