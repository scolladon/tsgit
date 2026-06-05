# Security model

This document explains the security properties tsgit enforces by construction. The bottom line: every adapter's `FileSystem` and `HttpTransport` runs through a wrapping validator on construction, so the adapters never receive a path or URL that isn't already inside the contracted boundary.

To report a vulnerability, see [`SECURITY.md`](../../SECURITY.md) at the repo root.

## Path containment

Every `FileSystem` adapter enforces that every input path resolves to a location **inside the adapter's root**. Escapes via:

- `..` traversal
- sibling-directory string tricks (`/repo-evil` vs `/repo`)
- symlinks pointing outside the root

…all throw `PERMISSION_DENIED` before any data is read or written.

### Node — symlink-escape defense

`checkContainment` uses `realpath` in three modes:

| Mode | Mechanism |
|---|---|
| **read** | Full `realpath` of the target path. |
| **lstat** | `realpath` of the parent directory only — preserves lstat semantics for the leaf. |
| **creation** | `realpathNearestExisting` + leaf symlink check. |

8.3 short-name reconciliation on Windows (`C:\PROGRA~1` vs `C:\Program Files`) is handled by a lazy canonical-root cache ([ADR-042](../adr/042-canonical-root-lazy-realpath.md)). `\\?\` extended-length prefixes are stripped during comparison.

### Browser — OPFS sandbox

OPFS is sandboxed per origin by the browser. The adapter does no extra path containment because it can't escape OPFS. The `gitDirName` option exists for hosts that disallow dot-prefixed names.

### Memory — symlink loop cap

The Memory adapter's symlink follower caps at 40 hops (POSIX `SYMLOOP_MAX`).

## Lock files & atomicity

`writeExclusive` (Node: `{ flag: 'wx' }`) provides atomic create-or-fail. Used by:

- Ref CRUD (`recordRefUpdate`) — under `.git/refs/<name>.lock`
- Index updates (`commit`, `add`, `reset --mixed`, `checkout`, `merge`) — under `.git/index.lock`

A `RESOURCE_LOCKED` error fires when another writer holds the lock. Stale-lock breaking is repository-environment policy: set `breakStaleLockMs` once on `openRepository({ config })` and every index acquisition honours it. Left unset (the default), tsgit never auto-breaks a lock — faithful to git.

## TLS & SSRF guards (Node HTTP)

- `http://` URLs are **rejected by default**. Opt in via `OpenNodeRepositoryOptions.allowInsecureHttp` — disabling this is a per-call choice, never inherited from environment.
- Certificate validation is **never disabled** by the library. If you need to test against a self-signed server, configure trust at the Node level (`NODE_EXTRA_CA_CERTS`).
- **DNS resolver is configured on the context, not per call.** Set `config.dnsResolver` on `openRepository`; the transport wrapper (`wrapTransportValidator`) validates every request URL — `clone`/`fetch`/`push` carry no SSRF options of their own. The default resolver is **fail-closed** (rejects every host as `BLOCKED_HOST`) until you supply one. A hand-built `Context` that skips the wrapper (or `unsafeRawAdapters: true`) opts out of the guard.
- **Private networks are rejected by default.** RFC1918 / loopback / link-local destinations require `config.allowPrivateNetworks: true`. Off by default. `http://` likewise requires `config.allowInsecure: true`.
- **Redirect cap.** Maximum redirect chain length enforced; `TOO_MANY_REDIRECTS` fires beyond the cap.

## Error sanitisation

`extractDetail` strips directory components from path-bearing error messages via a platform-agnostic `basename`. The `NETWORK_ERROR.reason` field is a static string drawn from a closed enum (`'connection-reset' | 'dns' | 'tls' | 'http-status' | 'aborted' | 'timeout'`), never raw `errno`. Goal: error messages never leak repo-local paths or kernel-level identifiers to upstream loggers.

## Defensive copying (Memory adapter)

Every `read` / `write` on the Memory adapter clones the `Uint8Array`. Caller mutations to a returned buffer cannot corrupt stored data; caller mutations to a passed-in buffer cannot corrupt subsequent reads.

## Object integrity

