# Design — SSH transport

> Brief (backlog 25.1): SSH transport — a new port; key resolution delegated to the
> system `ssh`; the browser adapter stays inert. Composes with the existing v0/v1
> protocol client that smart-HTTP uses today. Sibling 25.3 (smart-HTTP v2 /
> incremental negotiation) is separate and not folded in.
> Status: draft → self-reviewed ×3 → accepted

## Context

Today every network command drives a single transport port, `HttpTransport`
(`src/ports/http-transport.ts`), a **request/response** shape:
`request(HttpRequest) => Promise<HttpResponse>` where `HttpResponse.body` is a
`ReadableStream<Uint8Array>`. Adapters implement it per platform
(`node-http-transport.ts`, `browser-http-transport.ts`, `memory-http-transport.ts`)
and it is a **required** field on `Context` (`src/ports/context.ts`).

The v0/v1 git protocol client is split in two layers:

- **Pure protocol domain** (`src/domain/protocol/`) — transport-agnostic. pkt-line
  codec (`decodePktStream`, `encodePktStream`), advertisement parser
  (`parseAdvertisedRefs`), request builders (`buildUploadPackRequest`,
  `buildReceivePackRequest`), response parsers (`parseUploadPackResponse`,
  `parseReceivePackResponse`), side-band demux (`parseSideBand`). These operate on
  `AsyncIterable<Uint8Array>` / `Uint8Array` and know nothing about HTTP.
- **HTTP-coupled orchestration** (`src/application/commands/internal/` +
  `src/application/primitives/fetch-pack.ts`) — `discoverRefsForService`,
  `discoverRefs`, `discoverReceivePackRefs`, `fetchPack`, and the inline
  `postReceivePack`/`sendUpdates` in `push.ts`. These hard-code smart-HTTP:
  `buildDiscoveryUrl` appends `info/refs?service=…`; `buildUploadPackUrl` /
  `buildReceivePackUrl` append `/git-upload-pack` / `/git-receive-pack`; the
  `accept` / `content-type` headers; the two-request GET-then-POST shape; and the
  `# service=…\n0000` advertisement prologue that `parseAdvertisedRefs` validates
  via `consumeServiceHeader` (throws `MISSING_SERVICE_HEADER` if absent).

`clone.ts`, `fetch.ts`, and `push.ts` each build a transport with
`withDefaults(ctx, …)` (`internal/network-pipeline.ts`, composing
`withRetry`/`withAuth`/`withLogging`) then call the HTTP-coupled helpers directly.
`pull` = fetch + merge, and `fetchMissing` (promisor lazy-fetch) both route through
these same paths.

URL handling is HTTP-only:

- `validateUrl` (`internal/url-validate.ts`) parses with WHATWG `new URL()`,
  enforces `https:` (and `http:` only when `allowInsecure`), then does DNS
  resolution + an IP-range SSRF blocklist + DNS pinning. `ssh://…` today →
  `UNSUPPORTED_SCHEME`; scp-like `git@host:path` → `INVALID_URL` (not a WHATWG URL).
- `wrapTransportValidator` (`src/repository/wrap-transport-validator.ts`) wraps
  `ctx.transport` with that SSRF guard at `openRepository` time.

Constraints this design binds to:

- **Git-faithfulness prime directive** (CLAUDE.md, ADR-226): observable behaviour —
  object SHAs, refs, reflogs, on-disk state, refusal conditions — byte-for-byte vs
  canonical `git` unless an ADR diverges. Pinned empirically below; each pin becomes
  a `test/integration/*-interop.test.ts` case.
- **Structured output** (ADR-249): the library returns structured data; no
  rendered-text options. (Transport returns bytes/streams — already compliant.)
- **Hexagonal** (ADR-001): `repository → commands → primitives → domain`; ports are
  interfaces only; adapters per platform. A new SSH transport = a new port + a node
  adapter; browser/memory stay inert.
