# ADR-066: Hooks run by default (git-faithful), not behind a security opt-in

## Status

Accepted (at `acb9c62`)

## Context

The backlog scoped 17.2 as hooks "opt-in for the security model" — the concern
being that running arbitrary `.git/hooks/` scripts is a risk for a library that
may operate on a repository it did not create.

Canonical git takes the opposite stance: hooks run **by default**, and
`--no-verify` (`-n`) skips them per-command. There is no global "enable hooks"
switch in git.

When the design choice was put to the user — adapter-flag opt-in vs.
per-command verify-flag vs. config-gated — the user answered **"same as git
behavior"**, explicitly overriding the backlog's "opt-in" wording.

The forces: git-faithfulness (a core project value, see the
`be-git-faithful` instinct) pulls toward default-on; the library-safety concern
pulls toward default-off. The safety concern is also weaker than it first
appears — git **never transfers hooks over the wire**, so `clone`-ing an
untrusted URL never imports a hostile hook. The only exposure is operating on a
locally-obtained repo (e.g. an untrusted tarball) whose `.git/hooks/` was
pre-populated.

## Decision

**Hooks run by default**, mirroring git, whenever a `HookRunner` is wired onto
the `Context`:

- `createNodeContext` wires a `NodeHookRunner` by default; `index.node.ts`'s
  `openRepository` does the same via the runtime fallback.
- The opt-**out**s are git-faithful and explicit:
  - **`noVerify`** per command (`commit({ noVerify: true })`,
    `push({ noVerify: true })`) — git's `--no-verify`.
  - **`createNodeContext({ hooks: false })`** /
    **`openRepository({ hooks: false })`** — a full kill switch for hardened
    deployments operating on untrusted on-disk repositories.
- The browser adapter wires no runner — hooks are inert there regardless.

This **supersedes the backlog's "opt-in for the security model" wording.** The
backlog line stays as written (history); this ADR records the decision that
overrode it.

## Consequences

### Positive

- Git-faithful and least-surprising: a `.git/hooks/pre-commit` runs under tsgit
  exactly as it does under `git`.
- A repo with no hook files sees a `skipped` result on every call — zero
  behaviour change for the existing test corpus, one extra `lstat` per commit.
- The hardened path still exists: `hooks: false` fully detaches the runner.

### Negative

- A host that operates on an untrusted local repo will, by default, execute
  that repo's `.git/hooks/*`. Mitigated by `hooks: false` and documented in the
  design's Risks section — but it is a real, opt-out-only exposure.
- Diverges from the backlog's original framing; readers of the backlog must
  follow the link here to see the current truth.

### Neutral

- `OpenRepositoryOptions.hooks` is typed `HookRunner | false`: `false` disables,
  a `HookRunner` injects a custom one, `undefined` takes the runtime default.
- `noVerify` is additive on `CommitOptions` / `PushOptions` — no migration.
