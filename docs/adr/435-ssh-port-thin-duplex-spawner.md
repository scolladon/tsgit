# 435 — SSH port is a thin duplex command spawner

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-434 (transport seam), ADR-436 (channel shape)
- **Decision class:** D-architecture (adopted-as-recommended, no user judgment)

## Context

The brief mandates that key resolution is **delegated** — tsgit must not parse keys,
talk to agents, or implement the SSH protocol. That leaves the port boundary to draw:
how much git knowledge does the SSH port carry?

## Options considered

1. **Thin duplex spawner** *(recommended)* — `open({ command, args, env }) =>
   SshChannel`. The port knows nothing about git; argv construction, single-quoting of
   the remote path, and the `GIT_SSH_COMMAND` / `GIT_SSH` / `core.sshCommand`
   resolution order all live in pure, unit-testable application code.
2. **Rich git-aware port** — the port receives `{ host, port, path, service }` and the
   adapter builds argv. Faithful argv logic would then be duplicated per adapter and
   tested per platform instead of once.
3. **Reuse `CommandRunner`** — impossible: `CommandRunner` is one-shot and buffers
   stdout; the SSH channel is a long-lived duplex stream that must interleave writes
   and reads.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The `SshTransport` port
exposes a single `open` verb returning a duplex `SshChannel`. Everything
security-load-bearing — command resolution, argv assembly, `sqQuote(path)` of the
remote path (the server-side shell executes `git-upload-pack '<sq-quoted-path>'`) —
is pure code tested once, independent of platform. The node adapter's only job is
`child_process.spawn` with stdin/stdout piped and stderr inherited (no credential
capture); delegation of authentication to the system `ssh` is total.

## Consequences

### Positive
- Faithful argv/quoting is pinned in one place by unit + interop tests.
- The port surface is minimal — one method — so browser/memory inertness (ADR-437)
  is trivial.
- Zero runtime dependencies preserved: the system `ssh` binary does all cryptography.

### Negative
- A remote whose reachability depends on non-CLI SSH (e.g. an in-process SSH library)
  cannot be served without a custom adapter — accepted; custom adapters can implement
  the same port.

### Neutral
- `GIT_SSH_COMMAND`/`GIT_SSH` are read through the env capability, `core.sshCommand`
  through `readConfig` — the same resolution precedence as canonical git.
