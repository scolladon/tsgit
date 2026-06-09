# ADR-301: Informational-hook semantics — ignore exit code; `prepare-commit-msg` bypasses `--no-verify`; `clone` `post-checkout` omitted

## Status

Accepted (at `b3c53efa`)

## Context

The six new hooks split into two classes with different git semantics, and three
faithfulness details govern when and how they fire. These are determined by
canonical git's behaviour (the prime directive), not by tsgit preference, but
they are load-bearing enough to record.

1. **Exit-code handling.** `pre-rebase` / `prepare-commit-msg` are *blocking* — a
   non-zero exit aborts the operation before it mutates state. `post-commit` /
   `post-merge` / `post-checkout` / `post-rewrite` are *informational* — they
   fire **after** the operation has completed (refs moved, objects written,
   working tree materialised); git runs them and ignores their exit code (at
   most a warning).
2. **`--no-verify` scope.** `git commit`'s `--no-verify` bypasses **only**
   `pre-commit` and `commit-msg`. `prepare-commit-msg` runs regardless.
3. **`clone`'s `post-checkout`.** git fires `post-checkout` after a clone's
   initial checkout — but hooks are never transferred over the wire, and a
   freshly-created repo has only non-executable `*.sample` hooks.

## Decision

1. Informational hooks route through a new non-throwing primitive
   `runInformationalHook` (sibling to `runHook`, sharing an extracted
   `invokeHook`): absent runner / `skipped` / **any** exit code → no throw, no
   return value. tsgit cannot faithfully "abort" a finished operation — the
   on-disk SHAs/refs/state are already the faithful end result — so the exit
   code is discarded. This is not a swallowed error: the port never rejects, the
   hook ran to completion, and discarding the code is git's own policy.
   (`post-checkout`'s documented "exit status becomes the command's exit status"
   does not undo the checkout; tsgit, a library with no process exit code and a
   structured result, treats it as informational — observable state is identical
   either way.)
2. `prepare-commit-msg` is gated on the runner existing, **not** on `noVerify`;
   `commit-msg` keeps its `noVerify` gate. So a `--no-verify` commit still runs
   `prepare-commit-msg`, faithfully.
3. `clone`'s `post-checkout` is **omitted** as observationally inert: there is no
   point in the program where a user could install an executable hook before
   clone's own checkout, so the call would always resolve to `skipped`. Wiring
   it would add an unreachable branch (a permanent coverage/mutation hole) for
   zero observable behaviour.

## Consequences

### Positive

- The blocking/informational split is explicit in the type of call each command
  makes (`runHook` vs `runInformationalHook`), readable at the firing site.
- `--no-verify` faithfully still runs `prepare-commit-msg`, matching git.
- No unreachable `clone` hook branch to suppress or leave uncovered.

### Negative

- A post-hook that exits non-zero is silent in tsgit (no warning surfaced —
  tsgit emits no human-readable stdout per the structured-output rule). The
  operation's structured result is the faithful end state; a caller wanting the
  hook's output can wire the hook to record it.

### Neutral

- `prepare-commit-msg` now round-trips `COMMIT_EDITMSG` even on the `--no-verify`
  path when a runner is wired. The re-read + sanitise is idempotent for an
  unmodified file, so the committed message is unchanged when no hook edits it;
  when no runner is wired (browser), `COMMIT_EDITMSG` is not written — status
  quo.
