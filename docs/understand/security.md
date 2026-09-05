# Security model

This document explains the security properties tsgit enforces by construction. The bottom line: every `HttpTransport`, and every WRITE surface of every `FileSystem`, runs through a wrapping validator on construction, so writes never reach the adapter with a path or URL outside the contracted boundary — enforced against the resolved (real) location. READ surfaces differ by provenance: the **Node** `FileSystem`, sourced from the runtime itself (never a caller-supplied `fs`), already enforces the identical lexical containment in its own read path, so the facade skips the wrapper on reads for it entirely and the adapter becomes the sole read-containment authority — it alone is constructed at exactly the layout's root set. The Memory and browser adapters stay on the wrapper for reads too: `MemoryFileSystem` is single-rooted at a fixed directory independent of the layout it is paired with, so branding it would let its own containment run wider than the layout the wrapper enforces — a real escape, not a redundant check. A caller-supplied `fs` keeps the wrapper on reads on every runtime, exactly as every surface did before.

To report a vulnerability, see [`SECURITY.md`](../../SECURITY.md) at the repo root.

## Path containment

Every `FileSystem` adapter enforces that every input path resolves to a location **inside one of the adapter's containment roots** — but the two directions of traffic are held to different standards, matching git's own posture. For a normal repository (and a main worktree) that set is a single root, `workDir`. Opening a linked worktree, a submodule working directory, or a `--separate-git-dir` layout widens it to the resolved layout's `{ workDir, gitDir, commonDir }`, minimised so any root already contained in another is dropped — a normal repo still collapses to exactly `[workDir]`, byte-identical to before — [ADR-721](../adr/721-first-party-read-containment-is-single-authority.md), the single authority for first-party read containment, carries the root-set model forward unchanged.

A caller-supplied `commonDir` is a **privilege-relevant argument**, in the same class as `gitDir`: naming one widens the containment root set above (never anything read off disk) — including via the work tree the bareness suppression keeps: supplying the option, even with a value equal to the gitDir, can add the resolved work tree (`cwd` on the explicit route) to the root set where the same open without it stayed gitDir-only — chooses which `config` is authoritative — and therefore which `merge.<driver>.driver` shell commands run, which `core.excludesFile`/`core.attributesFile` get read, whether `core.worktree` widens the root set again (up to `/`), and which hash algorithm and ref backend the repository uses — and chooses which `hooks/` directory is spawned, with the caller's full environment. The ownership-trust gate (see [Repository trust](#repository-trust) below) checks the resolved value on the routes it already checks `gitDir` on, and is off on the explicit route exactly as it already is for `gitDir` — `openRepository({ gitDir, commonDir })` against another user's directory is accepted without an ownership check, the same as `openRepository({ gitDir })` already is; the option adds a second path into that pre-existing hole, not a new one. `hooks: false` and `command: false` close the two code-execution channels. **`commonDir` is not a sandbox** — a caller that must not reach a subtree must not be handed the ability to name it.

A **lexical** escape is refused on every surface, read and write alike — `..` traversal, an absolute foreign path, and the prefix-only sibling trick (`/repo-evil` vs `/repo`) all throw `PERMISSION_DENIED` before any I/O. What differs is the **post-realpath** stage:

- **Writes** additionally realpath the leading (parent) path and refuse if that resolution lands outside the root set — a symlinked leading directory cannot be used to write, rename, delete, or chmod outside the tree. A leaf that is itself a symlink is refused too, on every surface that would otherwise dereference it (`write`/`writeStream`/`writeUtf8`/`writeExclusive`/`appendUtf8`/`openWithNoFollow(_, 'write')`/`chmod`) — `rm`, `rmRecursive`, `rename`, `mkdir`, and `symlink`'s own link path act on the leaf itself and never follow it, matching POSIX and git semantics.
- **Reads** do not realpath at all: an input already inside the root set is served even when it (or a leading directory) is a symlink resolving outside, exactly as git reads through symlinks without restriction.
- A symlink's **target** — absolute or relative — is opaque bytes, written and read back verbatim, never validated against the root set, exactly like git ([ADR-632](../adr/632-symlink-targets-written-verbatim.md)). The defence against dereferencing a hostile planted link lives where git keeps it: working-tree content readers check `isSymbolicLink` before ever reading a path as content, never in the adapter.

### Node — the write/read split

