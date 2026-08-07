# 590 — fsck rejects on undecodable loose objects in connectivity-only mode

- **Status:** accepted (user-ratified)
- **Date:** 2026-08-07
- **Design:** docs/design/fsck-pack-accessibility-reporting.md (DC-10) · **Refines:** ADR-588 · **Tension with:** ADR-411

## Context

Within `--connectivity-only`, git splits unreadable loose objects by fault class
(Pin P): an object it cannot open (EACCES) or that is empty becomes `dangling unknown`
and the run continues — ADR-588's closure reproduces that. An object it can open but
whose zlib stream is undecodable makes git `die()`: exit 128, no findings,
deterministic. tsgit's `buildObjectCache` folds every failure into one `null`, so the
closure alone would return exit 0 + `dangling unknown` where git dies. The row was
already divergent before this change; the question was which divergence, if any, ships.

Refuted in writing: treating it as `missing` — the file exists; bit 2 would be a
connectivity claim about a present object.

## Options considered

1. **Close it** — distinguish "cannot open / empty" from "opened but undecodable" in
   the object cache; `fsck` rejects on the latter in `connectivityOnly` mode.
2. **Classify it like the others** — `dangling unknown`, exit 0; one uniform rule, but
   ships a known divergent cell (git 128 / tsgit 0), the residual shape ADR-588 was
   ruled against.
3. **Report it with exit bit 1** — matches git's default-mode verdict for the same
   damage, but neither tool's connectivity-only cell; a third behaviour.

## Decision

User-ratified option 1 (no designer recommendation was given): exact parity on every
Pin P cell. `fsck` — an integrity-reporting command — aborts instead of reporting on
this one fault class, in this one mode, because that is what git observably does and
the prime directive binds refusal conditions.

## Consequences

`buildObjectCache` gains a fault discriminator in place of its single blanket `catch`;
the connectivity-only path propagates the undecodable-stream fault instead of caching
`null`. ADR-411's maximal-taxonomy premise gains a mode-scoped exception, recorded
here. The design doc specifies the mechanism, the error shape, and the pins.

**Post-review note (same change, hardening):** the rethrown error keeps the
store's own class and code, but its attacker-influenced `reason` is
control-char-stripped and length-capped at the reject boundary, and the
verdict is gated on the ORIGINAL read failure's two-code test — a file whose
damage class changes under the probe stays a tolerated `unknown`.
