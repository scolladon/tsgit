# ADR-163: `isIgnored` returns detailed match info per path

## Status

Accepted (at `7d04c08`)

## Context

`isIgnored` is the second primitive shipped in Phase 20.2. The question
is the return shape:

1. **Detailed match info** — `{ ignored, source?, line?, pattern? }`
   per path. Mirrors `git check-ignore -v`. The caller can surface
   "why is this ignored?" to a user without re-running the matcher.
2. **Plain boolean** — `boolean[]` (or scalar). Smallest surface;
   callers who want the matching rule have to load and walk gitignore
   files themselves.
3. **Two functions** — `isIgnored` (bool) + `checkIgnore` (detailed).
   Closer to the git CLI's two-affordance split; doubles the
   primitive surface area.

`git check-ignore -v` is the canonical UX our tooling competitors
(isomorphic-git, libgit2-bindings) deliberately omit. Phase-20-onward
porcelain (`stash`, `status --verbose`, dev-tool integrations) needs
the detailed shape; covering both audiences with one primitive avoids
a second walker pass.

## Decision

Option (1): `isIgnored(queries)` returns
`ReadonlyArray<IsIgnoredMatch>`, where each match carries an `ignored`
boolean and, when `ignored === true`, a `source` object with `kind`,
`basedir`, `line`, and `pattern`. The boolean-only audience reads
`.ignored` and ignores the rest. The discriminant is unambiguous —
`ignored === true ⇒ source !== undefined`.

To make the `source` field accurate we extend two domain modules
(both additively):

- `parseGitignore` attaches `lineNumber` (1-based) to every parsed
  `IgnoreRule`.
- `IgnoreLevel` gains `kind?: 'global' | 'info' | 'gitignore'`
  (defaults `'gitignore'`) so the three base levels at `basedir ===
  ''` can be told apart in the response.

`buildRepoIgnorePredicate`'s boolean return is unchanged — the
boolean and verbose paths share the loop via a new
`matchInStackVerbose` sibling.

## Consequences

### Positive

- One primitive covers both the boolean and the diagnostic-tooling
  audiences.
- Surfaces meaningful context for "why is my file ignored?" — the
  most common gitignore debugging question.
- Domain extensions (`lineNumber`, `IgnoreLevel.kind`) are additive,
  protecting the 19.6 property tests for `parseGitignore`.

### Negative

- The return type carries optional fields, which the type checker
  forces every caller to narrow. Mitigated by the doc snippet:
  `result.filter(r => r.ignored)`.
- `'unignored'` (a negation rule was the last match) maps to the
  same `{ ignored: false, source: undefined }` shape as `'unset'`
  (no rule matched). Callers that need to distinguish those two
  cases can't today — we widen the type additively if a real caller
  proves the need.

### Neutral

- The CLI-style `git check-ignore` verb gets no Tier-1 facade — the
  primitive is enough. If a 21.x phase needs CLI parity we add the
  facade then.
- `matchInStack` keeps its current signature — the verbose path is a
  new sibling, not a breaking change.

## Alternatives considered

- **Option 2 (plain boolean)** — rejected: the detail half is exactly
  the differentiator vs. competitors. Forcing every caller to re-walk
  ignore files for the matching rule is the kind of avoidable
  duplication CLAUDE.md "Composition over reimplementation" rules out.
- **Option 3 (two functions)** — rejected: doubles the API surface
  for a tiny ergonomic win. The detailed shape's boolean is just
  `.ignored` — there is no friction.
