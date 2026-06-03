# ADR-246: pretty-format breadth — named + custom engine + email/mboxrd + decoration

## Status

Accepted (at `4492407b`)

## Context

`--pretty`/`--format` is git's largest output knob: ~9 named formats
(`oneline`, `short`, `medium`, `full`, `fuller`, `raw`, `reference`, `email`,
`mboxrd`) plus a `format:`/`tformat:` placeholder mini-language (dozens of
`%`-codes). Some placeholders need extra machinery: `%d`/`%D` (decoration) must
scan every ref to find which point at a commit; `email`/`mboxrd` emit an mbox
envelope (`From <oid> Mon Sep 17 …`, `Subject: [PATCH] …`).

How broad should the faithful surface be?

- **A — core only.** Named formats `oneline`…`reference` + `format:`/`tformat:`
  with the common placeholders; refuse `email`/`mboxrd` and decoration
  (`%d`/`%D`) with typed `UNSUPPORTED`, deferred.
- **B — core + email/mbox + decoration.** Everything in A plus the mbox
  formats and the decoration placeholders (ref-scan machinery).

## Decision

**Option B** (user-selected). Implement all named formats including
`email`/`mboxrd`, and the `format:`/`tformat:` engine including decoration:

- **named**: `oneline` (full oid + subject), `short`, `medium` (default),
  `full`, `fuller`, `raw`, `reference`, `email`, `mboxrd`.
- **custom**: hashes (`%H %h %T %t %P %p`), author/committer idents and dates
  (`%an %ae %ad %aD %ai %aI %at %as %ar %ah` and `%c*`), message (`%s %f %b %B
  %e`), decoration (`%d %D`), literals (`%n %% %xXX`); unknown `%?` pass through
  verbatim (git's behaviour).
- **decoration**: an `oid → labels` map from `enumerateRefs`, ordered as git
  does (`HEAD -> <branch>`, branches, `tag: <name>`, remotes).

Patch framing (blank line vs none vs separator-style) is resolved per format by
a dedicated lookup, pinned by interop. Unknown *named* formats still raise
typed `INVALID_OPTION`.

`email`/`mboxrd` single-object `show` always emits `Subject: [PATCH] <subject>`
(no series `n/m`); very long subject wrapping is pinned by interop and any
residual wrapping edge documented as a limitation.

## Consequences

### Positive

- Near-complete `--pretty` parity in one pass; `%d`/`%D` and the mbox formats
  work, not just the headers.
- The `%`-engine is one pure, table-driven transform reused by every custom
  template and by `reference`.

### Negative

- Largest non-diff surface in the item; decoration adds a ref-scan dependency
  (`enumerateRefs`) to `show`.
- The placeholder catalogue is large; the long tail (color/padding placeholders,
  `%N` notes, `%(trailers)`) stays out of scope (unknown-passthrough or
  documented), not silently mis-rendered.

### Neutral

- `format`/`date` interplay: `%ad`/`%cd` honour `--date=` (§ADR-247).
