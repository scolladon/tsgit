# 616 — Bitmap acceleration is automatic, with silent fallback

- **Status:** accepted (ratified — new scope, no design recommendation existed)
- **Date:** 2026-08-09
- **Design:** docs/design/rev-index-bitmap-read-support.md (revision) · **Refines:** ADR-613, ADR-614, ADR-615

## Context

git uses a bitmap whenever one covers the requested tips and silently walks otherwise; it
exposes `--no-use-bitmap-index` as an escape hatch. tsgit must decide whether the
acceleration is on by default, opt-in, or on with an escape hatch. The design names the
real risk of the automatic choice: the fast path is under-exercised unless tests
deliberately build bitmapped fixtures.

## Options considered

1. **Automatic when usable, silent fallback** — matches git, no public flag / the fast path
   is easy to leave untested.
2. **Automatic plus an explicit escape hatch** — helps debugging and equality testing / adds
   a public option.
3. **Opt-in only** — guarantees the walk stays the tested default / ships the acceleration
   effectively off.

## Decision

Option 1. A bitmap is used when one is present, parseable and covers the requested tips;
otherwise the closure falls back to the existing walk. No public option controls it, so no
cosmetic-adjacent surface is added (ADR-249's spirit: the caller asks for a result, not for
a strategy).

**The under-exercise risk is answered by test obligation, not by an option.** Every closure
test runs twice — once against a bitmapped fixture and once against the same repository with
the bitmap removed — and asserts the two object sets are **identical**. A test surface that
selects the path internally is acceptable; a public one is not.

Fallback is silent in the sense that no result changes and no error is raised. A *fault* in
a present bitmap still reaches the logger with the artefact name — silence about the
strategy is not silence about a fault, except where git itself is silent (an unreadable
artefact).

## Consequences

Consumers cannot force a walk. Should a decoder bug ever ship, there is no runtime switch to
disable the fast path — which is precisely why ADR-615's equality oracle and this ADR's
double-run obligation are load-bearing rather than nice-to-have.
