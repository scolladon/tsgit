# ADR-206: `log` message returns the raw commit-object body, trailing `\n` included

## Status

Accepted (at `7fb82649a6fb68d81b8cceca4c5bc7f14dd59120`)

## Context

`test/browser/surface-parity.spec.ts › log` has failed on `e2e (chromium)` and
`e2e (firefox)` since PR #93 (commit-message `stripspace` normalization). The
test expects `repo.log()` to return commit messages `['second commit', 'seed commit']`,
but the readback is `['second commit\n', 'seed commit\n']`.

Investigation established that this is **not** a browser-specific or
timing-dependent defect. `repo.log()` is a pure pass-through to `commands.log`,
which yields the commit body straight from the platform-independent domain parser
`splitHeaderAndMessage` — the raw bytes after the `\n\n` header separator,
verbatim. Since PR #93, the `commit` porcelain runs `stripspace`, which
guarantees the stored message ends with exactly one `\n` (ADR 203). So the stored
object body is `second commit\n`, and `repo.log()` faithfully returns
`'second commit\n'` on every platform. PR #93 updated the **Node** unit
assertion (`log.test.ts:85`: `['third','second','first']` → `['third\n',…]`) but
left the **browser** expectation stale; the browser job went red at PR #93.

The fix forks two ways, and the choice is load-bearing because it decides what
`repo.log().message` *means*:

- **A — keep the raw body, fix the stale test.** `message` is the verbatim
  object body, trailing `\n` included; update the browser expectation to match.
- **B — strip the trailing `\n` in production.** Make `message` the logical
  subject/body without the structural newline, and revert the Node assertion.

## Decision

**Option A.** `repo.log().message` returns the raw commit-object body verbatim,
including the trailing `\n` that `stripspace` guarantees. The browser
surface-parity expectation is corrected to `['second commit\n', 'seed commit\n']`.
No production code changes.

Rationale:

- **Git-faithful.** The on-disk commit body genuinely is `second commit\n`
  (`git cat-file commit`). The raw body is the faithful readback; stripping is a
  porcelain convenience (`git log --format=%s`), not the message itself.
- **Ecosystem-consistent.** isomorphic-git returns `commit.message` with the
  trailing `\n`.
- **Already the established contract.** The Node `log` unit test has asserted
  `'third\n'` since PR #93, and the `commit`/`createCommit` seam (ADR 203)
  deliberately stores the normalized body and reads it back verbatim.

## Consequences

### Positive

- Un-reds `e2e (chromium)` / `e2e (firefox)` with zero production risk.
- `repo.log().message` semantics are now documented and pinned on both Node and
  browser, so a future reader will not "fix" the trailing `\n` by stripping.
- Reinforces the `stripspace` faithfulness story rather than reopening it.

### Negative

- Callers wanting a `\n`-free subject must trim themselves. Acceptable: that is a
  `--format=%s` concern, deferred under YAGNI until a backlog item needs it.

### Neutral

- The browser `log` scenario carries a why-comment explaining the trailing `\n`.
- webkit continues to skip every OPFS scenario (Playwright headless WebKit does
  not expose `navigator.storage.getDirectory`) — unchanged by this decision.

## Alternatives considered

- **Option B — strip in production + revert the Node assertion.** Rejected: more
  invasive, diverges from the raw object body and from isomorphic-git, and
  reopens the `stripspace` faithfulness story for no user benefit.
