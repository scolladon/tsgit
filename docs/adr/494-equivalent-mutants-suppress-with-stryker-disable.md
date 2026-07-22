# 494 — Provable equivalents are annotated with `Stryker disable … equivalent`

- **Status:** accepted (user judgment — chose the suppressing codebase convention)
- **Date:** 2026-07-14
- **Design:** docs/design/whole-codebase-mutation-sweep.md · **Supersedes/Refines:** none

## Context

The sweep must annotate every provably-equivalent survivor. Two conventions existed in
the tree with **opposite** effects on the mutation score:

- `// Stryker disable next-line <mutators>: equivalent — <proof>` — **84 src files**;
  explicitly permitted by the `check-forbidden-patterns` hook (it blocks only a *bare*
  Stryker-disable carrying no `equivalent` rationale); **suppresses** the mutant so a proven
  equivalent leaves the score denominator.
- `// equivalent-mutant: <proof>` — 2 files (`name-rev`), and the wording in
  `.claude/workflow/mutation.md`; a plain doc comment that **does not suppress**, so the
  equivalent still counts against the score.

A proven-equivalent mutant is unkillable by construction; leaving it in the denominator
depresses the score for no signal. The hook was written to bless exactly the suppressing
form (with a mandatory `equivalent` rationale carrying the proof).

## Options considered

1. **`Stryker disable … equivalent`** (chosen) — dominant (84 files), hook-permitted,
   removes proven equivalents from the score. Also convert `name-rev`'s 2
   `// equivalent-mutant:` comments to match. / cons: a functional directive, not a plain
   comment.
2. **`// equivalent-mutant:`** — honest "nothing hidden" accounting (equivalents keep
   counting, absorbed by conservative thresholds). / cons: lower headline score;
   contradicts 84 existing files; wastes denominator on unkillable mutants.
3. **Keep both** — least churn. / cons: perpetuates the inconsistency; per-file-irregular
   threshold math.

## Decision

Provable equivalents are annotated `// Stryker disable next-line <mutators>: equivalent —
<proof>`, listing exactly the mutator(s) proven equivalent and one line of proof. The two
`name-rev` `// equivalent-mutant:` comments are converted to this form.
`.claude/workflow/mutation.md` is updated so its stated convention matches the hook and the
tree. Every suppression carries a proof; a bare disable stays hook-blocked.

## Consequences

- The post-sweep score reflects only genuinely killable-or-missed mutants; proven
  equivalents no longer depress it, so the conservative threshold raise (ADR 493) reads off
  a truthful floor.
- The convention is single-sourced and hook-enforced; the misleading `mutation.md` line is
  corrected in this PR.
- Each disable is auditable — mutator list + inline proof — never a blanket silence.
