# 586 — Exit bit 64 is modeled, with an ungated finding

- **Status:** accepted (user-ratified)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-6) · **Refines:** ADR-575

## Context

An unusable `.idx` gives git exit **68** (4 | 64) in full mode and **64** alone in
`--connectivity-only` / `--no-full` (Pin K). Isolation probe K-a proves bit 64 fires
with no `.rev` file on disk — it is a consequence of the index fault, not of
reverse-index support. tsgit has no `.rev` reader (28.3). The prime directive binds the
exit integer. Refuted in writing: gating bit 64 on a `.rev` file's presence.

## Options considered

1. **Model the bit and an ungated third finding variant** (`pack-rev-index-unusable`;
   designer's recommendation) — exact exit parity on every Pin K cell; a nonzero exit
   always has an explaining finding.
2. **Bare bit, no finding** — exit parity, but connectivity-only mode can return
   `exitCode 64` with an empty findings array: a nonzero exit nothing explains.
3. **Bit 4 only** — a named exit divergence in a family whose entire point is exit-code
   faithfulness; 28.3 must revisit.

## Decision

User-ratified option 1: model the bit with its own ungated finding variant. In full
mode one unusable `.idx` yields two findings for the same pack — faithful: git emits
both `index not opened` and `unable to load rev-index` (Pin J8).

## Consequences

Three public finding variants. The ungated evaluation makes `fsck({ full: false })`
read and parse every `.idx` in the repository — it loses its loose-only property, as
git's own `--no-full` does. The constant names a subsystem tsgit does not yet have; its
doc-comment says so, and 28.3's real `.rev` reader lands with nothing to correct.

**Post-review note (same change, hardening):** the ungated term now consumes
only the scan layer's retained skip records (`registry.indexFaults()`), so
`full: false` / `connectivityOnly` read and parse every `.idx` but never open
a `.pack` — the header probe runs only where the bit-4 report consumes it.

**Correction (see ADR-607).** The closing sentence above — that the real `.rev`
reader would land *with nothing to correct* — is **false**, and was falsified
empirically against git 2.55.0. Bit 64 has a second cause this ADR could not
test: a `.rev` file that exists, is readable, and is itself wrong. git sets bit
64 for it; tsgit exited **0**. Because `git repack` writes the artefact by
default, that gap was reachable in any maintained repository rather than an
exotic one. A second finding variant now separates the two layers (ADR-607), and
the exit-constant's doc-comment admission that it *"names a subsystem tsgit does
not yet have"* no longer applies. The ungated posture this ADR established is
**re-confirmed** for the new cause, and extends to exit bit 128.
