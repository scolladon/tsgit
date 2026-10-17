# Design — `.gitmodules` symlink aliases behind a backslash

## Goal

For a symlink (`120000`) entry, `verifyPath` must refuse exactly the `.gitmodules`
aliases git 2.55's `verify_path` refuses, no more and no fewer. Today it misses three
groups and over-refuses one:

- **(A) under-refusal** — an NTFS alias right after a `\` (`x\gitmod~1`, `x\.gitmodules`,
  `a\b\.gitmodules`, `y/x\gitmod~1`, …): git refuses, tsgit admits.
- **(B) over-refusal** — an NTFS alias followed by `/` (`gitmod~1/y`, `.gitmodules./y`,
  `gitmod~1./y`): tsgit refuses, git admits.
- **(C) under-refusal** — the 8.3 fall-back short name (`gi7eb~12`, `g~123456`,
  `~1234567`): git refuses, tsgit admits. tsgit's `/^gi7eba~[1-9]$/` is too narrow.

Security class: refusal mismatch on the CVE-2018-11235 hardening. Class A matters most:
a checkout on NTFS reads `x\gitmod~1` as `x/.gitmodules`, a symlinked `.gitmodules`.

The comment at `src/domain/path/verify-path.ts:239-248` says the backslash split can be
skipped because "`validateIndexPath`'s unconditional backslash rejection" runs first. That
is false. `src/domain/git-index/path-validator.ts:63-68` says the opposite: backslash is
POSIX-legal and deliberately not rejected. The comment above the regexes
(`verify-path.ts:227-235`) is also wrong. It describes `gi7eba~<digit>` as the whole
fall-back grammar, but git's rule is generic.

No API change, no new rejection reason. Every new refusal returns the existing
`'gitmodules-not-regular'`.

**Decision record:** governed by ADR-226 (git-faithfulness), ADR-763 (one byte-level
alias matcher shared by fsck) and ADR-978 (the HFS arm reads raw path bytes; refusals
apply on every platform and at index read). No new ADR unless a decision candidate below
is resolved against its recommendation.

## Faithfulness anchor (git)

### Source: git v2.55.0

Read from `read-cache.c` `verify_path_internal`/`verify_dotfile` and `path.c`
`is_ntfs_dot_generic`. This matches the session's reading:

```c
goto inside;
for (;;) {
    if (!c) return PATH_OK;
    if (is_dir_sep(c)) {                         /* '/' on POSIX */
inside:
        if (protect_hfs  && S_ISLNK(mode) && is_hfs_dotgitmodules(path))  return PATH_INVALID; /* component, up to '/' */
        if (protect_ntfs && S_ISLNK(mode) && is_ntfs_dotgitmodules(path)) return PATH_INVALID; /* rest of WHOLE path */
        c = *path++;
        if (c == '.' && !verify_dotfile(path, mode)) return PATH_INVALID;  /* ".gitmodules" + ('\0' | '/') */
        ...
    } else if (c == '\\' && protect_ntfs) {
        if (S_ISLNK(mode) && is_ntfs_dotgitmodules(path)) return PATH_INVALID;      /* rest of WHOLE path */
    }
    c = *path++;
}
```

`is_ntfs_dot_generic(name, "gitmodules", 10, "gi7eba")` matches when the name starts
with one of these, case-insensitively:

1. `.gitmodules`;
2. `gitmod~[1-4]`;
3. the fall-back: up to 6 characters of the prefix `gi7eba`, then `~`, a digit 1-9, and
   digits until exactly 8 characters (a non-ASCII byte fails).

Then `only_spaces_and_periods` must hold: only ` ` or `.` until `\0` or `:`. **A `/` or
`\` after the name fails the match.** `is_ntfs_dotgit` is different: it stops on `/` and
`\`. This one difference explains every row in classes A and B:

- the NTFS test runs at every component start **and after every `\`**, on the rest of
  the whole path;
- it cannot match a name followed by `/` (class B), or a `\` that has no `:` before it
  (`x\.gitmodules\y` is admitted).

HFS runs at component starts only, so `x\` followed by the ZWNJ alias (`.gitmodules` with U+200C after the `g`) is admitted.
`verify_dotfile` adds one more rule: exact `.gitmodules` (case-insensitive) followed by
`/`, which refuses `.gitmodules/y`.

### Pinned matrix

Setup: git 2.55.0 (`~/.local/git-2.55.0`), all `GIT_*` scrubbed,
`GIT_CONFIG_NOSYSTEM=1`, temp `HOME`, mktemp repo, darwin defaults
(protectNTFS and protectHFS on). Each row was run twice, with
`update-index --add --index-info` (`120000 <blob>\t<path>`) and with `git add` of an
on-disk symlink. The two always agreed, and 3/3 runs were identical. As regular files
(`100644`), git admits every path below.

| path (symlink, `120000`) | git | tsgit @ 785fadfc | class |
|---|---|---|---|
| `.gitmodules`, `.GITMODULES`, `gitmod~1`, `gitmod~1 `, `GI7EBA~1`, `x\/gitmod~1` | refused | refused | — |
| `.gitmodules/y`, `.GITMODULES/y`, `.gitmodules:s/y`, `gitmod~1:s/y`, the ZWNJ alias then `/y` | refused | refused | — |
| `.gitmodules\y`, `x\.gitmodules\y`, `x\gitmod~1\y`, `x\.gitmodules/y`, `x\gitmod~1/y` | admitted | admitted | — |
| `x\gitmod~5`, `x\` + the ZWNJ alias, `gi7eba~10`, `gi7eb~1`, `x\` | admitted | admitted | — |
| `\gitmod~1`, `x/\gitmod~1`, `\.gitmodules` (backslash **first** in its component) | admitted | admitted | — (must stay admitted) |
| `x\.gitmodules`, `x\.GITMODULES`, `x\gitmod~1`, `x\GITMOD~1`, `x\gitmod~4`, `x\gi7eba~1` | **refused** | admitted | A |
| `x\.gitmodules.`, `x\.gitmodules `, `x\.gitmodules. .`, `x\gitmod~1.`, `x\gitmod~1 `, `x\gitmod~1 . ` | **refused** | admitted | A |
| `x\.gitmodules:s`, `x\gitmod~1:s`, `x\.gitmodules:s\y` | **refused** | admitted | A |
| `a\b\.gitmodules`, `y/x\gitmod~1`, `x\\gitmod~1`, `\\gitmod~1`, `x:\gitmod~1`, `x\g~123456` | **refused** | admitted | A (+C) |
| `gitmod~1/y`, `gi7eba~1/y`, `.gitmodules./y`, `gitmod~1./y` | **admitted** | refused | B |
| `gi7eb~12`, `g~123456`, `~1234567` | **refused** | admitted | C |

Full per-mode, per-surface record: the session scratchpad `PIN.md` (45 rows × 2 modes ×
2 surfaces). The rows `x\`, `\gitmod~1`, `x/\gitmod~1`, `\\gitmod~1`, `\.gitmodules`,
`x\/gitmod~1`, `x:\gitmod~1`, `.GITMODULES` and `gi7eba~1/y` were pinned for this doc
(`--index-info` only, 3/3 identical). The tsgit column comes from running `verifyPath`
on `785fadfc`.

**A backslash that opens a component is never tested.** `verify_path_internal` reads a
component's first byte inside the `inside:` block (`c = *path++`), and the
`else if (c == '\\')` arm only sees bytes read at the bottom of the loop. So in
`\gitmod~1` the `\` is consumed as a plain first byte, and the alias is never re-tested
(admitted). In `\\gitmod~1` the *second* `\` is tested (refused). The design must
reproduce this skip.

### Other git surfaces (pinned for this doc, 3/3 identical)

Same setup. Trees were built with `mktree`. The index was written with
`-c core.protectNTFS=false update-index --index-info`.

| surface | `x\gitmod~1` | `gi7eb~12` | `gitmod~1/y` | `x\.gitmodules\y` |
|---|---|---|---|---|
| `git reset -q <c>` (tree → index) | exit 128, `error: invalid path` | exit 128 | exit 0 | exit 0 |
| `git checkout -q <c>` | exit 1, `error: invalid path`, HEAD unchanged | exit 1 | exit 0 | exit 0 |
| `git read-tree <t>` | exit 128 | exit 128 | exit 0 | — |
| git **reading** an index that already holds it (`ls-files`, `status`, `write-tree`) | exit 0, no refusal | exit 0 | exit 0 | — |

The last row is a known tsgit divergence: `parseIndex` refuses such an entry at read,
and git reads it without complaint. That is tsgit's existing posture (the
`path-validator.ts` header, ADR-978 Consequences). This change applies it to the new
classes; it does not create the posture (see D4).

## Design

The `.gitmodules` symlink check becomes a direct port of git's three tests, each in its
correct scope. It runs only when `mode === FILE_MODE.SYMLINK`, as it does today.

```
path bytes:  y / x \ g i t m o d ~ 1
offsets:     ^0  ^2  ^4                    ← NTFS start offsets: 0, after each '/', after each '\'
                                             that is NOT its component's first byte
