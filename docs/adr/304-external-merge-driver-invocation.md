# ADR-304: External merge driver invocation — `CommandRunner` port

## Status

Accepted (at `e9a15c7d`)

## Context

An external merge driver is a shell command (`driver = my-tool %O %A %B %L %P`) that reads
three temp files — base (`%O`), ours (`%A`), theirs (`%B`) — and **overwrites `%A`** with the
merge result. git runs it via the shell (`run_command` with `use_shell`), substitutes the
`%`-placeholders, then reads `%A` back; exit 0 means a clean merge, non-zero means the driver
left conflict markers it could not resolve. Placeholders: `%O %A %B` (temp paths), `%L`
(conflict-marker length), `%P` (the repo-relative pathname), `%%` → `%`.

Two questions: (1) what port abstraction runs the command, and (2) what happens in adapters
that cannot spawn a subprocess (memory, browser).

tsgit already has `HookRunner` — but it *resolves a known script by name* in a hooks
directory and checks the executable bit; a merge driver runs an *arbitrary shell command
line* with temp-file plumbing. Different enough to warrant its own abstraction.

## Decision

**A new generic `CommandRunner` port** runs a shell command line:

```ts
interface CommandRequest { command: string; cwd: string; env: Record<string,string>; signal?: AbortSignal }
type CommandResult = { exitCode: number }   // drivers communicate via %A, not stdout
interface CommandRunner { run(r: CommandRequest): Promise<CommandResult> }
```

Optional on `Context` (`ctx.command?`), wired by the node adapter (`NodeCommandRunner`,
mirroring `NodeHookRunner`: injectable `spawn`, `cwd`, env incl. `GIT_DIR`, abort-kill, never
rejects on non-zero exit). Runs via `sh -c "<command>"`.

**Temp-file orchestration lives in the primitive**, not the adapter: `run-merge-driver.ts`
writes `%O/%A/%B` under `${gitDir}` via the existing `FileSystem` port (`%A` seeded with the
*ours* bytes, git's convention), calls a **pure** `substituteDriverPlaceholders(template,
{O,A,B,L,P})`, invokes `ctx.command.run(...)`, reads `%A` back via `ctx.fs`, then deletes the
temp files. `%L` is fixed at git's default **7** (the `conflict-marker-size` attribute /
`merge.conflictMarkerSize` config are a documented follow-up). Substitution is **raw** (git
does not shell-quote — faithful, spaces in paths behave as in git).

**No runner wired (memory / browser): fall back to the built-in text merge.** This is the
established `HookRunner` precedent (hooks are inert in the browser — ADR-068/299): the merge
still completes; a configured external driver simply does not run off-node. Documented
environment limitation, not a hard error. In node the runner is always present, so the
faithfulness/interop suite is unaffected.

### Rationale for the split

- File I/O stays on the `FileSystem` port (hexagonal purity); the adapter gains only one
  narrow capability — "run a shell command".
- The substitution + temp-file lifecycle is unit-testable with the **memory** adapter + a
  **fake** `CommandRunner` (the fake operates on the same `ctx.fs`), with no real process.
- A generic `CommandRunner` is reusable by later external-tool features (diff `textconv`,
  `clean`/`smudge` filters) without a new port each time.

Writing temp files under `${gitDir}` is unobservable (they are deleted) and lets the real
subprocess read them via absolute paths the node `FileSystem` already manages.

## Consequences

### Positive

- One small, reusable port; clean layering; fully testable without spawning processes.
- Faithful invocation contract (shell, `%`-substitution, `%A` round-trip, exit-code policy)
  pinned by a real-git interop test in node.

### Negative

- External drivers do not run in memory/browser (built-in fallback) — a documented,
  precedented divergence.
- `%L` fixed at 7 and labels `%S/%X/%Y` unsupported until the follow-up — drivers that read
  a non-default marker size or labels see git's defaults.

### Neutral

- `CommandResult` carries only `exitCode`; stdout/stderr are intentionally omitted (drivers
  communicate through `%A`) and can be added if a future consumer needs them.
