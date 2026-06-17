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
| `ADAPTER_UNAVAILABLE` | `runtime, adapter` | A runtime-specific adapter is missing in the current environment. |
| `DIRECTORY_NOT_EMPTY` | `path` | A directory delete on a non-empty target. |
| `FILE_EXISTS` | `path` | Write attempted with `wx` flag against an existing file. |
| `FILE_NOT_FOUND` | `path` | Read against a path that does not exist. |
| `NOT_A_DIRECTORY` | `path` | Directory operation against a non-directory. |
| `OPERATION_ABORTED` | — | An `AbortSignal` fired during an operation. |
| `PERMISSION_DENIED` | `path` | Filesystem permission error, including symlink-escape rejections and 8.3 path mismatches on Windows. |
| `RESOURCE_LOCKED` | `path` | A `.lock` file already exists; another writer holds it. |
| `UNSUPPORTED_OPERATION` | `operation, reason` | Feature not available in this adapter / runtime. |

### Objects, storage, packs

| Code | Payload | Raised when |
|---|---|---|
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
| `REF_CHAIN_TOO_DEEP` | `depth, limit` | Symbolic ref chain exceeded the recursion cap. |
| `REF_CYCLE_DETECTED` | `name` | Symbolic ref pointed at itself directly or indirectly. |
| `REF_LOCKED` | `name` | Another writer holds the ref lock. |
| `REF_NOT_FOUND` | `name` | Resolution against a missing name. |
| `REF_UPDATE_CONFLICT` | `name, expected, actual` | CAS check failed in `updateRef`. |
| `REFLOG_ENTRY_OUT_OF_RANGE` | `index, length` | `@{N}` (or explicit delete by index) beyond reflog length. |
| `REFLOG_NOT_FOUND` | `ref` | Ref has no reflog. |
| `REVPARSE_AMBIGUOUS` | `expression, candidates` | Short oid matched multiple objects. |
| `REVPARSE_UNRESOLVED` | `expression, reason` | Revision expression could not resolve. |
| `TAG_EXISTS` | `name` | `tag.create(...)` without `force` against an existing tag. |
| `TAG_NOT_FOUND` | `name` | `tag.delete(...)` against an unknown tag. |

### Index, working tree, sparse, ignore

| Code | Payload | Raised when |
|---|---|---|
| `CHECKOUT_OVERWRITE_DIRTY` | `localChanges`, `untracked` | `checkout` switch mode would discard tracked modifications or clobber untracked files and no `force`. |
| `GITIGNORE_FILE_TOO_LARGE` | `name, bytes, limit` | `.gitignore` (or `core.excludesFile`) exceeds 1 MiB cap. |
| `INVALID_INDEX_ENTRY` | `offset, reason` | Entry in `.git/index` malformed. |
| `INVALID_INDEX_HEADER` | `reason` | `.git/index` header malformed. |
| `INVALID_FILE_MODE` | `value` | Mode bits do not match any recognised git file mode. |
| `PATHSPEC_NO_MATCH` | `pattern` | A literal path pattern matched nothing. |
| `PATHSPEC_OUTSIDE_REPO` | `pattern` | Pattern resolved to a path outside `workDir`. |
| `SPARSE_PATTERN_FILE_TOO_LARGE` | `bytes, limit` | `.git/info/sparse-checkout` exceeds the cap. |
| `TREE_CYCLE_DETECTED` | `path` | Recursing into a tree formed a cycle (gitlink loop). |
| `TREE_DEPTH_EXCEEDED` | `depth, limit` | Tree recursion exceeded `MAX_TREE_DEPTH` (4096). |
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
| `INVALID_URL` | `url, reason` | URL failed validation (scheme, DNS, structure). |
| `MAX_REFSPECS_EXCEEDED` | `count, limit` | Too many refspecs in one call. |
| `MISSING_CAPABILITIES` | `expected, advertised` | Server's capabilities list lacks a required entry. |
| `MISSING_SERVICE_HEADER` | — | Smart-HTTP discovery response missing the service line. |
| `NETWORK_ERROR` | `reason` | Transport failure (`'connection-reset' \| 'dns' \| 'tls' \| 'http-status' \| 'aborted' \| 'timeout'`). |
| `NO_PROMISOR_REMOTE` | — | `fetchMissing` against a non-partial repo. |
| `NON_FAST_FORWARD` | `name` | `push` would not fast-forward and no `force` / `forceWithLease`. |
| `PKT_LENGTH_RESERVED` | `value` | pkt-line length in the reserved range. |
| `PKT_TOO_LARGE` | `bytes, limit` | pkt-line payload exceeds the cap. |
| `PKT_TRUNCATED` | — | Stream ended mid pkt-line. |
| `PUSH_REJECTED` | `name, reason` | Server returned `ng` for at least one ref. |
| `REFSPEC_INVALID` | `value, reason` | Refspec syntactically invalid. |
| `REMOTE_ADVERTISES_NO_REFS` | — | Server returned an empty ref list. |
| `REMOTE_FILTER_UNSUPPORTED` | — | Server's capabilities lack `filter`. |
| `REMOTE_NOT_CONFIGURED` | `name` | `[remote "<name>"]` not in `.git/config`. |
| `SIDEBAND_FATAL` | `message` | Server emitted a sideband fatal-error line. |
| `TOO_MANY_ADVERTISED_REFS` | `count, limit` | Server advertised more refs than the cap. |
| `TOO_MANY_REDIRECTS` | `count, limit` | HTTP redirect loop / overflow. |
| `UNKNOWN_ACK_STATUS` | `status` | want/have negotiation returned an unrecognised ack. |
| `UNSUPPORTED_SCHEME` | `scheme` | URL scheme not in the allowed list. |

