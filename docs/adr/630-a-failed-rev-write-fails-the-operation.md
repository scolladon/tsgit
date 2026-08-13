# 630 — A failed rev write fails the operation

- **Status:** accepted — **adopted-as-recommended (no user judgment)**
- **Date:** 2026-08-13
- **Design:** docs/design/rev-on-idx-write.md (DC-7)

## Context

Once the `.rev` is part of the pack-write path, a disk or permission fault while writing
it becomes a new everyday-path failure mode. git `die`s in that situation. The
alternatives were to propagate, to warn and succeed without the file, or to reorder the
`.rev` before the `.idx`.

## Decision

Propagate — the enclosing `fetch`/`clone`/`packObjects` call fails with the underlying
error. Warning-and-continuing would swallow a real fault on the everyday path (a repo
guardrail violation), and writing the `.rev` before the `.idx` inverts the assembly
ordering for atomicity the content-addressed pack naming already provides.

## Consequences

The `.rev` write happens last, after `.pack` and `.idx`; a failure can leave those two
behind, which is exactly the state git's own death leaves and every reader tolerates
(Pin H).
