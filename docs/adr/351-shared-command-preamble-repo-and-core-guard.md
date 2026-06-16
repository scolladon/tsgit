# ADR-351: Shared command preamble — the universal `assertRepository` + eager core guard pair

## Status

Accepted (supersedes ADR-348's deferral of the shared preamble)

## Context

ADR-348 wired the eager `core` path-likes guard into the 37 non-exempt commands as a per-command pair: `await assertRepository(ctx); await assertNoValuelessCoreConfig(ctx);` immediately at each command's entry. ADR-348 deliberately chose per-command placement because no shared command preamble existed, and explicitly deferred building one as "a separable architectural design, its own ADR." The code review flagged the 37 identical two-line sequences as duplication worth centralizing. The user folded the preamble into this PR.

## Decision

Introduce a single **minimal** shared preamble helper that performs the only truly universal pair — repository assertion + the eager core guard — and route the 37 non-exempt commands through it:

```
export const assertCommandPreamble = async (ctx: Context): Promise<void> => {
  await assertRepository(ctx);
  await assertNoValuelessCoreConfig(ctx);
};
```

- **Minimal, not richer.** It absorbs ONLY `assertRepository` + `assertNoValuelessCoreConfig` — the pair every non-exempt command shares. It does NOT absorb `assertNotBare` / `assertNoPendingOperation` / the branch guard: those are command-specific (not universal), and folding them behind boolean flags would (a) violate the project's no-boolean-params guideline and (b) risk firing an assert where git does not. Each command keeps its own bare/pending/branch calls *after* the preamble, preserving today's exact ordering (e.g. `pull`: preamble(repo→core) → bare → pending → branch → fetch).
- **Scope.** The 37 commands that today call the pair switch to `assertCommandPreamble`. The exempt `config` / `init` / `clone` keep calling bare `assertRepository` (they must NOT get the core guard — ADR-348 C2/C11).
- **Behavior-preserving.** Same asserts, same order, same observable refusals; this is a pure consolidation of two calls into one at each site.

## Consequences

### Positive

- One home for the universal command precondition pair; a future cross-cutting per-command assert is added in one place, not 37.
- Removes the 37 two-line duplications the review flagged; each command's entry reads as one intent-revealing call.

### Negative

- Re-touches the same 37 command files the ADR-348 slices just edited (a two-line→one-line swap each). The diff is mechanical but broad; the existing per-command throw tests are the safety net (they must still fire through the preamble).

### Neutral

- The preamble is intentionally not a general "command middleware" framework — just the universal pair (YAGNI). Commands with richer preambles keep composing their own asserts explicitly after it.
