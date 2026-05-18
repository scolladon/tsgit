# ADR-036: `.gitignore` (and friends) reads are capped at 1 MiB

## Status

Accepted (at `8cd131f`)

## Context

§14.3 reads up to four `.gitignore`-shaped files PER repository, plus
one extra per descended subdirectory. Each is `fs.readUtf8`'d into a
string, then handed to `parseGitignore`. Without a cap, a hostile or
broken `.gitignore` (gigabytes, deliberately crafted to OOM a CI
runner) could exhaust memory before the parser sees the first line.

The §13.8 + §14.1 precedent is: cap reads at a published constant,
fail fast with a typed error carrying path + size + limit.

## Decision

Introduce `MAX_GITIGNORE_BYTES = 1 * 1024 * 1024` (1 MiB) and a new
`CommandError` variant `GITIGNORE_FILE_TOO_LARGE` with `path`, `size`,
and `limit`. The loader `lstat`s before reading; if `stat.size`
exceeds the cap, it throws. No partial parse happens. The error is
raised at the application layer (loader), not the domain (parser).

The cap is 1 MiB rather than the 256 MiB used by §14.1's working-tree
blobs because a `.gitignore` is a config file, not a blob. The
largest real-world `.gitignore` we surveyed (the GitHub
`.gitignore` repository's combined templates) is under 50 KiB. A
1 MiB ceiling leaves a 20× safety margin; anything larger almost
certainly indicates corruption or attack.

## Consequences

### Positive

- Bounds peak memory predictably. CI runners with tight memory caps
  won't OOM on adversarial input.
- Symmetric with `WORKING_TREE_FILE_TOO_LARGE` (§14.1) and
  `OBJECT_TOO_LARGE` (§13.8) — same shape of error payload, same
  diagnostic pattern.

### Negative

- A legitimate-but-pathological `.gitignore` over 1 MiB would be
  rejected. The cap can be tuned if real cases surface; bumping a
  constant is a one-line change.

### Neutral

- New error variant adds one row to `CommandError` and one
  `extractDetail` arm. Standard pattern in this codebase.
