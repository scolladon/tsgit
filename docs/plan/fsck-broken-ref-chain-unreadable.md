# Plan — fsck refs with a broken chain, an unreadable file or directory, and git's loose-ref grammar

> Source: design doc `docs/design/fsck-broken-ref-chain-unreadable.md` · ADRs 1121, 1122, 1123, 1124, 1125, 1126, 1127, 1128, 1129, 1130
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

<!-- cspell:ignore SRCH NOLF nodir UOUT ROOTORD GITFOO TABG SYMSP HEADTRAIL UPSPG UPNOLF SYMTABLF SYMSPNOLF SYMNOLF SYMNN SYMG SYMCRLF SPNOLF SPGNOLF RELUP OUTDOTS HEADNOLF GITDOTS rebuilders readdirs opendir scandir alphasort unsearchable backticked strerror ISBROKEN MAXSYMLINKS unstattable NOTDIR -->

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/ADV/property suites, docs/prose) with no `src/` delta ARE standalone — they
  have no implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.
- A part should land in ~100 tool calls. More than ~5 RED→GREEN cycles, or more than 6
  files in its `### Context` block, is two parts. What counts is a backticked path:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Run-wide facts every part needs

- Worktree root: the repository root of branch fix/fsck-broken-ref-chain-unreadable. All
  paths below are repo-relative. Line numbers are on dc75b1f8; re-grep before editing.
- Oracle: git 2.56.0. Interop rows compare tsgit against live git in the same test (never
  hard-coded git bytes). Permission and symlink rows run only where
  `process.platform !== 'win32' && process.getuid?.() !== 0` (precedent:
  test/integration/alternates-interop.test.ts L50–L53, constants `POSIX`, `UNPRIVILEGED`).
  Restore every mode (`chmod 0o755`/`0o644`) in a `finally` so the temp-dir cleanup can
  delete it.
- Interop roots: `realpathSync(await mkdtemp(path.join(os.tmpdir(), 'tsgit-…-')))`; git
  through `runGit` / `tryRunGitWithExit` / `runGitEnv()` from
  test/integration/interop-helpers.ts (L177, L430, L245); tsgit through
  `createNodeContext({ workDir })` (src/adapters/node/node-adapter.ts) and the command
  functions (`fsck` in src/application/commands/fsck.ts, `branchList`, `tagList`,
  `revList`, `resolveRef`, `maintenance(ctx, { tasks: ['gc'] })` in
  src/application/commands/maintenance.ts, `packRefs`).
- Lesson 022: every fixture that seeds one shape seeds it on the first AND the last name in
  byte order (`a` and `z`). Lesson 023 applies to the refs-verify death rows (see DC-4 and
  Part 14): Node's `fs.readdir` returns entries SORTED (libuv `scandir` + `strcmp`), while
  git's `readdir` returns the OS order — measured in this run on APFS: `ls -f` and
  `fs.opendirSync` give `z a m b y`, `fs.readdirSync` gives `a b m y z`. The memory
  adapter's `readdir` yields files (insertion order), then symlinks, then directories
  (src/adapters/memory/memory-file-system.ts L246–L270). Every unit death-pin names the
  order it relies on.
- Rebuilt git lines (interop only — the library emits no text, ADR-249):
  - pointer: `error: <ref>: invalid sha1 pointer <target>`
  - content: `<error|warning>: <ref>: <msgId>: <text>`; `info` and `warning` render
    `warning:`. Texts: `badRefContent: <seeded body with trailing SP/HT/CR/LF stripped>`
    (the test knows the bytes it seeded — ADR-1121 carries no content),
    `badReferentName: points to invalid refname '<referent>'`,
    `symrefTargetIsNotARef: points to non-ref target '<referent>'`,
    `trailingRefContent: has trailing garbage: '<trailing>'`,
    `trailingRefContent: has trailing whitespaces or newlines`,
    `refMissingNewline: misses LF at the end`. Control bytes other than LF render `?`
    (display transform done in the test, out of library scope). A `trailing` holding LF
    makes git's stderr span two lines: build the whole stderr text, then split both sides
    on `\n` the same way.
  - `error: cannot read ref file '<rel>': Permission denied` — `<rel>` =
    `path.relative(realpath(workDir), realpath(dirname(f.path)) + '/' + basename(f.path))`
    for a main-repo file, `realpath(f.path)` for a linked-worktree HEAD.
  - `warning: error opening directory '<rel>/': Permission denied` and
    `warning: failed to stat '<rel>': Permission denied` (ADR-1127, from
    `unreadable-ref-path`; `<rel>` as above — never `realpath` the unreadable leaf itself).
  - `fatal: Invalid path '<f.path>': <strerror>` / `fatal: More than 32 nested symlinks on
    path '<rel>'` (ADR-1128, from `refs-verify-ended`).
  - Compare: exit codes equal; content + walk lines as a sorted multiset; pointer lines in
    sequence (requirement 11).
- Part gate (manifest `gates.part`), placeholders resolved per part:
  `npx vitest run <touched-tests> && npm run check:types && ./node_modules/.bin/biome check <touched-files> && npm run check:spelling`.
  Phase gate: `npm run validate`.
- `REF_FAMILIES` (lesson 015 / ADR-1126 — every interop family whose command resolves or
  lists loose refs; vitest path filters, run as part of `<touched-tests>` where a part
  names it):
  `test/integration/fsck test/integration/alternates-gc-fsck test/integration/midx-fsck test/integration/rev-bitmap-fsck test/integration/loose-ref test/integration/ref-listing test/integration/packed-refs test/integration/pack-refs test/integration/symbolic-ref test/integration/head-symlink test/integration/ref-symlinked-directory test/integration/ref-transaction test/integration/ref-write-verification test/integration/symref-write-depth test/integration/branch- test/integration/tag- test/integration/rev-list-objects test/integration/log-interop test/integration/describe test/integration/name-rev test/integration/bundle test/integration/fetch-tracking-refs test/integration/push-tracking-refs test/integration/rebase-merges test/integration/reftable-ref-storage`
  `FSCK_FAMILIES` = `test/integration/fsck test/integration/alternates-gc-fsck test/integration/midx-fsck test/integration/rev-bitmap-fsck test/integration/ref-symlinked-directory test/integration/head-symlink`.
- Every RED is one test per function, run and seen failing for the stated reason before
  its GREEN. `sut` is the function under test, never its result. No ignore directives, no
  phase/ADR/backlog numbers in source or tests.

## Public-surface decisions

| Symbol | Part | Decision | Surface gates to pre-pay in-part |
|---|---|---|---|
| `readLooseBody`, `LooseBody` (src/domain/refs/loose-ref.ts) | 1 | internal (domain module export, not re-exported by the package entry; not added to src/domain/refs/index.ts — importers use the module path, as ref-store.ts does for packed-refs.ts) | none |
| `parseLooseRef(content, hexLength)` | 1 | internal (already internal) | none |
| `isRootRefName`, `isValidSymrefReferent`, `isOutsideRefsNamespace` (new src/domain/refs/symref-referent.ts) | 6 | internal | none |
| `RefIntegrityFinding` new arms (src/application/primitives/ref-store.ts) | 5–13 | internal (not in any public barrel — verified: no match in src/index*.ts, src/public-types.ts) | none |
| `FsckFinding` `bad-ref.referent?` | 10 | **public** | docs/use/commands/fsck.md type block (L33–L36) and finding table row `bad-ref` (L155); `reports/api.json` via `npm run docs:json` (prepush `check:doc-typedoc`); no exhaustive switch over `FsckFinding` exists in src (verified: the two `switch (f.type)` in test/integration have `default: return []`) |
| `FsckFinding` `bad-ref.trailing?` | 11 | **public** | same as above |
| `FsckFinding` arm `unreadable-ref-path` | 8 | **public** | same, plus a new finding-table row |
| `FsckFinding` arm `refs-verify-ended` | 13 | **public** | same, plus a new finding-table row and the exit table |
| `LayoutProbe.isSearchable?` (src/ports/layout-probe.ts) | 3 | internal (LayoutProbe is not in src/ports/index.ts) | none |
| realpath outcome core (src/application/primitives/internal/alternate-chain.ts) | 12 | internal | none |
| `FileSystem.readdirInOsOrder?` (src/ports/file-system.ts) | 14 | **public** (src/ports/index.ts L16 re-exports `FileSystem`; src/public-types.ts L90 `export type *`) | `reports/api.json`; the forwarding wrapper src/repository/wrap-fs-validator.ts; ADR per DC-4 (precedent ADR-884) |

## Requirement map

