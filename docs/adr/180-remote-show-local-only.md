# ADR-180: `remote show` is local-only; network query deferred

## Status

Proposed

## Context

`git remote show <name>` produces a human-readable summary of a
remote that includes BOTH local state (URL, push URL, fetch refspecs,
local-tracking branches) AND network state (the remote's HEAD, the
remote's branches that are not yet tracked, the remote's stale
branches that no longer exist).

The network half is an `ls-refs` round-trip; canonical git suppresses
it with `-n` / `--no-network`. The two halves carry very different
costs:

- **Local half**: pure read from `.git/config` and `refs/remotes/*`.
  Zero network. Tens of microseconds.
- **Network half**: HTTP discovery + ls-refs. Hundreds of milliseconds
  + auth + SSRF guards + transport adapter.

tsgit Phase 20.5 has two routes:

- **A: ship both halves now**, with `network: false` as the default to
  match the local-only cost characteristic users probably want.
- **B: ship the local half only**, with a structured result shape that
  leaves room for a future `network: true` to land additively.

The 20.5 PR scope already covers `add` / `remove` / `rename` /
`setUrl` / `list` / `show`. Pulling the network-querying smart-HTTP
client into `show` would significantly enlarge the surface and the
test matrix (mocked HTTP responses, auth threading, SSRF validation).

## Decision

`repo.remote({ kind: 'show', name })` is local-only. The result
exposes:

- `url`, `pushUrl`, `fetchRefspecs` — from `.git/config`.
- `trackingRefs` — every loose+packed ref under
  `refs/remotes/<name>/*` (`Map<RefName, ObjectId>`).
- `trackedBy` — local branches with `branch.<X>.remote = <name>`,
  including their paired `merge` value.

The result shape is structurally compatible with a future network
mode. When the network path lands, the signature becomes
`{ kind: 'show', name, network?: boolean }` and the result type
gains an optional `network?: { … }` field — additive, no breaking
change.

## Consequences

### Positive

- **Cheap and reliable.** No transport, no DNS, no auth — `show`
  runs in microseconds and never fails for reasons outside the
  caller's repo.
- **Browser parity easy.** The local-only view works identically on
  OPFS; no in-page HTTP server needed for the 20.5 parity scenario.
- **Result shape forward-compatible.** Adding `network: true` is
  additive on input and additive on output.

### Negative

- **Power users miss canonical git's network summary.** A user who
  runs `tsgit remote show origin` won't see "branches tracked by
  remote but not locally" or "branches local that remote no longer
  has". Mitigation: `repo.fetch({ prune: true })` already surfaces
  the stale set; `repo.fetch({ remote })` followed by `show`
  rebuilds the tracking view from fresh data.
- **No remote HEAD discovery.** A future `repo.checkout('main')` on
  a remote whose HEAD changed cannot self-correct without the
  network path. Today the user has to call `fetch` explicitly,
  same as before 20.5.

### Neutral

- **The structured-result shape differs from canonical git's
  text output.** That difference is intentional and consistent with
  the rest of tsgit's surface (we return data, not text — and
  callers format).

## Alternatives considered

- **A (ship both halves now, default `network: false`)** — rejected.
  Doubles the PR scope, drags the smart-HTTP client into a
  porcelain CRUD verb whose other actions are pure config writes,
  and forces the test matrix to include mocked HTTP responses for
  one branch of one verb. The local-only ship gets the surface to
  users this phase; the network ship lands cleanly later.
- **Ship the network path as a separate `repo.remote({ kind:
  'inspect', name })` later** — rejected. Two verbs for the same
  intent ("tell me about this remote") forces the user to pick;
  the additive-field route keeps one verb whose default is local
  and whose `network: true` opt-in covers the network case.
