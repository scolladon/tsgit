# ADR-247: date-mode breadth — absolute modes interop-pinned, relative/human now-dependent

## Status

Accepted (at `4492407b`)

## Context

`--date=<mode>` (and `%ad`/`%cd`) span absolute and relative families:

- **absolute** — `default`/`normal`, `iso`/`iso8601`, `iso-strict`, `rfc`/
  `rfc2822`, `short`, `raw`, `unix`, `local`, `format:<strftime>`. A pure
  function of the stored `(timestamp, offset)` — deterministic.
- **now-dependent** — `relative` (`2 years, 7 months ago`) and `human`
  (`Nov 15 2023`, contextual). These are functions of `(timestamp, offset,
  now)`; their bytes change as wall-clock advances, so cross-tool interop
  **cannot** pin them (git and tsgit would have to capture the identical
  microsecond).

The prime directive pins faithfulness with interop goldens. The now-dependent
modes break that mechanism, not faithfulness itself.

- **A — absolute only.** Support the deterministic modes; refuse
  `relative`/`human` with a typed error (documented divergence: a library can't
  emit a now-relative string a golden could pin).
- **B — include relative/human.** Implement git's `show_date_relative` /
  `show_date_human` faithfully, reading the current time internally (as
  `revParse`'s `@{date}` already does); cover them with deterministic structural
  unit tests (injected `now`) instead of interop goldens.

## Decision

**Option B** (user-selected). Implement every mode:

- Absolute modes are pure `(ts, offset)` formatters, **interop-pinned** against
  `git show --date=<mode>`.
- `local` uses the host timezone (JS `Date` local components, no `±ZZZZ`); the
  interop case fixes `TZ` so git and tsgit share a zone — with a structural
  fallback if Node's runtime `TZ` proves unreliable.
- `relative`/`human` port git's algorithms and read `now` internally. They are
  **excluded from interop** (now-dependent) and covered by example tests with an
  injected `now` walking git's threshold boundaries (seconds→minutes→…→years,
  the `human` year/time-omission rules). The injected-`now` seam keeps the unit
  tests deterministic.

Unknown date modes raise typed `INVALID_OPTION` (`option: 'date'`).

## Consequences

### Positive

- Full `--date=` parity, including the common `relative` mode.
- Determinism preserved in CI: interop pins the absolute modes; the now-dependent
  ones are pinned structurally with an injected clock.

### Negative

- `relative`/`human` faithfulness rests on ported-algorithm review + structural
  tests, not byte-goldens — a weaker guarantee, explicitly recorded.
- `show` acquires an internal clock read for the now-dependent modes (mirrors
  `revParse`).

### Neutral

- The injected-`now` seam is internal (not a public `ShowOptions` field);
  production reads the real clock.