| Requirement | Part(s) |
|---|---|
| R1 chain pointer | 4 (listing difference, `targetOf`), 7, 8 (rows that need the walk not to throw) |
| R2 `badReferentName` / `symrefTargetIsNotARef` | 10 (loose body), 12 (symlinked ref) |
| R3 `cannotReadRef` on a loose ref file | 7 |
| R4 linked-worktree HEAD | 9 |
| R5 severity overrides / `--strict` | 4 (S1, S2), 10 (S3–S9), 11 (notices) |
| R6 `--no-references` / `--connectivity-only` | 4, 7, 8, 9, 10, 11, 12, 13 (each part's `-nr` / `co` rows) |
| R7 loose-body grammar | 1 (resolution), 10 (integrity check) |
| R8 `refMissingNewline`, `trailingRefContent` | 11 |
| R9 unreadable directory | 2 (listing skip), 8 (refs-pass findings) |
| R10 symlinked ref referent | 12 (realpath referent), 13 (refs-verify end), 14 (OS order) |
| R11 order | 5 (HEAD after `refs/`), 6 (every root ref after `refs/`), 14 (OS readdir order) |
| R12 reftable unchanged | GUARD in 5 (`reftable-ref-storage` family in gate) |
| F1 every root ref body-checked | 6 (+ 11 for its `refMissingNewline` line) |
| F2 loose path across an unreadable directory | 2 (rows, DC-1), 3 (`.git/refs` unsearchable — red twin, probed below) |

Design inconsistency resolved: the design's "Out of scope" still lists root refs other than
`HEAD` and resolution through an unreadable directory; §6 (F1, F2) and ADR-1126's
Consequences fold both. This plan follows ADR-1126.

Probe record (this planning run, git 2.56.0, throwaways under `mktemp -d`, scrubbed env):
- `.git/refs` mode 000 → `git rev-parse --git-dir` 128 `fatal: not a git repository`;
  tsgit `openRepository({ cwd })` opens, then `fsck` throws `PERMISSION_DENIED`
  (`…/.git/refs`) and `status` throws `PERMISSION_DENIED` (`…/refs/heads/main`). Twice,
  same result. **Red twin → joins F2 as Part 3.** Further shapes: `refs` 0400 → git 128,
  tsgit opens; `refs` 0300 and 0100 → git 0, tsgit opens; `objects` 000 → git 128, tsgit
  opens (DC-3). git's rule is `access(<dir>, X_OK)` on both shared dirs.
- `git gc --prune=now` with a commit reachable only from `refs/heads/d/x`: `d/` mode 000 →
  exit 0 and the commit is pruned (`cat-file -t` 128); `d/` mode 0400 → exit 128
  `fatal: bad object refs/heads/d/x`, commit kept (DC-2).
- `git refs verify` on a symlinked ref whose realpath fails also dies on `Not a directory`
  (link text `main/x`, `main` a file: `fatal: Invalid path '<RB>/…/refs/heads/main/x': Not a
  directory`, fsck exit 8) and on `Permission denied` (link to `<B>/d000/x`, `d000` mode
  000: `fatal: Invalid path '<RB>/d000/x': Permission denied`, fsck 8); a link to the
  mode-000 directory itself is `badReferentName '<RB>/d000'`, fsck 8 (DC-5).
- Node readdir order: see Run-wide facts (DC-4).

## Why shared files span parts

ref-store.ts, refs-verify.ts, types.ts, docs/use/commands/fsck.md and ref-store.test.ts recur
across parts on purpose: each part adds one git behaviour (one msg family or one walk fault)
with its own RED, public field and doc row, and requirement 5 binds each doc delta to the
part that changes the behaviour. Merging them would exceed the six-file and five-cycle
ceilings. The parts are strictly sequential on one working tree.

## Decision candidates

Every choice below is load-bearing and not pre-decided by ADRs 1121–1130. The parts are
written to the recommendation; the alternative's delta is stated so a different decision
re-scopes only the named part.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| DC-1 | What `resolveDirect` does when the leaf probe of a walked/resolved loose path fails `PERMISSION_DENIED` (a leading directory unsearchable: DIR, DIR-PK, DIR-SRCH, DIR-HEAD) — ADR-1126 says "reads it as missing, ignoring the packed value, as git does" | (a) return `MISSING` (design §6 text): `resolveRef` → `REF_NOT_FOUND` like git's `unknown revision`, but `revList({ all })` and `gc` then silently skip DIR-SRCH's listed `d/x` where git dies 128 `bad object` — two extra caller rules needed; (b) keep today's `PERMISSION_DENIED` refusal: every pinned row's refuse/succeed outcome already matches git (the packed value is never returned, `revList`/`gc` refuse on 0400, fsck maps it to the zero pointer per ADR-1123), F2's resolution rows land as GUARDs; (c) a broken-class refusal (a code in `UNREADABLE_REF_CODES`, outside `GC_TOLERATED_REF_CODES`), so `readRefCandidate` reports `broken` exactly as git's `REF_ISBROKEN` — widest blast radius (every `resolveRefOrMissing` caller) | **(b)** | Smallest change that matches git's refusal conditions on every pinned row; (a) regresses two git deaths; (c) widens resolution for every caller on an unpinned set |
| DC-2 | `gc`/`prune` after the listing skip: a commit reachable only from a ref under a mode-000 directory is pruned — git does exactly that (probe above), tsgit today refuses with `PERMISSION_DENIED` | (a) faithful: inherit the skip, pin GC-000 (pruned) and GC-0400 (refused) against git; (b) keep `collectRetentionRoots` refusing on an unreadable ref directory (safety divergence, needs an ADR); (c) leave gc unpinned | **(a)** | Prime directive (ADR-226); git's own outcome; 0400 keeps the refusal on both |
| DC-3 | How discovery refuses an unsearchable shared dir (git `is_git_directory`: `access(X_OK)` on `objects/` and `refs/`) — `LayoutProbe.stat` folds a denial into `undefined` by contract | (a) optional `LayoutProbe.isSearchable?(path)` (node probe: `fs.access(p, X_OK)`; memory/browser omit it → today's behaviour), checked on both `objects/` and `refs/`; (b) the same capability on `refs/` only (the caller's literal scope), `objects/` 000 reported as an IMPACT line; (c) no discovery change: F2's red twin recorded as a divergence ADR | **(a)** | Same git function, same refusal path, one call site (`sharedDirsValid` and the speculative twin); precedent: the optional `readLink?` / `isOwnedByCaller?` probe members |
| DC-4 | git's death-pin lost-line set depends on readdir order, and Node's `fs.readdir` sorts (measured) | (a) the Node adapter's `readdir` switches to OS order (`fs.opendir`) for every caller — widest blast radius, perf unmeasured on the status/checkout walks; (b) an optional `FileSystem.readdirInOsOrder?` used only by the integrity walk (Node: `opendir`; memory/browser omit it → `readdir`), forwarded by the validator wrapper, ADR in the style of ADR-884; (c) accept the sorted order and amend ADR-1128: the lost set is "after the dying link in byte order", L-DIE-lost and ROOTORD become divergence rows | **(b)** | Faithful exactly where order is observable (ADR-1128 Consequences), no hot-path change |
| DC-5 | `refs-verify-ended.reason` set — ADR-1128 names `FILE_NOT_FOUND` / `SYMLINK_LOOP`; git also dies on `Not a directory` and `Permission denied` (probe above) | (a) widen to `'FILE_NOT_FOUND' \| 'NOT_A_DIRECTORY' \| 'PERMISSION_DENIED' \| 'SYMLINK_LOOP'` (amend ADR-1128); (b) keep two reasons, map the other two to `FILE_NOT_FOUND`; (c) keep two reasons, let the other two faults propagate | **(a)** | Faithful fault surfaces; (b) loses data, (c) crashes fsck where git exits 8 |
| DC-6 | The realpath hop cap: git uses `MAXSYMLINKS` from the platform headers — 20 on glibc/musl, git's own 32 on macOS; tsgit's walk caps at 32 everywhere (alternate-chain.ts L14) and its alternates interop runs that row on darwin only | (a) cap = 20 on `process.platform === 'linux'`, 32 elsewhere, for both alternates and refs (the walk Part 12 edits); (b) keep 32, gate chain-length rows on darwin as alternates does; (c) make the cap a resolver parameter, refs pass 32 | **(a)** | Fold, don't file: Part 12 edits that walk; the Linux CI then pins it |

## Part 1 — Loose-body grammar in the domain, bound to every resolution

### Context
Delivers R7 for resolution (backlog 32.39, ADR-1125, ADR-1126 §3) and the domain shape the
integrity walk reuses in Parts 10–11.

Files:
- `src/domain/refs/loose-ref.ts` — today `parseLooseRef(content: string): LooseRef` (L18):
  strips `/[\r\n]+$/`, requires `'ref: '` (one space, const `SYMBOLIC_PREFIX` L16), hands
  the rest to `ObjectIdFactory.from` (src/domain/objects/object-id.ts L42, accepts lower
  hex of width 40 OR 64 — unchanged by this part). Add, exported from this module only:
  ```ts
  export type LooseBody =
    | { readonly kind: 'unparseable' }
    | { readonly kind: 'direct'; readonly id: ObjectId; readonly missingNewline: boolean;
        readonly trailing?: string }   // set only when the trailer is not exactly '\n'
    | { readonly kind: 'symbolic'; readonly referent: string; readonly missingNewline: boolean;
        readonly trailingWhitespace: boolean };   // raw referent, not validated
  export function readLooseBody(content: string, hexLength: 40 | 64): LooseBody
  ```
  Rules (named constants for the whitespace class `' \t\r\n'` and `'ref:'`):
  symref when the content starts with `ref:` — strip trailing SP/HT/CR/LF, drop `ref:` and
  the following run of SP/HT/CR/LF, the rest is `referent` (may be `''`);
  `missingNewline` = last byte of the raw content is not LF; `trailingWhitespace` = more
  than one byte stripped at the end. Otherwise direct when
  `content.slice(0, hexLength)` is `hexLength` chars of `[0-9a-fA-F]` and
  `content[hexLength]` is `undefined` or one of SP/HT/CR/LF; `id =
  ObjectIdFactory.from(hex.toLowerCase())`; trailer = `content.slice(hexLength)`;
  `missingNewline` = trailer `''`; `trailing` = trailer unless it is `''` or exactly `'\n'`.
  Anything else (empty content included) → `unparseable`.
  `parseLooseRef(content: string, hexLength: 40 | 64): LooseRef` is rebuilt on it:
  `unparseable` → `invalidRef('empty ref content')` when content is `''`, else the
  `ObjectIdFactory.from` refusal it throws today (`INVALID_OBJECT_ID`) — keep today's codes:
  check loose-ref.test.ts for the asserted ones before choosing; symbolic with `''` →
  `invalidRef('empty symbolic ref target')`; symbolic → `validateRefName(referent)`
  (src/domain/refs/ref-validation.ts L27); direct → `{ type: 'direct', target: id }`.
- `src/application/primitives/ref-store.ts` — module-level `fromLooseContent` (L558),
  `fromNamedContent` (L584), `fromFollowedContent` (L596) gain a `hexLength: 40 | 64`
  parameter; call sites pass `ctx.hashConfig.hexLength`: `resolveHeadDirect` (L779),
  `resolveFollowed` (L810), `resolveDirect` (L938). `LOOSE_OID_RE` (L550) and the local
  `SYMBOLIC_PREFIX` (L548) stay until Part 10 (they serve `looseBodyFinding`).
  src/application/primitives/internal/ref-write-chain.ts only mentions `parseLooseRef` in a
  comment (L61) and re-reads through the store: no edit.
- `test/unit/domain/refs/loose-ref.test.ts` — extend with every grammar row below.
- `test/unit/domain/refs/loose-ref.properties.test.ts` — NEW. Arbitraries: reuse
  test/unit/domain/refs/arbitraries.ts. Lenses: round-trip (`serializeDirectRef` /
  `serializeSymbolicRef` → `readLooseBody` returns the id / referent, `missingNewline`
  false, no `trailing`, `trailingWhitespace` false); symref whitespace insensitivity (any
  SP/HT/CR/LF run after `ref:` and at the end gives the same referent); direct case
  insensitivity (any case mix gives the lower-case id); trailer lens (oid + a trailer
  starting with SP/HT/CR/LF keeps the id, `trailing` equals the trailer unless it is
  exactly `\n`; a trailer starting with any other byte is `unparseable`); newline lens
  (`missingNewline` iff the last byte is not LF, both arms). `numRuns` per
  .claude/workflow/property-testing.md.
- `test/integration/loose-ref-interop.test.ts` — append a `describe` comparing
  `git rev-parse --verify -q refs/heads/<r>` (and `--symbolic-full-name` for R rows) with
  `resolveRef(ctx, name, { peel: false })` / a refusal. Rows (design §1): UP, MIX, UPSPG,
  GARB, SPG, TABG, SP2, SPN, CRLF, NN, TWO, H39, H41, W64, VT, NOLF, UPNOLF, SPGNOLF, EMPTY,
  SYMNOLF, SYMSP, SYMCRLF, SYMNN, SYMSPNOLF, SYMG, R1–R6, V1, V3, HEADTRAIL
  (`rev-parse HEAD`). Seed each body on `a` and `z`.

Read-only: src/domain/refs/ref-types.ts (`LooseRef`), src/domain/objects/hash-config.ts
(`hexLength: 40 | 64`). W64: in a SHA-256 repo a 40-hex body is the mirror case — unit only.

### TDD steps
1. RED `readLooseBody` — "Given `<SHA>\n` upper case, When read with hexLength 40, Then direct
   with the lower-case id": fails, `readLooseBody` is not exported (TS2305 at the import).
   GREEN: the direct arm.
2. RED `readLooseBody` — one `it` per class, each failing against step 1's code because the
   symref arm / trailer / newline fields do not exist yet: `<sha> garbage\n` trailer;
   `<sha>\n\n`; `<sha>` (missingNewline); `<sha>garbage`, 39/41 hex, 64 hex at 40, `\v` →
   unparseable; `ref:refs/heads/main\n`, `ref:\trefs/heads/main\n`,
   `ref: refs/heads/main \n` (trailingWhitespace), `ref: refs/heads/main` (missingNewline),
   `ref: ` (referent `''`), `ref: refs/heads/main\nextra\n` (referent keeps the inner LF),
   `ref:\vrefs/heads/main\n` (referent starts with `\v`). GREEN: symref arm, trailer fields.
3. RED `parseLooseRef` — `(content, 40)` on `ref:refs/heads/main\n` returns symbolic: fails,
   today's parser requires `ref: ` and throws. And `<SHA>\n` returns the lower id: fails
   with `INVALID_OBJECT_ID`. And 64 hex at 40 throws: today it returns a 64-char id. GREEN:
   rebuild on `readLooseBody`; update ref-store.ts call sites (type-checker lists them).
4. RED interop rows (one `it` per row) in loose-ref-interop: UP, R1, SPG, W64, HEADTRAIL fail
   today (`INVALID_REF` / `INVALID_OBJECT_ID` / W64 resolves); the rows GARB, H39, H41, EMPTY,
   VT, V1, V3, SYMG, R6 are GUARD (both refuse today — proven by running each row before
   step 3's GREEN; any that is red there is a RED and is fixed here). GREEN: already
   delivered by step 3; fix any row the run shows red.
5. Property suite `loose-ref.properties.test.ts`: GUARD (properties hold on step 2's code —
   written after GREEN because properties are additive; any counterexample is a bug fixed in
   this part).
REFACTOR: one whitespace predicate shared by both arms; functions < 20 lines.

### Gate
`npx vitest run test/unit/domain/refs/loose-ref.test.ts test/unit/domain/refs/loose-ref.properties.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/ref-store-symlinked-refs.test.ts <REF_FAMILIES> && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/loose-ref.ts src/application/primitives/ref-store.ts test/unit/domain/refs/loose-ref.test.ts test/unit/domain/refs/loose-ref.properties.test.ts test/integration/loose-ref-interop.test.ts && npm run check:spelling`
(`<REF_FAMILIES>` expanded from Run-wide facts — `parseLooseRef`, `fromLooseContent` and
`resolveDirect` are on every resolution path.)

### Commit
`fix(refs): read loose ref bodies with git's symref whitespace and direct-oid grammar`

## Part 2 — The shared loose-ref walk skips an unreadable directory

### Context
Delivers R9's listing half (ADR-1126 §1, prerequisite of ADR-1123), DC-1 (b) and DC-2 (a).

- `src/application/primitives/ref-store.ts` — `walkRefDir(dir: string, prefix: string):
  Promise<ReadonlyArray<RefName>>` (L969, inside `createFilesRefStore`): wrap
  `ctx.fs.readdir(dir)`; a `PERMISSION_DENIED` (`errorCodeOf(err) === 'PERMISSION_DENIED'`,
  helper L355) returns `[]`; anything else rethrows. Named constant for the code. It
  reaches `walkRefsRoot` (L1038; a root refs/heads that is itself unreadable: DIR-HEADS),
  `walkAllLooseRefNames` (L1067) → `collectCandidateNames` (L1087) / `listRefs` (L1128) /
  `listRefNames` (L1142) / `packableEntries` (L1986, `packRefs` L2094); a symlinked
  directory goes through `followedEntryKind` (L957) → `walkRefDir` (DIR-LINK). Do NOT touch
  `walkLinkedRefNames` (L1149, rewritten in Part 5) or `walkReflogDir` (L1389). Update the
  `listRefs` / `listRefNames` JSDoc on `RefStore` (L105–L132) to state the skip.
- `test/unit/application/primitives/ref-store.test.ts` — in the `listRefs` / `listRefNames`
  area, `vi.spyOn(ctx.fs, 'readdir')` throwing `permissionDenied(path)`
  (src/domain/error.ts L155) for one directory: first name (refs/heads/a/), last
  (refs/heads/z/), nested (refs/heads/d/e/), the root refs/heads, a directory reached
  through a symlink; plus an isolated test that `fileNotFound`-free `new Error('EIO')`
  propagates (assert identity with `rejects.toBe(fault)`).
- `test/integration/ref-listing-interop.test.ts` — append rows (all POSIX non-root):
  DIR (`for-each-ref` ↔ `listRefs`, `branch -a` ↔ `branchList`, `show-ref` ↔ `listRefs`,
  `rev-list --all --count` ↔ `revList({ all: true, count: true })`), DIR-PR
  (`pack-refs --all` ↔ `packRefs`, compare `packed-refs` bytes), DIR-AZ, DIR-N, DIR-T,
  DIR-ONLY, DIR-HEADS, DIR-PK (`for-each-ref` shows packed d/x), DIR-SRCH (listings +
  `rev-list --all` 128 ↔ `revList` refusal), DIR-300, DIR-LINK (`for-each-ref` only), and
  the F2 resolution rows: `rev-parse refs/heads/d/x` 128 ↔ `resolveRef` refusal under
  DIR (000) and DIR-PK, `rev-parse HEAD` 128 ↔ refusal under DIR-HEAD. GC rows (DC-2):
  GC-000 — a commit made with `git commit-tree` (no ref, no reflog), named only by
  refs/heads/d/x written with `git -c core.logAllRefUpdates=false update-ref`, d/ mode
  000: `git gc --prune=now` exit 0 and `cat-file -t` 128 ↔ tsgit `gc` with prune-now
  (configured as below)
  resolves and the object is gone; GC-0400 — same at 0400: git 128, object kept ↔ tsgit
  does not complete gc (`tasksFailed` holds `gc`, or the call rejects — assert whichever
  the base yields, then keep it) and the object is kept. Prune-now: set `gc.pruneExpire
  now` in both repos and run plain `git gc` / `maintenance(ctx, { tasks: ['gc'] })`
  (precedent test/integration/alternates-gc-fsck-interop.test.ts L235, L401). Two fresh
  repos per row (one per tool).

Read-only: src/application/primitives/enumerate-refs.ts L17 (`enumerateRefs` →
`listRefNames`), src/application/commands/internal/fsck/roots.ts `addRefRoots` L134 /
`resolveTip` (strict rethrow of non-`isTolerableRefFault`), src/application/commands/rev-list.ts
`readAllRefTip` (L113).

Known trap: git's gc also runs `reflog expire`; seeding d/x without a reflog keeps that step
off the unreadable path. If tsgit's gc refuses GC-000 for a reason outside the walk (a reflog
or lock step), stop with the blocker protocol `{ unit: Part 2, reason, options }`.

### TDD steps
1. RED `listRefNames` — "Given `refs/heads/a/` unreadable, When listing names, Then `a/x` is
   absent and the rest listed": fails, `readdir` rethrows `PERMISSION_DENIED`.
2. RED `listRefs` — DIR-PK in unit form (packed `refs/heads/d/x`, loose `d/` unreadable
   holding `d/y`): returns packed `d/x` and not `d/y`: fails, `listRefs` throws.
   GREEN (both): the skip in `walkRefDir`.
3. GUARD `listRefNames` — last, nested, root `refs/heads`, under a link: pass after the
   GREEN (the same `walkRefDir` serves every depth; the link case goes through
   `followedEntryKind` → `walkRefDir`). Proof: run them right after the GREEN.
4. GUARD — `new Error('EIO')` propagates: passes (only the permission code is folded).
   Isolated test, kills the "fold everything" mutant.
5. RED interop DIR, DIR-AZ, DIR-N, DIR-T, DIR-ONLY, DIR-HEADS, DIR-PK, DIR-300, DIR-LINK,
   DIR-PR, GC-000: each throws `PERMISSION_DENIED` on the base (design §1 twin column) —
   write them with steps 1–2, before the GREEN; they go green with it. GUARD DIR-SRCH (listings drop
   `d/x` through `resolveEntry`, `revList` refuses — design twin run), the F2 resolution
   rows and GC-0400 (resolution keeps refusing `PERMISSION_DENIED`, DC-1 (b); proof: each
   row run before step 1).
REFACTOR: none expected.

### Gate
`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/enumerate-refs.test.ts test/unit/application/commands/branch.test.ts test/unit/application/commands/rev-list.test.ts test/unit/application/commands/tag.test.ts <REF_FAMILIES> && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts test/unit/application/primitives/ref-store.test.ts test/integration/ref-listing-interop.test.ts && npm run check:spelling`

### Commit
`fix(refs): skip an unreadable loose-ref directory in every listing as git does`

## Part 3 — Discovery refuses a repository whose shared dirs are not searchable

### Context
The F2 red twin probed in this run (Probe record), DC-3 (a).

- `src/ports/layout-probe.ts` — `LayoutProbe` (L8) gains, after `isOwnedByCaller?` (L47):
  `readonly isSearchable?: (path: string) => Promise<boolean>;` JSDoc: git's
  `access(path, X_OK)`; optional, an adapter without it is treated as searchable.
- `src/repository/find-layout.ts` — `sharedDirsValid(probe, commonDir, pathPolicy)`
  (L603–L612) and the speculative twin (L476–L480, `isSharedDirectory(await
  settleSpeculation(source.probes.objects/refs))`): after `isSharedDirectory(stat)` holds,
  `(await probe.isSearchable?.(dir)) !== false` must also hold, for `objects` and `refs`.
  Keep the speculation shape (fire `isSearchable` only once the stat says directory).
  `notARepository` (src/domain/repository/error.ts) is the refusal the walk already raises
  (L230).
- `src/index.node.ts` — `createNodeLayoutProbe(syncIo)` object (L295–L315): add
  `isSearchable` — sync path `fs.accessSync(p, fs.constants.X_OK)` under the existing
  `syncIo` helpers, async `fs.promises.access`; `EACCES` → `false`, `ENOENT`/`ENOTDIR` →
  `false`, any other errno rethrows. Follow the neighbouring `readLink` / `isOwnedByCaller`
  members' style.
- `test/unit/repository/find-layout.test.ts` — fake probes there; add
  `isSearchable` to a probe and test: `refs` unsearchable → refuses `NOT_A_REPOSITORY`;
  `objects` unsearchable → refuses; probe without `isSearchable` → opens (GUARD of today).
- `test/integration/discovery-unsearchable-shared-dir-interop.test.ts` — NEW (POSIX non-root):
  rows REFS-000, REFS-0400 (git 128 ↔ `openRepository({ cwd })` refuses
  `NOT_A_REPOSITORY`), REFS-0300, REFS-0100 (git 0 ↔ opens), OBJ-000 (128 ↔ refuses).

Read-only: src/repository/file-system-layout-probe.ts (memory/browser probe — no
`isSearchable`, unchanged), test/integration/linked-worktree-discovery-interop.test.ts (style).

### TDD steps
1. RED `findLayout` (the exported discovery entry in find-layout.ts) — refs unsearchable via
   a fake `isSearchable` → refuses: fails, today it opens. GREEN: the check in
   `sharedDirsValid` and its speculative twin.
2. RED — objects unsearchable → refuses: isolated test (kills a refs-only mutant); fails
   until the objects branch exists.
3. GUARD — probe without `isSearchable` opens: passes (optional member, `!== false`).
4. RED interop REFS-000, REFS-0400, OBJ-000: tsgit opens today (probe record). GREEN: the
   node probe's `isSearchable`. GUARD REFS-0300, REFS-0100 (both open today, probe record).
REFACTOR: one `isUsableSharedDir(probe, dir)` used by both call sites.

### Gate
`npx vitest run test/unit/repository/find-layout.test.ts test/unit/repository/resolve-layout.test.ts test/unit/repository/repository.test.ts test/integration/discovery-unsearchable-shared-dir-interop.test.ts test/integration/linked-worktree-discovery-interop.test.ts test/integration/bare-repo-custom-gitdir-interop.test.ts test/integration/repository-format-acceptance-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/layout-probe.ts src/repository/find-layout.ts src/index.node.ts test/unit/repository/find-layout.test.ts test/integration/discovery-unsearchable-shared-dir-interop.test.ts && npm run check:spelling`

### Commit
`fix(repository): refuse a gitdir whose objects or refs directory is not searchable as git does`

## Part 4 — fsck reports a zero pointer on every ref of a broken chain

### Context
Delivers R1 (ADR-1121 pointers, ADR-1123) and ADR-1122's re-pin of the fault test.

- `src/application/commands/internal/fsck/refs-verify.ts`:
  - `runRefsVerifyPass` (L226): `Promise.all` gains `refStore.listRefNames()`.
  - `snapshotTargets(ctx, entries)` (L161) → also takes `names: ReadonlyArray<RefName>`:
    every name not `HEAD` (`HEAD` const L126) — from `entries` its `targetOf`, absent from
    `entries` → `{ ref, id: zeroOid(ctx.hashConfig) }`; merged in byte order (both inputs
    are sorted; merge, don't re-sort); then worktree HEADs as today.
  - `targetOf` (L142) returns `ObjectId`: a named fsck-local set `ZERO_POINTER_CODES` =
    `UNREADABLE_REF_CODES` (src/application/primitives/resolve-ref.ts L28) + `REF_NOT_FOUND`
    + `PERMISSION_DENIED` → zero oid; every other code rethrows. `BROKEN_SYMREF_CODES`
    (L133) and the `isTolerableRefFault` import (L12) go.
  - `collectBadContentNotices` (L97): drop the synthesised `badRefOid` push and its
    `EXIT_MISSING` (L113–L120); it now emits the content notice only. Rewrite both doc
    comments (L84–L96, L207–L225) to the new model.
- `test/unit/application/commands/fsck-symbolic-ref-fault.test.ts` — re-pin (ADR-1122):
  the `PERMISSION_DENIED` row now yields `{ type: 'bad-ref', ref:
  'refs/remotes/origin/HEAD', msgId: 'badRefOid', severity: 'error', target: zeroOid }`
  and no `cannotReadRef` (the file is readable; the fault is synthetic), assert
  `exitCode & EXIT_MISSING`; add a row where the mock rejects `new Error('EIO: i/o error')`
  and the run rejects with that error (`rejects.toBe(fault)`), mirroring
  test/unit/application/commands/fsck-worktree-heads.test.ts L276.
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — NEW, memory adapter
  (`createMemoryContext`), `fsck` as `sut`: chain of two (`a`→`b` garbage) → pointers a and
  b; chain of three → three pointers; `a`→`b`=`ref: x..y` → pointers a and b (content line
  arrives in Part 10); packed shadow; pointer order by name with `z`→`b`. This file is
  shared by Parts 5–11 for store-level (`createRefStore(ctx).verifyIntegrity()`, precedent
  test/unit/application/commands/fsck-symlinked-ref.test.ts L89) and fsck-level tests.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — NEW, `describe.each` per
  matrix group; the line rebuilders of Run-wide facts live in this file (local helpers;
  test/integration/fsck-line-helpers.ts stays as is). Rows: A-garbage, A-abc, A-empty, CH3,
  ORDER, HT, HC, PK-ok, PK-abs, C-dangling, S1, S2, N and co (garbage shape). Runs on every
  platform (no permission/symlink in these rows).

Read-only: src/application/primitives/ref-store.ts `listRefs` (L1128 — a loose name never
falls back to its packed value: U-shadow by construction), `resolveEntry` (L1105).

### TDD steps
1. RED fsck — "Given `a`→`b`, `b` garbage, When fsck runs, Then badRefOid zero for a and b":
   fails, `a` gets no pointer (`INVALID_REF` maps to `undefined` in `targetOf`). GREEN:
   `targetOf` zero set.
2. RED fsck — "Given a 64-hex body in a SHA-1 repository, Then a zero pointer for it": fails,
   `listRefs` drops it (Part 1 grammar) and `LOOSE_OID_RE` accepts 64 hex, so no
   synthesised pointer either. GREEN: listing difference in `snapshotTargets`.
3. RED fsck — "Given `b` garbage alone, Then exactly one pointer for b": fails after step 2
   with two (snapshot + synthesised). GREEN: drop the synthesised push.
4. RED fsck — chain of three plus `z`→`b`: pointers `a, b, c, z` in that order — write with
   step 1's RED (fails: no `a`/`b`/`z` pointer); green after step 3.
5. RED `fsck-symbolic-ref-fault.test.ts` re-pin — write before step 1's GREEN (today the
   fault propagates); green with step 1 (`PERMISSION_DENIED` in the zero set). The `EIO`
   row is a GUARD (propagates today and after — proves "everything else rethrows").
6. RED interop A-garbage, A-abc, A-empty, CH3, ORDER, HC (missing `a`/`main`/`z` pointer
   today, design twin column); GUARD HT, PK-ok, PK-abs, C-dangling (match today), S1, S2,
   N, co — run before GREEN to confirm.
REFACTOR: `targetOf` < 20 lines; no `undefined` return path left.

### Gate
`npx vitest run test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck-symbolic-ref-fault.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck-symlinked-ref.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/refs-verify.ts test/unit/application/commands/fsck-symbolic-ref-fault.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): report a zero pointer on every ref whose chain fails to resolve`

## Part 5 — One no-follow integrity walk: links are never read through, HEAD after refs/

### Context
Structural prerequisite of Parts 6–8 and 12–14; ships git's walk semantics (R11 order,
design §2 model): `verifyIntegrity` walks refs/** once with the dirent types, never
descends or reads through a link, and checks `HEAD` after the walk (ROOTORD2).

- `src/application/primitives/ref-store.ts`:
  - `RefIntegrityFinding` (L229): the `badRefContent` arm loses `throughSymlink` →
    `{ readonly ref: RefName; readonly msgId: 'badRefContent' }`. Every arm keeps a `msgId`
    (later internal arms use internal discriminators `'unreadableRefPath'` /
    `'refsVerifyEnded'`), so collectors' `finding.msgId === …` filters compile.
  - Delete `walkLinkedRefNames` (L1149), `linkedRefNames` (L1164), `readThroughLink`
    (L1196). New `walkIntegrity(dir: string, prefix: string, findings:
    RefIntegrityFinding[]): Promise<void>` — per `ctx.fs.readdir(dir)` entry in order:
    symlink → `{ ref, msgId: 'symlinkRef' }`; directory → recurse; otherwise
    `looseBodyFinding(name)` (L1180, `throughSymlink` parameter removed). `verifyIntegrity`
    (L1199): for each `refsWalkRoots()` (L1019) root that `isDirectoryPath` (L1474), walk it
    with prefix `REFS_DIR`; then `HEAD` when `ctx.fs.exists(<gitDir>/HEAD)` (as
    `headCandidate` L1011 does). Keep the `badRefOid` loose-object probe as is.
  - Update the `verifyIntegrity` JSDoc on `RefStore` (L134–L147).
- `src/application/commands/internal/fsck/refs-verify.ts` — `collectBadContentNotices`
  (L97): drop `!finding.throughSymlink` (L109).
- `test/unit/application/primitives/ref-store.test.ts` — the `verifyIntegrity` block
  (L2657–L2770): drop `throughSymlink` from every expectation; the read-through rows
  (L2678–L2726) now expect `symlinkRef` and no `badRefContent` for names at or under a link.
- `test/unit/application/commands/fsck-symlinked-ref.test.ts` — re-run; update any
  expectation that relied on a read-through body finding (L89–L159 call `verifyIntegrity`).
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — new tests below.

Read-only: src/application/primitives/reftable-ref-store.ts `verifyIntegrity` (L267,
unchanged — R12).

### TDD steps
1. RED `verifyIntegrity` — "Given HEAD garbage and `refs/heads/a` garbage, Then `a`'s finding
   precedes HEAD's": fails, today HEAD is first (`walkAllLooseRefNames` lists it first).
2. RED `verifyIntegrity` — "Given `refs/heads/dl` a link to a directory holding a garbage
   ref, Then only `symlinkRef` for `dl`": fails, today a `badRefContent` with
   `throughSymlink: true` appears.
   GREEN (both): `walkIntegrity` (never descends or reads a link) + HEAD last.
3. GUARD fsck — a link onto a garbage ref still gets its zero pointer under the link's name:
   passes through Part 4's listing difference (proof: run it before deleting
   `readThroughLink`).
4. GUARD — existing ref-store / fsck-symlinked-ref expectations, edited for the removed
   field, pass.
REFACTOR: `verifyIntegrity` and `walkIntegrity` each < 20 lines.

### Gate
`npx vitest run test/unit/application/primitives/ref-store.test.ts test/unit/application/primitives/reftable-ref-store.test.ts test/unit/application/commands/fsck-symlinked-ref.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck.test.ts <FSCK_FAMILIES> test/integration/reftable-ref-storage test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/commands/internal/fsck/refs-verify.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-symlinked-ref.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts && npm run check:spelling`

### Commit
`refactor(refs): walk refs once without following links and check HEAD after refs/`

## Part 6 — Every root ref is body-checked, in the gitdir's readdir order

### Context
F1 (ADR-1126 Consequences). Also creates the domain ref-name classes Parts 10 and 12 use.

- `src/domain/refs/symref-referent.ts` — NEW, pure:
  ```ts
  export const isRootRefName = (name: string): boolean      // [A-Z_-]+ AND (=== 'HEAD' OR endsWith('_HEAD') OR one of the five irregular) AND not FETCH_HEAD/MERGE_HEAD
  export const isValidSymrefReferent = (referent: string): boolean  // isRootRefName(r) || (r.includes('/') && isSafeRefName(r))
  export const isOutsideRefsNamespace = (referent: string): boolean // !isRootRefName(r) && !r.startsWith('refs/')
  ```
  Named constants: `IRREGULAR_ROOT_REFS = ['AUTO_MERGE', 'BISECT_EXPECTED_REV',
  'MERGE_AUTOSTASH', 'NOTES_MERGE_PARTIAL', 'NOTES_MERGE_REF']`; pseudorefs from
  src/domain/refs/state-files.ts (`FETCH_HEAD`, `MERGE_HEAD`, already imported by
  src/domain/refs/per-worktree-ref.ts L2). `isSafeRefName`: src/domain/refs/ref-validation.ts
  L67. `isValidSymrefReferent` / `isOutsideRefsNamespace` are first consumed in Part 10
  (planned; knip runs at the phase gate only).
- `test/unit/domain/refs/symref-referent.test.ts` — NEW: design "Referent grammar" table
  (every cell except `head`), one `it` per class, plus `isRootRefName` on `ORIG_HEAD`,
  `BAR_HEAD`, `_HEAD`, `FO-O_HEAD`, `FOO1_HEAD` (false), `Foo_HEAD` (false), `FETCH_HEAD`
  (false), `HEAD`, the five irregular names, `refs` (false), `''` (false).
- `test/unit/domain/refs/symref-referent.properties.test.ts` — NEW: every `refs/<a>/<b>` of
  safe components is valid; every `[A-Z_-]+_HEAD` except the two pseudorefs is a root ref;
  `isOutsideRefsNamespace` ⇔ neither root ref nor refs/-prefixed.
- `src/application/primitives/ref-store.ts` — `verifyIntegrity`: replace Part 5's lone
  `HEAD` check with every entry of `ctx.fs.readdir(ctx.layout.gitDir)` (readdir order)
  that is not a directory and whose name `isRootRefName` admits → `looseBodyFinding(name as
  RefName)`. Assumption kept from today: a root ref that is a symlink is read through
  (`readLooseContent` follows it) — no `symlinkRef` outside refs/ (unpinned; do not
  invent). `looseBodyFinding` resolves root refs via `refDir(name)` → the worktree gitdir
  (per-worktree, src/domain/refs/per-worktree-ref.ts `isPerWorktreeRef`).
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — store + fsck tests below.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows F1-BAR (.git/BAR_HEAD =
  `garbage\n` only: `error: BAR_HEAD: badRefContent: garbage`, exit 8), ROOTORD2, and
  FETCH-PSEUDO (.git/FETCH_HEAD holding git's own fetch line after a local fetch: compare
  with git — expected no line).

### TDD steps
1. RED `isRootRefName` (one `it` per class above): module missing. GREEN.
2. RED `isValidSymrefReferent`: fails (not exported). GREEN. RED `isOutsideRefsNamespace`:
   fails. GREEN.
3. Property suite: GUARD after GREEN (additive).
4. RED `verifyIntegrity` — `BAR_HEAD` garbage → `badRefContent` for `BAR_HEAD`, after the
   `refs/` findings: fails, only HEAD is checked. GREEN: root-ref enumeration.
5. GUARD — `FETCH_HEAD` garbage → no finding (pseudoref excluded by `isRootRefName`;
   isolated test kills the pseudoref-exclusion mutant).
6. RED interop F1-BAR, ROOTORD2 (tsgit: no `BAR_HEAD` line, exit 0 / 2 — design F1 pin);
   GUARD FETCH-PSEUDO (run before GREEN).
REFACTOR: root-ref enumeration in its own helper.

### Gate
`npx vitest run test/unit/domain/refs/symref-referent.test.ts test/unit/domain/refs/symref-referent.properties.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/refs/symref-referent.ts src/application/primitives/ref-store.ts test/unit/domain/refs/symref-referent.test.ts test/unit/domain/refs/symref-referent.properties.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): check every root ref's body, not only HEAD's, as git does`

## Part 7 — An unreadable loose ref file is `cannotReadRef`, and the run carries on

### Context
R3 (ADR-1122). The finding shape already exists on the public `bad-ref` arm (`path?`,
`reason?`, src/application/commands/internal/fsck/types.ts L50–L59): no type change.

- `src/application/primitives/ref-store.ts`:
  - `RefIntegrityFinding` gains `{ readonly ref: RefName; readonly msgId: 'cannotReadRef';
    readonly path: string; readonly reason: 'PERMISSION_DENIED' }`.
  - `looseBodyFinding(name)` → `looseBodyFindings(name): Promise<ReadonlyArray<RefIntegrityFinding>>`
    (Parts 10–11 add arms): wrap `readLooseContent(name)` (L755 — do NOT change
    `readLooseContent`, it is on the resolution path via `leafAfterRefusedOpen` L851): on
    `PERMISSION_DENIED`, `ctx.fs.lstat(path)` where `path = looseRefPath(refDir(name),
    name)`; `lstat` resolves → `cannotReadRef` with that `path`; `lstat` rejects
    `PERMISSION_DENIED` → rethrow the ORIGINAL read error for now (Part 8 maps it); other
    codes rethrow. The fault-free path pays no extra call.
- `src/application/commands/internal/fsck/refs-verify.ts` — content collector: each
  `cannotReadRef` → `{ type: 'bad-ref', ref, msgId: 'cannotReadRef', severity: 'error',
  path, reason }`, gated by `checkContentFormat`, NOT re-typed (no `retypeSeverity`), bit 8
  (`EXIT_REFS_CONTENT`).
- `src/application/commands/internal/fsck/exit-codes.ts` — bit-8 comment (L6–L9): "refs-verify
  content failure" becomes an enumerated list: error-graded `bad-ref` content finding and
  `cannotReadRef` (Parts 10, 11, 13 extend it only where they add a non-content cause).
- `docs/use/commands/fsck.md` — `bad-ref` row (L155): `cannotReadRef` on any loose ref
  file (path absolute as opened, error, not re-typeable, gated); exit table row `8` (L259)
  names `cannotReadRef`.
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — spies on
  `ctx.fs.readUtf8` throwing `permissionDenied(path)` for one ref (pattern
  test/unit/application/commands/fsck-worktree-heads.test.ts L240–L247), and on `lstat`.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows B-with-a, B-alone, ORD-U,
  TAG, U-sym, U-shadow, U-only, U-sev, U-strict, U-sub (`cwd` = `<repo>/sub`), ORD, L-U000
  (+ `--no-references`).

### TDD steps
1. RED `verifyIntegrity` — "Given `refs/heads/b` whose read is refused for permission, Then a
   `cannotReadRef` finding with the absolute path": fails, the read rethrows. GREEN:
   `looseBodyFindings` catch + `lstat`.
2. GUARD — a plain `Error('EIO')` from the read propagates (isolated; `rejects.toBe`).
3. GUARD — `lstat` also refused → the original error propagates (isolated; Part 8 turns it
   into a finding).
4. RED fsck — B-alone in memory form: `cannotReadRef` (error) + zero pointer, exit 10:
   fails, fsck throws. GREEN: collector arm. RED — `checkReferences: false` drops the
   finding and bit 8: isolated gating test, fails until the gate wraps it.
5. GUARD — `fsck.cannotReadRef=ignore` and `strict: true` leave it an error with bit 8: the
   collector never calls `retypeSeverity` for it (proof: both tests pass on step 4's
   GREEN; they pin the "not re-typeable" contract against a future retype mutant).
6. RED interop B-*, ORD-U, TAG, U-*, ORD, L-U000 (all throw today, design twin column).
REFACTOR: none.

### Gate
`npx vitest run test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck.test.ts test/unit/application/commands/fsck-worktree-heads.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/commands/internal/fsck/refs-verify.ts src/application/commands/internal/fsck/exit-codes.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): report an unreadable loose ref file as cannotReadRef and carry on`

## Part 8 — An unreadable ref directory or unstattable entry is an `unreadable-ref-path` finding

### Context
R9's refs-pass half (ADR-1126 §1, ADR-1127).

- `src/application/commands/internal/fsck/types.ts` — `FsckFinding` (L9) gains, after the
  `bad-ref` arm (L50–L59):
  ```ts
  | {
      /** A path git's refs walk could not open or stat — `error opening directory` /
       *  `failed to stat`. A warning: no exit bit, gated by `checkReferences`, never re-typed. */
      readonly type: 'unreadable-ref-path';
      readonly path: string;            // absolute, as opened
      readonly operation: 'open-directory' | 'stat';
      readonly reason: 'PERMISSION_DENIED';
    }
  ```
  PUBLIC — pre-pay: docs below + `npm run docs:json` → commit reports/api.json (prepush
  gate, not validate).
- `src/application/primitives/ref-store.ts` — internal arm `{ readonly msgId:
  'unreadableRefPath'; readonly operation: 'open-directory' | 'stat'; readonly path: string }`.
  `walkIntegrity`: `readdir(dir)` `PERMISSION_DENIED` → push `{ operation: 'open-directory',
  path: dir }` and return (a root `refs/` dir included). `looseBodyFindings`: Part 7's
  `lstat` refused `PERMISSION_DENIED` → `{ operation: 'stat', path }` instead of rethrow.
  Other codes rethrow.
- `src/application/commands/internal/fsck/refs-verify.ts` — map each internal walk fault to
  the public arm, gated by `checkContentFormat`, no bit; order = the store's order (content
  and walk lines interleaved as walked).
- `docs/use/commands/fsck.md` — type block (L25–L45) gains the arm; finding table gains an
  `unreadable-ref-path` row (`path`, `operation`, `reason`; warning, no exit bit, gated).
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — `readdir` spy refusing
  one directory (first, last, nested, root), `lstat` spy refusing.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows DIR (default, `--strict`,
  `--connectivity-only`, `--no-references`), DIR-AZ, DIR-N, DIR-T, DIR-ONLY (+nr), DIR-HEADS
  (+nr), DIR-PK, DIR-CH (+nr), DIR-SRCH (+nr), DIR-300, DIR-LINK-in.

### TDD steps
1. RED `verifyIntegrity` — unreadable `refs/heads/d/` → walk fault `open-directory` with the
   absolute dir, walk continues to siblings: fails, `readdir` rethrows. GREEN.
2. GUARD — non-permission `readdir` fault propagates (isolated).
3. RED `verifyIntegrity` — read refused + `lstat` refused → walk fault `stat`: fails (Part 7
   rethrows). GREEN.
4. RED fsck — DIR in memory form: one `unreadable-ref-path` finding, exit 0: fails (no
   arm). GREEN: types + mapping. RED — `checkReferences: false` drops it (isolated).
5. RED interop DIR…DIR-LINK-in (all throw today). DIR-ONLY / DIR-HEADS also prove
   `no-default-references` (refs-verify.ts L203 rule) — GUARD on that line.
6. `npm run docs:json`, commit `reports/api.json` with the part.
REFACTOR: none.

### Gate
`npx vitest run test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/types.ts src/application/primitives/ref-store.ts src/application/commands/internal/fsck/refs-verify.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): report an unreadable ref directory or entry as git's refs walk warns`

