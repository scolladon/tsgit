# 437 — Browser inertness via absent ctx.ssh capability

- **Status:** accepted
- **Date:** 2026-07-02
- **Design:** docs/design/ssh-transport.md · **Relates:** ADR-133 (context capabilities), ADR-438 (refusal codes)
- **Decision class:** D-architecture (adopted-as-recommended, no user judgment)

## Context

The brief requires the browser to stay **inert** for SSH. "Inert" must be observable
and well-defined: what happens when a browser consumer passes an `ssh://` or scp-like
remote?

## Options considered

1. **Capability absence** *(recommended)* — `SshTransport` is an optional `Context`
   field (`readonly ssh?: SshTransport`), mirroring `command` / `hooks`. The browser
   shim wires nothing; when a command resolves an ssh/scp remote and
   `ctx.ssh === undefined`, it raises a typed refusal. Zero SSH bytes in the browser
   bundle.
2. **Browser adapter whose `open()` rejects** — explicit, but ships dead code to the
   bundle and invents a second inertness pattern beside the established one.
3. **Runtime-sniff in commands** — `typeof window` checks scattered through
   application code; unfaithful to the capability model and untestable in memory.

## Decision

**Adopted-as-recommended (no user judgment): option 1.** The node shim
(`index.node.ts`) wires `NodeSshTransport`; the browser shim (`index.browser.ts`)
wires nothing; the memory shim likewise omits it (a test double may be injected for
integration tests). `RuntimeFallback` in `repository.ts` threads the capability
exactly like `command`. The node shim must also wire `ctx.env` (`NodeEnvReader`
exists but the current `RuntimeFallback` omits it), because the
`GIT_SSH_COMMAND`/`GIT_SSH` tier of command resolution reads through it — without
it that tier would be silently skipped.

## Consequences

### Positive
- Same inertness idiom as `CommandRunner`/`HookRunner` — one pattern to learn.
- Browser bundle weight for SSH is exactly zero.
- Memory adapter tests can inject an `SshTransport` double to integration-test the
  session without spawning processes.

### Negative
- Wiring `ctx.env` into `RuntimeFallback` widens the default node context — a small,
  deliberate surface increase that the review pass must sanity-check.

### Neutral
- The refusal code for the inert path is decided in ADR-438.
