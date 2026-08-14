# Security model

This document explains the security properties tsgit enforces by construction. The bottom line: every adapter's `FileSystem` and `HttpTransport` runs through a wrapping validator on construction, so the adapters never receive a path or URL that isn't already inside the contracted boundary — enforced against the resolved (real) location for writes, lexically for reads.

To report a vulnerability, see [`SECURITY.md`](../../SECURITY.md) at the repo root.

## Path containment

Every `FileSystem` adapter enforces that every input path resolves to a location **inside one of the adapter's containment roots** — but the two directions of traffic are held to different standards, matching git's own posture. For a normal repository (and a main worktree) that set is a single root, `workDir`. Opening a linked worktree, a submodule working directory, or a `--separate-git-dir` layout widens it to the resolved layout's `{ workDir, gitDir, commonDir }`, minimised so any root already contained in another is dropped — a normal repo still collapses to exactly `[workDir]`, byte-identical to before ([ADR-541](../adr/541-raw-node-adapter-layout-root-set.md)).

A **lexical** escape is refused on every surface, read and write alike — `..` traversal, an absolute foreign path, and the prefix-only sibling trick (`/repo-evil` vs `/repo`) all throw `PERMISSION_DENIED` before any I/O. What differs is the **post-realpath** stage:

- **Writes** additionally realpath the leading (parent) path and refuse if that resolution lands outside the root set — a symlinked leading directory cannot be used to write, rename, delete, or chmod outside the tree. A leaf that is itself a symlink is refused too, on every surface that would otherwise dereference it (`write`/`writeStream`/`writeUtf8`/`writeExclusive`/`appendUtf8`/`openWithNoFollow(_, 'write')`/`chmod`) — `rm`, `rmRecursive`, `rename`, `mkdir`, and `symlink`'s own link path act on the leaf itself and never follow it, matching POSIX and git semantics.
- **Reads** do not realpath at all: an input already inside the root set is served even when it (or a leading directory) is a symlink resolving outside, exactly as git reads through symlinks without restriction.
- A symlink's **target** — absolute or relative — is opaque bytes, written and read back verbatim, never validated against the root set, exactly like git ([ADR-632](../adr/632-symlink-targets-written-verbatim.md)). The defence against dereferencing a hostile planted link lives where git keeps it: working-tree content readers check `isSymbolicLink` before ever reading a path as content, never in the adapter.

### Node — the write/read split

The write guard (`resolveWrite`) realpaths the leading path only — never the leaf, so a *dangling* symlink (whose leaf realpath would fail) stays removable — via a per-directory LRU-amortised cache, then re-checks containment on the joined result on every call. `chmod` layers an explicit leaf `lstat` on top (POSIX `chmod` follows its leaf and has no portable no-follow variant); every other leaf-dereferencing write surface instead composes `O_NOFOLLOW` into the underlying `open`/`writeFile` flags, which refuses a symlink leaf atomically at the syscall — on Windows, where `O_NOFOLLOW` is silently ignored, the explicit leaf `lstat` fallback covers it instead. The read path (`resolveRead`) is lexical and allocation-light: no `realpath` call, no syscall, matching every root's raw and canonicalised prefix against the input string alone.

This split makes the Node adapter's write side the *only* symlink-aware containment layer; the raw adapter's writes are confined to exactly the layout's root set — never their common ancestor, which would admit everything between them (and degrade to the whole filesystem for a cross-top-level layout). A root that doesn't exist yet (e.g. the not-yet-created target of `worktree add`) derives its canonical prefix from the realpath of its nearest existing ancestor plus the missing tail.

