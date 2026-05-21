# ADR-062: approxidate — form subset, git-faithful behaviour

## Status

Accepted (at `1e5f20b`)

## Context

`<ref>@{<date>}` revision selectors and `reflog expire --expire=<time>` both
need to parse an "approximate date". Git's approxidate parser (`date.c`) is a
~600-line grammar: weekday names, `tea time`, `noon`, `yesterday`,
`N.units.ago`, ISO dates, `@<unix>`, explicit timezones, and more.

Two decisions: **which forms** to implement, and **what timezone** absolute
forms are interpreted in.

An earlier draft chose to interpret ISO dates as **UTC** "for test
determinism" — a behaviour divergence from git, which uses the host's local
timezone. User feedback rejected this: test determinism must not change
library behaviour.

## Decision

**Forms — a subset.** Implement the common forms:

- `now`, `yesterday`
- ISO date (`2026-05-01`) and ISO datetime (`2026-05-01 12:30:00`)
- relative, dotted (`2.days.ago`, `90.days`) and spaced (`2 days ago`)
- units `second`/`minute`/`hour`/`day`/`week`/`month`/`year` (sing./plural);
  `month` ≈ 30 days, `year` ≈ 365 days, as in git's relative arithmetic.

Unsupported forms return `undefined` → the caller surfaces
`REVPARSE_UNRESOLVED`.

**Behaviour — git-faithful.** Supported forms behave **exactly** as git:

- ISO absolute forms are interpreted in the **host's local timezone**,
  constructed from calendar components (`new Date(y, m-1, d, …)`), never via
  `Date.parse` (whose date-only branch is UTC).
- Relative forms are timezone-agnostic (`now` minus a delta).
- Unit tests pin `TZ=UTC` in the vitest environment for determinism — a
  test-harness concern, not a library-behaviour change.

## Consequences

### Positive

- The forms users actually type (`@{yesterday}`, `@{2.days.ago}`,
  `@{2026-05-01}`) work and resolve identically to git.
- `parseApproxidate` is pure (`(text, now) => timestamp | undefined`) —
  deterministic and trivially testable.
- Shared by both `@{date}` and `reflog expire`.

### Negative

- Exotic git forms (weekday names, `tea time`, `noon`, `@<unix>`, explicit
  `+0900` suffixes) are unsupported. They fail cleanly rather than
  mis-parsing; the grammar is extensible if demand appears.

### Neutral

- A digits-only `@{…}` selector is always a reflog *index*, never a unix
  timestamp — matches git's disambiguation.
