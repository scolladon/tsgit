# ADR-315: String-typed `ParsedConfig` fields treat a valueless entry as absent

## Status

Accepted (at `3a5605c1`)

## Context

git resolves a valueless (NULL) config value lazily, per typed accessor: `git_config_bool(NULL)` is `true`, but a string-typed read dies at **use** time — `error: missing value for 'user.name'` — while `git config --list` on the same file succeeds. tsgit's `readConfig` merges known keys eagerly into `ParsedConfig`, so there is no per-use-site read at which to die faithfully: refusing at parse time would make list-style reads fail where git's succeed, and threading a missing-value marker through `ParsedConfig` to every consumer (commit identity, fetch/push URL resolution, merge-driver invocation, …) is feature-sized.

## Decision

String-typed `ParsedConfig` merge fields (`user.name`/`email`, `remote.*.url`/`pushUrl`/`fetch`/`partialCloneFilter`, `branch.*.remote`/`merge`, `submodule.*.url`/`update`, `merge.*.name`/`driver`/`recursive`, `core` path-likes, `extensions.partialClone`) **skip** a `null` value — the field stays unset, exactly as if the line were absent. Bool-typed fields keep faithful NULL semantics via `parseGitBoolean(null) → true`. The raw `null` remains visible on the porcelain read surfaces (ADR-314), so no data is lost.

Consequence at the command level: e.g. `commit` with a valueless `user.name` refuses through tsgit's existing identity-not-configured path rather than git's exact `missing value for 'user.name' / bad config variable` message. This is a **documented divergence**, recorded as a backlog follow-up for per-use-site message parity.

## Consequences

### Positive

- List-style reads keep parity with git (no eager refusal on files git reads fine).
- Commands still refuse when the missing string matters — only the message shape diverges.
- Bounded diff: the divergence lives in the merge functions, one pattern (`if (value === null) continue`).

### Negative

- Refusal *message* parity for string-typed NULL reads is not achieved (`missing value for '<key>'`); deferred to a follow-up.

### Neutral

- No int-typed config keys are merged into `ParsedConfig` today, so git's `bad numeric config value '' … invalid unit` shape is out of scope until one exists.
