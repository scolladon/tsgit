# ADR-034: Home directory surfaced via `RepositoryLayout.homeDir`

## Status

Accepted (at `8cd131f`)

## Context

§14.3 must resolve `core.excludesFile` paths such as
`~/.config/git/ignore`. Resolving `~` requires the user's home
directory. Options:

1. **Read `process.env.HOME` (or `USERPROFILE` on Windows) at call
   time** from within the domain/application layer.
2. **Use Node's `os.homedir()` at call time** inside the loader.
3. **Inject the home directory through the `RepositoryLayout`**
   discovered at repository open time; the node adapter populates it
   from `os.homedir()`, the memory adapter from options, the browser
   adapter leaves it `undefined`.

Options 1 and 2 reach into the runtime from the application layer,
violating hexagonal layering. They also defeat memory-adapter tests
(which need to control home resolution deterministically). Option 3
pushes the runtime concern back to the adapter / repository factory
where it belongs.

## Decision

Add `homeDir?: string` to `RepositoryLayout` (ports). The node shim
fills it from `os.homedir()`. The memory adapter accepts an optional
`homeDir` in its constructor options (default: undefined). The
browser shim leaves it undefined. Loaders that need home resolution
read `ctx.layout.homeDir`; if it's `undefined` and the path requires
expansion, the loader treats the source as missing (returns
`undefined`) — same outcome as the file not existing.

The "missing-or-undefined → undefined" pattern keeps the loader
non-throwing on platforms without a home concept (browser, memory
without options). Misconfiguration is silent by design: a user who
truly cares about global excludes will notice their `.gitignore`
isn't being honoured and configure `homeDir` explicitly.

## Consequences

### Positive

- Hexagonal layering holds — domain/application never imports `os` or
  `process.env`.
- Memory tests can inject any `homeDir` they like, including pointing
  at fake paths via the memory FS.
- Browser builds don't pull in a polyfill for home-directory APIs.

### Negative

- One more field on the layout type — small surface tax.
- Silent miss when `homeDir` is undefined but a `~` path is configured.
  Acceptable for v1; can add diagnostic logging later if it bites.

### Neutral

- Memory adapter's `createMemoryContext` gains an optional `homeDir`.
  Existing call sites need no change (default undefined).
