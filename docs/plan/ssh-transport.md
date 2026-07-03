# Plan — SSH transport

> Source: design doc `docs/design/ssh-transport.md` · ADRs 434, 435, 436, 437, 438, 439, 440, 441
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Shared context (read once — applies to every part)

- **Working tree:** `/Users/scolladon/workspace/perso/node/tsgit-ssh-transport` (work ONLY here). Serena MCP is **not** connected — use Read/Grep/Glob.
- **Part-gate command** (each part closes green on it):
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files>`
- **Test conventions (CLAUDE.md):** `describe('Given …')` > `describe('When …')` > `it('Then …')`; AAA body with section comments; system under test named `sut`; 100% line/branch/function/statement coverage; target 0 surviving mutants. Error assertions must assert `.data` (code + fields), never `toThrow(Class)` alone; guard clauses get isolated per-condition tests. No `v8 ignore` / `stryker-disable` / `biome-ignore` / `@ts-ignore`. No phase/ADR/backlog refs in source or test.
- **Property tests (CLAUDE.md):** parsers/round-trip pairs get a `*.properties.test.ts` sibling; per-family generators live in a shared `arbitraries.ts` in the same directory. `numRuns`: 200 cheap round-trip, 100 default, 50 filter-heavy. Never commit a seed.
- **Interop discipline:** real-`git` tests live in `test/integration/*-interop.test.ts` and MUST spawn git through the helpers in `test/integration/interop-helpers.ts` (`runGit`/`tryRunGit`/`runGitEnv` — they scrub every `GIT_*`, pin `HOME` to a non-existent tmp path, set `GIT_CONFIG_NOSYSTEM=1`). Signing is off by construction (isolated HOME → no `user.signingkey`). `GIT_AVAILABLE` gates the suite.
- **Hexagonal dependency rule:** `repository → commands → primitives → domain`; ports sit between application and adapters; domain imports nothing outward. A **primitive** (`src/application/primitives/*`) may NOT import from `src/application/commands/*` — the architecture boundary-check harness enforces this.
- **Error constructors already exist** (no new codes — ADR-438): `invalidUrl(reason)` (`INVALID_URL`, `src/domain/commands/error.ts:300`), `adapterUnavailable(runtime, reason)` (`ADAPTER_UNAVAILABLE`, sanitizes reason, `:414`), `networkError(reason)` (`NETWORK_ERROR`, `src/domain/error.ts:140`), `sanitizeForDisplay` (`src/domain/commands/error.ts`, scrubs control chars for embedded values).
- **Structured-output invariant (ADR-249):** transports return bytes/streams; no rendered strings. Nothing in this feature emits a display line.

## Part 1 — Parse ssh/scp/http remote URLs

### Context
New pure classifier, **internal** (consumed by Parts 2, 4, 5; NOT re-exported from the package entry — `src/public-types.ts` re-exports `application/commands/index.js` and `ports/index.js` only, never `commands/internal/*`, so no api.json impact).

- **Create** `src/application/commands/internal/remote-url.ts`:
  - `export type RemoteUrl = { readonly kind: 'http'; readonly url: string } | { readonly kind: 'ssh'; readonly user?: string; readonly host: string; readonly port?: number; readonly path: string }`. (`kind: 'http'` covers both `http:` and `https:` — the URL string is passed verbatim to the HTTP session which already parses scheme.)
  - `export const parseRemoteUrl = (raw: string): RemoteUrl`.
  - `export const formatRemoteUrl = (parsed: RemoteUrl): string` — the inverse used by the round-trip property (reconstructs the canonical `ssh://[user@]host[:port]/path`, the scp form, or the http url).
- **Classification rules (ADR-440, design matrix B):**
  - Reject control chars first: any `\n` (0x0A), `\r` (0x0D), or NUL (0x00) anywhere in `raw` → `invalidUrl('contains forbidden control character')` (mirror `rejectControlChars` in `src/application/commands/internal/url-validate.ts:38`; add NUL to the set).
  - `http://` or `https://` prefix → `{ kind: 'http', url: raw }`.
  - `ssh://` prefix → parse with `new URL(raw)`: `user = url.username || undefined`, `host = url.hostname`, `port = url.port === '' ? undefined : Number(url.port)` (explicit `:22` ⇒ `port: 22`, NOT dropped), `path` = `url.pathname` **except** a leading `/~` collapses to `~` (`/~/repo.git` → `~/repo.git`, `/~user/x` → `~user/x`). host token for argv is rebuilt later in Part 2 from `{user, host}`.
  - scp-like: a `:` appears **before** the first `/` and there is no `://` → split at the first `:`. Left = `[user@]host` (`user` before `@`); right = `path` **verbatim** (relative `path/to/repo.git` stays relative — no leading `/` added; `/abs/…` and `~user/…` kept as-is). No port syntax in scp form.
    - Disambiguation guard (ADR-440): a single-character segment before the `:` that looks like a Windows drive letter is NOT a host — but tsgit targets POSIX remotes; treat any `[user@]host:path` with a `:` before `/` as scp. (Keep the rule literal to git: colon-before-slash ⇒ scp.)
  - Anything else (no scheme, no colon-before-slash) → `invalidUrl('unrecognised remote URL')`.
- **Dash-guard (ADR-440/438, matrix E) — the SSH SSRF analog, refuse before any spawn:**
  - After extracting `host` (ssh + scp) and `path` (scp only — ssh paths always start with `/` so they never trip it), if the **host token** OR the **remote path** begins with `-`, throw `invalidUrl` with a reason embedding the sanitized offending value, e.g. `invalidUrl(`strange hostname '${sanitizeForDisplay(host)}' blocked`)` / `invalidUrl(`strange pathname '${sanitizeForDisplay(path)}' blocked`)`. Use `sanitizeForDisplay` (`src/domain/commands/error.ts`) so a hostile token cannot inject control bytes into the message.
  - Pinned outcomes: `ssh://-oProxyCommand=evil/repo.git` → host token `-oProxyCommand=evil` refused; `git@example.com:-leadingdash/repo.git` → path `-leadingdash/repo.git` refused; `ssh://git@example.com/-dash.git` → **allowed** (ssh path `/-dash.git` starts with `/`); `ssh://git@-evil.example.com/repo.git` → **allowed** (host token `git@-evil…` starts with `g`, the `@user` prefix means the token does not begin with `-`).
- **Tests** (create `test/unit/application/commands/internal/remote-url.test.ts`, `remote-url.properties.test.ts`, `arbitraries.ts` — dir already holds `url-validate.test.ts`):
  - Example matrix: every row of design matrix B (user/port/tilde extraction, scp relative vs absolute vs `~user`, explicit `:22`), the scp-vs-ssh disambiguation, http/https pass-through.
  - Dash-guard: **isolated** tests per condition (host-dash ssh, host-dash scp, path-dash scp) asserting `err.data.code === 'INVALID_URL'` and `err.data.reason` contains the sanitized token; plus the two **allowed** rows.
  - Control-char + NUL rejection: isolated tests per byte (`\n`, `\r`, `\0`).
  - Property (round-trip lens, CLAUDE.md case 1): `arbitraries.ts` exports a `remoteUrlArb` over an ASCII grammar (choose kind; ssh: optional user, host `[a-z0-9.-]` not leading `-`, optional port, path with/without `/~`; scp: host, path not leading `-`; http). Property: `parseRemoteUrl(formatRemoteUrl(parseRemoteUrl(x)))` deep-equals `parseRemoteUrl(x)` (canonicalising round-trip) at `numRuns: 200`.

### TDD steps
- RED: write `remote-url.test.ts` matrix + dash-guard + control-char cases → fail (`Cannot find module './remote-url.js'`).
- GREEN: implement `parseRemoteUrl`/`formatRemoteUrl`/`RemoteUrl` minimally to pass.
- RED: add `remote-url.properties.test.ts` + `arbitraries.ts` round-trip → shrinks to any grammar row `formatRemoteUrl` mishandles.
- GREEN: fix `formatRemoteUrl`/`parseRemoteUrl` until the property holds.
- REFACTOR: extract `classifyScheme` / `splitScpLike` / `applyDashGuard` early-return helpers (<20 lines each, nesting ≤2); no magic strings (name the `'-'`, `'~'` sentinels).

### Gate
`npx vitest run test/unit/application/commands/internal/remote-url.test.ts test/unit/application/commands/internal/remote-url.properties.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/remote-url.ts test/unit/application/commands/internal/remote-url.test.ts test/unit/application/commands/internal/remote-url.properties.test.ts test/unit/application/commands/internal/arbitraries.ts`

### Commit
`feat: parse ssh and scp-like remote URLs`

## Part 2 — Faithful OpenSSH argv, sq-quote, and ssh-command resolution

### Context
Two new **internal** pure modules (consumed by Part 5). All faithfulness-bearing logic lives here and is tested once (ADR-435). OpenSSH-only argv — `-p` for port, no variant detection (ADR-441, an explicit ADR-226 divergence for non-OpenSSH clients). Never set `GIT_PROTOCOL` (ADR-439).

- **Create** `src/application/commands/internal/ssh-argv.ts`:
  - `export const sqQuote = (s: string): string` — git's `sq_quote_buf`: wrap in single quotes, replace each embedded `'` with `'\''`. Pinned (design matrix C): `/path/to/repo.git` → `'/path/to/repo.git'`; `/pa th.git` → `'/pa th.git'`; `o'brien/repo.git` → `'o'\''brien/repo.git'`.
  - `export const buildSshArgs = (input: { readonly service: Service; readonly parsed: Extract<RemoteUrl, { kind: 'ssh' }>; readonly baseArgs: ReadonlyArray<string> }): ReadonlyArray<string>` — assembles the full argv **after** the resolved program: `[...baseArgs, ...portFlag, hostToken, remoteCommand]` where
    - `portFlag` = `parsed.port === undefined ? [] : ['-p', String(parsed.port)]` (explicit `:22` ⇒ `['-p','22']`, matrix B).
    - `hostToken` = `parsed.user === undefined ? parsed.host : `${parsed.user}@${parsed.host}``.
    - `remoteCommand` = ONE argv token: `${service} ${sqQuote(parsed.path)}` (e.g. `git-upload-pack '/path/to/repo.git'`). `service` is `'git-upload-pack'` (fetch/clone/ls-remote/pull) or `'git-receive-pack'` (push) — reuse `Service` from `src/domain/protocol/index.js`.
    - Emit **no** `-o SendEnv=GIT_PROTOCOL` (ADR-439 — v0 stream; the design's matrix A shows git adds it only for its v2 upload-pack, which tsgit does not request).
  - Import `RemoteUrl` from `./remote-url.js`, `Service` from `../../../domain/protocol/index.js`.
- **Create** `src/application/commands/internal/ssh-command.ts`:
  - `export const resolveSshCommand = async (ctx: Context): Promise<{ readonly program: string; readonly baseArgs: ReadonlyArray<string> }>` — git's resolution order (design matrix D): `GIT_SSH_COMMAND` → `core.sshCommand` → `GIT_SSH` → `'ssh'`.
    - `GIT_SSH_COMMAND` and `GIT_SSH` are read via `ctx.env?.get(name)` (`EnvReader`, `src/ports/env-reader.ts`). `core.sshCommand` via `readConfig(ctx)` (`src/application/primitives/config-read.ts`; shape `config.core?.get('sshCommand')` — verify the accessor against a sibling `readConfig` consumer, e.g. `push.ts`'s `config.remote?.get`).
    - `GIT_SSH_COMMAND` / `core.sshCommand` are **shell strings** (may carry args, e.g. `ssh -v -o X=y`): shell-word-split into `program` (first word) + `baseArgs` (rest). `GIT_SSH` is a **lone program path** — NO split (`program = value`, `baseArgs = []`).
    - Precedence: first non-empty source wins; env beats config (pinned matrix D — distinct recorders proved env wins).
  - Shell-word-split: a minimal POSIX word splitter honouring single/double quotes and backslash is sufficient for the pinned cases; keep it a small pure helper with its own tests. Do NOT shell out to split.
  - Import `Context` from `../../../ports/context.js`.
- **Tests:**
  - `test/unit/application/commands/internal/ssh-argv.test.ts`: `sqQuote` matrix (incl. embedded `'`, space, empty); `buildSshArgs` full pinned matrix B/C — port present/absent/explicit-22, user/no-user host token, upload-pack vs receive-pack command token. Assert exact argv arrays.
  - `test/unit/application/commands/internal/ssh-argv.properties.test.ts` (+ extend the Part-1 `arbitraries.ts` in the same dir with a `pathArb` of ASCII strings incl. quotes/spaces): property (round-trip / total-function lens) — a `sqQuote(p)` token, unwrapped by a real `sh -c 'printf %s <token>'` via `node:child_process.execFileSync('sh', ['-c', `printf %s ${sqQuote(p)}`])`, equals `p`. `numRuns: 200`. Skip gate `hasSh` if `sh` unavailable (it is present on darwin/linux CI).
  - `test/unit/application/commands/internal/ssh-command.test.ts`: precedence sweep with a stub `ctx.env` (`{ get: (n) => map[n] }`) and a stubbed/`readConfig`-backed config. Isolated tests per source: only `GIT_SSH_COMMAND` set; only `core.sshCommand`; only `GIT_SSH`; none → `'ssh'`; `GIT_SSH_COMMAND` + `core.sshCommand` both set → env wins; shell-split of `ssh -v` (program `ssh`, baseArgs `['-v']`) vs `GIT_SSH` = `/usr/bin/ssh` (no split). For `core.sshCommand`, back `readConfig` with a memory fs holding `.git/config` (mirror how existing `config-read` unit tests build their fixture) OR inject — pick the lighter of the two after reading `config-read.ts`.
  - **Interop** `test/integration/ssh-argv-interop.test.ts` (the faithfulness gate — uses `interop-helpers.ts`):
    - Install a **recorder** ssh script into a `mkdtemp` dir (`#!/bin/sh` that appends `"$@"` to a log file and exits 0), `chmod 0755`. Drive **real git** via `runGit(['-c', `core.sshCommand=${recorder}`, 'ls-remote', <ssh-url>], {env})` (and separately via `GIT_SSH_COMMAND`, `GIT_SSH`, and a `PATH`-shadowed `ssh`) for each matrix-B/C/D row; read the recorded argv; assert tsgit's `resolveSshCommand` + `buildSshArgs` reproduce git's real **connection** argv (host token, `-p` rule, sq-quoted remote command). Note git may first run a `ssh -G` probe for custom commands — filter to the connection invocation (the one carrying the `git-upload-pack '…'` token), per design section "Pinned faithfulness matrix A".
    - **Dash-guard co-refusal parity** (matrix E): `tryRunGit(['ls-remote', 'ssh://-oProxyCommand=evil/repo.git'])` and the scp `-leadingdash` form exit non-zero with `strange hostname/pathname … blocked`; assert tsgit's `parseRemoteUrl` (from Part 1) refuses the same inputs with `INVALID_URL`, and **allows** the two allowed rows (git also allows them — assert git does not print `blocked`).

### TDD steps
- RED: `ssh-argv.test.ts` sqQuote + buildSshArgs matrix → `Cannot find module './ssh-argv.js'`.
- GREEN: implement `sqQuote` + `buildSshArgs`.
- RED: `ssh-command.test.ts` precedence sweep → `Cannot find module './ssh-command.js'`.
- GREEN: implement `resolveSshCommand` + the word-splitter helper.
- RED: `ssh-argv.properties.test.ts` sqQuote round-trip via `sh` → shrinks to any quoting bug.
- GREEN: fix `sqQuote`.
- RED: `ssh-argv-interop.test.ts` vs real git → fails where tsgit argv/resolution diverges from git's recorded argv.
- GREEN: align `buildSshArgs`/`resolveSshCommand` to the recorded bytes.
- REFACTOR: extract `portFlag`/`hostToken`/`remoteCommand` builders; keep functions <20 lines, early returns.

### Gate
`npx vitest run test/unit/application/commands/internal/ssh-argv.test.ts test/unit/application/commands/internal/ssh-argv.properties.test.ts test/unit/application/commands/internal/ssh-command.test.ts test/integration/ssh-argv-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/ssh-argv.ts src/application/commands/internal/ssh-command.ts test/unit/application/commands/internal/ssh-argv.test.ts test/unit/application/commands/internal/ssh-argv.properties.test.ts test/unit/application/commands/internal/ssh-command.test.ts test/unit/application/commands/internal/arbitraries.ts test/integration/ssh-argv-interop.test.ts`

### Commit
`feat: build faithful OpenSSH argv and resolve the ssh command`

## Part 3 — SshTransport port, node adapter, and context wiring

### Context
Adds the port + platform adapter + capability wiring. **Public-surface decision:** `SshTransport`, `SshChannel`, `SshSpawnRequest` are **public** (mirroring `CommandRunner`/`HttpTransport`, which live in `src/ports/index.ts` and are re-exported by `src/public-types.ts` via `export type * from './ports/index.js'`). `Context` gains public fields. → **api.json regen is a prepush gate (pre-pay here):** run `npm run docs:json` and commit `reports/api.json` (huge typedoc-id diff is normal). Also add the three port types to the knip-reachability witness `test/unit/api-surface/snapshot-exports.test.ts` (imports port types so `check:dead-code` sees them reachable).

- **Create** `src/ports/ssh-channel.ts` — interface only, knows nothing about git (ADR-435 thin duplex spawner; ADR-436 web streams):
  ```ts
  export interface SshSpawnRequest {
    readonly command: string;                        // resolved ssh program
    readonly args: ReadonlyArray<string>;            // full argv incl. host + remote-cmd token
    readonly env: Readonly<Record<string, string>>;  // additions merged OVER parent env by the adapter
    readonly signal?: AbortSignal;
  }
  export interface SshChannel {
    readonly stdin: WritableStream<Uint8Array>;      // request bytes to the server
    readonly stdout: ReadableStream<Uint8Array>;     // advertisement + response bytes
    readonly exit: Promise<number>;                  // resolves with the ssh exit code
    readonly close: () => Promise<void>;             // idempotent teardown (kills child)
  }
  export interface SshTransport {
    readonly open: (req: SshSpawnRequest) => Promise<SshChannel>;
  }
  ```
- **Edit** `src/ports/index.ts`: add `export type { SshChannel, SshSpawnRequest, SshTransport } from './ssh-channel.js';` (alphabetical with the other `export type` lines).
- **Edit** `src/ports/context.ts`:
  - Import `type { SshTransport } from './ssh-channel.js'`.
  - `Context`: add `readonly ssh?: SshTransport;` (doc: "Optional SSH transport. Absent ⇒ ssh/scp remotes refuse — browser/memory cannot spawn a process."), mirroring the `command`/`env` fields (lines 120–132).
  - `Context`: add `readonly runtime: 'node' | 'browser' | 'memory';` (**required** — sourced from `fallback.runtime`; used by the inert refusal in Part 4 to name the runtime in `ADAPTER_UNAVAILABLE`, mirroring the existing `adapterUnavailable(fallback.runtime, …)` pattern in `src/repository/compose-adapters.ts`). Blast radius is small: `createContext` has 3 src callers (`node-adapter.ts`, `browser-adapter.ts`, `memory-adapter.ts`) + 1 test caller; most test ctx objects use `as unknown as Context` casts (unaffected). Add `runtime` to `CreateContextParts` and to those callers — let `check:types` enumerate the fix sites.
  - `CreateContextParts`: add `readonly ssh?: SshTransport;` and `readonly runtime: 'node' | 'browser' | 'memory';`. `createContext` already spreads `parts`, so no body change beyond passing `runtime` through.
- **Create** `src/adapters/node/node-ssh-transport.ts` — the ONLY faithfulness-free spawner (ADR-435). Mirror `NodeCommandRunner` (`src/adapters/node/node-command-runner.ts`) for the injectable-ops + abort pattern:
  - `child_process.spawn(req.command, req.args, { env: { ...process.env, ...req.env }, stdio: ['pipe', 'pipe', 'inherit'], ...(req.signal ? { signal: req.signal } : {}) })`. **stderr inherited** (`'inherit'`) so ssh prompts/errors are never captured — no credential capture (ADR-435, design "Context wiring").
  - `stdin: Writable.toWeb(child.stdin) as WritableStream<Uint8Array>`, `stdout: Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>` (mirror `Readable.toWeb` in `node-http-transport.ts:72`).
  - `exit: new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 128)))` (128 = signal-killed, as `SIGNAL_KILLED_EXIT` in `node-command-runner.ts`). Handle `'error'` (spawn failure) → resolve exit `127` (`SPAWN_ERROR_EXIT`).
  - `close: async () => { child.kill(); await exit; }` — idempotent.
  - Injectable `SshTransportOps` (`{ spawn }`) + `realSshTransportOps` so unit tests drive every branch with a fake child (no real process). `export class NodeSshTransport implements SshTransport`.
- **Edit** `src/index.node.ts`: import `NodeSshTransport` and `NodeEnvReader` (`./adapters/node/node-env-reader.js`); add to the `fallback` object `ssh: new NodeSshTransport()` and `env: new NodeEnvReader()`. (ADR-437: node wires `ctx.env` because `resolveSshCommand` reads `GIT_SSH_COMMAND`/`GIT_SSH` through it; without it that resolution tier is silently skipped.)
- **Edit** `src/repository.ts`:
  - `RuntimeFallback` (line 140): add `readonly ssh?: SshTransport;` and `readonly env?: EnvReader;` (import both types).
  - `openRepository` ctx assembly (baseCtx / final `Object.freeze`, lines 386–421): thread `runtime: fallback.runtime` into `baseCtx`; thread `...(fallback.ssh !== undefined ? { ssh: fallback.ssh } : {})` and `...(fallback.env !== undefined ? { env: fallback.env } : {})` into the final freeze (mirror the `command` field, line 419) — `exactOptionalPropertyTypes` requires the conditional spread.
  - Browser (`src/index.browser.ts`) and memory shims wire **neither** ssh nor env (ADR-437: capability absence = inert). No change to `index.browser.ts` fallback except confirming `runtime: 'browser'` is already present (it is).
- **Behavior-change watch (ADR-437 "widens the default node context"):** wiring `ctx.env` in node means `resolve-notes-ref.ts` (the only current `ctx.env` consumer, `ctx.env?.get('GIT_NOTES_REF')`) now reads the real `process.env.GIT_NOTES_REF` in node. Run the full notes suites (`test/unit/**/notes*`, `test/integration/**/notes*`) after wiring; they must stay green (interop tests already scrub `GIT_*` on the git side; the tsgit side reads the test-runner env — assert no test relies on `GIT_NOTES_REF` being unset by building ctx directly). If a green regression appears, escalate `{ notes-env, reason, ≤3 options }` — do not silently change notes behaviour.

### TDD steps
- RED: `test/unit/adapters/node/node-ssh-transport.test.ts` with injected fake ops — spawn writes stdin, reads stdout, resolves `exit` with the child code; `'error'` → 127; `close()` kills and awaits; abort forwards to `child.kill`. Fails: `Cannot find module '../../../../src/adapters/node/node-ssh-transport.js'`.
- GREEN: implement `NodeSshTransport` + ops.
- RED: `test/integration/node-ssh-transport.test.ts` — real spawn of a trivial process to prove the web-stream bridge end-to-end: `open({ command: 'sh', args: ['-c', 'cat'], env: {} })`, write bytes to `stdin`, read them back from `stdout`, assert `exit === 0`; and `open({ command: 'sh', args: ['-c', 'exit 3'], env: {} })` → `exit === 3`. Fails until the adapter bridges streams correctly.
- GREEN: fix the `Readable.toWeb`/`Writable.toWeb` wiring.
- RED: extend `test/unit/index.node.test.ts` — node `openRepository` ctx has `ssh instanceof NodeSshTransport`, `env` defined, `runtime === 'node'`; extend `test/unit/index.browser.test.ts` — browser ctx has `ssh === undefined`, `env === undefined`, `runtime === 'browser'`. Fails until shims + threading land.
- GREEN: wire shims + `RuntimeFallback` + `openRepository` threading + `Context`/`CreateContextParts` fields + `createContext` callers.
- REFACTOR: dedupe the child-lifecycle exit/error/abort handling into small helpers; keep the adapter under 120 lines.
- Surface gate (in-part): add the three port types to `test/unit/api-surface/snapshot-exports.test.ts` witnesses; run `npm run docs:json`; commit `reports/api.json`.

### Gate
`npx vitest run test/unit/adapters/node/node-ssh-transport.test.ts test/integration/node-ssh-transport.test.ts test/unit/index.node.test.ts test/unit/index.browser.test.ts test/unit/api-surface/snapshot-exports.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/ssh-channel.ts src/ports/index.ts src/ports/context.ts src/repository.ts src/index.node.ts src/adapters/node/node-ssh-transport.ts`
(Before commit: `npm run docs:json` to refresh `reports/api.json`, then include it in the commit.)

### Commit
`feat: add SshTransport port with node adapter and context wiring`

## Part 4 — GitServiceSession seam + behavior-preserving HTTP migration

### Context
Introduces the stateful transport seam and migrates the existing HTTP command path onto it (ADR-434, **user-ratified**). HTTP concrete wire bytes are **unchanged** — the HTTP session wraps today's helpers; the existing clone/fetch/pull/push/promisor tests are the re-proof. SSH is NOT wired yet: `openGitSession`'s ssh branch returns the **inert refusal** (ADR-437/438), which is the permanent browser/memory behaviour; Part 5 upgrades it to use `ctx.ssh`. All symbols here are **internal** — `parseAdvertisedRefs` and the protocol module are NOT in `public-types.ts`, so no api.json impact (adding an optional param is backward-compatible regardless).

- **The seam interface (ADR-434), created in** `src/application/commands/internal/git-service-session.ts`:
  ```ts
  export interface GitServiceSession {                 // one per network operation, one service
    readonly advertisement: () => Promise<AsyncIterable<PktLine>>;      // read refs (raw pkt stream)
    readonly exchange: (requestBytes: Uint8Array) => Promise<AsyncIterable<PktLine>>; // send + read
    readonly close: () => Promise<void>;
    readonly servicePrologue: boolean;  // true = smart-HTTP (advertisement carries `# service` prologue); false = SSH
  }
  ```
  - **Planner refinement of ADR-434 (additive, not a divergence):** the three verbs are exactly as pinned; a readonly `servicePrologue` discriminant is added so the discovery helper picks the advertisement-parse mode from the session, keeping commands free of per-transport branching beyond the single `openGitSession` dispatch point. (Alternative — return `{ session, servicePrologue }` from `openGitSession` — is equivalent; the discriminant-on-session form is chosen for the single-object lifecycle with `close()`.)
  - `export const openGitSession = (ctx: Context, url: string, service: Service): GitServiceSession` — dispatches on `parseRemoteUrl(url).kind` (Part 1):
    - `'http'` → the HTTP session (below).
    - `'ssh'` → **THIS PART:** `throw adapterUnavailable(ctx.runtime, 'ssh: transport unavailable in this runtime')` (ADR-438; `ctx.runtime` from Part 3). Two isolated tests kill any default-branch mutant: one with `ctx.runtime === 'browser'` asserting `err.data.runtime === 'browser'`, one with `'memory'`. (Part 5 replaces this branch body.)
  - **HTTP session** `HttpGitServiceSession` — wraps the existing helpers so bytes are unchanged:
    - Constructor builds the wrapped transport ONCE via `withDefaults(ctx, ctx.config?.auth !== undefined ? { auth: ctx.config.auth } : {})` (moved here from `clone.ts`/`fetch.ts`/`push.ts` — `withDefaults` from `./network-pipeline.js`).
    - `advertisement()`: the GET — `buildDiscoveryUrl(url, service)` (`domain/protocol`), `transport.request({ url, method:'GET', headers:{ accept: ACCEPT_HEADER[service] }, ...signal })`, non-200 → `httpError(...)` (verbatim from `refs-discovery.ts:29-51`), return `decodePktStream(readableStreamToAsyncIterable(response.body))` — **raw pkt stream, prologue still present**.
    - `exchange(requestBytes)`: the POST — URL = `service === 'git-upload-pack' ? buildUploadPackUrl(url) : buildReceivePackUrl(url)` (move both private builders here from `fetch-pack.ts:259` and `push.ts:366`), content-type/accept per service (`application/x-git-upload-pack-request`/`-result`, or `…receive-pack…`), non-200 → `httpError`, return `decodePktStream(readableStreamToAsyncIterable(response.body))`.
    - `close()`: no-op resolved promise (HTTP is stateless). `servicePrologue: true`.
    - `ACCEPT_HEADER` map: move from `refs-discovery.ts`.
- **`parseAdvertisedRefs` servicePrologue option (ADR-439 — SSH advertisement has no `# service` prologue).** Edit `src/domain/protocol/upload-pack.ts:237`:
  - New signature: `parseAdvertisedRefs(source, expectedService, options?: { readonly servicePrologue?: boolean })` — default `servicePrologue: true` (HTTP unchanged). When `false`, **skip** `consumeServiceHeader(iter, …)` (line 243) and go straight to `collectRefs(iter)`. Everything else (findHead, iter.return finally) unchanged.
  - Re-export unchanged from `src/domain/protocol/index.ts` (already exported).