NTFS arm:    matchesNtfsDotgitAlias(bytes, start, bytes.length, 'gitmodules')   // rest of WHOLE path
HFS arm:     per '/' component: hfsAlias(component, componentBytes, '.gitmodules') // unchanged
dotfile arm: per '/' component: component bytes ≡ ".gitmodules" (ASCII case-fold)  // verify_dotfile
```

```ts
// git re-tests the rest of the whole path after every '/', and after every '\'
// it reads mid-component; a component's first byte is consumed untested.
const opensComponent = (bytes: Uint8Array, at: number): boolean =>
  at === 0 || bytes[at - 1] === SLASH;

const isNtfsRetestPoint = (bytes: Uint8Array, at: number): boolean =>
  bytes[at] === SLASH || (bytes[at] === BACKSLASH && !opensComponent(bytes, at));

const hasNtfsGitmodulesAlias = (bytes: Uint8Array): boolean => {
  if (matchesNtfsDotgitAlias(bytes, 0, bytes.length, 'gitmodules')) return true;
  for (let at = 0; at < bytes.length; at += 1) {
    if (!isNtfsRetestPoint(bytes, at)) continue;
    if (matchesNtfsDotgitAlias(bytes, at + 1, bytes.length, 'gitmodules')) return true;
  }
  return false;
};
```

`matchesNtfsDotgitAlias` (`src/domain/objects/tree-entry-bytes.ts:213`) is already a
faithful byte port of `is_ntfs_dot_generic`:

- `isNtfsTail` (`:119`) fails on `/` and `\` for `gitmodules`;
- `foldsToNtfsFallbackShortName` (`:154`) is the 8-character fall-back grammar;
- fsck uses it today (ADR-763).

Given `end = path end`, it reproduces "rest of the whole path" exactly. That fixes A, B
and C together:

- **A:** new start offsets after a mid-component `\`.
- **B:** `/` now fails the tail. Today's per-component normalisation strips the trailing
  dots and spaces and ignores what follows.
- **C:** the generic fall-back grammar replaces the `gi7eba` regex.

The per-component part of `matchGitmodulesAliasPart` keeps only the scopes git gives it:

- **dotfile:** exact `.gitmodules` with ASCII case-fold only. No trailing-dot or space
  strip, and no stream split. A leaf `.gitmodules` is also caught by the NTFS arm, but a
  non-leaf `.gitmodules/y` is caught only here (or by HFS).
- **HFS:** `hfsAlias(component, componentBytes, GITMODULES)`, unchanged. The dotfile check
  must run first. The `Stryker disable` justification at `verify-path.ts:103` relies on
  "the caller's exact-match check already caught `candidate === part`", and the dotfile
  check is now the exact match it relies on. The justification text names
  `normalizeAliasCandidate`, so it gets reworded.

`GITMOD_NTFS_SHORT_NAME`, `GITMOD_NTFS_HASHED_SHORT_NAME`, and the `splitAtStream` and
`normalizeAliasCandidate` uses on the gitmodules path are deleted. They are still used
on the `.git` path.

### Bytes when the caller passes none

Some callers pass no bytes: `add.ts:836` and `:1270`, `mv.ts:343`, `archive.ts:164`,
`submodule-context.ts:74`, and `parseIndex` for a losslessly decoded path
(`lossyPathBytes` returns `undefined`). In these cases the NTFS arm runs on
`encode(path)` (`src/domain/objects/encoding.ts:74`). Encoding happens only for symlink
entries, so the hot path for regular files does not allocate.

Encoding is exact for this arm. Every byte in the grammar is ASCII. A non-ASCII code unit
encodes only to bytes `≥ 0x80`, which match no grammar byte and fail the tail. A lossy
`U+FFFD` changes the byte length only inside a region that already fails the match. So a
string path matches if and only if its raw bytes match. This needs no new decision.

### `.git` path: same skip, opposite symptom (proof; see D6)

`is_ntfs_dotgit` stops on `/`, `\` and `:`, so testing "this backslash part" is
equivalent to testing "the rest of the whole path". But `matchAliasComponent`
(`verify-path.ts:169-180`) splits each component on `\` and **also tests the part after
a component-leading `\`**, which git skips. Pinned (git 2.55, mode `100644`,
`--index-info`, 3/3 identical) against `verifyPath` on `785fadfc`:

| path | git | tsgit |
|---|---|---|
| `\.git`, `\git~1`, `x/\.git`, `\.git\y`, `x/\.git/y`, `\.git:s` | admitted | refused (`dotgit-alias` / `dotgit-ntfs-alias` / `dotgit-ntfs-stream`) |
| `\\.git`, `x\.git` | refused | refused |

That is an over-refusal in the `.git` arm. It also reaches `isDotGitAlias`, which
`src/domain/working-tree-path.ts:96` uses. It is outside the brief, so it is D6, not
scope.

## Parts

### P1 — domain: faithful `.gitmodules` symlink check

- **Files:**
  - `src/domain/path/verify-path.ts`:
    - comment and regexes `:227-237`;
    - `matchGitmodulesAliasPart` `:239-256`;
    - `hasGitmodulesSymlinkComponent` `:258-272`;
    - `verifyPath(path: string, mode: FileMode, pathBytes?: Uint8Array)` `:280-293`;
    - `hfsAlias` justification `:103`.
- **Reuse:**
  - `matchesNtfsDotgitAlias(buf, start, end, alias: DotgitAliasName)`, exported from
    `src/domain/objects/tree-entry-bytes.ts`;
  - `encode` from `src/domain/objects/encoding.ts`;
  - `splitAtSlash` (already imported).
  - The domain → domain import is allowed by `.dependency-cruiser.cjs`.
    `verify-path.ts` already imports `../objects/encoding.js` and
    `../objects/file-mode.js`.
- **Shape:** `verifyPath`'s signature is unchanged. Replace
  `hasGitmodulesSymlinkComponent(components, mode, bytes)` with a check that receives the
  whole-path bytes (`pathBytes ?? encode(path)`, computed only for symlinks) plus the
  per-component strings and bytes.
  - Keep functions under 20 lines and nesting no deeper than 2.
  - Use named constants for `0x2f` and `0x5c`.
  - `ASCII_BACKSLASH` already exists at `:137`.
- **Comments:**
  - Rewrite `:239-248` to explain why git tests the rest of the whole path after every
    `/` and `\`.
  - Remove the false claim that `validateIndexPath` rejects backslashes.
  - Drop the `gi7eba~[1-9]` overclaim.
- **Unit tests:** `test/unit/domain/path/verify-path.test.ts`, gitmodules table
  (`:312` onward, under `describe("Given a name from git's pinned verify_path matrix")`).
  - Add every row of the matrix above with its git verdict, at `120000`.
  - Add a `100644` twin for each class A/B/C row, expecting `undefined` (this kills
    mode-guard mutants).
  - Existing rows stay valid: `gi7eba~1..9` and `GI7EBA~1` are refused; `gi7eba~0`,
    `gi7eba~10` and `abcdef~1` are admitted.
  - Add a byte-path row, `verifyPath(view, SYMLINK, bytes)` for `x\gitmod~1` (section
    `verifyPath on raw path bytes`, `:720`), so that both the `pathBytes` branch and the
    `encode` branch are covered.
- **Property tests:** `test/unit/domain/path/verify-path.properties.test.ts`. The
  matcher and composition lenses apply. Add:
  - "for any non-empty `/`-free prefix `p` and any NTFS `.gitmodules` alias `a` (generator over the
    three grammars plus a dot/space tail and an optional `:stream`), `verifyPath(p + '\\' + a,
    SYMLINK)` is `'gitmodules-not-regular'`";
  - "for any NTFS short alias `a` (not exactly `.gitmodules`, no `:`) and any suffix,
    `verifyPath(a + '/' + s, SYMLINK)` does not return `'gitmodules-not-regular'`" (this
    pins class B; `s` must itself be alias-free).
- **Mutation focus:**
  - the `SLASH`/`BACKSLASH` disjunction: `y/x\gitmod~1` and `x\gitmod~1` each need one
    disjunct alone (`gitmod~1` at offset 0 covers neither);
  - `opensComponent`: `\gitmod~1` and `x/\gitmod~1` stay admitted, and `\\gitmod~1` is
    refused, which kills the `at === 0` and `bytes[at - 1] === SLASH` mutants
    independently;
  - the `0` start offset;
  - the `at + 1` offset (`x\\gitmod~1` against `x\gitmod~1`).

### P2 — interop: pin the matrix through tsgit's write surfaces

- **New file:** `test/integration/gitmodules-symlink-alias-interop.test.ts`. Copy the
  `@proves` header and the `interop-helpers.js` imports (`GIT_AVAILABLE`, `runGit`,
  `tryRunGitWithExit`, `git`) from `git-parity-containment-interop.test.ts`.
- **Rows:** the matrix above, one `describe.each` over `{ path, gitRefuses }`.
- **Arm 1, `add`:** create an on-disk symlink named `path`, then compare `git add` exit
  status and `ls-files -s` with `repo.add({ paths })` throwing `INVALID_INDEX_ENTRY` and
  `readIndex`.
  - Only the leaf row of each `/`-path is created on disk.
  - Skip on `win32`: NTFS cannot hold `\` or `:` in a filename. Follow the precedent in
    the existing `win32` skips in `test/integration/*.test.ts`.
- **Arm 2, tree → index:** build a commit with `mktree` and `commit-tree` (see
  `buildFloatingCommit` in the containment interop). Compare `git reset -q <c>` (exit
  128 or 0) with tsgit `repo.reset` mixed on the same commit, which goes through
  `buildIndexFromTree` → `validateIndexPath` (`build-index-from-tree.ts:118`).
  Assert that refusal parity holds and that the index is unchanged on refusal.
- **Arm 3, parsed index:** see D4.

## Faithful divergences (documented, not fixed here)

- **Index read** — git reads an index holding a refused symlink path without error; tsgit
  refuses it at `parseIndex`. This is pre-existing posture (ADR-978); D4 decides whether
  the interop suite pins it.
- **Platform gating** — git gates HFS on `core.protectHFS` (default on only on macOS)
  and NTFS on `core.protectNTFS` (default on). tsgit applies both unconditionally, as
  ADR-978 records. The pinned rows here are NTFS rows, plus the ZWNJ-alias `/y`
  HFS row, which is refused on darwin.

## Decisions taken

- D1 → all three classes (ADR-1003). D2/D3 → import `matchesNtfsDotgitAlias`, `encode(path)` when no bytes (ADR-1003).
- D6 → **in scope**: `matchAliasComponent` skips the part before a component-leading `\` — i.e. it tests only parts after a backslash that is not the component's first byte (ADR-1004). P1 carries it; `isDotGitAlias` shares the fix, unobservable through `working-tree-path.ts`, which rejects `\` first.
- D4 → interop row asserting the parsed-index divergence (ADR-1005). D5 → new interop file (ADR-1005).

## Non-goals

  32.26, fsck's raw-byte `.git`.
- A tsgit `update-index` surface (none exists). The `--index-info` column is covered by
  the unit tests on `verifyPath` itself.

## Decision candidates

- **D1 — Scope: also fix classes B (over-refusal) and C (fall-back grammar), or only A?**
  (a) fold all three; (b) A only, and file B and C as new backlog items; (c) A and C, and
  file B separately.
  **Recommend (a):** one port of `is_ntfs_dot_generic` over the whole-path rest fixes all
  three at once. Splitting would mean writing a deliberately unfaithful intermediate. The
  faithfulness rule is to fold pinned gaps.
- **D2 — Where the NTFS matcher comes from.** (a) import `matchesNtfsDotgitAlias` from
  `domain/objects/tree-entry-bytes.ts` as it is; (b) move the alias matchers
  (`matchesNtfsDotgitAlias`, `foldsToHfsAlias`, …) into a shared
  `src/domain/path/dotgit-alias-bytes.ts` imported by both `verify-path.ts` and
  `tree-entry-bytes.ts`; (c) write a string port inside `verify-path.ts`.
  **Recommend (a):** domain → domain is allowed, `verify-path.ts` already imports
  `domain/objects`, ADR-763 asks for a single implementation, and a smaller diff. (b) is
  a cohesion refactor you can do later. (c) duplicates a byte grammar that ADR-763
  centralised.
- **D3 — Bytes when `pathBytes` is absent.** (a) `encode(path)`, only on the symlink
  branch; (b) a second, string-indexed (`charCodeAt`) variant of the matcher;
  (c) require every `validateIndexPath` caller to pass bytes (add, mv, archive,
  submodule-context).
  **Recommend (a):** encoding is provably exact for an ASCII-only grammar, it allocates
  only for symlinks, and it avoids both a second matcher and a caller sweep. (c) is the
  ADR-978 posture for the HFS arm, but this arm does not need it.
- **D4 — Parsed-index interop arm.** git *admits* reading such an index; tsgit refuses at
  `parseIndex`. (a) cover it with unit tests only (`index-parser` /
  `path-validator.test.ts`, refuse at parse), with no interop row; (b) add an interop row
  that asserts the divergence (git `ls-files` is 0; tsgit `readIndex` throws
  `INVALID_INDEX_ENTRY`) and cite ADR-978; (c) record a new ADR-scoped divergence item.
  **Recommend (b):** a pinned, named divergence is better than an unpinned one, and the
  existing ADR-978 posture already justifies it, so no new ADR is needed.
- **D5 — Interop file placement.** (a) a new `gitmodules-symlink-alias-interop.test.ts`;
  (b) extend the `.gitmodules` mode-arm block in `git-parity-containment-interop.test.ts`.
  **Recommend (a):** the matrix has about 40 rows and three arms. The containment file's
  block is a two-row clone/checkout fixture with a different setup cost.

- **D6 — The `.git` arm's component-leading `\` over-refusal (proven above).**
  (a) fix it here: `matchAliasComponent` skips the first part when the component opens
  with `\` (affects `verifyPath` and `isDotGitAlias` → `working-tree-path.ts`);
  (b) file it as a new backlog item (refusal mismatch, over-refusal) and leave it out of
  this branch; (c) fix only `verifyPath` and leave `isDotGitAlias` unchanged.
  **Recommend (b):** the brief bounds scope, and the `working-tree-path` caller needs its
  own pin (git's worktree walk, not `verify_path`). An over-refusal is the safe direction
  for a security check.

## Self-review (3 passes, converged)

- Pass 1 fixed a wrong assumption. The first idea, testing per-component bytes, would
  have kept class B, because a component's end is not the path's end. The design now
  passes `end = path end`.
- Pass 1 also checked that the `verify_dotfile` arm is needed. Without it,
  `.gitmodules/y` survives only through HFS's exact-match early return, which is false
  for plain ASCII.
- Pass 2 hunted edge rows and pinned them instead of reasoning about them:
  - trailing `x\` is admitted;
  - `x\/gitmod~1` and `x:\gitmod~1` are refused;
  - **`\gitmod~1` is admitted.** That disproved the first snippet, which retested after
    every `\`. It led to the component-start skip (`opensComponent`) and to the `.git`
    arm finding (D6).
- Pass 3 re-traced every matrix row through the final snippet: offsets 0, after `/`,
  and after a mid-component `\`, with `end = path end`; the dotfile arm; and the HFS
  arm on the component. Every row matches git.

## Closes

- **32.25** — the `.gitmodules` symlink alias behind a backslash part. Classes B and C
  are included subject to D1.

## Addendum — git for Windows' backslash refusal

### Why

Part 2 (`ntfsParts`, ADR-1004) admits `\.git\hooks\post-checkout`, `\.git\config` and
`x/\.git\hooks\…` at `100644`, as git does on POSIX. On Windows the node adapter resolves
`\` as a separator (`joinPath` → `path.win32.resolve`), so a checkout writes
`<worktree>\.git\hooks\post-checkout`. The fs containment wrapper allows it, because `.git`
is inside the worktree. Before Part 2 these paths were refused only by accident. The symlink
`\gitmod~1` / `\.gitmodules` rows (CVE-2018-11235 vector) have the same root cause and were
already admitted before this branch.

**User decision (binding):** keep Part 2 (POSIX-faithful) and add git for Windows' rule.
When the repository runs with Windows path syntax, the index-write boundary refuses any
path that holds `\`.

### Faithfulness anchor (git for Windows, source read)

git v2.55.0 `read-cache.c` `verify_path_internal`, Windows build:

```c
if (is_dir_sep(c)) {            /* is_dir_sep('\\') is true on Windows (compat/win32/path-utils.h) */
inside:
    ...
    if (protect_ntfs) {
#if defined GIT_WINDOWS_NATIVE || defined __CYGWIN__
        if (c == '\\') return PATH_INVALID;
#endif
    ...
    c = *path++;
    if ((c == '.' && !verify_dotfile(path, mode)) || is_dir_sep(c)) return PATH_INVALID;
```

Traced byte by byte:

- `\` mid-component: the bottom read yields `c == '\\'`, `is_dir_sep` sends it to `inside:`,
  and `c == '\\'` returns `PATH_INVALID`.
- `\` opening a component, or the whole path: the `inside:` block reads it as the first byte
  (`c = *path++`), and `is_dir_sep(c)` returns `PATH_INVALID`, whatever `protect_ntfs` says.
- So with `core.protectNTFS` on (the default), **every** `\` is refused, for every mode.
  tsgit applies the NTFS protections unconditionally (ADR-978), so the Windows rule is
  unconditional too. With `protectNTFS=false`, git for Windows admits a mid-component `\` as a
  separator; tsgit does not model that switch (the existing ADR-978 posture).

Where git runs `verify_path` (source read, v2.55.0):

| git operation | runs `verify_path`? | where |
|---|---|---|
| `add`, `mv`, `stash` restore, checkout / `reset` / `read-tree` / merge (unpack-trees, merge-ort) | yes | `add_index_entry_with_check` (`read-cache.c:1287`), `make_cache_entry` (`:854`) |
| `apply` | yes | `apply.c:4047-4049` |
| `write-tree` | no | `cache-tree.c` `verify_cache` checks unmerged entries and D/F only |
| reading the index (`ls-files`, `status`, `write-tree`) | no | `read_index_from` has no path check (pinned on POSIX above, same code) |
| `archive` | no | `archive.c` has no `verify_path` call |

**Not pinned empirically.** git for Windows cannot run on this darwin host. The matrix below
is derived from the source; the win-only interop arm (WP3) is its empirical pin, run by CI's
`win-integration` job on `windows-latest`. If that run disagrees with a row, the design is
reopened before merge.

| path | mode | git POSIX (pinned above) | git for Windows (source) | tsgit posix rules | tsgit windows rules |
|---|---|---|---|---|---|
| `\.git\hooks\post-checkout`, `\.git\config`, `x/\.git\hooks\y` | `100644` | admitted | refused | admitted | refused `backslash` |
| `x\y`, `a\b\c` | `100644` | admitted | refused | admitted | refused `backslash` |
| `\gitmod~1`, `\.gitmodules`, `x/\gitmod~1` | `120000` | admitted | refused | admitted | refused `backslash` |
| `x\gitmod~1` | `120000` | refused | refused | `gitmodules-not-regular` | `backslash` |
| `a/b`, `gitmod~1/y` | `100644` / `120000` | admitted | admitted | admitted | admitted |
| `.git/x` | `100644` | refused | refused | `dotgit-alias` | `dotgit-alias` |
| an index already holding `a\b`, read | — | read | read | read | read (parse stays posix, WD1) |

### Design

#### Domain: two rule sets, one switch

```ts
// src/domain/path/verify-path.ts
export type VerifyPathRejection = /* existing members */ | 'backslash';

const BACKSLASH = '\\';

/** git for Windows' `verify_path`: `\` is a directory separator there, and it refuses every one. */
export const verifyWindowsPath = (
  path: string,
  mode: FileMode,
  pathBytes?: Uint8Array,
): VerifyPathRejection | undefined =>
  path.includes(BACKSLASH) ? 'backslash' : verifyPath(path, mode, pathBytes);
```

```ts
// src/domain/git-index/path-validator.ts
type PathVerifier = typeof verifyPath;

export interface IndexPathRules {
  readonly validateIndexPath: (path: string, offset: number, mode: FileMode, pathBytes?: Uint8Array) => void;
  readonly validateTreePath: (path: FilePath, mode: FileMode) => void;
}

const indexPathRulesFor = (verify: PathVerifier): IndexPathRules => { /* today's two bodies, verify injected */ };

export const posixIndexPathRules = indexPathRulesFor(verifyPath);
export const windowsIndexPathRules = indexPathRulesFor(verifyWindowsPath);
export const { validateIndexPath, validateTreePath } = posixIndexPathRules;
```

```ts
// src/application/primitives/internal/index-path-rules.ts   (mirrors gitPathSyntaxOf)
export const indexPathRulesOf = (host: { readonly windowsPathSyntax?: boolean }): IndexPathRules =>
  host.windowsPathSyntax === true ? windowsIndexPathRules : posixIndexPathRules;
```

- No boolean parameter crosses a function: the flag is read once, in `indexPathRulesOf`,
  and every site receives a rules value (WD2).
- The domain stays pure: it exports two values and knows nothing of `Context`.
- The string test is exact for byte paths. `\` is ASCII, so a lossy view keeps it, and
  `U+FFFD` never equals it. `validateTreePath` tests the decoded view of an escaped
  `FilePath` (`indexPathOfEscaped`), which keeps `\` too.
- `VERIFY_PATH_REASON` (`path-validator.ts:38`) is a total `Record<VerifyPathRejection, string>`,
  so the compiler forces the new entry: `'backslash': 'backslash rejected under Windows path syntax'`.
  The reason does not echo the path, as the header requires.
- The header comment at `path-validator.ts:63-68` ("backslash … deliberately NOT rejected
  here") gets one more sentence: true for the posix rules; the windows rules refuse it, as
  git for Windows does.

Where the flag comes from: `Context.windowsPathSyntax` (`src/ports/context.ts:358`). It is set
by the node runtime (`src/index.node.ts:171`, `src/adapters/node/node-adapter.ts:155`, from
`nativePolicy.windowsSyntax`). `openRepository` drops it when the caller supplies its own `fs`
(`hostHooksFor`, `src/repository.ts:599`): a caller's fs reads `\` as a plain byte, so the
windows rules would be an over-refusal there. The flag means exactly "this fs resolves `\` as
a separator", which is the threat.

#### Call-site map

`rg -n "validateIndexPath\(|validateTreePath\(|verifyPath\(|isDotGitAlias\(" src` → 21 calls.

| site | mirrors (git) | git `verify_path`? | rules | how the rules arrive |
|---|---|---|---|---|
| `src/application/commands/add.ts:836` `renormalizeOne` | `add --renormalize` → `add_index_entry` | yes | windows | `ctx` destructured in scope |
| `src/application/commands/add.ts:1270` `stageFromStat` | `add` → `add_index_entry` | yes | windows | `ctx` param |
| `src/application/commands/mv.ts:343` `applyToIndex` | `rename_index_entry_at` → `add_index_entry` | yes | windows | new `rules: IndexPathRules` param; caller `mv` (`:137`) has `ctx` |
| `src/application/primitives/build-index-from-tree.ts:118` `projectLeaf` | `reset` / `read-tree` → unpack-trees | yes | windows | new param; `buildIndexFromTree(ctx, opts)` (`:128`) derives it, public signature unchanged |
| `src/application/primitives/apply-changeset.ts:319` `validateChangesetEntry` | checkout → unpack-trees | yes | windows | new param through `validateChangesetPaths` (`:322`); `applyChangesetInScope` (`:815`) has `ctx` |
| `src/application/commands/stash.ts:671` `restoreUntracked` | `read-tree` + `checkout-index` (`builtin/stash.c:508,519`) | yes | windows | `ctx` param |
| `src/application/primitives/internal/validate-merge-write-paths.ts:34,51,54,55` | merge-ort / unpack-trees | yes | windows | new `rules` param on `validateMergeWritePaths` (`:27`) and `validateConflictWritePaths` (`:48`); callers `merge.ts:1288`, `merge.ts:1661`, `apply-merge-to-worktree.ts:454` have `ctx` |
| `src/application/commands/merge.ts:1863` `outcomeWave`, `:1927` `writeOutcomeToTree`; plus the two `validateConflictWritePaths` calls at `:1879` `conflictWave` and `:1957` `writeConflictToTree` | re-checks behind the merge gate | — | WD3 | the two `validateConflictWritePaths` calls need a rules value once it takes one (`posixIndexPathRules` under WD3 (a)) |
| `src/application/primitives/apply-merge-to-worktree.ts:224` `removeChangedOutcome`, `:251` `removeDisplacedFile` | removals behind the merge gate | no (removal) | WD3 | `ctx` param |
| `src/application/primitives/internal/submodule-context.ts:74` `deriveSubmoduleContext` | none (tsgit-only; the path becomes the child's work directory) | — | windows | `ctx` param |
| `src/application/commands/archive.ts:164` `buildEntryStream` | `archive` | no | posix | unchanged (tar/zip member names; nothing written on the host) |
| `src/application/primitives/synthesize-tree-from-index.ts:90` `indexEntryCheck` | `write-tree` | no | posix | unchanged (must agree with parse, WD1) |
| `src/domain/git-index/index-parser.ts:128` (via `read-index.ts:147` `parseIndex`) | `read_index_from` | no | posix | unchanged (WD1) |
| `src/domain/git-index/path-validator.ts:107,115` | — | — | — | become the bodies of `indexPathRulesFor` |
| `src/domain/working-tree-path.ts:96` `isDotGitAlias` | — | — | — | unchanged; it rejects `\` before the call |

Count by category: 11 index-write calls take the windows rules (add 2, mv 1,
build-index-from-tree 1, apply-changeset 1, stash 1, validate-merge-write-paths 4,
submodule-context 1). 3 read-side or no-verify calls stay posix (index-parser,
synthesize-tree-from-index, archive). 4 merge re-checks and removals are decided by WD3.
3 are internals (path-validator ×2, working-tree-path).

Existing suppression affected: the `Stryker disable` at `apply-changeset.ts:317` argues that a
`delete`/`noop` entry already passed "this same validateIndexPath" at parse. Under the windows
rules that is false: a `delete` of `a\b` from a parsed index would newly throw if the guard
were mutated. The mutant becomes killable, so the comment goes and a kill test replaces it
(windows rules, a `delete` entry `a\b`, no throw). That keeps git's behaviour: removing an
entry does not verify its path.

#### Parsed index (WD1)

git for Windows reads an index holding `a\b` without complaint (`read_index_from` does not
verify paths). If tsgit refused every `\` at parse on Windows, it could not open a repository
whose index was written on Linux with a backslash filename. That is a new over-refusal git
does not have, and it stops every command, `status` included, not only writes. The ADR-978 /
ADR-1005 read posture refuses aliases at parse; it does not refuse POSIX-legal bytes. So parse
and `synthesizeTreeFromIndex` keep the posix rules. The windows rule applies only where a path
enters the index from a tree or the worktree, or is written to the worktree.

The exposure left is the same as git for Windows': an index that already holds `\.git\hooks\x`
(only another tool can write one) is read, and `checkout-index`-style writes from it are not
re-verified by git either.

#### Ordering

`verifyWindowsPath` tests `\` before every other rule, so `../a\b` reports `backslash`, not
`dotdot-segment`. git returns one `invalid path` for every rule, so the order is not
observable against git. It is observable in `INVALID_INDEX_ENTRY.data.reason` (WD4).

#### Bundle size

Estimate, gzip, Full library row: about 150-300 B. That covers the wrapper and reason string
(~60 B), the rules factory and two values (~80 B), `indexPathRulesOf` (~50 B), and about 10
threaded call sites. The previous domain-only change on this branch measured 242 B
(`38124a7f`). The Full library row has about 97 B of headroom, so it will fail. Other rows that
bundle `add.ts` or `path-validator.ts` (`Command (add)`, `Primitives`, the facades) may fail too.
Measure with `npx size-limit --json` on clean builds (`rm -rf dist .wireit` first). Raise only
the failing rows, to measured + ~100 B, with a row appended to
`docs/design/bundle-size-optimization.md` in the `38124a7f` format, as its own
`chore(size)` commit.

#### Public API

No exported type changes. `reports/api.json` names none of `VerifyPathRejection`,
`validateIndexPath` or `IndexPathRules`. It names `windowsPathSyntax` (unchanged) and
`applyChangeset`, `buildIndexFromTree`, `synthesizeTreeFromIndex`, `parseIndex`, `readIndex`,
whose signatures stay as they are: the rules are derived from the `ctx` they already take. No
regeneration is expected. Confirm with the pre-push `api.json` check.

### Parts

#### WP1 — domain: windows rules

- **Files:** `src/domain/path/verify-path.ts` (`VerifyPathRejection` `:6-15`, new
  `verifyWindowsPath` after `verifyPath` `:277`); `src/domain/git-index/path-validator.ts`
  (`VERIFY_PATH_REASON` `:38`, header `:63-68`, `validateIndexPath` `:97`, `validateTreePath`
  `:113`, new `IndexPathRules`, `indexPathRulesFor`, `posixIndexPathRules`,
  `windowsIndexPathRules`).
- **Unit tests:** `test/unit/domain/path/verify-path.test.ts`, a new
  `describe('Given the Windows rules')` table with the rows of the matrix above
  (`verifyWindowsPath`), each with its posix verdict alongside: `\.git\hooks\post-checkout`
  (`100644`), `x\y`, `\gitmod~1` (`120000`), `x\gitmod~1` (`120000` → `backslash`), `a/b`
  admitted, `.git/x` → `dotgit-alias`, `../a\b` → `backslash`.
  `test/unit/domain/git-index/path-validator.test.ts`: `windowsIndexPathRules.validateIndexPath`
  and `.validateTreePath` throw `INVALID_INDEX_ENTRY` with
  `reason: 'backslash rejected under Windows path syntax'` and the given offset /
  `NO_PARSER_OFFSET`; `posixIndexPathRules` admits the same paths. Assert `.data` with
  try/catch, not `toThrow(Class)`.
- **Property tests:** `test/unit/domain/path/verify-path.properties.test.ts`:
  "for any path holding `\` and any mode, `verifyWindowsPath` is `'backslash'`" and
  "for any `\`-free path and any mode, `verifyWindowsPath === verifyPath`" (composition lens).
- **Mutation focus:** the `includes` operand (the `x\y` row versus the `a/b` row), the
  `'backslash'` literal (asserted reason), and the factory's injected verifier (posix versus
  windows on the same `\.git\config` row).

#### WP2 — application: thread the rules

- **New:** `src/application/primitives/internal/index-path-rules.ts` (`indexPathRulesOf`),
  test `test/unit/application/primitives/internal/index-path-rules.test.ts` with three rows:
  `true` → windows, `false` → posix, absent → posix.
- **Sites:** the "windows" rows of the call-site map, plus WD3's choice.
- **Tests:** one twin per threaded site, beside the existing hostile-path refusal test in the
  same file. Context `{ ...ctx, windowsPathSyntax: true }` on the memory adapter (precedent:
  `test/unit/application/primitives/object-store.test.ts:949-951`). The memory fs treats `\`
  as a plain byte, so the refusal is the rule alone. Each test asserts the reason and that the
  index and worktree are untouched. Files:
  `test/unit/application/commands/add.test.ts`, `mv.test.ts`, `stash.test.ts`, `merge.test.ts`;
  `test/unit/application/primitives/build-index-from-tree.test.ts` (fixture
  `buildSeededContext`), `apply-changeset.test.ts` (plus the `delete` kill test above),
  `apply-merge-to-worktree.test.ts`, `internal/validate-merge-write-paths.test.ts`,
  `internal/submodule-context.test.ts`. Plus one posix-context control row per file where none
  exists: `x\y` admitted.

#### WP3 — interop: pin git for Windows on CI

- **New file:** `test/integration/win-only/backslash-path-windows-interop.test.ts`, which runs
  in the `win-integration` vitest project (`npm run test:win-integration`, CI job
  `win-integration` on `windows-latest`, which ships git for Windows). Same `@proves` header
  and `interop-helpers.js` imports as `gitmodules-symlink-alias-interop.test.ts`, the same
  scrubbed env, and a mktemp repo.
- **Rows:** build a commit with `git mktree` (it refuses only `/` in a name, so a `\` name is
  accepted) holding `\.git\hooks\post-checkout` (`100644`), `x\y` (`100644`), `\gitmod~1`
  (`120000`), and the control `a/b`. For each, compare `git reset -q <c>` (expected exit 128,
  `invalid path`) with tsgit `repo.reset` mixed through the node adapter, which has
  `windowsPathSyntax: true` on win32 (expected `INVALID_INDEX_ENTRY`, reason `backslash …`).
  Assert that `<worktree>\.git\hooks\post-checkout` does not exist after either.
- **Parsed-index row:** write `a\b` with `-c core.protectNTFS=false update-index --index-info`
  (with the switch off, git for Windows admits a mid-component `\`). Then git `ls-files` exits
  0 and tsgit `readIndex` succeeds (WD1).
- **Gate:** this is the only empirical proof of the Windows column. Run it on CI before
  integrate, and read its row output, not only the job status.

### Out of scope (proven by source read, not acted on)

- git for Windows also refuses a drive prefix (`has_dos_drive_prefix`, `read-cache.c:993`) and
  names `is_valid_win32_path` rejects (`compat/mingw.c:3403`: reserved device names, a
  trailing `.` or space, `<>:"|?*`). tsgit's `verifyPath` admits `c:x` (no rule at
  `verify-path.ts:282-290`). To prove the impact: a win-only test that checks out a tree
  holding `c:x`.