- **Zero runtime dependencies**: no SSH library may be added. SSH is achieved by
  spawning the **system `ssh` binary** and speaking pkt-line over its stdio — the
  same delegation model canonical git uses.
- **Protocol version** (ADR-005): tsgit ships smart v1 (v0 advertisement-first),
  not v2. 25.3 owns v2. SSH follows the same choice.

Prior art in this repo for "optional, absent on browser" ports: `CommandRunner`
(`src/ports/command-runner.ts` — buffered, one-shot, `run() => {exitCode, stdout}`;
absent on browser/memory) and `HookRunner` (ADR-133: browser has no runner, the
primitive refuses). SSH follows that idiom but **cannot reuse `CommandRunner`**: SSH
needs a bidirectional streaming duplex (read the advertisement, then write the
request while still reading the response), whereas `CommandRunner` buffers all
stdout and resolves only on process close.

## Requirements

When this ships, all of the following are verifiable:

1. `clone` / `fetch` / `pull` / `push` / `fetchMissing` against `ssh://[user@]host[:port]/path`
   and scp-like `[user@]host:path` produce **byte-identical on-disk results** to the
   equivalent HTTP operation and to canonical `git` over SSH: same pack SHAs, same
   `refs/*`, same reflog lines, same `.git/config`.
2. **Key resolution is fully delegated.** tsgit reads no private keys, no
   `~/.ssh/config`, no `known_hosts`, and talks to no ssh-agent. The spawned `ssh`
   does all of it. tsgit builds argv and **inherits the parent process env** (so ssh
   finds `SSH_AUTH_SOCK`, `HOME`/`~/.ssh`, and `known_hosts`), merging only its own
   additions — it does not curate a minimal env.
3. Command resolution honours git's order: `GIT_SSH_COMMAND` → `core.sshCommand` →
   `GIT_SSH` → default `ssh` (found on `PATH`). `GIT_SSH_COMMAND`/`core.sshCommand`
   are shell-word-split; `GIT_SSH` is a single program (no split).
4. Argv is built faithfully to the pinned matrix: correct host token, `-p` port
   rule, and the remote command `git-upload-pack '<sq-quoted-path>'` /
   `git-receive-pack '<sq-quoted-path>'`.
5. A host token or remote path beginning with `-` is **refused** (git's
   `strange hostname … blocked` / `strange pathname … blocked` argv-injection guard).
6. The **browser adapter is inert**: any ssh/scp remote raises a typed refusal
   (structured error, no rendered string); no SSH code path is reachable in-browser;
   no new browser bundle weight.
7. **Zero runtime dependencies** preserved — spawn the system `ssh`; no SSH protocol
   library.
8. The existing **v0/v1 protocol client is reused** — pkt-line, want/have/done,
   side-band-64k, report-status — with a no-service-prologue advertisement mode. No
   fork of the wire parsers.
9. v0/v1 only: tsgit does **not** set `GIT_PROTOCOL=version=2` and does not parse a
   v2 advertisement. 25.3 owns v2.
10. `ctx.signal` abort kills the `ssh` child and unwinds the streams.
11. No credentials or full URLs leak into logs or error payloads (ssh owns auth; the
    existing log sanitiser + error `sanitize` cover our surface).

## Design

### Pinned faithfulness matrix (canonical `git`)

Pinned against `git --version` = **2.55.0** on darwin, `GIT_*` scrubbed, isolated
`HOME`, `GIT_CONFIG_NOSYSTEM=1`, in a `mktemp -d`. The probe intercepts the ssh
invocation with a recorder script installed via `GIT_SSH_COMMAND` (and, separately,
`GIT_SSH` / `core.sshCommand` / a `PATH`-shadowed `ssh`) and dumps argv. Every row
below becomes an interop assertion.

**A. Real-connection argv (OpenSSH variant).** git first runs a `ssh -G <host>`
capability probe **only when it cannot infer the variant from the program name**
(custom `GIT_SSH_COMMAND`); with a plain `ssh` on `PATH` it skips the probe. The
probe is a git implementation detail, not a wire artifact — tsgit does not
replicate it. The *real* connection argv is what matters:

