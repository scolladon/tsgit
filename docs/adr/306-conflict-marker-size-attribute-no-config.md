# ADR-306: `conflict-marker-size` attribute only — no `merge.conflictMarkerSize` config

## Status

Accepted (at `<sha-after-merge>`)

## Context

The three-way content merge writes conflict markers (`<<<<<<<` / `=======` /
`>>>>>>>`) at a fixed length of 7, and the external merge-driver `%L` placeholder
is hardcoded to 7. git lets a path override this length.

The backlog item (24.9b) named two knobs: a `conflict-marker-size` **attribute**
and a `merge.conflictMarkerSize` **config**. Verification against git 2.54.0
shows git has **no** `merge.conflictMarkerSize` config:

- `git help config` lists no such key.
- `git help attributes` documents the `conflict-marker-size` *attribute*.
- An experiment setting `merge.conflictMarkerSize=10` left the markers at 7;
  setting the `conflict-marker-size` attribute to 10 produced 10-character
  markers.

The prime directive forbids inventing observable behaviour git does not have.

## Decision

Implement the **`conflict-marker-size` attribute only**. Do **not** add a
`merge.conflictMarkerSize` config — it does not exist in git, so adding it would
be a divergence with no upstream counterpart.

The resolved size feeds **both** the built-in markers (all three marker runs
scale to the size) and the external-driver `%L` placeholder.

Value interpretation matches git's `strtol_i` (full-string base-10, optional
sign): a parsed integer **strictly greater than 0** is the size; everything else
(`0`, negative, `12abc`, `0x10`, `15.9`, a bare-set/unset/unspecified attribute,
overflow) falls back to the default **7**.

## Consequences

### Positive

- Byte-for-byte faithful: the only marker-size lever is the one git actually has.
- The size threads through the seams that already exist (`ConflictMarkerOptions`
  for the built-in path, `DriverPlaceholders.L` for drivers) — additive.

### Negative

- A user expecting a `merge.conflictMarkerSize` config (perhaps from a third-party
  tool that invented one) finds none. This is correct: git has none either.

### Neutral

- The backlog wording is corrected to drop the phantom config.
- If git ever gains such a config, wiring it is additive (the resolver already
  produces a number; the caller would pass a config-resolved fallback).
