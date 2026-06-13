# ADR-329: Missing-value refusal scope — identity **and** remote-URL; defer the remaining string fields and int-typed

## Status

Accepted (at `f72d2177`)

## Context

git dies with the `missing value` shape at every use site that reads a string-typed config key for a real purpose. Pinned against git 2.54: commit identity (`user.name`/`user.email`) and remote-URL on both `fetch` and `push` (`remote.<n>.url`). Other string-typed `ParsedConfig` fields also reach string reads in principle (`branch.*.merge`, `merge.*.driver`, `submodule.*.url`, `core` path-likes), and an int-typed valueless read has its own distinct shape — but no int key is merged into `ParsedConfig` today (ADR-315 §Neutral).

Faithfulness argues for breadth; bounded-diff argues for landing the proven pattern incrementally. The detection mechanism (ADR-327) makes each additional site a single additive call, so breadth is cheap to extend later without rework.

## Decision

This change covers the **identity** surface (`commit` + the shared `resolveCurrentIdentity` consumers: cherry-pick, rebase, revert, merge) **and** the **remote-URL** surface (`fetch`, `push` — valueless `remote.<n>.url` before the existing `REMOTE_NOT_CONFIGURED` absent path). Both reuse the single `findFirstValuelessEntry` primitive and the single `CONFIG_MISSING_VALUE` error.

Deferred as backlog follow-ups, in dependency order:

1. Other string-typed fields (`branch.*.merge`, `merge.*.driver`, `submodule.*.url`, `core` path-likes) — each a new `findFirstValuelessEntry` call site, lower traffic.
2. Int-typed valueless shape (`bad numeric config value '' … invalid unit`, its own error code) — **blocked** on an int key actually being merged into `ParsedConfig`.

The **absent** (wholly-unconfigured) case is untouched: identity keeps `AUTHOR_UNCONFIGURED` (a pre-existing divergence — tsgit cannot portably probe GECOS as git does), remote keeps `REMOTE_NOT_CONFIGURED`. Only the **valueless** case gains the new shape.

## Consequences

### Positive

- Covers the two surfaces git actually dies on in tsgit's command set (commit identity + fetch/push URL) — the high-value faithfulness gains.
- The deferred sites are additive (ADR-327) — no rework when they land, just new call sites.
- No `AUTHOR_UNCONFIGURED`/`REMOTE_NOT_CONFIGURED` regression on the absent path.

### Negative

- The remaining string-typed fields stay divergent (valueless → treated as absent) until their follow-ups land; documented, dependency-ordered.

### Neutral

- Int-typed parity is genuinely out of reach until an int config key exists; recorded as blocked, not forgotten.
