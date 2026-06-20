# ADR-396: gitGrep v1 command surface — targets, data flags, binary datum, context deferral

## Status

Accepted

- **Date:** 2026-06-20
- **Design:** [design/gitgrep-pattern-grammar.md](../design/gitgrep-pattern-grammar.md)
- **Relates to:** [ADR-395](395-gitgrep-grammar-diverges-to-js-regexp.md) (grammar engine)
- **Refines:** [ADR-249](249-describe-structured-data-only.md) (structured output)

## Context

With the grammar engine settled ([ADR-395](395-gitgrep-grammar-diverges-to-js-regexp.md)),
the v1 `grep` surface must fix three things: which search **targets** ship, which
**flags** are honoured (and which are excluded as rendering-only per ADR-249), and how
**binary** blobs that match are represented. These are git-faithful decisions
independent of the grammar divergence — the question is *which blob/line a target
exposes* and *what git reports for a binary match*, both pinned against real `git`.

## Options considered

- **Targets:** (a) full v1 — working tree + `--cached` + `<tree-ish>` in one PR;
  (b) tiered — working tree only now, defer the rest; (c) minimal. **Chose (a)** — the
  repo lands a whole feature per PR; the three targets reuse existing primitives
  (`walkWorkingTree` / `readIndex` / `walkTree`), so splitting them would only fragment
  the interop suite.
- **Binary match:** (a) a `binaryMatch` datum, line scan skipped (git's default);
  (b) treat binary as text always (git's non-default `-a`); (c) omit binary blobs.
  **Chose (a)** — git's default reports a matched binary blob as a blob-level fact
  (`Binary file X matches`, exit 0), not line hits; (b) is the non-default behaviour and
  (c) loses the match signal.
- **Context lines (`-A`/`-B`/`-C`):** (a) out of v1; (b) structured `context` per hit;
  (c) rendered blocks. **Chose (a)** — context is an ADR-249 grey area (the line *set*
  is data, the `--` separator and overlap-merge layout are rendering) orthogonal to this
  grammar-scoped item; it earns its own pinned design.

## Decision

**Targets — all three ship in v1:**

- working tree (default), via `walkWorkingTree` (ignore-aware);
- `--cached` / index, via `readIndex`;
- `<tree-ish>` (commit or tree), via `walkTree`.

**Flags honoured — structured data, not rendering:**

- whole-word gating (`-w`) applied at the matcher level, so it works for both the
  `RegExp` and the fixed-string form;
- invert (`-v`) — return lines that do *not* match;
- multiple patterns — OR-combine (git's `-e … -e …`).

Case-insensitivity is **not** a command option — it rides on the caller's `RegExp`
flags ([ADR-395](395-gitgrep-grammar-diverges-to-js-regexp.md)).

**Binary blobs:** skipped from line-level matching by default; a matched binary blob is
recorded as `binaryMatch: true` on the path entry with empty `hits`. The caller
reconstructs git's `Binary file X matches` line and exit code from the datum. A future
opt-in "treat as text" (`-a`) flag may follow; the door stays open.

**Structured output ([ADR-249](249-describe-structured-data-only.md)):** `GrepResult`
carries, per matching path, the hits (1-based line number, raw line bytes, match
spans) plus the `binaryMatch` datum. Counts (`-c`) and name-only (`-l`) are **derived**
by the caller from `hits.length` / membership — never stored fields. No rendering-only
flag (`-n`, `-h`, `--color`, `--null`, `--heading`, `-o` formatting) appears on the
surface.

**Context lines (`-A`/`-B`/`-C`)** are out of v1 — a documented candidate for its own
pinned design (the overlapping-window merge/de-dup behaviour is observable and must be
byte-pinned separately).

## Consequences

### Positive

- A cohesive v1 covering the three search targets a consumer realistically needs, all
  reusing existing enumeration primitives.
- Binary handling is faithful to git's default and ships as structured data, leaving a
  clean path to an opt-in `-a` later.
- The result shape lets a caller reconstruct every git rendering (`path:line:text`,
  `-c`, `-l`, `Binary file X matches`, `-o`) without the library emitting display text.

### Negative

- A larger single PR than a tiered landing — accepted, per the repo's one-PR-per-feature
  working style.

### Neutral

- Context lines, `-a` (binary-as-text), `grep.patternType` read from on-disk config, and
  the `--and`/`--or`/`--not` boolean grammar are out of v1 and tracked as future
  expansions; the per-blob matcher is reusable for them.
