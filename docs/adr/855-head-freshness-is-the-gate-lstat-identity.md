---
subjects:
  - src/application/primitives/internal/repo-state.ts
  - src/application/primitives/internal/ref-store.ts
---
# 855 — HEAD freshness is the gate's `lstat` identity, and adapters without inodes re-read

- **Status:** accepted
- **Date:** 2026-09-11
- **Design:** docs/design/session-caches-per-command-floor.md (D4, DC-5) · **Supersedes/Refines:** none

## Context

`HEAD` is read twice per command: the operational gate does an `lstat` and a `readUtf8` to decide
the repository is usable, and the ref store reads the same file again to resolve it. `revParse('HEAD')`
costs 4 filesystem calls and 13 libuv hops; a warm `catFile` is the gate alone.

Two facts constrain any cache over it. First, a symlinked `HEAD` is currently resolved wrongly:
`readLooseContent` follows the link and returns the branch's object id, so `resolveDirect('HEAD')`
reports **detached** where git reports a symbolic ref to `refs/heads/main` — the gate already
models the link correctly through `isRefsLinkText`, the ref store does not. Second, the identity
key the brief proposed — `(mtime, size, ino)` — is **degenerate on two of three adapters**: the
memory and browser adapters report `ino: 0` for every file with millisecond-resolution times, so
two same-length HEAD rewrites inside one millisecond are indistinguishable. There are 187 raw
`writeUtf8` calls to a HEAD path across 66 unit-test files that do exactly that between commands.

## Options considered

1. **Identity where it is real, re-read where it is not** (recommended, chosen) — trust the
   `lstat` identity across commands only when `ino !== 0`; adapters reporting `ino: 0` re-read at
   each gate and share the bytes within the command.
2. **Content-share only** — the gate always reads, no cross-command trust. Pros: one rule. Cons:
   gives up most of the win on the platform that has the identity.
3. **Identity everywhere, with the memory adapter minting a per-write generation `ino`** — cons:
   changes the memory adapter's stat identity, which the next item's stat-cache work depends on.

## Decision

**Adopted-as-recommended (no user judgment).** Option 1. The ref store becomes the sole reader of
`${gitDir}/HEAD`. A single slot holds the bytes together with the `lstat` identity the gate
observed — `(mtimeNs or mtimeMs, ctimeNs or ctimeMs, ino, size)`. The slot is trusted across
commands only when `ino !== 0`; otherwise it is re-validated by a read at each gate and shared
only within the command. The gate's `lstat` and `readUtf8` collapse into the port's
`openWithNoFollow`, and the reader lives in a module both the gate and the files store import, so
neither has to construct the other.

The sole reader resolves a symlinked `HEAD` as **symbolic**, matching git. Preserving today's
`detached` answer would mean deliberately re-implementing a divergence inside the fix that removes
its cause.

## Consequences

On Node the gate drops from 5 hops to 1 and `revParse('HEAD')` from 13 to 5. On the memory and
browser adapters behaviour is unchanged from today apart from the intra-command share, so no test
that rewrites HEAD raw between commands can go stale.

The pinned faithfulness fix — symlinked HEAD reporting `symbolic` — is an observable change and
carries its own interop test against real git. It moves toward git, so it is a fix rather than a
break, and it is listed in the design's freshness ledger with the rest.

The residual staleness window on Node is a rewrite that leaves `mtimeNs`, `ctimeNs`, `ino` and
`size` all identical, which requires an in-place write inside one nanosecond tick; git's own
lock-and-rename always changes the inode. Within a single command, after its gate, an external
rewrite is not observed — that is the epoch, stated for HEAD exactly as ADR-850 states it for
config.
