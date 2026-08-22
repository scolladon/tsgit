# Errors

Every error tsgit throws is a `TsgitError` carrying a `data` payload — a discriminated union keyed on `code`. The `code` field is stable; the rest of the payload may grow new fields under SemVer minor releases.

## Catching pattern

```ts
import { TsgitError } from '@scolladon/tsgit';

try {
  await repo.commit({ message: 'wip' });
} catch (err) {
  if (err instanceof TsgitError) {
    switch (err.data.code) {
      case 'HOOK_FAILED':
        console.error(`hook ${err.data.hook} exited ${err.data.exitCode}`);
        break;
      case 'EMPTY_COMMIT_MESSAGE':
        console.error('refusing to commit with empty message');
        break;
      default:
        throw err;
    }
  } else {
    throw err;
  }
}
```

The `code` field is a string literal type — TypeScript narrows the rest of the payload when you switch on it.

## Code reference

Codes are grouped by domain. Within each group, alphabetical.

### Adapters & I/O

| Code | Payload | Raised when |
|---|---|---|
| `ADAPTER_UNAVAILABLE` | `runtime, reason` | A runtime-specific adapter is missing in the current environment — e.g. an `ssh://`/scp-like remote on Browser or Memory, which wire no `SshTransport`. |
| `DIRECTORY_NOT_EMPTY` | `path` | A directory delete on a non-empty target. |
| `FILE_EXISTS` | `path` | Write attempted with `wx` flag against an existing file. |
| `FILE_NOT_FOUND` | `path` | Read against a path that does not exist. |
| `NOT_A_DIRECTORY` | `path` | Directory operation against a non-directory. |
| `OPERATION_ABORTED` | — | An `AbortSignal` fired during an operation. |
| `PERMISSION_DENIED` | `path` | Filesystem permission error, including lexical out-of-root rejections, **write**-side symlink-escape rejections (a symlinked leading directory or leaf resolving outside the root set), and 8.3 path mismatches on Windows. A **read** through a symlink resolving outside the root set is not refused — reads are lexical, matching git. |
| `RESOURCE_LOCKED` | `path` | A `.lock` file already exists; another writer holds it. |
| `UNSUPPORTED_OPERATION` | `operation, reason` | Feature not available in this adapter / runtime. |

### Objects, storage, packs

| Code | Payload | Raised when |
|---|---|---|
| `BUNDLE_BAD_HEADER` | `path, reason ('not-a-bundle' \| 'malformed-header' \| 'unknown-capability' \| 'unknown-hash-algorithm'), …` | A bundle's header text does not conform to the v2/v3 grammar. `not-a-bundle` carries no extra fields (the magic line names neither v2 nor v3); `malformed-header` carries `line, length` (a content line that doesn't fit the prerequisite/ref shape, including any line read before a v3 header's algorithm is known); `unknown-capability` carries `capability` — the whole `name[=value]` text verbatim, including a valueless `@object-format` (a different key, not a missing value); `unknown-hash-algorithm` carries `algorithm` — an `@object-format` value outside `sha1`/`sha256`. |
| `BUNDLE_PREREQUISITE_ALGORITHM_MISMATCH` | `oid, bundleAlgorithm, localAlgorithm` | `bundle verify`'s prerequisites are declared under an algorithm the verifying repository does not itself use — git can never map such an oid to a local object, so this fires before the prerequisite-presence lookup (which would otherwise misreport the oid as merely absent, exit 1, instead of an algorithm mismatch, exit 128). Fires only when the bundle carries prerequisites — a cross-format complete bundle verifies fine. |
| `BUNDLE_UNSUPPORTED_VERSION` | `path?, version` | A bundle version outside the supported set — v2 and v3 are both accepted, so this fires only for an explicit `bundle create` request for a version tsgit does not produce (e.g. 1 or 4, or 2 where the selected algorithm requires 3). `path` is present for a read-side refusal, absent for a write-side one. |
| `COMPRESS_FAILED` | `reason` | Adapter-level compression error. |
| `DECOMPRESS_FAILED` | `reason` | Adapter-level decompression error. |
| `DELTA_CHAIN_TOO_DEEP` | `depth, limit` | Resolving a packed object exceeded the recursion cap. |
| `HASH_FAILED` | `reason` | Adapter-level hashing error. |
| `INVALID_DELTA` | `reason` | Malformed pack delta entry. |
| `INVALID_OBJECT_HEADER` | `reason` | Loose object header could not be parsed. |
| `INVALID_OBJECT_ID` | `value, reason` | String → `ObjectId` parsing failed. |
| `INVALID_PACK_ENTRY` | `reason` | Packfile entry malformed. |
| `INVALID_PACK_HEADER` | `reason` | Packfile header malformed. |
| `INVALID_PACK_INDEX` | `reason` | Pack index (`.idx`) malformed. |
| `INVALID_TREE_ENTRY` | `reason` | Tree object entry malformed. |
| `OBJECT_TOO_LARGE` | `id, actualSize, limit` | Object exceeds `maxBytes` cap. |
| `OBJECT_NOT_FOUND` | `id` | Id missing locally and (if applicable) the promisor remote did not deliver it. |
| `PACK_TOO_LARGE` | `bytes, limit` | Pack exceeded the adapter's size guard. |
| `UNEXPECTED_OBJECT_TYPE` | `id, expected, actual` | Resolved object's type does not match the caller's expectation (e.g. asked for tree, got blob). |

