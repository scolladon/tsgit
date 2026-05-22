# Harden `compileGlob` against catastrophic backtracking — Design (17.3b)

> Status: Draft. Backlog item **17.3b** — "Harden `compileGlob` against
> catastrophic backtracking (ReDoS)". New ADR: 077.

## 1. Goal & scope

`src/domain/pathspec/compile-glob.ts` compiles a glob pattern to a `RegExp`.
The compiled regex backtracks catastrophically on an adversarial pattern.

`compileGlob('a*a*a*…*b', { anchored: true })` produces
`/^a[^/]*a[^/]*…a[^/]*b$/`. Tested against `'aaaa…aaaa'` (a long run of `a`
with no `b`), each `[^/]*` can split the run in many ways and the engine
explores them all — exponential time. The unanchored `(^|.*/)` prefix adds a
second backtracking layer. `compileGlob` is reachable from
**`.gitignore`** (`parseGitignore`), **pathspec** (`compilePathspec`), and
**sparse-checkout** (`compileSparseRule`). A `.gitignore` file is
clone-transferred — the real attack surface — so a hostile pattern there can
hang any consumer that lists or matches paths.

**17.3b replaces the regex with a linear, non-backtracking matcher.** Behaviour
is preserved for every non-adversarial input; the three consumers keep passing
their full unit, integration and mutation suites.

### Out of scope

- Character classes (`[abc]`), `{a,b}` alternation, git magic pathspec
  prefixes — unsupported in v1, unchanged.
- `containsGlob` — a pure string scan, untouched.

## 2. Why a linear matcher (not a "safe regex")

JavaScript regex has no DoS-proof escape hatch on tsgit's runtime floor:

- **Atomic groups `(?>…)` / possessive quantifiers `*+`** eliminate the
  backtracking but were added to V8 only recently. tsgit targets Chrome 90,
  Firefox 100, Safari 15.4 and Node 18 — none guaranteed to support them.
  Not portable.
- **A timeout around `RegExp.test`** is impossible — JS regex execution is
  synchronous and uninterruptible.

A hand-written matcher that never backtracks is the only portable fix. The
glob grammar (`*`, `?`, `**`, `**/`, literals) is regular and small, so a
linear matcher is short and total. See [ADR-077](../adr/077-linear-glob-matcher.md).

## 3. The `GlobMatcher` interface

`compileGlob`'s return type changes from `RegExp` to a `GlobMatcher`:

```ts
/** A compiled glob — `test` reports whether a path matches it. */
export interface GlobMatcher {
  test(path: string): boolean;
}
```

Every existing call site uses only `.test(path)` (`rule.compiled.test(path)`,
`entry.compiled.test(path)`, `rule.regex.test(path)`). `GlobMatcher` is the
exact structural shape `RegExp` already satisfied for that use, so the change
is a **drop-in**: no `.test` call site changes, and the existing
`compile-glob.test.ts` (which calls `sut.test(...)`) is unchanged.

Consumer field types change `RegExp → GlobMatcher`:

- `IgnoreRule.compiled` — name kept (still "the compiled form").
- `PathspecEntry.compiled` — name kept.
- `SparseRule.regex` — **renamed to `SparseRule.matcher`**: the value is no
  longer a regex, and a field called `regex` holding a `GlobMatcher` would
  mislead. `nonConeMatcher` updates `rule.regex.test` → `rule.matcher.test`.

`compileGlob` returns a plain object `{ test }` closing over the compiled
token list — a pure value, no `RegExp` `lastIndex` state to worry about.

## 4. Tokenisation

The pattern is scanned **once** into a `GlobToken[]`. The scan reuses the exact
cursor logic the regex compiler already had (`scanStar`'s `**/` /  `**` /
`*` disambiguation), so tokenisation is byte-identical to the old regex's
structure — only the emitted unit changes from a regex fragment to a token.

```ts
type GlobToken =
  | { readonly kind: 'literal'; readonly char: string } // one literal char
  | { readonly kind: 'single' }        // `?`  — one non-`/` char
  | { readonly kind: 'star' }          // `*`  — run of non-`/` chars
  | { readonly kind: 'star-star' }     // `**` (no trailing `/`) — run of any
  | { readonly kind: 'star-slash' };   // `**/` — zero+ `<segment>/` runs
```

- `*` → `star`. `**` not followed by `/` → `star-star`. `**/` → `star-slash`
  (the `/` is consumed). `***` → `star-star` then `star` (unchanged).
