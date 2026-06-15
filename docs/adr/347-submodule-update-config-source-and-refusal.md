# ADR-347: `submodule.<name>.update` becomes a real config-sourced mode (config over `.gitmodules`), then refuses when valueless

## Status

Accepted (at `53b61b42`)

## Context

git dies with the `missing value` shape on a valueless `submodule.<name>.update` at `git submodule update` (pinned, git 2.54.0, exit 128). But tsgit never reads `submodule.<name>.update` **from config** for a real purpose: `validateUpdateModes` reads the update mode from `.gitmodules`, and `submoduleUpdate` resolves it as `opts.mode ?? gitmodulesMode ?? 'checkout'`. The config field is parsed into `ParsedConfig.submodule[name].update` but has no consuming read — so there is no faithful death site without a behaviour change.

In real git the registered config value `submodule.<name>.update` **overrides** the `.gitmodules` value (config is the per-repo override of the upstream-suggested mode). tsgit's omission of that precedence is the reason the refusal has nowhere to land.

ADR-329 listed `submodule.<name>.update` among the deferred string keys; this backlog (24.9r) revisits it. The original 24.9r framing was "one guard per *existing* consuming site", which this decision deliberately exceeds.

## Decision

Make `config.submodule[<name>].update` a **real mode source** with git's precedence (config update mode overrides the `.gitmodules` update mode), then guard the valueless case with `CONFIG_MISSING_VALUE` at the consuming read in `submoduleUpdate`. The precedence (`opts.mode` > config `submodule.<name>.update` > `.gitmodules` `submodule.<name>.update` > `checkout` default) is pinned empirically against git 2.54.0 in the revised design before implementation.

This is a deliberate **behaviour change** beyond a pure refusal wiring: tsgit gains git's config-over-gitmodules update-mode precedence, which is the prerequisite for a faithful death site. It is therefore treated as feature scope — it goes through the normal review battery.

## Consequences

### Positive

- tsgit gains git's faithful submodule update-mode precedence (config overrides `.gitmodules`), closing a real behavioural gap, not just a refusal gap.
- The valueless refusal then has a genuine consuming read to sit on — no synthetic guard on an ignored value.

### Negative

- Enlarges 24.9r beyond refusal wiring into a behaviour change; the update-mode resolution and its precedence must be pinned against git and unit-/interop-tested, not just the valueless row.

### Neutral

- The new precedence is scoped to the `update` mode; other `submodule.<name>` config-over-gitmodules overrides (e.g. `url` sync semantics) are unchanged by this ADR.
