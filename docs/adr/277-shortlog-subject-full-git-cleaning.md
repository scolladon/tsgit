# ADR-277: `shortlog` subject is git's full cleaned oneline; `foldSubject` made faithful

## Status

Accepted

## Context

Backlog **23.5** ships `shortlog` returning structured per-author groups of
`{ id, email, subject }`. The `subject` field's fidelity is load-bearing: real
`git shortlog` does **not** emit the raw subject, nor even git's `%s`. Its
`insert_one_record` cleans the oneline:

1. `format_subject(message)` — git `%s`: skip leading blank lines, fold the
   leading paragraph to one space-joined line (per-line trailing whitespace
   stripped, continuation-line leading whitespace preserved), stop at the first
   blank line after content.
2. Trim leading ASCII whitespace.
3. If the result starts with the literal `[PATCH` (case-sensitive), drop through
   the **first** `]`.
4. Trim leading ASCII whitespace.

Verified byte-for-byte against canonical `git` (with `--cleanup=verbatim` to
control exact stored bytes): `[PATCH] x`→`x`, `[PATCH v2] x`→`x`,
`[PATCHwork] y] z`→`y] z`, `[BUGFIX] x`→unchanged, `[patch] x`→unchanged,
`[PATCH no-close`→unchanged, `[PATCH]\n\nbody`→`''`, `[PATCH]\nbody`→`body`.

Two complications surfaced:

- **The `[PATCH` strip is unique to `shortlog`** — `log`/`show`/`%s` never do it.
  A consumer cannot re-derive it from `log`'s raw `message` without
  re-implementing git's rule. It is the part of `shortlog` users **cannot** DIY,
  and the thing that distinguishes `shortlog` from "`log` grouped by name."
- **`foldSubject` is latently unfaithful.** `domain/objects/commit-message.ts`
  `foldSubject` is documented as git's `%s` but **breaks** on the first blank
  line instead of **skipping** *leading* blanks — `foldSubject('\nx')` returns
  `''` where git `%s` returns `x`. The bug is masked today because `foldSubject`
  has **zero `src` consumers** (only test oracles) and committed messages are
  pre-`stripspace`d. `shortlog` is its first production consumer.

Alternatives considered for `subject`:

- **(A) Full git cleaning** — reproduce steps 1–4 exactly.
- **(B) `foldSubject` only** — fold to `%s`, skip the `[PATCH` strip.
- **(C) Raw first line** — `subjectLine(message)`, untouched.

## Decision

**(A).** `shortlog`'s `subject` is git's fully cleaned oneline, byte-faithful to
`git shortlog`. A new pure `domain/shortlog/clean-subject.ts`
`cleanShortlogSubject(message)` ports steps 1–4 over a corrected `foldSubject`.

`foldSubject` is **fixed in place** to faithfully skip leading blank lines (its
true `%s` contract), since `shortlog` is its first real consumer and the fix has
no production blast radius. Its leading-blank example test is corrected to the
git-faithful expectation; the existing `foldSubject` properties (idempotence,
no-newline, subject-before-body) are unaffected. The `history-interop` `%s`
oracle, built from real-committed (pre-stripped) messages, stays green.

This **refines ADR-249** ("structured output, not cosmetics"): the cleaned
subject is **data** — the defining datum of a `shortlog` entry that git produces
regardless of any `-e`/`-n`/`-s` flag — not a rendering choice. `log` remains the
surface for the raw `message`.

## Consequences

### Positive

- Byte-for-byte parity with `git shortlog` subjects, pinned by interop.
- Fixes a latent `%s` faithfulness bug in `foldSubject` at zero production cost.
- Clean separation: `shortlog` = git-faithful cleaned subject; `log` = raw message.
- The non-DIY-able part of `shortlog` is delivered, justifying it as distinct
  from `log` + manual grouping.

### Negative

- ~15 LOC of pure domain (`cleanShortlogSubject` + the `foldSubject` fix) plus
  tests, including the case-sensitive `[PATCH` branch and leading-blank cases.

### Neutral

- `cleanShortlogSubject` and `foldSubject` stay **domain-internal** (not on the
  public `api.json`); only `shortlog`'s structured result is public.
- `.mailmap` identity canonicalisation remains out of scope (no mailmap support
  anywhere yet) — a deferred cross-cutting follow-up.