### Hooks & lifecycle

| Code | Payload | Raised when |
|---|---|---|
| `HOOK_FAILED` | `hook, exitCode, stderr` | A `.git/hooks/<name>` script exited non-zero. |
| `REPOSITORY_DISPOSED` | — | A bound method was called after `repo.dispose()` or `signal.abort()`. |

### Repository state

| Code | Payload | Raised when |
|---|---|---|
| `ALREADY_INITIALIZED` | `path` | `init` against a directory that already has `.git/HEAD`. |
| `BARE_REPOSITORY` | `operation` | Command not valid in a bare repository (`add`, `checkout`, `commit`, `rm`, …). |
| `CONFIG_MISSING_VALUE` | `key, source, line` | A string-typed config key is present-but-valueless (git NULL) at a command that reads it for a real purpose. Covers identity (`user.name` / `user.email`), `remote.<n>.url` / `remote.<n>.pushurl`, `branch.<n>.remote` / `merge`, `merge.<d>.driver` / `name`, `submodule.<n>.url` / `update`, and the `[core]` path-likes `core.excludesFile` / `core.attributesFile` / `core.hooksPath`. Most keys refuse **lazily**, at the consuming command (`commit`, `fetch`, `push`, `pull`, `merge`, `submodule update`). The `[core]` path-likes refuse **eagerly**: `excludesFile` / `attributesFile` on every operational command (matching git's broad default-config death — `config --get` / `--list` still survive); `hooksPath` only when a command resolves the hooks dir (a documented narrower under-refusal — `log` / `diff` / `show` succeed where git dies). Reconstructs git's two-line refusal: `error: missing value for '<key>'` + `fatal: bad config variable '<key>' in file '<F>' at line <N>`. Distinct from the absent case (`AUTHOR_UNCONFIGURED` / `REMOTE_NOT_CONFIGURED` / built-in defaults). Porcelain reads (`config --get` / `--list`) still succeed on valueless keys. |
| `CONFIG_BAD_NUMERIC_VALUE` | `key, source, value, reason` | An int-typed config key holds a value git cannot parse as an integer — valueless (git NULL, `value` `''`), unparseable (`abc`, `1.5`, `5x`), or beyond the signed-64-bit range. Today scopes `core.loosecompression` / `core.compression`, validated **eagerly and fully** (git's `git_default_config` parity) on the same broad operational surface as the `[core]` path-likes (`status`, `log`, `branch`, … die; `config --get` / `--list` still survive). Reconstructs git's **single-line** refusal: `fatal: bad numeric config value '<value>' for '<key>' in file <F>: <reason>`, where `reason` ∈ `{'invalid unit', 'out of range'}`. Structurally distinct from `CONFIG_MISSING_VALUE`: **one** line (no `error:` prefix), the file token is **unquoted**, and there is **no `at line <N>`** — hence a separate code with no `line` field. The gate reports the first failing `[core]` entry by file line across the string path-likes and the compression keys (git's per-entry order). |
| `CONFIG_BAD_ZLIB_LEVEL` | `level` | An int-typed compression key (`core.loosecompression` / `core.compression`) parses to a valid integer but lies outside zlib's `-1..9` range (e.g. `10`, `99`, `-2`). Validated eagerly alongside `CONFIG_BAD_NUMERIC_VALUE` (parse first, then the zlib range-check) on the same broad operational surface. Reconstructs git's **bare** `fatal: bad zlib compression level <N>` — no key, file, or `value` token, so a distinct code carrying only `level`. |
| `CONFIG_PARSE_ERROR` | `line, source?, partialSectionName?` | A config file value (unknown escape, unclosed quote) or quoted-subsection header is malformed — git's `bad config line N in file F`; refuses any command that reads the file. |
| `CONFIG_INVALID_FILE` | `sectionName, source` | A config `set`/`unset` refused because the file holds a malformed quoted-subsection header — git's `invalid section name '<partial>'` + `invalid config file F`. |
| `INVALID_WALK_INPUT` | `reason` | Walker arguments invalid. |
| `TARGET_DIRECTORY_NOT_EMPTY` | `path` | `clone` into a directory that already has `.git/HEAD`. |