## Part 9 — A linked-worktree HEAD is unreadable only when its own file is

### Context
R4 (ADR-1122).

- `src/application/commands/internal/fsck/roots.ts` — `headOf(worktreeCtx)` (L897):
  `PERMISSION_DENIED` maps to `{ kind: 'unreadable', path }` only when `err.data.path ===
  \`${worktreeCtx.layout.gitDir}/HEAD\``; any other `PERMISSION_DENIED` → `NO_HEAD`
  (HU, DIR-HEAD). Callers: `snapshotWorktreeHeads` (L963), `worktreeHeads` (L975).
- `src/application/commands/internal/fsck/refs-verify.ts` — `collectAbsentTargets` (L186)
  gains `checkContentFormat: boolean`: worktree-HEAD `cannotReadRef` findings and their
  bit 8 only when it holds (W-nr); pointers unaffected.
- `test/unit/application/commands/fsck-worktree-heads.test.ts` — beside L249: HEAD → main,
  main's read refused → no HEAD finding, main's `cannotReadRef` from the walk; the L249 row
  with `checkReferences: false` → no finding, exit 0.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows HU, HU-nr, W, W-nr,
  DIR-HEAD.

### TDD steps
1. RED `fsck` — HU in memory form: no `cannotReadRef` on `HEAD`: fails, `headOf` reports
   the main file's path under `HEAD`. GREEN: the path rule.
