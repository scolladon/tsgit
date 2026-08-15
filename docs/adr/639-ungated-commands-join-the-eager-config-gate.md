# 639 — The five ungated commands join the eager config gate

- **Status:** accepted
- **Date:** 2026-08-15
- **Design:** docs/design/depth-caps-and-node-aliases.md (candidate DC-15) · **Supersedes/Refines:** refines ADR-355 (eager full validation of core compression keys); completes ADR-637's repo-wide refusal

## Context

ADR-637 makes an invalid `core.maxTreeDepth` refuse repo-wide, matching git's startup parse, and puts that refusal in the eager operational gate rather than in `readConfig` — the pattern ADR-355 built for `core.compression`. The gate reaches commands through `assertOperationalRepository`: **106 call sites across 39 of 50 command files**.

Eleven command files have no operational gate at all, and the pin splits them. With an invalid `core.maxTreeDepth` in local config, git exits 0 for `config --get`, `config --list`, `config <write>`, `init` and `remote` — so `config.ts`, `init.ts` and `remote.ts` are **correct** as they stand, and gating them would be a divergence. Git exits 128 for `archive`, `bundle-create`, `clone`, `fsck` and `grep`. tsgit currently survives all ten.

Two of the five are themselves depth-cap sites. Left ungated, `archive` and `bundle-create` would resolve a depth cap from a config value git refused to read — the failure is not merely a missing refusal, it is a cap derived from input already known bad.

`bundle-list-heads` and `bundle-verify` are ungated too and share `bundle-create`'s shape, but were **not** pinned. They are not covered by this decision on the strength of a resemblance.

## Options considered

1. **Wire the five to `assertOperationalRepository` (recommended)** — pros: closes exactly the gap the pin measures; one call per command / cons: the five also begin refusing on invalid `core.compression`, `core.sparseCheckout` and the `[core]` path-likes, which is behaviour change outside this change's stated subject.
2. **Make `resolveMaxTreeDepth` refuse as a second, narrower guard** — pros: closes `archive` and `bundle-create` with zero collateral; direct precedent in ADR-355's `write-object` fallback / cons: leaves `clone`, `fsck` and `grep` diverging.
3. **Accept and document the under-refusal** — pros: cheapest, and `docs/use/errors.md` already publishes a narrower under-refusal for `core.hooksPath` / cons: documents a gap the pin can quantify and a one-line-per-command fix can close.

## Decision

**Option 1 (user-ratified), with option 2 as its complement rather than its alternative.**

`archive`, `bundle-create`, `fsck` and `grep` each gain an `assertOperationalRepository` call, bringing them to the same gate the other 39 command files already reach.

**`clone` is excluded, and the pin behind its inclusion was wrong.** The original reading — `clone` exits 128, therefore `clone` refuses — collapsed three different scenarios into one row. Re-pinned during implementation:

| Scenario | git | mechanism |
|---|---|---|
| Clone **from** a poisoned source | 128, `bad numeric config value` | the process serving the local-path clone reads its own config at startup |
| Clone **into** an occupied poisoned destination | 128, `destination path … already exists` | occupancy check fires first; destination config never read |
| Standing **inside** a poisoned repo, cloning a clean source | **0** | the ambient repository's config is never read |

Git's refusal is **source-side only**. tsgit's `clone` is client-only and reaches its source through a transport, so it has no analogue for that read. The destination-side gate first implemented here would have refused where git succeeds — a divergence in the strict direction, introduced by a guard meant to remove one. It was reverted, and `clone.ts` now carries the three-scenario reasoning as a comment so the gate is not re-added on the strength of the same misreading. `resolveMaxTreeDepth` additionally refuses on an invalid value, as a defensive guard for any direct primitive path that does not pass through a command's operational gate — the same shape ADR-355 keeps for `write-object`'s honour guard, and the reason a caller reaching a cap site directly cannot resolve a cap from a value git would reject.

`config`, `init` and `remote` stay ungated. That is not an omission: the pin has git surviving on all three, and gating them would break the one porcelain a user with a bad value needs in order to fix it.

`bundle-list-heads` and `bundle-verify` are **pinned before they are changed**. If git refuses on them they join the five; if git survives, they stay ungated and the reason is recorded. Neither is gated on the strength of sharing `bundle-create`'s shape.

## Consequences

The collateral is real and converges. Those five commands begin refusing on every key the gate already carries, not only `core.maxTreeDepth` — and the pin covers the gate's whole key set, so each of those new refusals matches git too. The change is larger than its subject and more faithful than its subject; that is the trade this record accepts, and it is why the choice was escalated rather than assumed.

`fsck` is the sharpest of the five to reason about, because it is the command a user runs when a repository is already suspect. It now refuses to run on a repo whose `core.maxTreeDepth` is malformed. Git does the same, so the behaviour is faithful — but it means a bad config value must be fixed before `fsck` will report anything, and `config --get`/`--set` remaining ungated is what makes that recoverable rather than a deadlock.

The two guards are deliberately redundant. The gate is the faithful one and covers the command surface; `resolveMaxTreeDepth`'s refusal covers the primitive surface, which the gate cannot see. A test that proves only one of them proves nothing about the other, so each needs isolated coverage — the guard-clause rule applies to the pair, not just to each `if`.
