# ADR-463: `name-rev` cutoff underflow guard transcribed in full

## Status

Accepted (2026-07-09)

## Context

git guards the slop subtraction against `timestamp_t` underflow
(`adjust_cutoff_timestamp_for_slop`): the subtraction only happens when
`cutoff > TIME_MIN + CUTOFF_DATE_SLOP`, else the cutoff clamps to `TIME_MIN`;
and the whole adjustment is skipped when `cutoff == 0` (a target dated exactly
at the Unix epoch). tsgit timestamps are safe-integer JS `number`s parsed by
`AuthorIdentity`; a real committer date can never approach the representable
floor, so the guard branch is unreachable in a real repository.

## Decision

Transcribe git's control flow in full:
`cutoff = t > FLOOR + SLOP ? t − SLOP : FLOOR` with
`FLOOR = Number.MIN_SAFE_INTEGER` as tsgit's `TIME_MIN` mapping, plus the
`if (cutoff)` epoch-zero skip (a target dated `0` keeps `cutoff = 0`). Both
branches are isolated-tested — the floor branch via a crafted floor-dated
in-memory commit, the epoch-zero skip via a `0`-dated target — so nothing is
suppressed or left as dead code.

## Consequences

- The pruning arithmetic is faithful even at the representable edge; a
  crafted floor-dated target cannot underflow into a wrong-signed cutoff.
- Every branch of the pure helper is reachable and mutation-tested; no
  coverage exception needed.

## Alternatives considered

- **Drop the guard** (`cutoff = t − 86400` unconditionally) — simpler, but
  diverges from git's transcribed control flow and leaves a latent
  wrong-sign cutoff for crafted inputs; the kind of silent gap the
  faithfulness review exists to catch.
- **`BigInt` timestamps** to match `timestamp_t` width — over-engineered;
  `AuthorIdentity.timestamp` is `number` everywhere and the safe-integer
  bound covers every real committer date.