### Decision candidates (addendum)

- **WD1 — Does the windows rule apply when the index is parsed?** (a) No: parse and
  `synthesizeTreeFromIndex` keep the posix rules, and only index-write and worktree-write sites
  take the windows rules; (b) yes, refuse every `\` at parse on Windows; (c) parse admits, but
  `status` / `checkout-index`-style writes from a parsed entry re-check with the windows rules.
  **Recommend (a):** git for Windows reads such an index. (b) is a new over-refusal that blocks
  even `status` on a repository written on Linux. (c) adds checks git does not have, on read
  paths that are not part of the reported attack, which comes from trees.
- **WD2 — API shape.** (a) Domain strategy values `posixIndexPathRules` /
  `windowsIndexPathRules` (an `IndexPathRules` interface), chosen once by `indexPathRulesOf(ctx)`,
  which mirrors `gitPathSyntaxOf`; (b) an `indexPathRules` member on `GitPathSyntax`, so sites
  write `gitPathSyntaxOf(ctx).indexPathRules`; (c) a 4th positional `syntax: 'posix' | 'windows'`
  argument on `verifyPath` / `validateIndexPath`.
  **Recommend (a):** no boolean or tag parameter, the domain stays free of `Context`, and the
  existing `validateIndexPath` / `validateTreePath` names stay as the posix rules, so the three
  posix sites do not change. (b) mixes host-path parsing with index policy and adds a Demeter
  chain. (c) needs an `undefined` placeholder for `pathBytes` at four sites, and the tag is a
  primitive.
- **WD3 — The merge re-checks and removals behind the merge gate** (`merge.ts:1863,1927,1957`,
  `apply-merge-to-worktree.ts:224,251`). (a) Leave them on the posix rules: every path they see
  already passed `validateMergeWritePaths` with the windows rules (`merge.ts:1288,1661`,
  `apply-merge-to-worktree.ts:454`); (b) thread the windows rules into all of them, for
  uniform defence in depth (5 more parameters, more bytes); (c) like (a), but also exempt
  `resolved-deleted` outcomes from the windows rules in the gate, since git does not verify a
  removal.
  Under (a), `merge.ts:1879,1957` pass `posixIndexPathRules` to `validateConflictWritePaths`.
  **Recommend (a):** the gate already refuses the whole set before the first write, so (b)
  adds bytes for no new refusal. (c) would let a merge on Windows delete through a `\` path
  (`\.git\config` → `.git/config`), and tsgit already validates removals where git does not
  (the `REGULAR` stand-in). The planner must confirm that every `removeChangedOutcome` /
  `removeDisplacedFile` call follows a gate call; if one does not, that site takes the windows
  rules.
- **WD4 — Rejection precedence.** (a) `backslash` first, so `verifyWindowsPath` wraps
  `verifyPath`; (b) `\` tested per component inside `findComponentRejection`, in git's
  left-to-right order (`../a\b` → `dotdot-segment`); (c) `\` tested last, after the posix rules.
  **Recommend (a):** git's verdict is one `invalid path` for every rule, so the order is not
  git-observable. (a) is one scan and the smallest bundle, and it keeps `verifyPath` unchanged.
- **WD5 — The win-only interop arm.** (a) Add it (WP3) as the empirical pin, gated on CI;
  (b) unit tests only, citing the source read; (c) add it, but run it only when someone asks.
  **Recommend (a):** faithfulness rules forbid designing from a source read alone, and CI's
  `windows-latest` runner is the only git for Windows available. The cost is one file in an
  existing project.

### Self-review (addendum, 2 passes, converged)

- Pass 1 traced the component-leading `\` through git's Windows loop. It is refused by
  `is_dir_sep(c)` after the `inside:` read, not by the `c == '\\'` arm. So "every `\`" holds
  for `\gitmod~1` too, which Part 2 admits on POSIX.
- Pass 1 found that the `apply-changeset.ts:317` equivalence argument breaks under split rules,
  and added the kill test.
- Pass 2 checked that `windowsPathSyntax` is absent when the caller supplies its own fs
  (`hostHooksFor`), so a sandboxed fs on a Windows host keeps the posix rules. That is correct,
  because that fs does not split on `\`.
- Pass 2 checked byte-path exactness (`\` is ASCII, and the lossy view and the escaped view
  both keep it) and that no public signature changes.