### Refs, reflog, revparse

| Code | Payload | Raised when |
|---|---|---|
| `AMBIGUOUS_OID_PREFIX` | `prefix, candidates` | An abbreviated object-id prefix matched more than one object. |
| `BRANCH_EXISTS` | `name` | `branch.create(...)` without `force` against an existing branch. |
| `BRANCH_NOT_FOUND` | `name` | `branch.delete(...)` against an unknown branch. |
| `CANNOT_DELETE_CHECKED_OUT_BRANCH` | `name` | Attempt to delete the branch HEAD points at. |
| `DUPLICATE_REF` | `name` | Packed-refs file lists the same name twice. |
| `INVALID_PACKED_REFS` | `reason` | `.git/packed-refs` malformed. |
| `INVALID_REF` | `name, reason` | Ref name violates git syntax. |
| `INVALID_REF_LINE` | `reason` | Ref-line on the wire was malformed. |
| `INVALID_REFLOG_ENTRY` | `reason` | Reflog file line could not be parsed. |
| `INVALID_REFTABLE` | `check, reason` | A reftable stack file failed a structural parse gate. |
| `REF_CHAIN_TOO_DEEP` | `depth, limit` | Symbolic ref chain exceeded the recursion cap. |
| `REF_CYCLE_DETECTED` | `name` | Symbolic ref pointed at itself directly or indirectly. |
| `REF_LOCKED` | `name` | Another writer holds the ref lock. |
| `REF_NOT_FOUND` | `name` | Resolution against a missing name. |
| `REF_UPDATE_CONFLICT` | `name, expected, actual` | CAS check failed in `updateRef`. |
| `REFLOG_ENTRY_OUT_OF_RANGE` | `index, length` | `@{N}` (or explicit delete by index) beyond reflog length. |
| `REFLOG_NOT_FOUND` | `ref` | Ref has no reflog. |
| `REFTABLE_LOCKED` | `stack, reason` | Another writer holds the reftable stack's `tables.list.lock`. |
| `REVPARSE_AMBIGUOUS` | `expression, candidates` | Short oid matched multiple objects. |
| `REVPARSE_UNRESOLVED` | `expression, reason` | Revision expression could not resolve. |
| `TAG_EXISTS` | `name` | `tag.create(...)` without `force` against an existing tag. |
| `TAG_NOT_FOUND` | `name` | `tag.delete(...)` against an unknown tag. |

### Index, working tree, sparse, ignore