- **`GitExchange` callback type (hexagonal fix).** A primitive (`fetch-pack.ts`) may NOT import from `commands/internal/`, so it cannot import `GitServiceSession`. Define `export type GitExchange = (requestBytes: Uint8Array) => Promise<AsyncIterable<PktLine>>` in `src/domain/protocol/pkt-line.ts` (next to `PktLine`, primitive-importable) and re-export from the protocol barrel. `HttpGitServiceSession.exchange` (and Part 5's SSH `exchange`) satisfy it structurally.
- **Migrate `fetch-pack.ts`** (`src/application/primitives/fetch-pack.ts`): change `fetchPack(ctx, transport, input)` → `fetchPack(ctx, exchange: GitExchange, input)`; delete `input.url` from `FetchPackInput` and delete the private `buildUploadPackUrl`; `downloadPack` calls `await exchange(buildUploadPackRequest({...}))` → the returned pkt stream feeds `parseUploadPackResponse(...)` unchanged (drop the inline `transport.request`/`decodePktStream`/statusCode block, now in the HTTP session). Keep drain/verify/walk/write untouched.
- **Migrate discovery** (`src/application/commands/internal/refs-discovery.ts`): `discoverRefsForService(session: GitServiceSession, service: Service)` → `parseAdvertisedRefs(await session.advertisement(), service, { servicePrologue: session.servicePrologue })`. Update the thin wrappers `discoverRefs` (`upload-pack-client.ts:28`) and `discoverReceivePackRefs` (`receive-pack-client.ts:22`) to take the session. Delete the now-unused `HttpTransport`/`buildDiscoveryUrl`/`ACCEPT_HEADER` imports from `refs-discovery.ts` (moved to the session).
- **Migrate `clone.ts`** (`fetchAndPropagate`, line 99): replace `const transport = withDefaults(...)` + `discoverRefs(ctx, transport, opts.url)` + `fetchPack(ctx, transport, {…url…})` with:
  ```ts
  const session = openGitSession(ctx, opts.url, 'git-upload-pack');
  try {
    const advertisement = await discoverRefs(session);
    …
    const packResult = await fetchPack(ctx, session.exchange, { …no url… });
  } finally { await session.close(); }
  ```
- **Migrate `fetch.ts`** (`src/application/commands/fetch.ts`): identical pattern — one `openGitSession(ctx, url, 'git-upload-pack')`, `discoverRefs(session)`, `fetchPack(ctx, session.exchange, …)`, `finally session.close()`. `pull` (fetch+merge) and `fetchMissing`/`createPromisorRemote` route through `fetch`/`fetchPack` — no direct edits; their tests re-prove the migration.
- **Migrate `push.ts`** (`push`, `sendUpdates`, `postReceivePack`, `parseReceiveResponse`): create `openGitSession(ctx, url, 'git-receive-pack')` once in `push()`; `discoverReceivePackRefs(session)`; `sendUpdates` calls `await session.exchange(requestBody)` (replacing `postReceivePack`'s `transport.request`), then `parseReceiveResponse` runs the existing side-band demux (`parseSideBand` → `decodePktStream` → `parseReceivePackResponse`) on the returned pkt stream — the sideband/report-status parsing is unchanged. Delete the private `buildReceivePackUrl` (moved to session) and the `withDefaults` call. `finally session.close()`.
- **Reference bytes to preserve:** the discovery `# service=…\n0000` prologue (HTTP), the two-request GET-then-POST shape, all content-type/accept headers, the `httpError` on non-200, the side-band-64k demux, `report-status`. Every existing interop pin (`test/integration/*-interop.test.ts` for clone/fetch/push) must stay byte-green.

### TDD steps
- RED: extend `test/unit/domain/protocol/upload-pack.test.ts` — `parseAdvertisedRefs(sshStream, 'git-upload-pack', { servicePrologue: false })` parses refs from a prologue-less advertisement (incl. the empty-repo zero-oid `capabilities^{}`-style line), AND assert the default/`true` path is byte-identical on an HTTP advertisement (prologue consumed). Fails: option not yet supported.
- GREEN: add the `servicePrologue` option (skip `consumeServiceHeader` when false).
- RED: `test/unit/application/commands/internal/git-service-session.test.ts` — with a mock `ctx.transport` (returns a canned `ReadableStream`): `openGitSession(ctx,'https://h/r','git-upload-pack')` → HTTP session; `advertisement()` issues the GET to `…/info/refs?service=git-upload-pack` and yields pkt lines; `exchange(bytes)` POSTs to `…/git-upload-pack`; `servicePrologue === true`; non-200 → `httpError`. And `openGitSession(ctx,'ssh://git@h/r',…)` → `adapterUnavailable` with `err.data.runtime === ctx.runtime` (two isolated runtime cases). Fails: module missing.
- GREEN: implement `git-service-session.ts` (interface + HTTP impl + `openGitSession` with the inert ssh branch); move `buildUploadPackUrl`/`buildReceivePackUrl`/`ACCEPT_HEADER`; add `GitExchange`.
- GREEN (migration): refactor `fetch-pack.ts`, `refs-discovery.ts`, `upload-pack-client.ts`, `receive-pack-client.ts`, `clone.ts`, `fetch.ts`, `push.ts` onto the seam. Run the FULL existing clone/fetch/pull/push/promisor unit + integration + interop suites — they are the behavior-preserving proof; all stay green.
- REFACTOR: collapse the two HTTP `decodePktStream(readableStreamToAsyncIterable(...))` sites into one private helper in the session; keep each session method <20 lines.

### Gate
`npx vitest run test/unit/domain/protocol/upload-pack.test.ts test/unit/application/commands/internal/git-service-session.test.ts test/unit/application/commands/internal/upload-pack-client.test.ts test/unit/application/commands/internal/receive-pack-client.test.ts test/unit/application/primitives/fetch-pack.test.ts test/unit/application/commands/clone.test.ts test/unit/application/commands/fetch.test.ts test/unit/application/commands/push.test.ts test/integration/clone-interop.test.ts test/integration/fetch-interop.test.ts test/integration/push-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/protocol/upload-pack.ts src/domain/protocol/pkt-line.ts src/application/commands/internal/git-service-session.ts src/application/commands/internal/refs-discovery.ts src/application/commands/internal/upload-pack-client.ts src/application/commands/internal/receive-pack-client.ts src/application/primitives/fetch-pack.ts src/application/commands/clone.ts src/application/commands/fetch.ts src/application/commands/push.ts`
(Verify the exact interop/unit test filenames with `ls test/integration` and `ls test/unit/application/commands` first; run every clone/fetch/pull/push/promisor test file the migration touches, not only those listed.)

### Commit
`refactor: route git transport through a GitServiceSession seam`

## Part 5 — SSH GitServiceSession: clone/fetch/pull/push over SSH

### Context
Adds the stateful SSH implementation of the seam and upgrades `openGitSession`'s ssh branch to use `ctx.ssh` (ADR-434 SSH impl; ADR-435 spawn; ADR-436 streams; ADR-439 v0/v1). This makes clone/fetch/pull/push/fetchMissing work over `ssh://` and scp-like remotes with byte-identical on-disk results (design requirement 1, faithfulness matrix). Memory/browser keep refusing (ctx.ssh absent — ADR-437/438). All internal — no api.json impact.

- **Edit** `src/application/commands/internal/git-service-session.ts`:
  - Add `SshGitServiceSession` implementing `GitServiceSession`, `servicePrologue: false`:
    - Construction (lazy — the channel opens on first `advertisement()`): `const parsed = parseRemoteUrl(url)` (already `kind: 'ssh'` here); `const { program, baseArgs } = await resolveSshCommand(ctx)` (Part 2); `const args = buildSshArgs({ service, parsed, baseArgs })` (Part 2); `const channel = await ctx.ssh!.open({ command: program, args, env: {}, ...(ctx.signal ? { signal: ctx.signal } : {}) })`. (`env: {}` — total delegation, ADR-435 requirement 2: tsgit adds nothing; the adapter merges over the parent env so ssh finds `SSH_AUTH_SOCK`/`HOME`/`known_hosts`.)
    - `advertisement()`: open the channel (once), return `decodePktStream(readableStreamToAsyncIterable(channel.stdout))` — the server sends the advertisement immediately, prologue-less; the caller parses with `servicePrologue: false`.
    - `exchange(requestBytes)`: write `requestBytes` to `channel.stdin` (get a writer, `write`, `close` the writer — this is git's "write want/have/done to the same channel then read the rest of stdout"), then return the **continuation** of the same `decodePktStream(channel.stdout)` iterable (do NOT re-open — SSH is one stateful duplex; `advertisement()` and `exchange()` read the same stdout stream in sequence). Design "Wire difference SSH vs HTTP": one stateful channel; reuse `buildUploadPackRequest`/`parseUploadPackResponse`/`buildReceivePackRequest`/`parseReceivePackResponse` verbatim (the callers already do, post-Part-4).
    - `close()`: `await channel.close()` (kills the child; idempotent). On `channel.exit` resolving non-zero mid-stream → surface `networkError('ssh exited with code ' + code)` (ADR-438 — exit code in `reason`; ssh's stderr is inherited, never captured).
  - Upgrade `openGitSession` ssh branch: `if (ctx.ssh === undefined) throw adapterUnavailable(ctx.runtime, 'ssh: transport unavailable in this runtime'); return new SshGitServiceSession(ctx, url, service);`. (The Part-4 unconditional throw becomes conditional; the browser/memory refusal tests from Part 4 still pass since their ctx.ssh is undefined.)
- **Abort (design requirement 10):** `ctx.signal` is forwarded into `ssh.open`; the node adapter kills the child on abort; in-flight `channel.stdout` reads reject via `readableStreamToAsyncIterable`'s `return`→`cancel` unwinding.
- **Stateful-stream caution:** `advertisement()` and `exchange()` must share ONE `AsyncIterable`/reader over `channel.stdout` (materialise the `decodePktStream(...)` iterator once in the session and hand out its continuation), or the second `getReader()` will throw "locked". Verify against `readableStreamToAsyncIterable` semantics (`src/operators/readable-stream.ts` — one reader per stream).
- **Tests:**
  - **Unit** `test/unit/application/commands/internal/git-service-session.test.ts` (extend): inject a fake `ctx.ssh` (an `SshTransport` double returning a scripted `SshChannel` backed by in-memory web streams) + stub `ctx.env`. Assert: `advertisement()` opens with the argv from `buildSshArgs` (spy the `open` req.command/req.args), yields the scripted advertisement pkt lines; `exchange(bytes)` writes `bytes` to the double's stdin and yields the scripted response; `close()` calls the channel `close`; non-zero `exit` → `networkError` with `err.data.reason` containing the code. Kill-mutant assertions on `err.data`.
  - **Memory inert (end-to-end refusal)** `test/integration/ssh-transport.test.ts` (or a memory unit): `openRepository` on the **memory** adapter (ctx.ssh absent), `repo.clone({ url: 'ssh://git@h/r.git' })` → `ADAPTER_UNAVAILABLE` with `err.data.runtime === 'memory'`; same for `fetch`/`push`. Browser inertness is proven by the Part-3 `index.browser.test.ts` (ctx.ssh undefined) + this memory proxy (identical capability-absence path).
  - **Integration (node, fake-ssh bridge)** `test/integration/ssh-transport.test.ts` (uses `interop-helpers.ts`):
    - Seed a source repo with real git (`initBothRepos`/`runGit`); install a **bridge** ssh script into a `mkdtemp` dir: `#!/bin/sh` that parses its argv's remote command (`git-upload-pack '<path>'` / `git-receive-pack '<path>'`) and `exec`s the corresponding local `git-upload-pack`/`git-receive-pack` (both on PATH) against `<path>` over the inherited stdio pipes. Point tsgit at it via `GIT_SSH_COMMAND=<bridge>` (read by `NodeEnvReader` → `resolveSshCommand`).
    - tsgit `clone` / `fetch` / `pull` / `push` over `ssh://…/<source>`; assert pack SHAs, `refs/*`, reflog subjects (`topReflogSubject`), and `.git/config` match the equivalent HTTP/local operation.
  - **Interop (faithfulness gate)** `test/integration/ssh-transport-interop.test.ts`:
    - Cross-tool object identity: tsgit clone over the fake-ssh bridge vs `git clone` over the **same** bridge into the same source ⇒ identical object store + refs (compare `writeTreeOf`, `lsStage`, ref oids). Signing off, `GIT_*` scrubbed, `mktemp` (via `interop-helpers`).
    - (Argv/quoting/resolution parity and dash-guard co-refusal already pinned in Part 2's `ssh-argv-interop.test.ts` — do not duplicate.)

### TDD steps
- RED: extend `git-service-session.test.ts` with the fake-`ctx.ssh` SSH-session cases → fail (SSH branch still throws `adapterUnavailable`).
- GREEN: implement `SshGitServiceSession` + upgrade the `openGitSession` ssh branch (conditional on `ctx.ssh`).
- RED: `test/integration/ssh-transport.test.ts` memory-inert case → assert refusal (passes once Part 4 branch is conditional — confirm), then the fake-ssh bridge clone/fetch/pull/push cases → fail until the SSH session drives the real servers.
- GREEN: fix the stateful single-reader stdout handling + stdin writer lifecycle until the bridge round-trips.
- RED: `test/integration/ssh-transport-interop.test.ts` cross-tool identity → fails on any object/ref divergence.
- GREEN: reconcile to byte-identity.
- REFACTOR: extract the shared-stdout iterator + stdin-writer helpers; keep `SshGitServiceSession` methods <20 lines, early returns, no nesting >2.

### Gate
`npx vitest run test/unit/application/commands/internal/git-service-session.test.ts test/integration/ssh-transport.test.ts test/integration/ssh-transport-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/git-service-session.ts test/unit/application/commands/internal/git-service-session.test.ts test/integration/ssh-transport.test.ts test/integration/ssh-transport-interop.test.ts`

### Commit
`feat: drive clone, fetch, pull, and push over SSH`
