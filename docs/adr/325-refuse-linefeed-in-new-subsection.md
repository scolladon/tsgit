# ADR-325: Refuse LF/NUL in new subsection names instead of replicating git's self-corruption

## Status

Accepted (at `bb7b607e`)

## Context

Pinned against git 2.54.0: `--rename-section s "t.a\nb"` (literal newline) writes the newline **raw** inside the quoted subsection and exits 0 — the resulting config file is corrupt and no longer parseable by git itself. tsgit's `rejectSubsection` currently refuses `\n` and `\0` in subsection names reaching the writer.

The prime directive (ADR-226) demands byte-for-byte faithfulness unless an ADR diverges and says why.

## Decision

Keep `rejectSubsection`'s LF/NUL refusal for the NEW name in section renames — a deliberate divergence on a git foot-gun. tsgit refuses to produce a config file that git itself cannot re-read. NUL cannot reach git via argv at all, so the observable divergence is effectively LF-only.

## Consequences

### Positive

- tsgit never writes an unparseable config file; the failure is an explicit structured error instead of silent corruption.

### Negative

- One pinned row is intentionally not replicated; interop pins for the rename matrix must exclude the LF row (covered by a refusal-side unit test instead).

### Neutral

- All other new-name grammar rows (charset refusals, first-dot split, quote escaping) remain byte-faithful.