The write guard (`resolveWrite`) realpaths the leading path only — never the leaf, so a *dangling* symlink (whose leaf realpath would fail) stays removable — via a per-directory LRU-amortised cache, then re-checks containment on the joined result on every call. `chmod` layers an explicit leaf `lstat` on top (POSIX `chmod` follows its leaf and has no portable no-follow variant); every other leaf-dereferencing write surface instead composes `O_NOFOLLOW` into the underlying `open`/`writeFile` flags, which refuses a symlink leaf atomically at the syscall — on Windows, where `O_NOFOLLOW` is silently ignored, the explicit leaf `lstat` fallback covers it instead. The read path (`resolveRead`) is lexical and allocation-light: no `realpath` call, no syscall, matching every root's raw and canonicalised prefix against the input string alone — and, for a first-party adapter, it is the *only* check a read passes through: the facade's wrapping validator no longer duplicates it on that path.

This split makes the Node adapter's write side the *only* symlink-aware containment layer; the raw adapter's writes are confined to exactly the layout's root set — never their common ancestor, which would admit everything between them (and degrade to the whole filesystem for a cross-top-level layout). A root that doesn't exist yet (e.g. the not-yet-created target of `worktree add`) derives its canonical prefix from the realpath of its nearest existing ancestor plus the missing tail.

