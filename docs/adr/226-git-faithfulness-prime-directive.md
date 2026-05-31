# ADR-226: git-faithfulness is the prime directive

## Status

Accepted (at `ff557417`)

## Context

tsgit is a from-scratch reimplementation of git. Its entire value proposition is
that its output is **indistinguishable from canonical git's**: the same object
SHAs, the same ref and reflog contents, the same on-disk state files, the same
refusal conditions and message formats. A tool that is "git-like" but subtly
divergent is worse than useless — it silently corrupts interop with real git and
every other git implementation.

Faithfulness is already the de-facto rule and is already **mechanically enforced**:

- the cross-tool interop harness (`test/integration/*-interop.test.ts`) invokes
  real `git` and asserts byte-parity — a divergence fails the build ([ADR-137](137-interop-real-git-over-snapshot.md));
- cross-adapter parity goldens use the 40-hex commit id as the load-bearing signal
  ([ADR-128](128-golden-commit-id-as-parity-signal.md));
- the `@writes` / `@proves` write-surface audit forces every new write surface to
  ship interop coverage ([ADR-204](204-porcelain-commands-as-write-surfaces.md)).

But the *principle* has no single home. It is re-derived ad hoc across a dozen
per-feature ADRs (137, 128, 212, 216, 218, 224, 225, …), buried inside the
development-workflow non-negotiables, and implicit in CONTRIBUTING's interop-test
how-to. Nothing names it as **the** directive, and nothing states what to do when a
divergence is genuinely warranted. The result: each feature re-litigates "should we
match git here?" from scratch, and the rare justified divergence (e.g. returning a
raw log body with its trailing newline, [ADR-206](206-log-message-returns-raw-body-with-trailing-newline.md))
looks indistinguishable from an accidental one.

## Decision

Establish **git-faithfulness as the prime directive**, with a single canonical
statement (this ADR) that the narrative docs reference rather than re-derive:

> tsgit replicates canonical git's **observable behaviour byte-for-byte** — object
> SHAs, ref & reflog contents, on-disk state files (`sequencer/`, `MERGE_HEAD`,
> `CHERRY_PICK_HEAD`, …), refusal conditions, and message formats — **unless an ADR
> explicitly diverges and says why.**

- **Enforcement** is the existing mechanism, not prose: the cross-tool interop
  harness (ADR-137) + cross-adapter parity goldens (ADR-128) + the write-surface
  audit (ADR-204). Faithfulness is proven by a failing test on divergence, not by
  review opinion. Verify against real `git` (scrubbed `GIT_*`, signing off) when in
  doubt — do not guess git's behaviour.
- **Escape hatch:** a deliberate divergence is permitted only when it carries its
  own ADR recording *what* diverges and *why* (and ideally an interop test pinning
  the chosen behaviour). ADR-206 is the template: a conscious, documented, pinned
  divergence.
- `docs/understand/architecture.md`, `CLAUDE.md`, and `CONTRIBUTING.md` point back
  to this ADR as the source of truth instead of restating the rule.

This is a documentation/normative change. It codifies existing practice; it adds no
new CI gate (the enforcement already exists) and changes no code.

## Consequences

### Positive

- One canonical source of truth. New features start from "match git" by default;
  the question is settled, not re-litigated per feature.
- Every divergence becomes a conscious, reviewable, ADR-documented decision —
  distinguishable at a glance from an accidental one.
- The narrative docs (architecture / CONTRIBUTING / CLAUDE) stop drifting from the
  principle because they link to it rather than paraphrase it.

### Negative

- Discipline overhead: a justified divergence now requires writing an ADR, not just
  a code comment. This is intentional friction — divergence should be rare and
  deliberate.

### Neutral

- No code change and no new gate. The per-feature faithfulness ADRs (137, 224, 225,
  …) remain valid as concrete applications of this directive.