8.3 short-name reconciliation on Windows (`C:\PROGRA~1` vs `C:\Program Files`) is handled by a lazy canonical-root cache ([ADR-042](../adr/042-canonical-root-lazy-realpath.md)). `\\?\` extended-length prefixes are stripped during comparison.

### Browser — OPFS sandbox

OPFS is sandboxed per origin by the browser. The adapter does no extra path containment because it can't escape OPFS. The `gitDirName` option exists for hosts that disallow dot-prefixed names.

### Memory — symlink loop cap

The Memory adapter's symlink follower caps at 40 hops (POSIX `SYMLOOP_MAX`).

## Index entry name validation

Independent of path containment, every entry name that would become part of an index — parsed from `.git/index`, projected from a tree, or synthesized back into one — is validated once against git's own `verify_path` rule set: a leading `/`, a `..`/`.`/empty segment, a `.git` alias (any case, trailing dot/space, the NTFS `git~1` short name, a `.git:`-stream form, or an HFS+ ignorable-codepoint spelling), or a `.gitmodules` entry whose mode is a symlink (CVE-2018-11235) all throw `INVALID_INDEX_ENTRY`. A backslash, a C0/C1 control byte, or a BIDI/isolate Unicode control character is deliberately **not** rejected — git accepts all three in a path, and rejecting them was tsgit being stricter than the tool it replicates. The check fires at every tree↔index boundary (index parse, `buildIndexFromTree`, `synthesizeTreeFromIndex`) and at every write that projects a tree onto the working tree (`applyChangeset`, the shared 3-way-merge applier, `stash apply`'s untracked restore) — never at a tree *read*, so `cat-file`/`show`/`log` still print a hostile tree, matching git.

The working-tree **walker** (`walkWorkingTree`) applies a narrower rule: it skips only an exact `.git` name, folded by case. An on-disk NTFS/HFS-alias entry (`git~1`, a `.git:`-stream name) is walked like any other path, exactly as git's own directory scan treats it — the wider rejection above applies only once that name would become an index entry.

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

## SSH transport (Node only)

`clone` / `fetch` / `pull` / `push` accept `ssh://[user@]host[:port]/path` and scp-like `[user@]host:path` remotes by spawning the system `ssh` binary. Delegation is total: tsgit reads no private key, parses no `~/.ssh/config` or `known_hosts`, and talks to no agent — the spawned `ssh` does all of it. `stderr` is inherited, never captured, so no credential ever passes through tsgit's own error or logging paths.

Command resolution follows git's order — `GIT_SSH_COMMAND` → `core.sshCommand` → `GIT_SSH` → `ssh` on `PATH` — and only OpenSSH-style argv is built (`-p <port>`); other SSH clients get the same flags until variant detection lands ([ADR-441](../adr/441-openssh-only-argv-variant-detection-deferred.md)).

The SSH analog of the HTTP SSRF guard is the **dash-guard**: a host token or remote path beginning with `-` is refused as `INVALID_URL` before spawn (the CVE-2017-1000117 argv-injection class), and the remote path is single-quoted in the built argv. DNS resolution and the private-network / `allowInsecure` policy are **HTTP-only** — the spawned `ssh` process performs its own resolution (through `~/.ssh/config` aliases, `ProxyJump`, etc.), so a pre-pinned IP would prove nothing about what `ssh` actually contacts ([ADR-440](../adr/440-parse-remote-url-ssh-scp-ssrf-boundary.md)).

Browser and Memory wire no `SshTransport`; an `ssh://`/scp-like remote there throws `ADAPTER_UNAVAILABLE` ([ADR-437](../adr/437-browser-inert-via-absent-ssh-capability.md)).

## Error sanitisation

`extractDetail` strips directory components from path-bearing error messages via a platform-agnostic `basename`. For HTTP transport failures, `NETWORK_ERROR.reason` is a static string drawn from a closed enum (`'connection-reset' | 'dns' | 'tls' | 'http-status' | 'aborted' | 'timeout'`), never raw `errno`. SSH transport failures also surface as `NETWORK_ERROR`, with `reason` naming the `ssh` child process's exit code (e.g. `'ssh exited with code 128'`) — never the inherited stderr or any credential. Goal: error messages never leak repo-local paths or kernel-level identifiers to upstream loggers.

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
| `SHALLOW_FILE_MALFORMED` | 500 000 entries (`MAX_SHALLOW_ENTRIES`) | `.git/shallow` reader and writer (`updateShallow` refuses before persisting an over-cap or foreign-width set). A file over the cap written by another tool refuses on every read; the remedy is trimming or deleting `.git/shallow` externally. |

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
- **SSH-variant argv (PuTTY / plink / tortoiseplink)** — only OpenSSH-style flags are built; a documented faithfulness deferral ([ADR-441](../adr/441-openssh-only-argv-variant-detection-deferred.md)).
- **Smart-HTTP/SSH protocol v2** — roadmap (Phase 25.3). v0/v1 only in v1, over both HTTP and SSH.

These omissions are documented to set expectations, not as a recommendation against using tsgit in security-sensitive contexts. For the curtain-up checklist before deploying tsgit in such contexts, also see `SECURITY.md` and the operator playbook in `RUNBOOK.md`.
