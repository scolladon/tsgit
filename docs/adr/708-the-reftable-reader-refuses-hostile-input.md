# 708 — The reftable reader refuses hostile input, including input git accepts

- **Status:** accepted
- **Date:** 2026-08-22
- **Design:** docs/design/reftable-ref-storage.md · **Refines:** ADR-226, ADR-688

## Context

ADR-688 ratified refusing a **corrupt** reftable stack with a structured code, on the grounds that
git 2.55.0's own `fsck` dies of signal 11 there: a crash is not behaviour to reproduce, so the
divergence was "confined to inputs on which git has no defined behaviour".

A hardening review of the completed backend found two input classes that reasoning does not reach.
The threat model is a repository **cloned from an untrusted remote**, where every byte of
`.git/reftable/tables.list` and `*.ref` is attacker-controlled.

**Class A — git neither crashes nor completes.** A `.ref` whose first ref-index record points at
its own index block makes the descent spin forever: no throw, no timeout, 100% CPU. Patching that
one record inside real writer output leaves the footer CRC valid, so every integrity check tsgit
had still passed. Separately, log blocks were inflated eagerly and retained with no aggregate
bound, so a modest table could exhaust heap on the first ref read. ADR-688's tiering **cannot
fire on either**, because nothing is ever thrown.

The distinction that matters is not crash-versus-hang, it is *whose process*. git is a program a
user can kill. tsgit is a library embedded in someone else's server or browser tab, where a wedged
event loop or an exhausted heap is a fault in a host that never opted into it.

**Class B — git succeeds.** Measured against the peer binary (git 2.55.0, scrubbed environment,
throwaway repository): git's reftable reader enforces **no name grammar at all** on `tables.list`
entries. It read a plain non-canonical `evil.ref`, and — the finding that matters — it followed
`../../../outside/escape.ref` **out of the reftable directory entirely**, returning the ref with
exit 0. An absolute path is *not* followed: git joins it onto the reftable directory, finds
nothing, and degrades silently to an empty ref space rather than refusing. So the exploitable
primitive is relative escape, not absolute addressing.

tsgit interpolates each entry into a path for a read, a lock write, and an unlink, so an
unconstrained grammar hands an attacker all three. Here git *does* have defined behaviour on the
traversing input — it succeeds — and ADR-688's justification does not apply.

## Options considered

1. **Match git everywhere** — including following a traversing `tables.list` entry — pros:
   maximal faithfulness, no new divergence to document / cons: ships a path-traversal primitive
   and a hang an attacker can trigger remotely, because git's own reader has confinement tsgit's
   embedding context does not.
2. **Extend ADR-688 mechanically** — refuse only where git has no defined behaviour — pros: no new
   principle needed; covers Class A / cons: leaves Class B open, and the traversal is the finding
   with the widest blast radius.
3. **Refuse hostile input by class, including where git succeeds**, and record the divergence with
   its measurement.

## Decision

**Option 3.** tsgit refuses the following, each with a structured `ReftableCheck` code:

| Refusal | Bound | Measured git 2.55.0 behaviour |
|---|---|---|
| `tables.list` entry naming a path separator, `..`, NUL, or a leading dot | — | **Succeeds** — follows a relative escape out of the reftable directory (an absolute path is silently ignored, not refused) |
| Ref-index descent depth | 64 levels | Hangs indefinitely on a cyclic index |
| Log-block inflation | Each block bounded by its own declared size | Unbounded |
| Tables per stack | 4096 | Unbounded |
| Bytes per table file | 64 MiB, checked by `stat` before any read | Unbounded |

Ceilings are set orders of magnitude above anything git's own writer produces — auto-compaction
keeps the table count near `log2(ref count)`, a real log block is ~4 KiB, and a real index nests a
handful of levels at tens of millions of refs — so no legitimately-produced repository is refused.

## Consequences

- **This widens ADR-688's divergence and says so.** ADR-688 could claim the gap only ever narrowed,
  because it touched inputs git had no answer for. That claim no longer holds for the `tables.list`
  grammar: tsgit refuses something git reads successfully. The justification is not faithfulness
  but embedding context, and it is recorded here rather than left implicit in a code comment.
- **The interop suite cannot co-pin the Class B row.** git succeeds where tsgit refuses, so the
  test must assert both sides explicitly — git's success and tsgit's structured refusal — the same
  shape ADR-688 established for the crashing rows, and for the same reason: a later reader must not
  "tighten" it into equality.
- **Refusals stay structured, not prose.** Each carries a `ReftableCheck` discriminant (`'cycle'`,
  `'block-bounds'`, `'tables-list'`, `'record-overrun'`), so a caller classifies the fault without
  parsing a message — consistent with ADR-249.
- **Error messages must not echo unvalidated bytes.** Because a `tables.list` entry could resolve
  through a symlink before this ADR, the header-mismatch message echoed the first four bytes of
  whatever it reached, making a parse refusal a read oracle. Refusal messages now describe the
  fault without quoting content read from an unvalidated path — a constraint on every future
  reftable refusal, not a one-off fix.
- **The `Compressor` port gains an optional per-call output bound**, so a log block cannot inflate
  past its own declared size. This widens a public interface and therefore carries the full surface
  gate; it is recorded here because the security requirement is what drove the widening.
- **A future git that adds its own confinement narrows this ADR.** The fixtures are retained so the
  comparison can be re-run, and the Class B row in particular should be re-measured on each git
  bump — if git starts refusing traversal, that row stops being a divergence at all.