| Code | Payload | Raised when |
|---|---|---|
| `CHECKOUT_OVERWRITE_DIRTY` | `localChanges`, `untracked` | `checkout` switch mode would discard tracked modifications or clobber untracked files and no `force`. |
| `CLEAN_FILTER_FAILED` | `path, filter, exitCode` | A `filter=<name>` clean command (`filter.<name>.required = true`) exited non-zero during `add` / stage — the stage is refused and nothing is committed. If `required` is absent or `false`, a failing clean is a warning and raw bytes are staged instead (no throw). |
| `SMUDGE_FILTER_FAILED` | `path, filter, exitCode` | A `filter=<name>` smudge command (`filter.<name>.required = true`) exited non-zero during `checkout` — the checkout is refused and the file is not written to the working tree. If `required` is absent or `false`, a failing smudge is a warning and raw blob bytes are written instead (no throw). |
| `GITIGNORE_FILE_TOO_LARGE` | `name, bytes, limit` | `.gitignore` (or `core.excludesFile`) exceeds 1 MiB cap. |
| `INVALID_INDEX_ENTRY` | `offset, reason` | An entry's path fails git's own `verify_path` rule set: a traversal/absolute/empty segment, a `.git` alias (any case, trailing dot/space, the NTFS `git~1` short name, a `.git:`-stream form, or an HFS+ ignorable-codepoint spelling), or a `.gitmodules` entry staged as a symlink (CVE-2018-11235). Raised parsing `.git/index`, and at every boundary that projects a tree into index shape or writes one back out (`buildIndexFromTree`, `synthesizeTreeFromIndex`, checkout/reset materialisation, `stash apply`'s untracked restore). A backslash, a C0/C1 control byte, or a BIDI/isolate Unicode control character is **not** rejected here — git accepts all three in a path, and tsgit now matches. |
| `INVALID_INDEX_HEADER` | `reason` | `.git/index` header malformed. |
| `INVALID_FILE_MODE` | `value` | Mode bits do not match any recognised git file mode. |
| `PATHSPEC_BEYOND_SYMLINK` | `path` | `add` refused a literal pathspec whose leading directory is a symbolic link (fires for an intra-repo link target too — shape-based, not containment-based). |
| `PATHSPEC_NO_MATCH` | `pattern` | A literal path pattern matched nothing. |
| `PATHSPEC_OUTSIDE_REPO` | `pattern` | Pattern resolved to a path outside `workDir`. |
| `SPARSE_PATTERN_FILE_TOO_LARGE` | `bytes, limit` | `.git/info/sparse-checkout` exceeds the cap. |
| `TREE_CYCLE_DETECTED` | `path` | Recursing into a tree formed a cycle (gitlink loop). |
| `TREE_DEPTH_EXCEEDED` | `depth` | Tree recursion exceeded `core.maxTreeDepth` — read from the repository-local config only (never `~/.gitconfig` or any other scope), defaulting to 2048 when unset, and honoured unclamped at any configured value. |
| `TREE_ENTRY_LIMIT_EXCEEDED` | `path, limit` | Tree had more than the configured entry cap. |
| `WORKING_TREE_DIRTY` | `localChanges`, `untracked` | Operation requires a clean working tree (and no `force`), or a conflicting merge whose materialisation would overwrite a tracked-and-modified or untracked path. `localChanges` holds the tracked-dirty paths, `untracked` the untracked-clash paths. |
| `WORKING_TREE_FILE_TOO_LARGE` | `path, bytes, limit` | File exceeds `MAX_WORKING_TREE_BLOB_BYTES` (256 MiB). |
| `WORKTREE_FILE_ABSENT` | `path` | Working-tree blame (`worktree: true`) of a tracked path whose file is missing from disk. |

### Diff & merge

| Code | Payload | Raised when |
|---|---|---|
| `INVALID_DIFF_INPUT` | `reason` | `diff` / `diffTrees` arguments invalid. |
| `INVALID_MERGE_INPUT` | `reason` | `merge` arguments invalid. |
| `INVALID_MERGE_TREE` | `reason` | Three-way merge encountered structurally invalid trees. |
| `INVALID_TREE_FOR_DIFF` | `id` | Caller passed a non-tree id to a tree-diff path. |
| `MERGE_HAS_CONFLICTS` | _legacy_ | Pre-1.x throw form; v1 returns `{ kind: 'conflict', … }` instead. |

### Commits & identity

| Code | Payload | Raised when |
|---|---|---|
| `AUTHOR_UNCONFIGURED` | — | No `user.name` / `user.email` and no caller override. |
| `CHERRY_PICK_MERGE_NO_MAINLINE` | `commit` | `cherryPick` of a merge commit (≥2 parents) without a chosen mainline (`-m`). |
| `REVERT_MERGE_NO_MAINLINE` | `commit` | `revert` of a merge commit (≥2 parents) without a chosen mainline (`-m`). |
| `EMPTY_COMMIT_MESSAGE` | — | `commit({ message: '' })`. |
| `EMPTY_PATHSPEC` | — | Path-based command called with empty `paths` and no bulk flag. |
| `INVALID_COMMIT` | `reason` | Commit object failed validation. |
| `INVALID_IDENTITY` | `reason` | Author / committer identity malformed. |
| `INVALID_OPTION` | `option, reason` | Caller passed an incompatible option combination. |
| `INVALID_SEQUENCER_TODO` | `reason` | A `.git/sequencer/todo` line could not be parsed or its commit could not be resolved. |
| `INVALID_TAG` | `reason` | Tag object failed validation. |
| `NOTHING_TO_COMMIT` | — | `commit` called when the index matches HEAD's tree (no changes to commit). |
| `OPERATION_IN_PROGRESS` | `operation` | Another long-running operation (merge / rebase / cherry-pick) is pending. |
| `SIGNING_FAILED` | `reason` | `commit` / `tag` requested signing but the signing program failed or is unavailable (off-node, no `gpg`, bad key, or `gpg.format=x509` which is unsupported). Nothing is written. |

### Network, transport, partial clone

| Code | Payload | Raised when |
|---|---|---|
| `BLOCKED_HOST` | `host, reason` | SSRF guard rejected an URL. |
| `EMPTY_RECEIVE_UPDATES` | — | `push` produced no ref updates. |
| `EMPTY_WANTS` | — | `fetch` had nothing to ask for. |
| `HTTP_ERROR` | `statusCode, reason` | Non-2xx HTTP response. |
| `INVALID_BASE_URL` | `url, reason` | Base URL failed validation. |
| `INVALID_FILTER_SPEC` | `value, reason` | `--filter` spec could not be parsed. |
| `INVALID_PKT_LENGTH` | `value` | Wire-protocol pkt-line length invalid. |
| `INVALID_REPORT_STATUS` | `reason` | `receive-pack` report malformed. |
| `INVALID_SIDEBAND_CHANNEL` | `channel` | Unrecognised sideband channel byte. |
| `INVALID_URL` | `reason` | URL failed validation. HTTP: scheme / DNS / structure. SSH or scp-like: a control character, or the host/path begins with `-` (argv-injection guard). |
| `MAX_REFSPECS_EXCEEDED` | `count, limit` | Too many refspecs in one call. |
| `MISSING_CAPABILITIES` | `expected, advertised` | Server's capabilities list lacks a required entry. |
| `MISSING_SERVICE_HEADER` | — | Smart-HTTP discovery response missing the service line. |
| `NETWORK_ERROR` | `reason` | Transport failure. HTTP: `'connection-reset' \| 'dns' \| 'tls' \| 'http-status' \| 'aborted' \| 'timeout'`. SSH: free-form text naming the `ssh` child process's exit code (e.g. `'ssh exited with code 128'`). |
| `NO_PROMISOR_REMOTE` | — | `fetchMissing` against a non-partial repo. |
| `NON_FAST_FORWARD` | `name` | `push` would not fast-forward and no `force` / `forceWithLease`. |
| `PKT_LENGTH_RESERVED` | `value` | pkt-line length in the reserved range. |
| `PKT_TOO_LARGE` | `bytes, limit` | pkt-line payload exceeds the cap. |
| `PKT_TRUNCATED` | — | Stream ended mid pkt-line. |
| `PUSH_OBJECT_FORMAT_UNSUPPORTED` | `local, remote` | `push` discovered the receiving end's hash algorithm (v1 — push has no v2 wire form) differs from this repository's own. |
| `PUSH_REJECTED` | `name, reason` | Server returned `ng` for at least one ref. |
| `REFSPEC_INVALID` | `value, reason` | Refspec syntactically invalid. |
| `REMOTE_ADVERTISES_NO_REFS` | — | Server returned an empty ref list. |
| `REMOTE_FILTER_UNSUPPORTED` | — | Server's capabilities lack `filter` (v1 capability list or v2 `fetch` command's sub-features). |
| `REMOTE_NOT_CONFIGURED` | `name` | `[remote "<name>"]` not in `.git/config`. |
| `SIDEBAND_FATAL` | `message` | Server emitted a sideband fatal-error line. |
| `SIGNED_PUSH_UNSUPPORTED` | — | `push({ signed: 'yes' })` but the server does not advertise the `push-cert` capability. Nothing is sent. (`'if-asked'` falls back to an unsigned push.) |
| `TOO_MANY_ADVERTISED_REFS` | `count, limit` | Server advertised more refs than the cap (v1 ref advertisement or v2 `ls-refs` response). |
| `TOO_MANY_REDIRECTS` | `count, limit` | HTTP redirect loop / overflow. |
| `TOO_MANY_SECTION_ENTRIES` | `section, count, limit` | A v2 `fetch` response section (`acknowledgments`, `shallow-info`, `wanted-refs`) produced more lines than the safety cap. |
| `UNEXPECTED_V2_SECTION` | `section` | A v2 `fetch` response section header names something other than `acknowledgments`, `shallow-info`, `wanted-refs`, or `packfile`. |
| `UNKNOWN_ACK_STATUS` | `status` | want/have negotiation returned an unrecognised ack. |
| `UNSUPPORTED_OBJECT_FORMAT` | `format, local?` | `fetch`/`clone` discovered a peer whose declared hash algorithm (v1 advertisement token or v2 capability line) differs from this repository's own (`local` set), or the peer advertised a value outside the closed `sha1`/`sha256` set (`local` absent). |
| `UNSUPPORTED_SCHEME` | `scheme` | URL scheme not in the allowed list. |
| `V2_COMMAND_UNSUPPORTED` | `command` | The server's v2 capability advertisement doesn't support a command tsgit needs — e.g. its first line isn't exactly `version 2`, or it doesn't list the `fetch` command. |

