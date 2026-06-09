# `runHook`

Execute a `.git/hooks/<name>` script. Node only — the browser adapter has no hook runner. Returns the exit code; non-zero exits surface as `HOOK_FAILED` if you let them bubble.

## Signature

```ts
repo.primitives.runHook(
  name: string,
  input?: HookInput,
): Promise<{ exitCode: number; stdout: string; stderr: string }>;

interface HookInput {
  readonly args?: ReadonlyArray<string>;
  readonly stdin?: string;
  readonly env?: Record<string, string>;
}
```

## Behaviour

- Honours `core.hooksPath` from `.git/config`.
- Inherits `process.env` by default; pass `env` to override per call.
- Returns the exit code so callers can decide whether non-zero is a failure (default policy in `commit` / `push` is to throw `HOOK_FAILED`; lower-level callers can be more permissive).

## Lifecycle hooks the commands fire

The commands invoke these `.git/hooks/*` scripts automatically (Node only; the
browser has no runner). **Blocking** hooks abort their command on a non-zero
exit (`HOOK_FAILED`); **informational** (`post-*`) hooks run after the operation
completes and their exit code is ignored, exactly as canonical git treats them.

| Hook | Fired by | Class | Arguments / stdin |
|------|----------|-------|-------------------|
| `pre-commit` | `commit` | blocking | — (skipped by `noVerify`) |
| `prepare-commit-msg` | `commit` | blocking | `<editmsg-path> <source>` — `source` is `message` or `merge`; runs even under `noVerify` |
| `commit-msg` | `commit` | blocking | `<editmsg-path>` (skipped by `noVerify`) |
| `post-commit` | `commit` | informational | — |
| `post-merge` | `merge` / `pull` (fast-forward + clean true-merge) | informational | `<squash-flag>` (always `0` — no `--squash`) |
| `post-checkout` | `checkout` (branch switch + path restore) | informational | `<prev-head> <new-head> <branch-flag>` (`1` switch, `0` file checkout) |
| `pre-push` | `push` | blocking | args `<remote> <url>`; stdin one ref line per update |
| `pre-rebase` | `rebase` | blocking | `<upstream>` |
| `post-rewrite` | `rebase` (on completion) | informational | args `rebase`; stdin `<old> <new>` per rewritten commit |

Server-side hooks (`pre-receive` / `update` / `post-receive` / `post-update`)
are out of scope — tsgit is a client library with no `receive-pack` server
([ADR-299](../../adr/299-server-side-hooks-out-of-scope.md)).

## Example

```ts
const result = await repo.primitives.runHook('pre-commit');
if (result.exitCode !== 0) console.warn(result.stderr);

// With stdin (pre-push contract)
await repo.primitives.runHook('pre-push', {
  args: ['origin', 'https://example.com/repo.git'],
  stdin: 'refs/heads/main <oid> refs/heads/main <oid>\n',
});
```

## See also

- Tier-1: [`commit`](../commands/commit.md), [`push`](../commands/push.md)
- ADRs: [065](../../adr/065-hook-runner-port.md), [066](../../adr/066-hooks-default-on.md), [068](../../adr/068-windows-hook-execution.md), [299](../../adr/299-server-side-hooks-out-of-scope.md), [300](../../adr/300-extend-hook-name-union.md), [301](../../adr/301-informational-hook-semantics.md)
