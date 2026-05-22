# ADR-077: `compileGlob` compiles to a linear, non-backtracking matcher

## Status

Accepted (at `38f345e`)

## Context

`compileGlob` (`src/domain/pathspec/compile-glob.ts`) turns a glob into a
`RegExp`. The compiled regex backtracks catastrophically: `a*a*a*…*b`
(anchored) compiles to `/^a[^/]*a[^/]*…a[^/]*b$/`, and matching it against a
long `a`-run with no `b` is exponential. The unanchored `(^|.*/)` prefix adds
a second backtracking layer. `compileGlob` is shared by `.gitignore`
(`parseGitignore`), pathspec (`compilePathspec`) and sparse-checkout
(`compileSparseRule`); a `.gitignore` file is clone-transferred, so a hostile
pattern is a remote denial-of-service vector (backlog 17.3b).

The fix must work on tsgit's full runtime floor — Node 18, Chrome 90,
Firefox 100, Safari 15.4. Two regex-preserving options were considered:

- **Atomic groups `(?>…)` / possessive quantifiers `*+`** make the regex
  backtrack-free, but JavaScript gained them only in a recent V8/JSC; they are
  not available on tsgit's minimum browser targets. Not portable.
- **A timeout around `RegExp.test`** is impossible: JS regex execution is
  synchronous and uninterruptible.

## Decision

Replace the regex with a **hand-written linear matcher**.

- The pattern is tokenised once into a `GlobToken[]` (`literal`, `single` for
  `?`, `star` for `*`, `star-star` for `**`, `star-slash` for `**/`), reusing
  the existing cursor logic so tokenisation is structurally identical to the
  old regex builder.
- Matching is a backward dynamic program over `(token, path position)` — a
  boolean table, filled in `O(tokenCount × pathLength)`. It **never
  backtracks**: no input can make it super-linear.
- The unanchored `(^|.*/)` prefix is exactly `(.*/)?` and is modelled as one
  extra `star-slash` step; `withDirSuffix`'s `(/.*)?$` is modelled in the
  table's base case.
- `compileGlob` returns a `GlobMatcher` — `{ test(path: string): boolean }` —
  instead of a `RegExp`. Every call site already used only `.test(path)`, so
  `GlobMatcher` is a drop-in: zero `.test` call-site churn.
- `SparseRule.regex` is **renamed to `SparseRule.matcher`** — the value is no
  longer a regex; a field named `regex` holding a `GlobMatcher` would mislead.
  `IgnoreRule.compiled` and `PathspecEntry.compiled` keep their names ("the
  compiled form" stays accurate).

## Consequences

### Positive

- The ReDoS vector is closed: glob matching is provably linear, on every
  supported runtime, with no dependency on modern regex features.
- A drop-in return type — the three consumers and the existing
  `compile-glob.test.ts` need no `.test`-site changes.
- No escaping logic: with no regex involved, every non-glob character
  (including regex metacharacters) is matched verbatim by a `literal` token.

### Negative

- A hand-written matcher is code tsgit must own and test, versus delegating to
  the platform `RegExp`. Mitigated by a property-based equivalence test that
  pins the matcher against the old regex compiler (kept as a test oracle) over
  the input domain on which the two must agree.
- `O(tokenCount × pathLength)` is linear but not constant; a very long pattern
  against a very long path costs proportionally. This is bounded and not a DoS
  — the exponential blow-up is what mattered, and it is gone.

### Neutral

- `**` now spans line terminators (`\n`, `\r`, `U+2028`, `U+2029`), which the
  old `.`-based regex excluded. This is an intentional, git-faithful
  correction of a latent quirk — git's `**` spans any byte. Unobservable for
  real repositories, since git rejects most control bytes in tracked paths.
- `containsGlob` is a separate pure string scan and is unchanged.