- `?` → `single`.
- Any other char → `literal` — including regex metacharacters (`.`, `+`, `(`,
  `[`, …): with no regex involved there is nothing to escape, every non-glob
  char is matched verbatim. (Confirms the existing "character classes are
  literal in v1" behaviour.)

## 5. The matcher — a linear dynamic program

Matching is a backward dynamic program over `(token index, path position)`.
Let `n = path.length`. A boolean vector `dp` of length `n + 1` holds, after
processing tokens `i …` , the predicate **"`tokens[i…]` matches `path[j…]`"**
for each `j`.

**Base** (no tokens left — the suffix). `withDirSuffix` accepts a trailing
descendant (`(/.*)?$`):

```
dp[j] = (j === n) || (withDirSuffix && path[j] === '/')
```

**Step** — for each token from last to first, derive a new `dp` from the old:

| token        | recurrence (`cur` from `next`) |
|--------------|--------------------------------|
| `literal c`  | `cur[j] = j<n && path[j]===c && next[j+1]` |
| `single`     | `cur[j] = j<n && path[j]!=='/' && next[j+1]` |
| `star`       | `cur[j] = next[j] \|\| (j<n && path[j]!=='/' && cur[j+1])` |
| `star-star`  | `cur[j] = next[j] \|\| (j<n && cur[j+1])` |
| `star-slash` | `cur[j] = next[j] \|\| seg[j]`, where `seg[j] = j<n && ((path[j]==='/' && next[j+1]) \|\| seg[j+1])` |

`star` / `star-star` / `star-slash` reference `cur[j+1]` (or `seg[j+1]`), so
each step iterates `j` from `n` down to `0` — one linear pass. `star-slash`
encodes `(.*/)?`: it matches the empty string (`next[j]`) or any consumed run
that **ends in `/`** (`seg`).

**Anchoring.** The unanchored prefix `(^|.*/)` is exactly `(.*/)?` — a
`star-slash`. So an unanchored match applies one final `star-slash` step after
the body tokens. An anchored match does not.

**Result:** `dp[0]` after all steps.

Complexity: `O(tokenCount × n)` — for the adversarial `a*a*…*b` the chained
`star` tokens cost a fixed linear pass each, never an exponential split. No
input can make it backtrack, because it never backtracks: it fills a table.

## 6. Behavioural equivalence & the line-terminator note

The matcher reproduces the old regex for every path that contains no JS line
terminator (`\n`, `\r`, `U+2028`, `U+2029`).

The old regex used `.` (in `**` → `.*` and the `(^|.*/)` / `(/.*)?` parts),
and JS `.` excludes line terminators. So the old `compileGlob('a**b')` would
**not** match `'a\nb'`. The linear matcher's `star-star` matches *any* char,
so it **does** match `'a\nb'`. This is an **intentional** correction: git's
`**` (via `fnmatch`/`wildmatch`) spans any byte, newline included; the old
regex's exclusion was a latent bug. Git itself rejects most control bytes in
tracked paths, so the divergence is unobservable for real repositories — but
where it shows, the new behaviour is the git-faithful one. ADR-077 records
this. The property-based equivalence test (§8) restricts generated paths to
line-terminator-free strings precisely because that is the domain on which the
two implementations are required to agree.

## 7. File layout & changes

| File | Change |
|------|--------|
| `src/domain/pathspec/compile-glob.ts` | `GlobMatcher` interface; `compileGlob` returns it; tokeniser + linear matcher replace the regex builder. `containsGlob` unchanged. |
| `src/domain/pathspec/index.ts` | export `GlobMatcher` |
| `src/domain/pathspec/compile-pathspec.ts` | `PathspecEntry.compiled: RegExp → GlobMatcher` |
| `src/domain/ignore/parse-gitignore.ts` | `IgnoreRule.compiled: RegExp → GlobMatcher` |
| `src/domain/sparse/sparse-pattern.ts` | `SparseRule.regex: RegExp → matcher: GlobMatcher` |
| `src/domain/sparse/non-cone.ts` | `compileSparseRule` sets `matcher`; `nonConeMatcher` reads `rule.matcher.test` |

No new files. No port/adapter changes. No public-API change beyond the
`compileGlob` return type and the `SparseRule` field rename.

## 8. Testing strategy

**Conventions** (CLAUDE.md): `Given/When/Then` titles, AAA body, `sut`, 100%
coverage, 0 surviving mutants.

### Unit — `compile-glob.test.ts`

- The existing 12 cases stay (they call `sut.test(...)`, unchanged).
- Add per-token-kind cases that pin each recurrence row of §5: `literal`,
  `single`, `star`, `star-star`, `star-slash`, anchored vs unanchored,
  `withDirSuffix`, empty pattern, `***`.
- **ReDoS regression** — `compileGlob('a*'.repeat(64) + 'b', { anchored: true })`
  `.test('a'.repeat(10_000))` returns `false` and the test completes well
  within the runner timeout. Catastrophic backtracking would hang the test —
  its mere completion is the guard; an explicit elapsed-time bound makes the
  intent visible.
- **Equivalence property test** (`fast-check`) — for a random glob pattern
  and a random line-terminator-free path, the new matcher agrees with a
  reference regex built by the *old* compiler (inlined in the test as the
  oracle). This proves no behavioural regression across the input space the
  two are required to agree on.

### Consumers — regression

`parse-gitignore`, `compile-pathspec` / `match-pathspec`, `non-cone` /
`parse-sparse-checkout` keep their existing unit suites; the integration
suites (`gitignore-end-to-end`, `sparse-checkout`) and their interop blocks
must stay green unchanged — the behavioural contract is identical.

### Mutation

`stryker run` over `compile-glob.ts`, `non-cone.ts`, `compile-pathspec.ts`,
`parse-gitignore.ts`. Equivalent mutants accepted only with an inline
`// equivalent-mutant:` justification.

## 9. Key decisions

1. **Linear matcher, not a "safe regex"** — atomic groups / possessive
   quantifiers are not portable to tsgit's runtime floor; a regex timeout is
   impossible in JS ([ADR-077](../adr/077-linear-glob-matcher.md)).
2. **`compileGlob` returns a `GlobMatcher` (`{ test }`)** — a drop-in for the
   `RegExp` shape every call site already used; zero call-site churn.
3. **`SparseRule.regex` → `SparseRule.matcher`** — the field no longer holds a
   regex; the name is corrected.
4. **`**` spans line terminators** — an intentional, git-faithful correction
   of a latent quirk in the old `.`-based regex.

## 10. ADR index

| ADR | Title |
|-----|-------|
| [077](../adr/077-linear-glob-matcher.md) | `compileGlob` compiles to a linear, non-backtracking matcher |