2. RED `fsck` — W with `checkReferences: false`: no finding, exit 0: fails (8 today).
   GREEN: gating.
3. GUARD — L249 (own HEAD unreadable) still reported; L276 `EIO` still propagates.
4. RED interop HU, W-nr, DIR-HEAD (spurious HEAD line / bit 8 today); GUARD HU-nr, W.
REFACTOR: none.

### Gate
`npx vitest run test/unit/application/commands/fsck-worktree-heads.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/roots.ts src/application/commands/internal/fsck/refs-verify.ts test/unit/application/commands/fsck-worktree-heads.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): judge a linked worktree's HEAD unreadable only by its own file`

## Part 10 — A loose symref whose referent git rejects is `badReferentName`

### Context
R2 for loose bodies (ADR-1121, ADR-1124) and R7 in the integrity check (ADR-1125).

- `src/application/primitives/ref-store.ts`:
  - internal arm `{ readonly ref: RefName; readonly msgId: 'badReferentName' |
    'symrefTargetIsNotARef'; readonly referent: string }`.
  - `looseBodyFindings`: replace the `SYMBOLIC_PREFIX` / `LOOSE_OID_RE` test with
    `readLooseBody(raw, ctx.hashConfig.hexLength)` imported from
    ../../domain/refs/loose-ref.js: `unparseable` → `badRefContent`; `direct` → the
    loose-object probe with the lower-cased `id` (`badRefOid`); `symbolic` →
    `!isValidSymrefReferent(referent)` → `badReferentName { referent }`, then
    `isOutsideRefsNamespace(referent)` → `symrefTargetIsNotARef { referent }` (both facts
    independent; order: badReferentName, NotARef). Delete `LOOSE_OID_RE` (L550) and
    `SYMBOLIC_PREFIX` (L548) if no other use remains.
