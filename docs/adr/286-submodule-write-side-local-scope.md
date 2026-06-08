# ADR-286: Submodule write side — split local (`init`/`sync`/`deinit`) from network (`add`/`update`)

## Status

Accepted (at `7b8a65cd`)

## Context

Backlog **24.1** ("Submodule write side — `add`/`init`/`update`/`sync`/`deinit`")
is one item, but its five verbs split cleanly along a network/no-network fault
line:

- `init` / `sync` / `deinit` mutate only **local state already on disk**:
  `.git/config` `[submodule "<name>"]` sections (read + write), the working-tree
  `.gitmodules` (read), an already-present `.git/modules/<name>/config` (`sync`),
  and the submodule's working-tree directory + dirtiness (`deinit`). They compose
  on the existing `update-config` primitive + the 17.5 read side. No clone, no
  checkout, no network.
- `add` / `update` require a **clone → checkout-into-`.git/modules/<name>`**
  substrate. tsgit's `clone` is smart-HTTP-only and deliberately does **not**
  materialise a working tree (it fetches objects + sets refs only), so both verbs
  need new working-tree-materialisation-into-a-nested-gitdir machinery plus a
  real `git http-backend` integration harness (the pattern every networked
  command here already uses).

Doing all five in one workflow run means standing up that clone/checkout
substrate and http-backend integration for two verbs — feature-sized on its own,
and it would dwarf the three local verbs it ships alongside.

## Decision

Split 24.1 into two backlog items and implement only the local half now:

- **24.1a** — `init` / `sync` / `deinit` (this run): local config + worktree
  state, no network, unit + node-adapter interop against real `git`.
- **24.1b** — `add` / `update` (a later workflow run): the clone→checkout
  substrate + http-backend integration, with its own ADRs.

`24.1b` inherits the shared domain modules this run lands (`relativeUrl`,
`parseGitmodules`, `deriveSubmoduleContext`) and the unified `repo.submodule`
namespace, so it is purely additive (new `add`/`update` verbs).

## Consequences

### Positive

- Each PR is reviewable and faithfully testable on its own substrate — the local
  verbs against memory/node adapters, the network verbs against http-backend.
- The trickiest faithfulness work (relative-URL resolution, `.git/config` byte
  parity) lands first and de-risks `add`/`update`, which reuse it.
- No half-built clone/checkout machinery sitting unused if priorities shift.

### Negative

- The "submodule story" stays incomplete until 24.1b ships; a one-item backlog
  entry becomes two.

### Neutral

- `recursive` for `sync` rides with 24.1b — it only bites on checked-out
  submodules, which 24.1a never populates.
