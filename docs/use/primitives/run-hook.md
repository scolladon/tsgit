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
- ADRs: [065](../../adr/065-hook-runner-port.md), [066](../../adr/066-hooks-default-on.md), [068](../../adr/068-windows-hook-execution.md)