Every object read through `readObject` is hashed and verified against the requested `ObjectId`. Bytes that don't hash to the id throw `OBJECT_HASH_MISMATCH`. There is no opt-out.

## Object & pack size caps

| Cap | Default | Where enforced |
|---|---|---|
| `OBJECT_TOO_LARGE` | caller-supplied `maxBytes` | Loose object: post-inflate header parse. Pack base: pre-inflate via declared header size. Pack delta: post-apply ([ADR-024](../adr/024-bounded-reads-where-cap-fires.md)). |
| `PACK_TOO_LARGE` | adapter default | `fetchPack` / clone — caps the received pack size. |
| `WORKING_TREE_FILE_TOO_LARGE` | 256 MiB (`MAX_WORKING_TREE_BLOB_BYTES`) | `walkWorkingTree` + post-re-lstat re-check in `add --all`. |
| `GITIGNORE_FILE_TOO_LARGE` | 1 MiB (`MAX_GITIGNORE_BYTES`) | Ignore source readers. |
| `SPARSE_PATTERN_FILE_TOO_LARGE` | `MAX_SPARSE_PATTERN_FILE_BYTES` | `loadSparseMatcher`. |
| `TREE_DEPTH_EXCEEDED` | 4096 | Recursive tree walks. |
| `TREE_ENTRY_LIMIT_EXCEEDED` | configured | Tree parsers. |
| `DELTA_CHAIN_TOO_DEEP` | configured | Pack delta resolution. |

## Glob matcher — ReDoS protection

`compileGlob` (shared by `.gitignore`, pathspec, and sparse-checkout) is a **non-backtracking linear matcher**: O(tokens × path-length), not a regex. An adversarial pattern (`a*a*a*…b`) cannot cause catastrophic backtracking ([ADR-077](../adr/077-linear-glob-matcher.md)).

## Submodule name validation (CVE-2018-17456 lineage)

`submodules` / `walkSubmodules` reject submodule names with:

- empty / `.` / `..` segments
- backslash
- absolute or drive-prefixed paths
- leading `-` (would be parsed as a CLI flag by lower-level tooling)
- NUL or other control characters

…surfaced as `UNSUPPORTED_OPERATION` with the offending name in the payload.

## `.gitmodules` parsing (CVE-2018-11235 hardening)

`.gitmodules` is only read when the tree entry mode is `100644` / `100755`. Symlink / directory / gitlink modes for `.gitmodules` are ignored — preventing attacker-controlled file content from being parsed as configuration.

## Hooks (Node only)

Hooks default to **on** because git's mental model is "hooks run unless I say otherwise". A non-zero hook exit throws `HOOK_FAILED`. Callers MUST opt **out** explicitly when operating on a repository they do not trust:

```ts
const repo = await openRepository({ cwd: '.', hooks: false });
```

Hooks spawn `.git/hooks/*` scripts that inherit the **full `process.env`** of the calling process, including any secrets the process holds. The browser adapter has no hook runner; hooks are inert in the browser.

## Lifetime & cancellation

`repo.dispose()` aborts the internal `AbortSignal` synchronously, lets in-flight I/O unwind, then tears down adapters. After dispose resolves, every bound method throws `REPOSITORY_DISPOSED`. The dispose is idempotent.

Caller-supplied `signal: AbortSignal` is composed via `AbortSignal.any` so external cancellation behaves identically to internal dispose.

## Adapter wrapping (opt-out is dangerous)

`openRepository` wraps the caller-supplied `fs` and `transport` with validators on construction. Set `unsafeRawAdapters: true` to skip the wrapping — **never set this with adapters whose code you do not control**. A raw transport receives `config.auth` credentials with no SSRF guard.

## What tsgit does NOT do

- **GPG signing** of commits or tags — roadmap (Phase 25.2).
- **SSH transport** — roadmap (Phase 25.1). HTTPS only in v1.
- **Smart-HTTP v2** — roadmap (Phase 25.3). v0/v1 only in v1.

These omissions are documented to set expectations, not as a recommendation against using tsgit in security-sensitive contexts. For the curtain-up checklist before deploying tsgit in such contexts, also see `SECURITY.md` and the operator playbook in `RUNBOOK.md`.
