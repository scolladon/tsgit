# ADR-279: `range-diff` returns the correspondence list plus a structured diff-of-diffs

## Status

Accepted

## Context

Backlog **23.6** `range-diff` compares two versions of a patch series. Git's
default output has two layers: the **correspondence lines** (`git range-diff -s`)
— `<oldNo>:  <oldSha> <marker> <newNo>:  <newSha> <subject>` with marker
`= ! < >` — and, for each **changed** (`!`) pair, a **diff-of-diffs** body: git
diffs the two commits' specially-formatted `## ` patch texts (metadata + message
+ line-number-stripped diff) and renders it with a 2-level `+`/`-`/` ` prefix.

The correspondence is a min-cost bipartite **assignment** (the novel algorithm).
The diff-of-diffs is a diff over a rendered intermediate (the `## ` text). Per
ADR-249 ("structured output, not cosmetics") and the 23.2a precedent (which
dropped patch rendering from `show`/`diff`, returning structured `TreeDiff`), a
pre-rendered body string is forbidden — the library ships fields, the caller
formats. So the question is **how much** to expose:

- **(A) Correspondence list only** (= `git range-diff -s`). The assignment is the
  faithful datum; the diff-of-diffs is re-derivable by the caller (heavy: it must
  reproduce git's `## ` format + 3-context diff). Smallest surface, most
  ADR-249-pure.
- **(B) Correspondence list + structured diff-of-diffs.** Additionally attach, to
  each `changed` entry, the structured `LineDiff` over the two `## ` patch texts.
  The engine already renders those texts (for exact-match hashing and the cost
  matrix), so the `LineDiff` is one extra `diffLines` call. The caller still
  applies the outer prefix/indent/colour to render the body string. Carries a
  diff-over-rendered-text in the data model (less ADR-249-pure), larger surface.

Verified: git emits a body **only** for `changed` pairs — creations (`>`),
deletions (`<`), and unchanged (`=`) get the header line and no body.

## Decision

**(B)** — return the ordered correspondence list, and attach `diffOfDiffs` (a
diff-domain `LineDiff`, `diffLines(old.patch, new.patch)`) to each entry whose
status is `changed`. `=`/`<`/`>` entries carry no `diffOfDiffs` (git emits none).

The `LineDiff` is structured (hunks of `common`/`ours-only`/`theirs-only` line
ranges + the `## `-text line arrays), not a pre-rendered string. The byte body git
prints — the outer `+`/`-`/` ` prefix, 4-space indent, dual-colour — stays a
caller projection, as does the `-s` line itself (number padding, oid abbreviation,
dash run) and `--left-only`/`--right-only` (filters over the entry list).

## Consequences

### Positive

- Delivers the full range-diff value structurally: a consumer gets both the
  assignment and the per-pair change without re-deriving git's `## ` format.
- The engine renders the `## ` texts anyway; exposing the `LineDiff` is nearly
  free at runtime.
- Both layers are byte-reconstructable in interop (the `-s` lines from
  status/positions/oids/subject; the body from `diffOfDiffs`), pinning
  faithfulness end-to-end.

### Negative

- The `LineDiff`'s `oursLines`/`theirsLines` are the `## ` patch-text bytes — a
  rendered intermediate in the data model, a softening of the ADR-249 "fields not
  rendering" stance. Accepted deliberately: the diff-of-diffs *is* range-diff's
  payload, and the alternative forces every caller to re-implement git's `## `
  formatter to get a faithful body.

### Neutral

- `diffOfDiffs` is optional (present iff `changed`), so `=`/`<`/`>` entries stay
  lean; `LineDiff` is an already-public diff-domain type (no new vocabulary).
- The rendered body string remains out of scope (caller projection), consistent
  with `show`/`diff` post-23.2a.
