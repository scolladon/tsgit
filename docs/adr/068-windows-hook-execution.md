# ADR-068: Windows hooks are spawned directly, without a bundled shell

## Status

Accepted (at `acb9c62`)

## Context

Git hooks are conventionally POSIX shell scripts — an extensionless file with a
`#!/bin/sh` shebang and the executable bit set. The `NodeHookRunner` must decide
how to (a) judge a hook file "runnable" and (b) execute it, on both POSIX and
Windows.

- **POSIX** has a natural answer: the file is runnable iff it is a regular file
  with an executable bit (`mode & 0o111`); `child_process.spawn(path, …)` honours
  the shebang.
- **Windows** has neither an executable bit nor kernel shebang support. An
  extensionless `#!/bin/sh` script cannot be run without a POSIX shell.
  Git-for-Windows solves this by **bundling an `sh.exe`** (MSYS2) and running
  every hook through it.

tsgit is a zero-dependency library. Bundling a shell is off the table — it
would dwarf the package and contradict the project's portability ethos.

## Decision

`NodeHookRunner` spawns the hook file **directly**, with platform-appropriate
runnability checks:

- **POSIX** — `lstat` the resolved `${hooksDir}/${name}`. Absent or not a
  regular file → `skipped`. A regular file with no executable bit → `skipped`
  (git's exact rule). Otherwise `spawn(path, args, …)`; the shebang is honoured
  by the OS.
- **Windows** — there is no executable bit, so a regular file is treated as
  runnable. `spawn(path, args, …)` runs native executables and `.bat` / `.cmd`
  hooks. An extensionless POSIX shell-script hook will fail to launch unless a
  compatible shell is reachable on `PATH`.
- A spawn-level failure (`error` event — e.g. ENOEXEC from a shebang Windows
  cannot satisfy) resolves as `{ kind: 'ran', exitCode: 126 }`, the
  conventional "command found but not executable" code. That funnels into a
  normal `HOOK_FAILED` rather than crashing the command.

tsgit does **not** wrap hooks in `cmd.exe` / `sh` and does not probe for a
shell. The constraint "POSIX shell-script hooks on Windows need a shell on
`PATH`" is documented and is the *same* constraint git itself imposes (git just
satisfies it by shipping one).

## Consequences

### Positive

- Zero dependencies preserved; no shell bundled.
- POSIX behaviour is exactly git's, including the executable-bit gate.
- A Windows hook failure surfaces as a clean `HOOK_FAILED` (exitCode 126), not
  an unhandled adapter exception.

### Negative

- Extensionless `#!/bin/sh` hooks do not run on a bare Windows install. Windows
  users wanting POSIX hooks must have a shell on `PATH` (Git-for-Windows'
  `sh.exe`, WSL, etc.). Documented in the design's Risks section.

### Neutral

- Windows users can author native hooks (`.bat`, `.cmd`, `.exe`,
  `.ps1`-via-launcher) that run without any shell.
- If first-class Windows POSIX-hook support is later required, a follow-up can
  add opt-in shell discovery without changing the port contract — the
  `HookRunner` interface is execution-mechanism-agnostic.