8.3 short-name reconciliation on Windows (`C:\PROGRA~1` vs `C:\Program Files`) is handled by a lazy canonical-root cache ([ADR-042](../adr/042-canonical-root-lazy-realpath.md)). `\\?\` extended-length prefixes are stripped during comparison.

### Browser — OPFS sandbox

OPFS is sandboxed per origin by the browser. The adapter does no extra path containment because it can't escape OPFS. The `gitDirName` option exists for hosts that disallow dot-prefixed names.

### Memory — symlink loop cap

The Memory adapter's symlink follower caps at 40 hops (POSIX `SYMLOOP_MAX`).

## Index entry name validation

Independent of path containment, every entry name that would become part of an index — parsed from `.git/index`, projected from a tree, or synthesized back into one — is validated once against git's own `verify_path` rule set: a leading `/`, a `..`/`.`/empty segment, a `.git` alias (any case, trailing dot/space, the NTFS `git~1` short name, a `.git:`-stream form, or an HFS+ ignorable-codepoint spelling), or a `.gitmodules` entry whose mode is a symlink (CVE-2018-11235) all throw `INVALID_INDEX_ENTRY`. A backslash, a C0/C1 control byte, or a BIDI/isolate Unicode control character is deliberately **not** rejected — git accepts all three in a path, and rejecting them was tsgit being stricter than the tool it replicates. The check fires at every tree↔index boundary (index parse, `buildIndexFromTree`, `synthesizeTreeFromIndex`) and at every write that projects a tree onto the working tree (`applyChangeset`, the shared 3-way-merge applier, `stash apply`'s untracked restore) — never at a tree *read*, so `cat-file`/`show`/`log` still print a hostile tree, matching git.

The working-tree **walker** (`walkWorkingTree`) applies a narrower rule: it skips only an exact `.git` name, folded by case. An on-disk NTFS/HFS-alias entry (`git~1`, a `.git:`-stream name) is walked like any other path, exactly as git's own directory scan treats it — the wider rejection above applies only once that name would become an index entry.

**One deliberate divergence, in the strict direction.** git gates the HFS+
ignorable-codepoint spelling behind `core.protectHFS`, whose default is
*platform-conditional*: true on macOS, false everywhere else. (`core.protectNTFS`,
by contrast, defaults true on every platform — so the `git~1` and `.git:`-stream
forms match git exactly.) tsgit applies the HFS guard **unconditionally on every
platform** and does not read `core.protectHFS`, so on Linux it refuses a name git
would accept. The reasoning: a repository is portable, the guard exists to stop a
name that resolves to `.git` on someone *else's* HFS+ volume, and honouring a
platform-conditional default would make the same repository validate differently on
different machines. This is the one place the entry-name validator is knowingly
stricter than the tool it replicates; the cross-tool test pins it with
`-c core.protectHFS=true` so the comparison exercises the guard rather than the
runner's platform.

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

`readObject` and its siblings (`readRawObject`, `streamBlob`, `walkCommits`, `walkCommitsByDate`) accept an opt-in `verifyHash: true` that hashes the returned bytes and verifies them against the requested `ObjectId`, throwing `OBJECT_HASH_MISMATCH` on a mismatch. Verification is off by default — matching canonical git, an ordinary read (`cat-file`, `checkout`, `log`, `rev-list`, `show`) does not re-hash on every object access. Corruption detection lives in `fsck` (which independently re-hashes every object it visits) and in `bundle verify` (which opts in explicitly on both of its prerequisite reads). Which hash function performs verification, when requested, is itself a config value — `extensions.objectFormat` in `<commonDir>/config` selects SHA-1 or SHA-256 — exactly the property canonical git has too: the config is the authority on the repository's format there as well.

tsgit never infers the algorithm from **data** — an object id's width, a `.rev` file's hash id, a `multi-pack-index` or `commit-graph`'s hash-version byte — only from the repository's own **declaration**. Inferring from data would let planted bytes choose their own verifier: a hostile object store could declare itself SHA-256-shaped by construction and steer verification toward whichever function is easiest to forge for its payload. The declaration-only rule also fails **closed**: a repository declared SHA-1 that holds 64-hex object ids cannot resolve them. The pack-index and multi-pack-index searches refuse a target whose width is not the index's own, so such an id reads as *absent* rather than being compared byte-by-byte against a wider slot — a comparison that would run off the end of the target and, because `NaN` is neither less nor greater than zero, could otherwise settle on an unrelated object. Absent, not reinterpreted, and not dependent on the hash check to catch it afterwards.

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

`openRepository` wraps the caller-supplied `fs` and `transport` with validators on construction. Set `unsafeRawAdapters: true` to skip the wrapping — **never set this with adapters whose code you do not control**. A raw transport receives `config.auth` credentials with no SSRF guard. This does not touch the ownership-trust gate described in [Repository trust](#repository-trust) below — that verdict is already resolved by the time adapter wrapping decides anything.

## Repository trust

`openRepository` computes an ownership-trust verdict while resolving a discovered repository's layout; the first command that requires an accepted repository enforces it, refusing before it ever reads the repository's config — see [the options](../get-started/node.md#bare-repositories-and-explicit-layout) (`trust`, `trustedDirectories`, `bareRepositories`), [the verdict fields](repository-layout.md#reading-the-result) (`untrusted`, `implicitBare`, `foreignPath`), and [the refusal codes](../use/errors.md#repository-state) (`DUBIOUS_OWNERSHIP`, `IMPLICIT_BARE_REPOSITORY`). Refused, the repository's local config is never parsed, which closes:

- `hooks/` in the discovered common dir, otherwise spawned with the caller's full environment;
- `merge.<driver>.driver`, otherwise a shell command executed on the caller's behalf;
- `core.excludesFile` / `core.attributesFile`, otherwise attacker-named file reads;
- and the row that closes **before any command runs**: `core.worktree` widening the containment root set up to `/` is structurally impossible when the repository is refused, because the config that would carry it is never read.

The gate is **on by default** (`trust: 'ownership'`), and the explicit-`gitDir` route is never gated — a narrower blast radius than git's own `safe.directory`, which gates every route equally.

`unsafeRawAdapters: true` does **not** bypass this gate: that option opts out of the FS/transport *validators* (see [Adapter wrapping](#adapter-wrapping-opt-out-is-dangerous) above), while the trust verdict is computed upstream of adapter composition, at layout resolution. The two are independent axes.

## What tsgit does NOT do

- **GPG signing** of commits or tags — roadmap (Phase 25.2).
- **SSH-variant argv (PuTTY / plink / tortoiseplink)** — only OpenSSH-style flags are built; a documented faithfulness deferral ([ADR-441](../adr/441-openssh-only-argv-variant-detection-deferred.md)).
- **Smart-HTTP/SSH protocol v2** — roadmap (Phase 25.3). v0/v1 only in v1, over both HTTP and SSH.
- **Repository trust answers "who owns this," not "is this safe."** An attacker who can write inside a repository you own passes the gate outright — `hooks: false` and `command: false` remain the content-side mitigations, not this gate. A same-uid attacker is out of scope for the same reason: they can already touch anything you own.
- **Caller opt-outs re-open what the gate closes.** `trust: 'always'`, `trustedDirectories: ['*']`, or an over-wide `/*` prefix all trust unconditionally; the explicit-`gitDir` route is never gated at all.
- **Pointer redirection is resolved before the gate runs.** An alien `.git` file or `commondir` pointer chooses which directory discovery lands on; the gate then judges the resolved target, never the path the caller named.
- **Windows is a named gap, not an invented behaviour.** `process.getuid` is absent there, so the ownership capability is omitted and every repository is trusted — a gap awaiting a Windows-hosted measurement.
- **Sandboxed adapters** (Memory, Browser) have no filesystem ownership to check.
- **Permission bits** are not part of an ownership predicate.
- **TOCTOU**: the verdict is computed once per `openRepository` call, mirroring git's one check per process — an ownership change after open is not re-checked.
- **Deliberate over-refusal.** tsgit may refuse a shape git permits: a repository path you own whose gitdir or common dir is owned by someone else, with `trustedDirectories` as the escape hatch.

These omissions are documented to set expectations, not as a recommendation against using tsgit in security-sensitive contexts. For the curtain-up checklist before deploying tsgit in such contexts, also see `SECURITY.md` and the operator playbook in `RUNBOOK.md`.