- `src/application/commands/internal/fsck/refs-verify.ts` — content collector:
  `badReferentName` base `'error'`, `symrefTargetIsNotARef` base `'info'`, each through
  `retypeSeverity(severities, msgId, base)` (src/domain/fsck/severity.ts L177; the table
  holds configured values only, so `--strict` never upgrades them); `ignore` drops; the
  ADR-1124 early return: a ref's NotARef is dropped when that ref's `badReferentName` is
  graded `'error'`; gated by `checkContentFormat`; bit 8 per error-graded notice.
- `src/application/commands/internal/fsck/types.ts` — `bad-ref` arm gains
  `/** The name a symbolic ref points to, exactly as read … not a RefName. */ readonly
  referent?: string;` (design §3 wording). PUBLIC — `npm run docs:json`, commit
  reports/api.json.
- `docs/use/commands/fsck.md` — type block + `bad-ref` row: `referent?`, msgIds
  `badReferentName` (error, bit 8) and `symrefTargetIsNotARef` (info; dropped when the same
  ref's `badReferentName` is an error).
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — store facts and fsck
  severities: each severity value per msgId, the early-return rule (error drops, warn
  keeps), `--strict`, `checkReferences: false`.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows A-ref-dots, CH3-dots, DA,
  HD, S3, S4, S5, S6, S7, S8 (+nr), S9, N and co (dots shape), the Referent grammar table
  (every `<R>` but `head`), R1, R2, R3, V1, V3, R6, SYMG, and the direct rows whose fsck
  column has no notice: UP, MIX, GARB, H39, H41, W64, VT, EMPTY.

### TDD steps
1. RED `verifyIntegrity` — `ref: x..y` → `badReferentName { referent: 'x..y' }` and
   `symrefTargetIsNotARef { referent: 'x..y' }`: fails, a `ref: ` body is healthy today.
   GREEN: `readLooseBody` switch + symbolic arm.
2. RED `verifyIntegrity` — `<SHA>\n` (upper) → no finding: fails, `LOOSE_OID_RE` flags it.
   GREEN: direct arm. RED — 64 hex in SHA-1 → `badRefContent`: fails (regex accepts 64).
3. RED fsck — badReferentName error + pointer, exit 10 (A-ref-dots memory form): fails (no
   collector arm). GREEN. RED — `badReferentName=warn` keeps NotARef as info (S3): fails
   until NotARef is mapped. GREEN. RED — default drops NotARef when badReferentName is
   error: isolated (kills the early-return mutant). RED — `symrefTargetIsNotARef=error` →
   bit 8 (S8).
4. GUARD — `--strict` leaves both (retype table holds configured values only — proof: the
   S6 unit test run after step 3).
5. RED interop rows listed (each red today per design twin column: nothing / 0, or BC for
   UP/MIX/R1, W64 resolving).
6. `npm run docs:json`, commit `reports/api.json`.
REFACTOR: collector split per msg family, each < 20 lines.

### Gate
`npx vitest run test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck.test.ts test/unit/domain/refs/symref-referent.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/commands/internal/fsck/refs-verify.ts src/application/commands/internal/fsck/types.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): report a loose symref's invalid referent as badReferentName and symrefTargetIsNotARef`

## Part 11 — `trailingRefContent` and `refMissingNewline` on loose bodies

### Context
R8 (ADR-1126 §4–5, ADR-1130).

- `src/application/primitives/ref-store.ts` — internal arms `{ ref; msgId:
  'refMissingNewline' }` and `{ ref; msgId: 'trailingRefContent'; trailing?: string }`.
  `looseBodyFindings` per arm, BEFORE the referent facts (Derived rule order): direct —
  `missingNewline` → `refMissingNewline`; `trailing !== undefined` →
  `trailingRefContent { trailing }`; symbolic — `missingNewline` → `refMissingNewline`;
  `trailingWhitespace` → `trailingRefContent` (no `trailing`). Unparseable → none.
  Symlinked refs never reach this function (Part 5). Root refs do (HEADTRAIL, HEADNOLF, F1).
- `src/application/commands/internal/fsck/refs-verify.ts` — both base `'info'` through
  `retypeSeverity`; `ignore` drops; error → bit 8; gated; independent of the early-return
  rule (they survive an error-graded `badReferentName` — DOTS-NOLF).
- `src/application/commands/internal/fsck/types.ts` — `bad-ref` gains `/** The bytes after
  the object name — on a direct body's trailingRefContent. */ readonly trailing?: string;`.
  PUBLIC — `npm run docs:json` and commit the regenerated API report (reports/api.json, a generated artifact).
- `docs/use/commands/fsck.md` — type block + `bad-ref` row: `trailing?`, msgIds
  `trailingRefContent` / `refMissingNewline` (info, no bit unless configured error).
- `test/unit/application/commands/fsck-broken-ref-chain.test.ts` — store facts per body
  class, fsck severities per msgId, `--strict`, gating.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows UPSPG, SPG (four
  columns), TABG, SP2, SPN, CRLF, NN, TWO, NOLF (four columns), UPNOLF, SPGNOLF, SYMNOLF,
  SYMSP, SYMCRLF, SYMNN, SYMTABLF, SYMSPNOLF, SYM2SPNOLF, FOO-NOLF, FOO-SP, DOTS-NOLF (+warn),
  HEADTRAIL, HEADNOLF, F1 (ORIG_HEAD no-LF + BAR_HEAD garbage, exit 8), R4, R5, PKT.

### TDD steps
1. RED `verifyIntegrity` — `<sha> garbage\n` → `trailingRefContent { trailing: ' garbage\n' }`:
   fails, no notice. GREEN. RED — `<sha>` → `refMissingNewline`: fails. GREEN.
2. RED — symref `ref: refs/heads/main \n` → `trailingRefContent` without `trailing`; RED —
   `ref: refs/heads/main` → `refMissingNewline`; order before `badReferentName` on
   `ref: x..y` (no LF): one RED each.
3. GUARD — `<sha>\n` and EMPTY yield no notice (isolated; kill the `!== '\n'` and
   empty-trailer mutants).
4. RED fsck — info by default, exit unchanged; `=error` → bit 8; `ignore` drops;
   `checkReferences: false` drops: one RED per guard clause.
5. RED interop rows listed.
6. `npm run docs:json`, commit `reports/api.json`.
REFACTOR: none.

### Gate
`npx vitest run test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/ref-store.ts src/application/commands/internal/fsck/refs-verify.ts src/application/commands/internal/fsck/types.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): emit trailingRefContent and refMissingNewline on loose ref bodies`

## Part 12 — A symlinked ref's referent is its realpath, and an unresolvable link ends the walk

### Context
R10 (ADR-1126 §2 as amended, ADR-1129, ADR-1128's store half), DC-5 (a), DC-6 (a).

- `src/application/primitives/internal/alternate-chain.ts` — the existing userland realpath
  (`realpathAllowingMissingLeaf(syntax, probe, path, cwd): Promise<string | undefined>`
  L108; walk helpers `lookup` L23, `follow` L64, `descend` L71, `MAX_SYMLINKS = 32` L14) IS
  ADR-1129's resolver. Add a reason-bearing core it delegates to:
  ```ts
  export type RealpathOutcome =
    | { readonly kind: 'resolved'; readonly path: string }
    | { readonly kind: 'failed'; readonly path: string;
        readonly reason: 'FILE_NOT_FOUND' | 'NOT_A_DIRECTORY' | 'PERMISSION_DENIED' | 'SYMLINK_LOOP' | 'ROOTLESS' };
  export const realpathOutcome = (syntax, probe, path, cwd): Promise<RealpathOutcome>
  ```
  `path` on failure = the resolved prefix joined with the failing component (git's
  `Invalid path` text; for `SYMLINK_LOOP` the input path). `lookup`'s `PERMISSION_DENIED`
  becomes a `failed` outcome in the core; `realpathAllowingMissingLeaf` keeps its contract
  exactly (rethrows the original error on `PERMISSION_DENIED`, `undefined` on every other
  failure) — alternates behaviour unchanged except DC-6: the hop cap is 20 on
  `process.platform === 'linux'`, 32 elsewhere (pass the platform in from the caller, keep
  the domain-free module testable).
- `src/application/primitives/internal/real-path.ts` — add `realPathOutcomeOf(ctx,
  absolute)` beside `realPathOf` (same probe: `ctx.alternatePathProbe?.(absolute) ??
  narrowAlternatePathProbe(ctx.fs)`), `realPathOf` delegates.
- `src/application/primitives/ref-store.ts` — `walkIntegrity`, symlink entry: after
  `symlinkRef`, `linkReferentFindings(name, path)`: `outcome = realPathOutcomeOf(ctx, path)`
  and `gitDirReal = realPathOutcomeOf(ctx, ctx.layout.gitDir)` (memoised per
  `verifyIntegrity` call); resolved → `referent = real.startsWith(gitDirReal + '/') ?
  real.slice(gitDirReal.length + 1) : real` → the Part 10 facts (`badReferentName`,
  `symrefTargetIsNotARef`); no body or newline facts. Failed → internal arm `{ ref, msgId:
  'refsVerifyEnded', path, reason }` and the walk STOPS: no later content finding, root refs
  included (thread a stop signal out of `walkIntegrity`). refs-verify ignores the new arm
  until Part 13. The arm's `reason` excludes the core's `ROOTLESS`: that outcome needs a
  rootless link target (a share-less `\\server` text — Windows path syntax only, no
  pinned row); the store maps it to `FILE_NOT_FOUND`, tested by one unit row with the
  Windows path syntax.
- `test/unit/application/primitives/internal/alternate-chain.test.ts` — `realpathOutcome`:
  resolved, missing last kept, missing middle `FILE_NOT_FOUND` with the prefix path, under a
  file `NOT_A_DIRECTORY`, permission `PERMISSION_DENIED`, loop `SYMLINK_LOOP`, cap 20 vs 32
  by platform argument; `realpathAllowingMissingLeaf` GUARDs (existing suite).
- `test/unit/application/primitives/ref-store-symlinked-refs.test.ts` — store-level referent
  rows on the memory adapter (it implements `symlink`/`readlink`/`lstat`) and the stop:
  memory readdir yields files, then symlinks, then directories — so the dying link
  refs/heads/z loses refs/heads/sub/a (a directory entry, walked after symlinks) and
  the root refs, and keeps refs/heads/a (a file, walked before). Name that order in the
  test title.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows L-REL, L-RELUP, L-ABS-own,
  L-ABS-other, L-DANG, L-DANG-abs, L-OUT, L-OUTDOTS, L-GITFOO, L-GITDOTS, L-ROOT, L-WARN,
  L-CHAIN, L-ORDER, L-UOUT (+nr), DIR-LINK (+nr).

Read-only: src/application/primitives/object-store.ts `narrowAlternatePathProbe`,
src/application/primitives/internal/git-path-syntax.ts `gitPathSyntaxOf`. Existing
test/unit/application/primitives/internal/alternate-chain.properties.test.ts keeps running
over `realpathAllowingMissingLeaf` (it now delegates to the core): no new property suite —
the resolver is not a parser/serializer shape.

### TDD steps
1. RED `realpathOutcome` — missing middle → `failed FILE_NOT_FOUND` with the prefix path:
   fails (not exported). GREEN: core + delegation. RED per remaining reason (one each).
2. RED `realpathOutcome` — the cap is 20 when called for `linux`, 32 otherwise: a chain of
   21 links fails `SYMLINK_LOOP` for `linux`: fails, the cap is 32 everywhere. GREEN:
   platform-keyed cap (DC-6). GUARD — the existing alternate-chain suites (contract
   unchanged on darwin).
3. RED `verifyIntegrity` — link to `<outside>` → `badReferentName { referent: <realpath> }`:
   fails, only `symlinkRef` today. GREEN: `linkReferentFindings`. RED — link `../../foo/bar`
   → `symrefTargetIsNotARef { referent: 'foo/bar' }` only.
4. RED `verifyIntegrity` — dying link stops the walk (memory order as named): fails, the walk
   continues. GREEN: stop signal.
5. RED interop rows listed (design: tsgit `symlinkRef` only, exit 0).
REFACTOR: `linkReferentFindings` < 20 lines.

### Gate
`npx vitest run test/unit/application/primitives/internal/alternate-chain.test.ts test/unit/application/primitives/internal/alternate-chain.properties.test.ts test/unit/application/primitives/ref-store-symlinked-refs.test.ts test/unit/application/commands/fsck-symlinked-ref.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/integration/alternates <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/primitives/internal/alternate-chain.ts src/application/primitives/internal/real-path.ts src/application/primitives/ref-store.ts test/unit/application/primitives/internal/alternate-chain.test.ts test/unit/application/primitives/ref-store-symlinked-refs.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): judge a symlinked ref by its realpath referent and stop where git's walk dies`

## Part 13 — fsck reports where git's refs-verify child dies

### Context
ADR-1128's fsck half; DC-5 (a).

- `src/application/commands/internal/fsck/types.ts` — `FsckFinding` gains:
  ```ts
  | {
      /** git's `refs verify` child died on this symlinked ref: every content check after
       *  it is lost, pointers stand. Bit 8. */
      readonly type: 'refs-verify-ended';
      readonly ref: RefName;
      readonly path: string;
      readonly reason: 'FILE_NOT_FOUND' | 'NOT_A_DIRECTORY' | 'PERMISSION_DENIED' | 'SYMLINK_LOOP';
    }
  ```
  (Part 12's ref-store arm already narrows the core's `ROOTLESS`, see there.) PUBLIC — `npm run docs:json` and commit the regenerated API report (reports/api.json, a generated artifact).
- `src/application/commands/internal/fsck/refs-verify.ts` — map the internal
  `refsVerifyEnded` arm, gated by `checkContentFormat`, bit 8 (`EXIT_REFS_CONTENT`).
- `src/application/commands/internal/fsck/exit-codes.ts` — bit-8 comment adds "a
  refs-verify end".
- `docs/use/commands/fsck.md` — type block, finding table row `refs-verify-ended`, exit
  table row `8`.
- `test/unit/application/commands/fsck-symlinked-ref.test.ts` — fsck-level: finding + bit 8;
  `checkReferences: false` drops both; pointers still present.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows L-DIE-mid, L-DIE-abs,
  L-DIE-refs, L-LOOP (`fatal:` text compared on darwin; on linux compare exit + reason, git's
  text names its own cap), LINK-NOTDIR and LINK-EACCES (this run's probes: link main/x,
  link `<B>/d000/x`), ROOTORD-ROOTS (refs/tags/z → nodir/x, healthy `main`, HEAD =
  `ref: refs/heads/main` without LF, `BAR_HEAD` garbage: both root-ref lines lost whatever
  the refs/ readdir order, exit 8).

### TDD steps
1. RED fsck — dying link → `refs-verify-ended` + exit bit 8: fails (no mapping). GREEN.
2. RED — `checkReferences: false` drops it and its bit (isolated).
3. GUARD — the zero pointer of the dying link's name still stands (snapshot, Part 4).
4. RED interop rows listed (tsgit: `symlinkRef` only, exit 0 — design twin column).
5. `npm run docs:json`, commit `reports/api.json`.
REFACTOR: none.

### Gate
`npx vitest run test/unit/application/commands/fsck-symlinked-ref.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts test/unit/application/commands/fsck.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/fsck/types.ts src/application/commands/internal/fsck/refs-verify.ts src/application/commands/internal/fsck/exit-codes.ts test/unit/application/commands/fsck-symlinked-ref.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): report the end of git's refs-verify walk on an unresolvable symlinked ref`

## Part 14 — The integrity walk reads directories in the operating system's order

### Context
DC-4 (b): makes ADR-1128's lost-line set match git on the same filesystem. Requires the
DC-4 ADR (precedent ADR-884) before this part runs.

- `src/ports/file-system.ts` — `FileSystem` gains, after `readdir` (L171–L172):
  `readonly readdirInOsOrder?: (path: string) => Promise<ReadonlyArray<DirEntry>>;` JSDoc:
  the entries in the order the operating system returns them (git's `readdir`), same
  refusals as `readdir`; optional — an adapter without it is read with `readdir`. PUBLIC
  (re-exported through src/ports/index.ts L16) — `npm run docs:json`, commit
  reports/api.json.
- `src/adapters/node/node-file-system.ts` — implement with `fs.promises.opendir` (iterate
  the `Dir`, close in `finally`), through the same root-set resolution and `runFs` mapping
  as `readdir` (L1398–L1410); the sync-I/O branch uses `fs.opendirSync` likewise.
- `src/repository/wrap-fs-validator.ts` — forward the optional member exactly as it
  forwards `tryLstat` (grep `tryLstat` there for the pattern).
- `src/application/primitives/ref-store.ts` — `walkIntegrity` and the root-ref enumeration
  read through `ctx.fs.readdirInOsOrder ?? ctx.fs.readdir` (bound). The listing walk
  (`walkRefDir`) is unchanged — every listing sorts its result.
- `test/unit/adapters/node/node-file-system.test.ts` — `readdirInOsOrder` returns the
  entries `fs.opendirSync` yields (assert against an `opendirSync` read of the same temp
  dir, never a hard-coded order), refuses `FILE_NOT_FOUND` / `NOT_A_DIRECTORY` as `readdir`
  does.
- `test/integration/fsck-broken-ref-chain-interop.test.ts` — rows L-DIE-lost and ROOTORD.

Read-only: test/unit/repository/wrap-fs-validator.test.ts (add one forwarding test only if
the wrapper's suite pins each optional member — follow its `tryLstat` test).

### TDD steps
1. RED `NodeFileSystem.readdirInOsOrder` — equals the `opendirSync` order: fails (missing).
   GREEN.
2. RED — refusals mirror `readdir` (one `it` per code).
3. RED `wrapFsValidator` forwarding (if the suite pins members): fails until forwarded.
4. RED interop L-DIE-lost, ROOTORD: on APFS tsgit's sorted walk keeps `refs/heads/a`'s
   and `main`'s lines git loses (this run's readdir probe). GREEN: the walk reads through
   `readdirInOsOrder`.
5. `npm run docs:json`, commit `reports/api.json`.
REFACTOR: none.

### Gate
`npx vitest run test/unit/adapters/node/node-file-system.test.ts test/unit/repository/wrap-fs-validator.test.ts test/unit/application/primitives/ref-store.test.ts test/unit/application/commands/fsck-broken-ref-chain.test.ts <FSCK_FAMILIES> test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/file-system.ts src/adapters/node/node-file-system.ts src/repository/wrap-fs-validator.ts src/application/primitives/ref-store.ts test/unit/adapters/node/node-file-system.test.ts test/integration/fsck-broken-ref-chain-interop.test.ts && npm run check:spelling`

### Commit
`fix(fsck): walk ref directories in the operating system's order as git does`

## Mutation buckets (validation phase)

Narrowed eponymous buckets (.claude/workflow/mutation.md):
- src/domain/refs/loose-ref.ts ← loose-ref.test.ts + loose-ref.properties.test.ts
- src/domain/refs/symref-referent.ts ← symref-referent.test.ts + symref-referent.properties.test.ts
- src/application/primitives/ref-store.ts walk slice (`walkRefDir`) ← ref-store.test.ts
- src/application/primitives/ref-store.ts integrity slice (`walkIntegrity`,
  `looseBodyFindings`, `linkReferentFindings`, root-ref enumeration) ← ref-store.test.ts +
  ref-store-symlinked-refs.test.ts + fsck-broken-ref-chain.test.ts + fsck-symlinked-ref.test.ts
- src/application/primitives/internal/alternate-chain.ts ← alternate-chain.test.ts +
  alternate-chain.properties.test.ts
- src/application/commands/internal/fsck/refs-verify.ts ← fsck-broken-ref-chain.test.ts +
  fsck-symbolic-ref-fault.test.ts + fsck-symlinked-ref.test.ts + fsck-worktree-heads.test.ts
- src/application/commands/internal/fsck/roots.ts (`headOf`) ← fsck-worktree-heads.test.ts
- src/repository/find-layout.ts (shared-dir check) ← find-layout.test.ts
- src/adapters/node/node-file-system.ts (`readdirInOsOrder`) ← node-file-system.test.ts
`targetOf`'s removed `isTolerableRefFault` branch must not reappear as an equivalent survivor.

## Self-review (3 passes)

1. Contradictions: the design's Out-of-scope list vs §6/ADR-1126 — resolved to ADR-1126.
   Design §5 assumption "Node readdir is unsorted" — refuted by this run's probe → DC-4,
   Part 14; Part 12/13 rows chosen to be order-independent. ADR-1128's two-reason set vs
   git's four death reasons → DC-5. Design F2 "maps to missing" vs git's DIR-SRCH death →
   DC-1.
2. Unstated assumptions made explicit: a root ref that is a symlink is read through (Part 6,
   unpinned, today's HEAD behaviour); `refDir(name)` resolves root refs to the worktree
   gitdir; walk faults and content lines interleave in walk order; memory readdir order
   named in every death-pin; `gitDirReal` resolved by the same resolver (L-ABS-own through
   `/var`).
3. Edge behaviour: empty symref referent is `symbolic ''` (fsck flags it) yet
   `parseLooseRef` still refuses it; `ROOTLESS` cannot reach the public reason; a link onto
   an unreadable file yields no `cannotReadRef` of its own (L-UOUT) because the walk never
   reads a link; the zero pointer for a name hidden by an unreadable directory never
   appears (DIR, DIR-CH) because both listings skip it (Part 2 before Part 4's difference is
   relied on in Part 8).
