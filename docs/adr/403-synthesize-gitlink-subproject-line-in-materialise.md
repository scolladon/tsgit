# 403 — synthesize the gitlink Subproject-commit line in the materialise primitive

- **Status:** accepted
- **Date:** 2026-06-22
- **Design:** docs/design/gitlink-type-change-patch.md · **Refines:** ADR-226 (git-faithfulness), ADR-249 (structured-data-only) · **Relates:** ADR-402 (type-change patch render), ADR-399 (structural gitlink pins)
- **Decision class:** adopted-as-recommended (no user judgment)

## Context

A gitlink (mode `160000`) oid is a commit, not a blob. The patch-hydration primitive
`materialiseOne` (`src/application/primitives/materialise-patch-files.ts`) loads every
diff side via `readBlob`, which throws on a commit oid — so any diff touching a gitlink
entry crashes before the serializer runs. Real git renders a gitlink side with the
synthetic single line `Subproject commit <40-hex-oid>` (newline-terminated, no
no-newline marker), pinned across every direction in the design's faithfulness matrix.
The block header's mode and the `index` abbrev already derive from the structured
change (`oldMode`/`newMode`/`oldId`/`newId`); only the body line is missing. We must
produce it byte-faithfully without leaking submodule semantics into the platform-free
domain serializer.

## Options considered

1. **Synthesize the gitlink side's content bytes `Subproject commit <oid>\n` in the
   primitive `materialiseOne`** (designer's recommendation) — the existing domain
   `renderDeleteBlock`/`renderAddBlock`/`renderModifyBlock` then render byte-perfectly
   from the structured change. pros: domain stays submodule-ignorant (hexagonal), the
   one submodule constant lives in the application tier where git itself produces it,
   minimal diff (no serializer change). cons: a materialised side whose bytes are
   synthetic rather than a real blob — acceptable, the bytes ARE git's display form.
2. **Add a `{ gitlink, oid }` marker to the materialised `PatchFile`** and synthesize
   the line inside the domain serializer. cons: pushes the `Subproject commit` template
   into the platform-free domain and widens `PatchFile` — architecture violation.
3. **A dedicated `renderGitlinkBlock` in the serializer** emitting the line from the
   change oid. cons: duplicates delete/add logic AND leaks submodule semantics into the
   domain.

## Decision

The gitlink side of any diff change is hydrated by synthesizing the literal bytes
`Subproject commit <oid>\n` in the application primitive `materialiseOne` — never via
`readBlob` — whenever that side's mode is a gitlink (`kindOf(mode) === 'gitlink'`). The
domain patch serializer is unchanged: it renders the synthesized bytes through its
existing block path exactly as it renders a real blob. The submodule-specific string is
a single named constant in the primitive. This is not an ADR-249 rendering knob —
`renderPatch` is the one sanctioned patch-bytes producer and this completes the case
ADR-402 deferred; the diff command surface still returns structured `TreeDiff` only,
and the interop test reconstructs git's display from those fields.

## Consequences

- The platform-free domain stays ignorant of submodules; the only submodule knowledge
  is one constant in the application tier — mirroring git's own architecture, where the
  synthetic line is produced by submodule-aware diff code, not the generic formatter.
- The serializer needs zero edits for the gitlink patch; the change is a one-primitive
  edit, applied per-side (a `TypeChangeChange` has at most one gitlink side; a modify or
  add/delete may have the gitlink on either side).
- Forecloses a domain-side submodule renderer and a `PatchFile` shape change.
- The blast-radius consumers (patch-id, range-diff, rebase) that share this hydration
  are fixed transitively — none needs its own source edit.
