# ADR-065: Git hooks run through a `HookRunner` port executing scripts

## Status

Accepted (at `acb9c62`)

## Context

Backlog item 17.2 adds git hooks (`pre-commit`, `commit-msg`, `pre-push`).
Canonical git hooks are **executable scripts** under `.git/hooks/`; a named
script fires at a fixed point and a non-zero exit aborts the operation.

tsgit is portable (Node + browser), zero-dependency, hexagonal, and
dogmatically git-faithful. Running a script means spawning a process — which
Node can do (`node:child_process`, a builtin, no new dependency) but a browser
fundamentally cannot. Three ways to reconcile this were considered:

- **A — `HookRunner` port + script execution.** A new port; the Node adapter
  spawns the real `.git/hooks/*` scripts; the browser has no runner and hooks
  are inert; the memory adapter takes an injectable runner for tests.
- **B — programmatic JS callbacks only.** No script execution anywhere; the
  host registers JS functions as hooks. Fully portable and safe by
  construction, but it does **not** run existing `.git/hooks/` shell scripts —
  a real divergence from canonical git.
- **C — a port supporting both** scripts and host-supplied callbacks. Maximum
  flexibility, largest API surface to design, test, and document.

## Decision

**Option A.** A new `HookRunner` port (`src/ports/hook-runner.ts`):

- The port is a stateless contract — "resolve `${hooksDir}/${name}`, and if it
  exists and is runnable, spawn it with these args / stdin / cwd". Everything
  it needs travels in the `HookRequest`; nothing git-specific leaks into the
  adapter.
- **Node adapter** (`NodeHookRunner`) spawns the real `.git/hooks/*` scripts
  via `node:child_process` — fully git-faithful.
- **Browser adapter** wires no runner; `Context.hooks` is `undefined` and every
  hook call is a no-op. Browsers cannot spawn processes.
- **Memory adapter** (`MemoryHookRunner`) is a programmable test double.
- `Context.hooks?: HookRunner` is optional; its absence is the natural "no
  hooks" state.

Hook invocation is funnelled through one application primitive, `runHook`,
which owns config-driven hooks-dir resolution and the exit-code → `HOOK_FAILED`
policy.

## Consequences

### Positive

- Git-faithful: tsgit runs the same `.git/hooks/*` scripts canonical git does,
  so existing project hooks work unchanged.
- Hexagonal integrity preserved: domain, primitives, and commands stay
  platform-agnostic; process spawning is confined to the Node adapter.
- Zero new dependencies — `node:child_process` is a Node builtin, the same
  class as `node:fs` / `node:zlib` already used.
- The browser story is safe by construction: no runner, no execution.

### Negative

- The Node adapter gains genuinely hard-to-test surface (process spawning,
  signal kills, output capping) — 100 % coverage / 0 mutants needs fixture
  hook scripts and integration tests.
- Hooks are inert in the browser; a browser host cannot validate commits via
  hooks. Acceptable — option B's portability would have cost git-faithfulness
  everywhere, which is the worse trade for this project.

### Neutral

- Adding a future hook (`post-commit`, …) means extending the `HookName` union
  and inserting one `runHook` call — no structural change.
- Host-supplied JS callbacks (option C's extra) are not offered; if demand
  appears, a callback-backed `HookRunner` implementation can be added later
  without touching the port or any command.
