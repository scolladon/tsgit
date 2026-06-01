# ADR-231: patch-id is an internal equivalence key; drop-set parity, not hex-identity

## Status

Accepted (at `06489642`)

## Context

`git rebase` drops commits already present upstream (cherry-pick equivalents) by
default — verified: a `dup` commit cherry-picked onto `main` beforehand is
silently absent from the rebased history, appearing in neither the todo, `done`,
nor the reflog. Reproducing this is required for faithful output (otherwise the
rebased graph carries commits git would have dropped).

git detects equivalence via patch-id. The planning conversation chose **faithful
patch-id pre-drop** (drop before the replay loop, like git) over post-replay
empty-dropping. The open question: must tsgit's patch-id match `git patch-id`'s
hex byte-for-byte?

`git patch-id`'s exact canonicalization (header construction, `@@`-header
handling, `remove_space` rules) is intricate and version-sensitive; an empirical
reverse-engineering attempt did not reproduce the hex in a few tries. Critically,
the patch-id is **never persisted to a state file and never surfaced in the API**
— it is purely an internal key for the drop decision.

## Decision

tsgit computes a patch-id that replicates git's **equivalence semantics** — per
file (sorted by path), the diff content with hunk `@@` headers and the
`diff`/`index`/`---`/`+++` marker lines excluded, line numbers ignored, intra-line
whitespace removed — so tsgit's equivalence **classes** match git's. A candidate
in `mergeBase..head` is dropped when its patch-id collides with one in
`mergeBase..upstream`.

Faithfulness is pinned by **observable drop-set parity**, not hex-identity: an
interop test rebases the same fixture under tsgit and git and asserts they drop
the identical commits. Byte-identity with `git patch-id`'s hex is explicitly
**not** a requirement, because the id is not observable.

## Consequences

### Positive

- Faithful observable behaviour (the dropped-commit set matches git) without
  coupling to git's brittle, version-sensitive patch-id hex.
- The patch-id primitive reuses the existing diff infrastructure (20.3).

### Negative

- The proof is fixture-based drop-set parity rather than a closed-form hex match;
  a pathological equivalence edge git handles differently could escape the
  fixtures. Mitigated by covering content-offset and whitespace cases.

### Neutral

- If a future need arises to expose patch-id (e.g. `git patch-id` porcelain), the
  hex canonicalization can be made exact then — out of scope here.