### Hooks & lifecycle

| Code | Payload | Raised when |
|---|---|---|
| `HOOK_FAILED` | `hook, exitCode, stderr` | A `.git/hooks/<name>` script exited non-zero. |
| `REPOSITORY_DISPOSED` | — | A bound method was called after `repo.dispose()` or `signal.abort()`. |

### Repository state

| Code | Payload | Raised when |
|---|---|---|
| `ALREADY_INITIALIZED` | `path` | `init` against a directory that already has `.git/HEAD`. |
| `BARE_REPOSITORY` | `operation` | `reset({ mode: 'mixed' })` against a repository where `layout.bare` is `true` — git's `is_bare_repository()`-keyed refusal (`fatal: mixed reset is not allowed in a bare repository`). Narrower than it sounds: every other work-tree-requiring command refuses with `WORK_TREE_REQUIRED` instead, because bareness and work-tree presence are different questions that can disagree (a repository opened with an explicit `workDir` over `core.bare = true` is not bare and keeps working; a linked worktree of a bare repository is not bare either). |
| `CONFIG_MISSING_VALUE` | `key, source, line` | A string-typed config key is present-but-valueless (git NULL) at a command that reads it for a real purpose. Covers identity (`user.name` / `user.email`), `remote.<n>.url` / `remote.<n>.pushurl`, `branch.<n>.remote` / `merge`, `merge.<d>.driver` / `name`, `submodule.<n>.url` / `update`, `extensions.objectFormat` (and, identically, `extensions.refStorage`), and the `[core]` path-likes `core.excludesFile` / `core.attributesFile` / `core.hooksPath`. Most keys refuse **lazily**, at the consuming command (`commit`, `fetch`, `push`, `pull`, `merge`, `submodule update`). The `[core]` path-likes refuse **eagerly**: `excludesFile` / `attributesFile` on every operational command (matching git's broad default-config death — `config --get` / `--list` still survive); `hooksPath` only when a command resolves the hooks dir (a documented narrower under-refusal — `log` / `diff` / `show` succeed where git dies). `extensions.objectFormat` refuses **eagerly, at `openRepository`** (Stage 2 of layout resolution), ahead of the acceptance gate. Reconstructs git's two-line refusal: `error: missing value for '<key>'` + `fatal: bad config line <N> in file <F>` (`extensions.objectFormat`) or `fatal: bad config variable '<key>' in file '<F>' at line <N>` (the other keys above — git's exact second line varies by call site even though the tsgit code is shared). Distinct from the absent case (`AUTHOR_UNCONFIGURED` / `REMOTE_NOT_CONFIGURED` / built-in defaults). Porcelain reads (`config --get` / `--list`) still succeed on valueless keys. |
| `CONFIG_BAD_NUMERIC_VALUE` | `key, source, value, reason` | An int-typed config key holds a value git cannot parse as an integer — valueless (git NULL, `value` `''`), unparseable (`abc`, `1.5`, `5x`), or beyond the signed-64-bit range. Scopes `core.loosecompression` / `core.compression` and `core.maxTreeDepth`, validated **eagerly and fully** (git's `git_default_config` parity) on the same broad operational surface as the `[core]` path-likes (`status`, `log`, `branch`, … die; `config --get` / `--list` still survive). Reconstructs git's **single-line** refusal: `fatal: bad numeric config value '<value>' for '<key>' in file <F>: <reason>`, where `reason` ∈ `{'invalid unit', 'out of range'}`. Structurally distinct from `CONFIG_MISSING_VALUE`: **one** line (no `error:` prefix), the file token is **unquoted**, and there is **no `at line <N>`** — hence a separate code with no `line` field. `core.maxTreeDepth` has a validation model the compression keys do not share: it is validated on its **effective, last-wins** entry (an invalid line followed by a valid one succeeds), where the compression keys die on *any* malformed line, and its refusal is reported **ahead of** every line-ordered class below rather than folded into that ordering. The gate otherwise reports the first failing `[core]` entry by file line across the string path-likes and the compression keys (git's per-entry order). |
| `CONFIG_BAD_ZLIB_LEVEL` | `level` | An int-typed compression key (`core.loosecompression` / `core.compression`) parses to a valid integer but lies outside zlib's `-1..9` range (e.g. `10`, `99`, `-2`). Validated eagerly alongside `CONFIG_BAD_NUMERIC_VALUE` (parse first, then the zlib range-check) on the same broad operational surface. Reconstructs git's **bare** `fatal: bad zlib compression level <N>` — no key, file, or `value` token, so a distinct code carrying only `level`. |
| `CONFIG_BAD_BOOLEAN_VALUE` | `key, source, value` | A boolean-typed config key holds a value git's boolean grammar refuses: not one of the six words (`true`/`false`/`yes`/`no`/`on`/`off`, case-insensitive), not valueless (git NULL ⇒ true) or empty (⇒ false), and not an integer git can parse into a C `int` (non-zero ⇒ true, zero ⇒ false — so `2`, `0x1`, `1k` are true and `0`, `0x0` are false; values that overflow `int32` such as `2147483648` still refuse even though tsgit's own 64-bit `parseGitInt` would otherwise accept them). Refuses at the same tier git does: `core.bare` / `extensions.worktreeConfig` refuse every command including the `config` porcelain; `core.sparseCheckout` / `core.sparseCheckoutCone` / `core.logAllRefUpdates` / `diff.<d>.cachetextconv` refuse the operational surface while `config --get` / `--list` still succeed; `commit.gpgSign`, `tag.gpgSign`, `filter.<d>.required`, `submodule.<n>.active`, `remote.<n>.promisor`, and `pack.writeReverseIndex` refuse only at the consuming command. Reconstructs git's single-line `fatal: bad boolean config value '<value>' for '<key>'` — `key` is the lower-cased qualified token with the subsection preserved verbatim. When several entries are malformed, the reported one is picked by tier first, then lowest config-file line, ordered against `CONFIG_MISSING_VALUE` and `CONFIG_BAD_NUMERIC_VALUE` as one shared rule. |
| `CONFIG_BAD_BOOLEAN_LITERAL` | `key, source, value` | `push.gpgSign`'s own boolean refusal — same grammar and consuming-command tier as `CONFIG_BAD_BOOLEAN_VALUE` (cross-ordered by config-file line against a malformed `push.default`), but git reports it with a different line — `error: invalid value for 'push.gpgsign'` — so a distinct code carries it rather than overloading one shape with two renderings. |
| `CONFIG_PARSE_ERROR` | `line, source?, partialSectionName?` | A config file value (unknown escape, unclosed quote) or quoted-subsection header is malformed — git's `bad config line N in file F`; refuses any command that reads the file. |
| `CONFIG_INVALID_ENUM_VALUE` | `key, source, value, line` | A string-typed config key restricted to a fixed, case-sensitive set of literals holds a value outside that set. Currently `extensions.objectFormat` (`sha1` / `sha256`; `extensions.refStorage` shares the identical grammar). Refuses **eagerly, at `openRepository`** (Stage 2 of layout resolution), ahead of the acceptance gate — measured: git rejects a malformed value even at an unsupported `core.repositoryformatversion`. The *key* is matched case-insensitively and lower-cased for the message, but the *value* is compared case-sensitively (`SHA256` refuses even though `sha256` is legal); the empty string (`key =` with nothing after) is a value under this grammar, distinct from the valueless case (`CONFIG_MISSING_VALUE`). Reconstructs git's two-line refusal: `error: invalid value for '<key>': '<value>'` + `fatal: bad config line <N> in file <F>`. |
| `CONFIG_INVALID_FILE` | `sectionName, source` | A config `set`/`unset` refused because the file holds a malformed quoted-subsection header — git's `invalid section name '<partial>'` + `invalid config file F`. |
| `DUBIOUS_OWNERSHIP` | `path, foreignPath?` | git's dubious-ownership refusal (`safe.directory`): the repository's metadata is owned by someone other than the current user. `path` is the work tree when discovery produced one, else the gitdir. `foreignPath`, when present, names only the **first** member of the checked set the ownership predicate reported unowned, in the documented check order — never read it as the only unowned path — and it is **absent**, never equal to `path`. Remedy: pass `trustedDirectories: [path]` to `openRepository` (tsgit's analogue of git's `safe.directory`). Refuses ahead of the format gate; `IMPLICIT_BARE_REPOSITORY` refuses first when both conditions hold. |
| `GITFILE_INVALID_FORMAT` | `path` | Discovery met a `.git` **file** it cannot use: it lacks the exact `gitdir: ` prefix, is unreadable, or exceeds the 64 KiB pointer-file cap — or the admin dir's `commondir` file is empty (after stripping trailing CR/LF) or itself oversized. Mirrors git's `fatal: invalid gitfile format: <file>`. A `.git` **file** is a commitment: this hard-stops discovery and never falls back to an enclosing repository, unlike an unusable `.git` **directory**, which is skipped and the walk continues upward. |
| `GITFILE_NO_PATH` | `path` | Discovery met a `.git` file whose `gitdir: ` prefix is followed by an empty path. Same hard-stop as `GITFILE_INVALID_FORMAT` — mirrors git's `fatal: no path in gitfile: <file>`. (A pointer that parses but whose target is missing or not a valid repository still raises `NOT_A_REPOSITORY`, named after the worktree path the caller gave — never the enclosing repository. This is what makes opening a submodule's working directory resolve the submodule itself rather than silently falling back to the superproject.) |
| `IMPLICIT_BARE_REPOSITORY` | `gitDir` | Discovery reached the gitdir by the cwd-is-a-gitdir route AND the gitdir's basename is not literally `.git`, with `bareRepositories: 'explicit'` set. The name is deliberately imprecise — it follows the wording a user will search for — but whether the repository is bare (by `core.bare`, or by what a bareness query would report) plays **no part** in the condition; nothing downstream may infer bareness from it. Refuses ahead of `DUBIOUS_OWNERSHIP`, and `trustedDirectories` does not lift it. |
| `INVALID_WALK_INPUT` | `reason` | Walker arguments invalid. |
| `OBJECT_FORMAT_CONFLICT` | `requested, declared, source` | Two of the three object-algorithm channels disagree: `openRepository`'s `algorithm` option, the repository's declared `extensions.objectFormat` (read from disk), and a caller-supplied `hash` adapter's own `algorithm`. `source` (`'option'` or `'hash'`) names which channel `requested` came from; `declared` is the other side of the disagreement — not necessarily the repository's declared format (a `hash`-vs-`algorithm` conflict names the option's value there). An option/config conflict, not a repository property — raised by `openRepository` itself, outside the repository-format acceptance tier `DUBIOUS_OWNERSHIP` / `REPOSITORY_FORMAT_VERSION_UNSUPPORTED` / `REPOSITORY_EXTENSIONS_UNSUPPORTED` share. |
| `REPOSITORY_EXTENSION_UNSUPPORTED` | `extension, value` | the repository declares an extension git accepts but tsgit cannot yet act on; refused at the point of use rather than read wrong. Distinct from the two gate codes by **tier, not severity**: the gate codes refuse a repository git also refuses, this refuses an operation on a repository git's format gate accepts. State the current membership in the row while keeping the code general. |
| `REPOSITORY_EXTENSIONS_UNSUPPORTED` | `version, extensions` | at version 1, one or more `extensions.*` entries name a key git itself does not know; at version 0, one or more name a key git treats as v1-only. `version` selects which condition. `extensions` carries **every** offender in config-file order, duplicates included. Same tier as the version code. |
| `REPOSITORY_FORMAT_VERSION_UNSUPPORTED` | `version` | the effective (last-wins) `core.repositoryformatversion` exceeds 1. `version` is the **parsed** integer, so `1k` carries `1024` and `0777` carries `511`. Values ≤ 1 — including negatives — are accepted, as is an absent key and an absent config file. Reconstructs `fatal: Expected git repo version <= 1, found <version>`. Refuses every repository-needing verb; the four `config` read verbs survive with the repository config scope dropped. |
| `SHALLOW_FILE_MALFORMED` | `reason, lineNumber` | `.git/shallow` violates git's strict line grammar — a blank/short/non-hex line, or more than `MAX_SHALLOW_ENTRIES` lines. Carries the 1-based `lineNumber` of the offending line, never the raw line bytes (the content is remote-influenced). |
| `SUBMODULE_OBJECT_FORMAT_MISMATCH` | `local, remote` | `submodule add` discovered the cloned submodule's hash algorithm differs from the superproject's own — a cross-width gitlink oid cannot be represented in the superproject's tree. The clone into `.git/modules/<name>` has already happened by the time this fires; the partial state is left behind, matching git's own `error: cannot add a submodule of a different hash algorithm`. |
| `TARGET_DIRECTORY_NOT_EMPTY` | `path` | `clone` into a directory that already has `.git/HEAD`. `path` is `workDir ?? gitDir` — a bare clone's target has no work tree to name. |
| `WORK_TREE_CONFIG_INVALID` | `gitDir` | `core.bare` and `core.worktree` are both set in the repository's own config — git's `work_tree_config_is_bogus`. No work tree can be set up until the config is fixed, regardless of which command runs. Raised at the first work-tree-requiring command, ahead of `WORK_TREE_REQUIRED` — a bogus config refuses before the "no work tree" question is even asked. |
| `WORK_TREE_REQUIRED` | `operation` | A work-tree-requiring command (`status`, `add`, `checkout`, `commit`, `merge`, `mv`, `rm`, `stash`, `sparse-checkout`, `cherry-pick`, `revert`, `rebase`, `pull`, the default (working-tree) `grep` target, `blame({ worktree: true })` outside a bare repository, `describe({ dirty: true })`, the local `submodule` verbs, `reset({ mode: 'hard' })`, …) found no work tree — a bare repository, or a git directory opened without one (`cd .git`). Raised **lazily**, the first time the command reads the work tree — not at `openRepository` time. |
| `WORK_TREE_UNRESOLVABLE` | `value, gitDir` | A relative `core.worktree` failed to resolve physically from the gitDir — git changes directory to the gitDir, then to the relative value, and dies if that fails (`fatal: cannot chdir to '<value>'`). Raised **eagerly, at `openRepository`**, on adapters that realpath (Node); accepted lexically (no refusal) on sandboxed adapters (Memory, Browser), matching their existing canonicalisation split. `value` is the config's own relative text; an absolute `core.worktree` naming a missing directory is not this condition — it resolves and only a later work-tree-requiring command refuses. |