```
upload-pack (fetch/clone/ls-remote):
  ssh [-o SendEnv=GIT_PROTOCOL] [-p <port>] <host-token> "git-upload-pack '<path>'"
receive-pack (push):
  ssh                            [-p <port>] <host-token> "git-receive-pack '<path>'"
```

- `-o SendEnv=GIT_PROTOCOL` appears **only** for upload-pack, because git 2.55
  requests protocol v2 by exporting `GIT_PROTOCOL=version=2`. Push uses v0 and does
  **not** send it. tsgit targets v0/v1 (ADR-005), so it sets **no** `GIT_PROTOCOL`
  and omits the `SendEnv` option in both directions — this is the documented v1
  choice, not a divergence in git wire bytes (omitting `GIT_PROTOCOL` yields exactly
  the v0 advertisement-first stream tsgit's parser already consumes).
- The remote command is **one argv token**: service name + space + the sq-quoted
  path. The host token is a separate argv element.

**B. Host token, port flag, and remote path extraction:**

| Input URL | host token | port flag | remote path (inside `'…'`) |
|---|---|---|---|
| `ssh://git@example.com/path/to/repo.git` | `git@example.com` | *(none)* | `/path/to/repo.git` |
| `ssh://git@example.com:2222/path/to/repo.git` | `git@example.com` | `-p 2222` | `/path/to/repo.git` |
| `ssh://git@example.com:22/repo.git` | `git@example.com` | `-p 22` *(explicit `:22` ⇒ `-p`)* | `/repo.git` |
| `ssh://example.com/repo.git` *(no user)* | `example.com` | *(none)* | `/repo.git` |
| `ssh://git@example.com/~/repo.git` | `git@example.com` | *(none)* | `~/repo.git` *(leading `/` before `~` stripped)* |
| `git@example.com:path/to/repo.git` *(scp)* | `git@example.com` | *(none)* | `path/to/repo.git` *(relative, no leading `/`)* |
| `git@example.com:/abs/path/repo.git` *(scp)* | `git@example.com` | *(none)* | `/abs/path/repo.git` |
| `git@example.com:~user/repo.git` *(scp)* | `git@example.com` | *(none)* | `~user/repo.git` |

Rule: ssh:// port present in the URL ⇒ `-p <port>` (even `:22`); absent ⇒ no `-p`.
scp-like syntax carries **no** port (`ssh://` required for a non-default port). The
ssh:// path is the URL pathname verbatim, except a leading `/~` collapses to `~`.
The scp path is everything after the first `:`.

**C. sq-quote of the path** (git's `sq_quote_buf`): wrap in single quotes; each
embedded `'` becomes `'\''`. Pinned:

| raw path | quoted token in remote command |
|---|---|
| `/path/to/repo.git` | `git-upload-pack '/path/to/repo.git'` |
| `/pa th.git` *(space)* | `git-upload-pack '/pa th.git'` |
| `o'brien/repo.git` *(scp)* | `git-upload-pack 'o'\''brien/repo.git'` |

**D. Command resolution order.** Pinned that `GIT_SSH_COMMAND` is honoured and
**wins over** `core.sshCommand` (distinct recorders proved env won); `GIT_SSH` (a
program) is honoured; and a plain `ssh` on `PATH` is used when none is set. git's
documented full order, which tsgit replicates: **`GIT_SSH_COMMAND` → `core.sshCommand`
→ `GIT_SSH` → `ssh`**. `GIT_SSH_COMMAND`/`core.sshCommand` are shell strings (may
carry args, e.g. `ssh -v`), shell-word-split by tsgit into program + leading args;
`GIT_SSH` is a lone program path (no split).

**E. Argv-injection refusal** (CVE-2017-1000117 class). Pinned:

| Input | git outcome |
|---|---|
| `ssh://-oProxyCommand=evil/repo.git` | `fatal: strange hostname '-oProxyCommand=evil' blocked` |
| `git@example.com:-leadingdash/repo.git` *(scp)* | `fatal: strange pathname '-leadingdash/repo.git' blocked` |
| `ssh://git@example.com/-dash.git` | *allowed* — ssh:// path is `/-dash.git`, starts with `/` |
| `ssh://git@-evil.example.com/repo.git` | *allowed* — token is `git@-evil…`, starts with `g` |

Unified faithful rule: **refuse when the host token OR the remote path begins with
`-`** (git's `looks_like_command_line_option`). ssh:// paths always start with `/`
so they never trip it; scp paths and userless hosts can, and must be blocked before
spawn. As a **library** (not a CLI), tsgit receives the URL as a string argument, so
it applies this guard itself rather than relying on the git CLI arg parser that
intercepts a leading-`-` scp host.

### Wire difference SSH vs HTTP (the one that shapes the design)

The pure protocol domain is transport-independent, but the *connection choreography*
differs:

- **Smart-HTTP**: two independent, stateless requests. GET
  `…/info/refs?service=git-upload-pack` returns the advertisement **prefixed** with
  `001e# service=git-upload-pack\n0000`; POST `…/git-upload-pack` carries the
  want/have body and returns the pack.
- **SSH (v0)**: one **stateful** duplex channel. On connect, `git-upload-pack` sends
  the advertisement **immediately with no `# service` prologue**; the client then
  writes want/have/done to the *same* channel's stdin and reads the pack from its
  stdout. Push is symmetric with `git-receive-pack`.

So SSH reuses `buildUploadPackRequest` / `parseUploadPackResponse` /
`buildReceivePackRequest` / `parseReceivePackResponse` **verbatim** (the bodies are
transport-independent), and needs exactly one adaptation to the shared parser:
`parseAdvertisedRefs` must skip `consumeServiceHeader` in SSH mode. Proposed: add an
options arg `{ servicePrologue: boolean }` (default `true`, HTTP behaviour
unchanged); SSH passes `false`.

### Component shape

New port (`src/ports/ssh-channel.ts`), interface only — a **thin duplex process
spawner**; it knows nothing about git:

```ts
export interface SshSpawnRequest {
  readonly command: string;                       // resolved ssh program
  readonly args: ReadonlyArray<string>;           // full argv incl. host + remote cmd token
  readonly env: Readonly<Record<string, string>>; // additions merged over parent env
  readonly signal?: AbortSignal;
}
export interface SshChannel {
  readonly stdin: WritableStream<Uint8Array>;     // request bytes to the server
  readonly stdout: ReadableStream<Uint8Array>;    // advertisement + response bytes
  readonly exit: Promise<number>;                 // resolves with the ssh exit code
  readonly close: () => Promise<void>;            // idempotent teardown
}
export interface SshTransport {
  readonly open: (req: SshSpawnRequest) => Promise<SshChannel>;
}
```

Stream shapes mirror `HttpTransport` (`ReadableStream<Uint8Array>` out;
`readableStreamToAsyncIterable` already bridges to the pkt codec). All
faithfulness-bearing logic (URL parse, argv build, sq-quote, dash-guard, command
resolution) lives in the **pure application/domain tier** and is tested once — the
adapter is a dumb spawner, never per-platform faithfulness logic.

New pure modules (application tier, `src/application/commands/internal/`):

- `remote-url.ts` — `parseRemoteUrl(raw)` → discriminated union
  `{ kind: 'http', url } | { kind: 'ssh', user?, host, port?, path }`. Recognises
  `ssh://`, scp-like `[user@]host:path` (a `:` before any `/`, no `://`), and
  http(s). Applies the control-char guard and the leading-`-` dash-guard.
- `ssh-command.ts` — `resolveSshCommand(ctx)` reads `GIT_SSH_COMMAND` /
  `core.sshCommand` / `GIT_SSH` (via `ctx.env` + `readConfig`) in order, returns
  `{ program, baseArgs }` (shell-split for the shell forms).
- `ssh-argv.ts` — `buildSshArgs({ service, parsed, baseArgs })` produces the argv
  array (port rule, host token, `service '<sq-quoted-path>'`). `sqQuote(path)` is the
  faithful quoter.

New session seam that both transports satisfy (**decision candidate 1**). The seam
is **stateful** to accommodate SSH's single channel, and is created **bound to one
service** (`git-upload-pack` / `git-receive-pack`) and the base URL — e.g. a factory
`openGitSession(ctx, url, service) => GitServiceSession` that dispatches on
`parseRemoteUrl(url).kind`:

```ts
export interface GitServiceSession {                 // one per network operation, one service
  readonly advertisement: () => Promise<AsyncIterable<PktLine>>;      // read refs
  readonly exchange: (requestBytes: Uint8Array) => Promise<AsyncIterable<PktLine>>; // send + read
  readonly close: () => Promise<void>;
}
```

- HTTP impl wraps the existing helpers: `advertisement()` = the GET (prologue on);
  `exchange()` = the POST. Stateless — its concrete bytes are unchanged.
- SSH impl: `advertisement()` opens the channel and reads the pre-flush
  advertisement (prologue off); `exchange()` writes to the same channel's stdin and
  returns the rest of stdout. Stateful.

`clone` / `fetch` / `push` pick the session by `parseRemoteUrl(url).kind` at the
single transport-selection point, then drive the pure protocol client uniformly.

### Context wiring

`SshTransport` is an **optional** field on `Context`
(`readonly ssh?: SshTransport;`), mirroring `command` / `hooks`:

- **node** shim (`index.node.ts`) wires a `NodeSshTransport`
  (`node:child_process.spawn(program, args, { env: {...process.env, ...req.env}, stdio: ['pipe','pipe','inherit'] })`,
  exposing stdin/stdout as web streams; `stderr` inherited so ssh prompts/errors are
  never captured — no credential capture). Delegation is total: no key parsing. The
  node shim must **also wire `ctx.env`** (`NodeEnvReader` — it exists in
  `adapters/node/` but the current `RuntimeFallback` omits it), because
  `resolveSshCommand` reads `GIT_SSH_COMMAND` / `GIT_SSH` through it
  (`core.sshCommand` comes from `readConfig`). Without `ctx.env` the env-var tier of
  the resolution order is silently skipped.
- **browser** shim (`index.browser.ts`) wires **nothing** — `ctx.ssh` absent. When a
  command resolves an ssh/scp remote and `ctx.ssh === undefined`, it raises a typed
  refusal (**decision candidate 4/5**). No SSH bytes ship to the browser bundle.
- **memory** shim: absent (like `command`); ssh remotes refuse. A test double may be
  injected for integration.

Added to `RuntimeFallback` (`repository.ts`) and threaded through `openRepository`
exactly like `command`. No SSRF wrapper: ssh handles its own DNS/connection, so
`config.dnsResolver` / `allowInsecure` / `allowPrivateNetworks` (HTTP-only) do not
apply; the dash-guard is the SSH analog and lives in the pure URL parser.

### Error semantics

- Bad scheme / malformed remote → `INVALID_URL` (control chars) or a dash-guard
  refusal (**candidate 5** picks the code).
- `ssh` exits non-zero before/while streaming → surface as `NETWORK_ERROR` with the
  exit code in `reason` (ssh's own stderr goes to the inherited fd, not captured, so
  no credential capture). A protocol-shaped failure (e.g. server closes early) flows
  through the existing pkt/`parseUploadPackResponse` error paths unchanged.
- Browser (no `ctx.ssh`) → typed inert refusal.
- Abort → `close()` kills the child; in-flight reads reject via the existing
  abort-aware stream unwinding.

### Faithfulness scope note

Per ADR-249, faithfulness binds the git **wire bytes and on-disk state**, not the
`ssh` subprocess argv, which is a delegation implementation detail. Nonetheless the
argv/quoting/resolution matrix is pinned and interop-tested because a wrong argv
changes *which repository* is contacted and *what the server-side shell executes* —
i.e. it is security- and correctness-load-bearing even if not a git wire artifact.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Transport-seam abstraction that lets SSH "compose with the v0/v1 client" | (A) Introduce a stateful `GitServiceSession` seam; HTTP + SSH both implement it; clone/fetch/push call it uniformly. (B) Parallel SSH client path reusing only the pure domain primitives; HTTP path untouched; scheme dispatch inline in each command. (C) Force-fit SSH into the `HttpTransport` request/response shape. | **A** | Best matches the brief ("composes with the existing client") and leaves a clean seam for 25.3 v2; HTTP's concrete bytes stay identical (its impl wraps today's helpers). B duplicates orchestration across three commands; C mismodels a duplex as req/resp. |
| 2 | SSH port shape | (A) Thin duplex spawner `SshTransport.open({command,args,env}) => SshChannel`; argv/quoting/resolution stay pure. (B) Rich git-aware port taking parsed connection + service; adapter builds argv. (C) Reuse/extend `CommandRunner`. | **A** | Keeps faithfulness logic pure + tested once; adapter is a dumb process bridge. B scatters faithful argv into per-platform adapters. C impossible — `CommandRunner` buffers stdout and is one-shot, no interleaved duplex. |
| 3 | Duplex data shape across the port | (A) Web streams (`ReadableStream`/`WritableStream<Uint8Array>`). (B) `AsyncIterable` out + sink callback in. (C) Node stream objects. | **A** | Consistent with `HttpResponse.body`; `readableStreamToAsyncIterable` already bridges to the pkt codec; portable. C leaks node types into a port. |
| 4 | Browser "inert" mechanism | (A) `ctx.ssh` absent (optional field); the command refuses when a resolved remote is ssh and `ctx.ssh` is undefined. (B) A browser `SshTransport` whose `open()` always rejects. (C) Runtime-sniff (`isBrowser`) inside commands. | **A** | Matches `CommandRunner`/`HookRunner` + ADR-133 (browser omits the runner; the consumer refuses); zero browser bundle weight; no runtime sniffing in domain-adjacent code. |
| 5 | Refusal error taxonomy (inert browser + bad host/path) | (A) Reuse `unsupportedOperation('ssh-transport', reason)` (`UNSUPPORTED_OPERATION`). (B) New `SSH_UNSUPPORTED` command error code. (C) `ADAPTER_UNAVAILABLE(runtime:'browser', reason)` for the browser case; dash-guard reuses `INVALID_URL`. | **C** | `ADAPTER_UNAVAILABLE` already means "this adapter can't do this" and carries `runtime`; `INVALID_URL` already covers malformed remotes incl. the dash-guard. Avoids inventing a code (structured-data faithfulness). A is the fallback if a non-browser "no ssh wired" case needs distinguishing. |
| 6 | Protocol version over SSH | (A) v0/v1 only; never set `GIT_PROTOCOL`; consume the v0 advertisement-first stream. (B) Request v2 (`-o SendEnv=GIT_PROTOCOL` + env) and parse a v2 advertisement. | **A** | Consistent with ADR-005 and with git's own push (v0); 25.3 owns v2. Pinned: omitting `GIT_PROTOCOL` yields the exact v0 stream the existing parser handles. |
| 7 | URL parsing + SSRF story for ssh | (A) New pure `parseRemoteUrl` classifying http/ssh/scp with control-char + dash guards; `validateUrl` (DNS/SSRF) stays HTTP-only; ssh bypasses DNS (delegated to ssh). (B) Extend `validateUrl` to also accept ssh. | **A** | DNS pinning + IP blocklist are meaningless when ssh owns resolution; scp-like isn't a WHATWG URL so it can't go through `new URL()`. The dash-guard is the SSH analog of the SSRF guard. |
| 8 | ssh variant handling | (A) OpenSSH-style argv only (`-p` for port); document plink/tortoiseplink (`-P`) + variant auto-detection as a follow-up. (B) Replicate git's variant auto-detection (`ssh -G` probe + basename table, `simple`/`plink`/`tortoiseplink`/`putty`). | **A** | OpenSSH is the overwhelming default on every target platform; git's variant table is heavy and mostly Windows-PuTTY. A ships the 95% faithfully; B is a large surface better sized as its own backlog item. |

## Test strategy

- **Unit (pure, 100% + mutation):**
  - `parseRemoteUrl` — ssh://, scp-like, http(s); user/port/tilde extraction; the
    scp-vs-ssh disambiguation (`:` before `/`, no `://`); control-char and dash-guard
    refusals (host and path, both syntaxes). *Property lens (round-trip)*:
    `format(parse(x)) ≡ x` over an ASCII remote-URL grammar; `parseRemoteUrl` is half
    of a parse/format pair → `*.properties.test.ts` sibling.
  - `sqQuote` — example matrix incl. embedded `'` and space; *property lens*: a
    `sqQuote`d token, unwrapped by a real `sh -c 'printf %s'`, equals the input.
  - `buildSshArgs` — the full pinned matrix (port rule incl. explicit `:22`, host
    token, service command token, upload vs receive).
  - `resolveSshCommand` — precedence sweep over `EnvReader` + config stub
    (`GIT_SSH_COMMAND` > `core.sshCommand` > `GIT_SSH` > `ssh`); shell-split of the
    shell forms vs no-split for `GIT_SSH`.
  - `parseAdvertisedRefs({ servicePrologue: false })` — SSH advertisement with no
    `# service` prologue (incl. the empty-repo zero-oid advertisement); assert the
    HTTP `true` path is byte-unchanged.
  - Inert refusal: command with an ssh remote and `ctx.ssh === undefined` throws the
    chosen typed error (assert `.data`, per mutation-resistant convention).
- **Integration (node, `test/integration/`):** a fake `ssh` (installed via
  `GIT_SSH_COMMAND`) that bridges the argv's remote command to a locally spawned
  `git-upload-pack` / `git-receive-pack` over pipes; clone/fetch/push a real seed
  repo; assert pack + refs + reflog. Reuses the git-subprocess env hardening
  (`GIT_*` scrubbed) from the interop helper.
- **Interop (`test/integration/*-interop.test.ts`, the faithfulness gate):**
  - argv/quoting/resolution: drive **real `git`** through the same recorder and
    assert tsgit's `buildSshArgs`/`resolveSshCommand` output equals git's real
    connection argv for the pinned matrix — signing OFF, `GIT_*` scrubbed, `mktemp`.
  - cross-tool object identity: tsgit clone over the fake-ssh bridge vs `git clone`
    over the same bridge into the same source ⇒ identical object store + refs.
  - dash-guard refusal parity (host and path, both syntaxes).
- **Browser (playwright surface):** an ssh remote raises the inert refusal; extend
  the browser-surface audit (ADR-131/132) — clone/fetch/push are already allowlisted
  (ADR-133); add the ssh-inert assertion so the refusal is observed, not merely
  untested.

## Out of scope

- **smart-HTTP v2 / v2-over-ssh / incremental negotiation** — sibling 25.3; the
  `GitServiceSession` seam is designed to admit it later.
- **git:// (daemon) and dumb-HTTP** transports — not requested.
- **Non-OpenSSH variants** (plink/tortoiseplink `-P`) and git's `ssh -G` variant
  auto-detection — candidate 8; follow-up backlog item.
- **Browser SSH** — structurally impossible (no process spawn in-browser); inert by
  design, mirroring ADR-133's `runHook`.
- **Key/agent/known_hosts management** — fully delegated to the spawned `ssh` per the
  brief; tsgit parses none of it.
- **Server-side hooks** — ADR-299 (out of scope project-wide).
- **ssh connection multiplexing / reuse across operations** — each operation opens
  one channel; pooling is a later optimisation.
