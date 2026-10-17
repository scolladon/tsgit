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
