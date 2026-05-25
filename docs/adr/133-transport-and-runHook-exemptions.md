# ADR-133: Transport commands and `runHook` are the opening allowlist entries

## Status

Accepted (at `75a0cde6`)

## Context

The audit's first run lists 31 gaps. The "close gaps" deliverable
ships ~a dozen parity scenarios that cover 26 of them. The remaining
five are surfaces that 19.5a cannot test in the browser without
infrastructure outside the phase's scope:

- `clone`, `fetch`, `push`, `fetchMissing` — all four exchange data
  with a smart-HTTP backend. The Node parity driver and integration
  suite use a real `git-http-backend` subprocess (see
  `test/integration/network/clone-http-backend.test.ts`). Replicating
  that inside `page.evaluate` requires either a `MockServiceWorker`
  intercept, a Node-side fixture server reachable from the browser
  (already running for the test harness but not wired for
  pack-exchange semantics), or the Workers-test runtime that 19.8
  brings in for the runtime parity matrix.
- `runHook` — the browser facade intentionally has no `HookRunner`
  wired (`src/index.browser.ts`); hooks spawn `.git/hooks/*`
  subprocesses that don't exist in OPFS. The primitive throws if
  invoked from a browser-bound `Repository`. This is a structural
  property of the adapter, not a deferred feature.

## Decision

The opening `tooling/audit-browser-surface.allowlist.json` contains
exactly five entries:

| Tier | Name | Reason | `deferredTo` |
|---|---|---|---|
| commands | `clone` | smart-HTTP transport needs an in-page server | `19.8` |
| commands | `fetch` | smart-HTTP transport needs an in-page server | `19.8` |
| commands | `push` | smart-HTTP transport needs an in-page server | `19.8` |
| commands | `fetchMissing` | partial-clone lazy fetch uses the same transport path | `19.8` |
| primitives | `runHook` | browser facade has no `HookRunner` by adapter design | `null` |

19.8 ("Runtime parity matrix — expand CI to exercise Deno + Bun +
Cloudflare Workers") already commits to a Workers test harness with
the memory adapter and HTTP transport. When that harness lands, the
transport entries get removed and the corresponding browser parity
scenarios get added in the same PR.

`runHook` stays exempt indefinitely. If a future phase wires a
browser-side hook runner (e.g., evaluating JS hooks in a worker),
the entry gets removed then.

## Consequences

### Positive

- The deferred work is named — `19.8` is the line where the
  transport exemptions die, and future-us can grep for `"deferredTo":
  "19.8"` to find the cleanup list.
- The structural exemption is separated from the deferred ones via
  `deferredTo: null`, so the report distinguishes "we'll get to it"
  from "this is impossible by design."

### Negative

- Transport surfaces stay browser-untested for the duration of v2.
  Mitigated by the Node-side integration suite which already
  exercises the full pack-exchange semantics; the browser-specific
  risk is narrower (fetch API quirks rather than git protocol
  bugs).
- A regression in `runHook` would never be caught by the browser
  parity job. Acceptable: `runHook` is bound on the facade only for
  the Node runtime that supplies the `HookRunner`; the browser
  binding throws on first call, which is the correct behaviour.

### Neutral

- The allowlist remains short (five entries) and reviewable. If it
  grows past ~10 entries, that signals the audit is being misused as
  a backlog tracker; the rule "exemption needs a written reason and
  a deferred-to or null" stays the gate.
