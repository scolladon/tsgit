# Plan — pathspec glob dialect, unmatched-pathspec refusal, describe/name-rev patterns

> Source: design doc `docs/design/pathspec-glob-dialect.md` · ADRs 1033, 1034, 1035, 1036, 1037, 1038, 1039, 1040, 1041, 1042, 1043, 1044 (binding); pre-existing 038, 077, 226, 249, 866, 980, 1000, 1012
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

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
  files in its `### Context` block, is two parts. What counts is a path in backticks:
  backtick the files the part CREATES or EDITS, and write read-only reference paths in
  plain text.

## Facts the planner established (beyond the design)

Each was probed against git 2.55.0 in a `mktemp -d` throwaway (scrubbed `GIT_*`, empty `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, `LC_ALL=C`, signing off) or read from the code at `8dd442ee`.

1. **tsgit refused every pathspec holding a backslash before any matching** (base `8dd442ee`).
   `resolvePathspec` runs `validatePath` (= `validateWorkingTreePath`, src/domain/working-tree-path.ts:71
   `if (input.includes('\\')) reject(input)`) on every body. Probe through the real module:
   `resolvePathspec(['a\\b'])`, `(['a\\*b'])`, `(['a\\'])` each throw
   `{"code":"PATHSPEC_OUTSIDE_REPO","path":…}`; `(['[ab].txt'])` is accepted.
   **Decided: ADR-1044, option B** (candidate 1) — on a host without Windows path syntax the
   pathspec intake accepts `\` for matching only; Part 9 lands it. D6, D17 and E2 get command-level
   interop rows on POSIX hosts; D8b and E1 stay pinned follow-ups (they need a `\`-named
   working-tree file, which `validateWalkedEntryPath` refuses).
2. **B11 as designed is unreachable**: its `.gitignore: nomatch[*]` needs `[…]` in the gitignore
   dialect, which tsgit does not have (src/domain/pathspec/compile-glob.ts header; R9 keeps it so).
   Re-pinned variant **B11′**: file `nomatch*`, `.gitignore: nomatch?`, `git add 'nomatch*'` →
   exit 0, index empty, 0 loose objects.
3. **The name-rev abbreviation oracle is `git rev-parse --abbrev-ref=loose <ref>`, not plain
   `--abbrev-ref`.** Probe (tag `x` at c1, branch `x` at c2): `name-rev --refs x HEAD` → `heads/x`,
   `name-rev --refs x HEAD~1` → `x`; `rev-parse --abbrev-ref refs/tags/x` → `tags/x` (strict, wrong
   for N28); `rev-parse --abbrev-ref=loose refs/tags/x` → `x`, `=loose refs/heads/x` → `heads/x`
   (both right). git's name-rev calls `refs_shorten_unambiguous_ref(path, 0)` — non-strict.
4. Extra pins: **RN4** untracked file named `nomatch*`, `add --renormalize 'nomatch*'` → exit 0,
   index unchanged; **RN5** untracked `untracked.txt`, `add --renormalize untracked.txt` → exit 0;
   **RN6** `add --renormalize 'untr*'` where `untr*` names only an untracked file → 128
   `fatal: pathspec 'untr*' did not match any files`; **K1L** held `index.lock`,
   `checkout -- missing` (unmatched literal) and `checkout -- a.txt` (tracked literal) → 128 lock
   refusal; **B12r** `add 'zz*' .` → 128 naming
   `'zz*'`.
5. git's `subpath_matches` returns the FIRST offset that matches (full ref first), so an include
   abbreviates only when its first match is at a suffix (N15: `*1.0` matches the full
   `refs/tags/v1.0` → `tags/v1.0^0`, not abbreviated).
6. git's per-path match levels order as `RECURSIVE < FNMATCH < EXACT` and `rm` keeps the maximum
   per pathspec item, so one wildcard match lifts an item out of the `-r` refusal (R4 vs R4b).
   An empty match (the whole tree, `.`) is `RECURSIVE` for every path.
7. `add`'s walk is already fully buffered before any staging (`walkedTrackedFirst`,
   src/application/commands/add.ts:647 collects every walked entry into a Map before yielding),
   so collecting the walk before the refusal costs no walk/hash overlap.

## Requirement map

| Req | Part(s) |
|---|---|
| R1 dialect (verbatim first, flags-0 wildmatch over bytes) | 1, 2 (fast paths), 9 (`\` bodies at command level, ADR-1044) |
| R2 add / add --renormalize / rm refuse the first unmatched, before any write | 6 (rm), 7 (add); helpers: 5 |
| R3 checkout refuses every unmatched, lock + index read first | 8; helpers: 5 |
| R4 rm -r by match level | 6 |
| R5 unmatched glob whose verbatim body exists is not refused | 7 |
| R6 grep never refuses | 1 (GUARD rows) |
| R7 describe flags-0 on the short name | 3 |
| R8 name-rev suffix matching + abbreviation as data | 3 (filter), 10 (result field, every N interop row) |
| R9 gitignore/attributes/sparse unchanged | 4 |
| R10 linear matchers, size, add-glob bench | 2, 11 |

## Decision candidates

Candidate 1 is decided (ADR-1044, B); candidates 2–5 were adopted as recommended. The rows stay
as the audit trail.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | Backslash in a pathspec body (fact 1) | **A** keep `validateWorkingTreePath`'s refusal: D6/D8b/D17/E1/E2 stay divergent at command level, pinned as a follow-up; the matcher keeps `\` glob-special · **B** accept `\` in pathspec bodies on non-Windows hosts, matcher-only: a `\`-holding body never reaches `lstat`, the symlink scan or `literalStats` (needs a security review of the relaxed validator) · **C** accept `\` everywhere | **Decided: ADR-1044, B** (recommendation was A) | The refusal is a path-traversal defence shared with tree/index boundaries; relaxing it is a security-surface change the design never weighed. B is a separate part (validator split + the five rows) if chosen. |
| 2 | Testing the Part 2 fast paths under mutation | **A** export the shape classifier and the one-star evaluator (internal) and unit-test them directly; the dispatch `if` that falls back to the byte DP stays an equivalent mutant, triaged at validation with no suppression comment unless the user approves one · **B** ship Part 1 without fast paths; add them only if `bench:ab` on the add-by-glob row regresses beyond noise | A | The design and ADR-1033 admit the fast paths and the hot path (`add '*.ts'`) is the common call; A leaves at most a handful of provably equivalent dispatch mutants. |
| 3 | `add` walk-seen source when a `!` element is present | **A** test each positive element against the leaves the walk yields (already filtered by the whole spec) · **B** test against every non-ignored leaf before the pathspec filter (git's positive pass marks `seen` before excludes) | A | Only specs combining `!` with an otherwise-unmatched element differ; `!` semantics are backlog 32.11b. |
| 4 | On-disk escape scope under `add --renormalize` | **A** every unseen positive (literal or wildcard) whose verbatim body `lstat`s is accepted — git's `file_exists` (RN4, RN5) · **B** wildcard only, as ADR-1036 states for the walk | A | RN5 is today's pinned literal behaviour and RN4 is git's; ADR-1036's literal exclusion exists because the walk's ignored-literal advice is unbuilt, which `--renormalize` never prints. |
| 5 | checkout when every positive is seen but the spec selects nothing (a `!` removes all) | **A** release the lock without writing the index (today's no-op, now under the lock) · **B** commit the index as git's `checkout_paths` does after taking the lock | A | Unpinned; only reachable through `!` (32.11b). |

## Deferred to documentation phase

- Design part e: `docs/BACKLOG.md` release-order row 1 and the 32.11 sub-items (strike a–d, keep
  32.11b) — no part carries it.
- User docs that state the old behaviour (documentation phase rewrites them):
  docs/use/commands/add.md lines 42 and 60, docs/use/commands/rm.md line 77,
  docs/use/commands/checkout.md line 92, docs/use/recipes.md line 71, docs/use/errors.md line 130
  (`patterns`), docs/use/commands/name-rev.md (result shape gains `abbreviated`; line 40 says
  "full-refname glob"), docs/use/commands/describe.md (`match`/`exclude` dialect).
- docs/use/errors.md line 131 (`PATHSPEC_OUTSIDE_REPO`): on a POSIX host a pathspec holding `\` is
  no longer refused (ADR-1044); the row's wording and the pathspec mentions in
  docs/use/commands/add.md, rm.md and checkout.md need the Windows-only qualifier.
- `docs/design/pathspec-glob-dialect.md` Test strategy names `rev-parse --abbrev-ref`; fact 3
  corrects it to `--abbrev-ref=loose`.

## Out of scope, proven (one line each, not acted on)

- tsgit's gitignore dialect has no `[…]` (compile-glob.ts header, R9): git ignores `nomatch*` under
  `nomatch[*]`, tsgit does not — prove with a twin `git check-ignore nomatch*` against tsgit's
  ignore predicate.
- `rm` tolerates an unreadable index (`isIndexMissingCode`, src/application/commands/rm.ts:53)
  where git dies on it — hunch; prove with a twin `git rm 'x*'` over a 3-byte `.git/index`.

## Part 1 — Pathspec wildcards match with git's flags-0 wildmatch over the path's bytes

### Context

Files this part creates or edits (exactly these):
- `src/domain/refs/ref-glob.ts` — add the bytes-taking compile.
- `test/unit/domain/refs/ref-glob.test.ts` — rows for it.
- `src/domain/pathspec/wildcard.ts` — CREATED: match levels, verbatim rule, glob-special test,
  the wildcard matcher. Part 2 adds the fast paths to it (a new module, so the two parts share no
  pre-existing file).
- `test/unit/domain/pathspec/wildcard.test.ts` — CREATED; Part 2 extends it.
- `src/domain/pathspec/compile-pathspec.ts` — `compileOne` delegates to wildcard.ts. This part is
  its only editor in the run.
- `test/integration/pathspec-glob-dialect-interop.test.ts` — CREATED here; Parts 6, 7, 8, 9 extend it
  (one interop file per pinned matrix, one twin-repo builder).

Read-only references: src/domain/objects/encoding.ts (encodeEscaped at :205, encode),
src/domain/git-index/index-path-key.ts (escapedPathOf, IndexPath),
src/domain/pathspec/match-pathspec.ts, src/domain/pathspec/matching-path.ts,
test/unit/domain/pathspec/compile-pathspec.test.ts and matching-path.test.ts (existing rows stay
green unchanged here — Part 2 retitles two of them), test/integration/pathspec-dot-interop.test.ts
(twin-repo and createNodeContext template, the `@proves` header shape),
test/integration/interop-helpers.ts (GIT_AVAILABLE, runGit, runGitEnv, runGitBytes,
tryRunGitWithExit, stageRaw, hashBlob, pathHexOfRecords, lsFilesPathHex, hex).

Current code (at the base):
- ref-glob.ts: private `tokenize(bytes, dialect)`, `matchTokens(tokens, text: Uint8Array)`,
  `REF_DIALECT` (flags 0), `compileWith(pattern, dialect): (text: string) => boolean`
  (encodes the pattern once and the text per call), exports `compileRefGlob(pattern)`,
  `compilePathnameGlob(pattern)`, `matchRefGlob(pattern, ref)`. Shared with
  src/application/commands/internal/merge-message.ts and src/domain/reflog/expire-policy.ts: those
  three exports keep their contracts. Keep the four `Stryker disable next-line` equivalence lines
  (:112, :140, :284, :295) byte-identical.
- compile-pathspec.ts: `compileOne` → literal (`!containsGlob(body)`) uses `compileLiteral`
  (`''` → WHOLE_TREE, trailing "/" → `compileDirectory` = startsWith, else
  `compileGlob(body, { anchored: true, withDirSuffix: true })`); glob uses
  `compileGlob(body, { anchored: body.includes('/') })` (gitignore anchoring: "foo*" is tried at
  every depth, `*` stops at "/", no brackets, no escapes, `?` is one UTF-16 unit).
  `PathspecEntry` = { pattern, body, negated, isLiteral, compiled: GlobMatcher } — the public
  `Pathspec` type (src/public-types.ts:85); keep the shape.
- matching-path.ts: `matchesIndexPath(spec, entry) = matchesPathspec(spec, escapedPathOf(entry))` —
  the escape view (a non-UTF-8 byte is a lone U+DC80..U+DCFF); unchanged.

Target shape (internal exports, not barrelled, not public):

    // wildcard.ts
    export const MATCH_LEVEL = { NONE: 0, RECURSIVE: 1, FNMATCH: 2, EXACT: 3 } as const;
    export type MatchLevel = (typeof MATCH_LEVEL)[keyof typeof MATCH_LEVEL];
    export const hasGlobSpecial = (body: string): boolean  // any of * ? [ \
    export const verbatimLevel = (body: string, path: string): MatchLevel
      // '' → RECURSIVE (git: an empty match covers every path)
      // !path.startsWith(body) → NONE; same length → EXACT;
      // body ends in '/' or path[body.length] === '/' → RECURSIVE; else NONE
    export const compileWildcard = (body: string): GlobMatcher
      // const wild = compileRefGlobBytes(body);
      // test = verbatimLevel(body, p) !== NONE || wild(encodeEscaped(p))
    // compile-pathspec.ts — compileOne: isLiteral = !hasGlobSpecial(body)
    //   literal: '' → WHOLE_TREE, else test = verbatimLevel(body, p) !== NONE
    //   wildcard: compileWildcard(body)
    // ref-glob.ts
    export const compileRefGlobBytes = (pattern: string): ((text: Uint8Array) => boolean)
      // tokenize(encode(pattern), REF_DIALECT) once; abort → () => false; reuses matchTokens;
      // compileWith is rewritten on top of it (no second DP)

wildcard.ts imports `GlobMatcher` as a type from compile-glob.ts; compile-pathspec.ts imports
wildcard.ts (no import back — no cycle). The level ordering mirrors git
(`RECURSIVE < FNMATCH < EXACT`) so Part 6 can take a max. Never `TextEncoder` a path:
`encodeEscaped` turns each lone U+DC80..U+DCFF back into its raw byte.

Matrix rows this part makes pass (design `## Pin matrix (git 2.55.0)`): D2, D3, D5a–D5e, D9, D11,
D11b, D12, D16, E4, E5, C6, L1–L3, L5, L6, G3, R2, R4, R5, R6. GUARD rows (design marks them ok):
D1, D4, D8a, D13, D14, E3, G1, G2, G4, G5, L4, R3. Not here: D7, D8c, D10 (refusals, Part 7).
The matcher behaviour of D6, D17, E1, E2 (bodies holding a backslash) IS unit-tested here through
`compileWildcard`; their command-level rows (D6, D17, E2) land in Part 9 once the intake accepts
the backslash on POSIX hosts (ADR-1044); D8b/E1 stay follow-ups.

Interop file guidance: copy the header and the twin-repo builder shape from
pathspec-dot-interop.test.ts (`@proves` surface/bucket/unique/interopSurface: add, rm, checkout,
grep). One builder writes the same files into a git-initialised `git-<slug>` and `tsgit-<slug>`
repo (`runGit(['init','-q','-b','main', dir])`); tracked fixtures commit on the git side with
`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE` pinned (as pathspec-dot-interop does) and on the tsgit twin
with the same git commands (the twin is set up by git; only the Act step runs tsgit). Compare
`git ls-files -s` (or `lsFilesPathHex` for non-UTF-8 names), file bytes, loose-object counts.
Keep rows table-driven (`describe.each` / `it.each`) — `check:duplicates` (jscpd, 5 lines /
50 tokens) runs in validate. L rows: build the index with `stageRaw` (bytes via
`update-index -z --index-info`; works on APFS): entries `a\377` (bytes 61 ff), `aé`
(61 c3 a9), `ab`, each pointing at a `hashBlob` oid; git side `runGitBytes(['-C', dir,
'ls-files','-s','-z','--', spec])` → `pathHexOfRecords`; tsgit side `readIndex` +
`matchesIndexPath(compilePathspec([spec]), entry)` → hex of `entry.pathBytes ?? encode(entry.path)`.
L6: tsgit `rm(ctx, ['a?'], { cached: true })` vs `git rm --cached -q 'a?'`, compare
`lsFilesPathHex`. A worktree-side lossy row (`add 'a?'` with files `a\377`, `aé`, `ab`; git stages
`a\377` and `ab`) is gated with `describe.skipIf(!GIT_AVAILABLE || process.platform !== 'linux')`
— APFS refuses the name.

Environment: anything running real git needs git 2.55.0 first on PATH:
`PATH="$HOME/.local/git-2.55.0/bin:$PATH"` (the default git 2.56 fails ~100 interop tests on
`main` for unrelated reasons). Probes that write git state go in a `mktemp -d` throwaway.
Implementers have no MCP tools: use Bash (grep/sed) over the paths above.

Windows: no file name there can hold `*`, `?`, `:` or a backslash, so every interop row whose
FIXTURE creates such a name (not merely a pathspec spelling) sits under
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (the repo convention, e.g.
test/integration/filter-clean-smudge-interop.test.ts:1377); the unit rows (memory adapter) cover
those shapes on every OS.

House rules: one RED per function, run it and watch it fail for the stated reason before writing
its code; a row that already passes is a GUARD, never a RED. After any scripted edit, confirm
`git diff --no-ext-diff --stat` shows it before trusting a gate. Poll background processes, never
end a turn waiting on one. Commit only this part's files (explicit `git add <file>…`). No phase,
ADR, backlog or matrix-row ids in source or test text (titles describe behaviour; "pinned against
git 2.55" is fine). No suppression directives.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
The design names compile-pathspec.test.ts "Given a glob \"*.ts\"" (D1) and "Given an anchored glob
\"src/**\"" (D13): their verdicts do not change, they stay green here, and Part 2 retitles them.
Consumer suites the gate sweeps (add, rm, checkout, grep, snapshot, workdir enumerator, the
existing pathspec suites) must stay green; any row there that breaks goes through the rule above.

### TDD steps

1. RED — `ref-glob.test.ts`, new describe "compileRefGlobBytes": Given well-formed refs, its verdict
   equals `compileRefGlob(pattern)(text)` for "refs/tags/*" vs "refs/tags/rel/v1", "m[a-z]in" vs
   "main", "m\\*in" vs "m*in", "m[a" vs "main" (abort → false); Given raw bytes: "a?" accepts
   `[0x61,0xff]` and rejects the bytes of "aé"; "a??" accepts "aé"; "a[^b]" accepts `[0x61,0xff]`;
   "a[[:alpha:]]" rejects `[0x61,0xff]`. Fails: `compileRefGlobBytes` is not exported (import is
   undefined → "is not a function").
   GREEN — add `compileRefGlobBytes`; rebuild `compileWith` on it; existing exports unchanged.
2. RED — `wildcard.test.ts` (create), describes "verbatimLevel" (rows: "src"/"src" EXACT,
   "src"/"src/a" RECURSIVE, "src"/"src2" NONE, "d/"/"d/x" RECURSIVE, "a?"/"a?/f" RECURSIVE,
   ""/"x" RECURSIVE, "src/a"/"src" NONE) and "hasGlobSpecial" ("*.ts", "a?", "[ab]", "a\\b" true;
   "plain.ts", "a]b", "" false). Fails: the module does not exist.
   GREEN — create wildcard.ts with `MATCH_LEVEL`, `MatchLevel`, `verbatimLevel`, `hasGlobSpecial`.
3. RED — `wildcard.test.ts`, describe "compileWildcard" over `compileWildcard(body).test(path)`:
   "src/*.ts": "src/a/b.ts" true, "src/x.ts" true, "y.ts" false · "foo*": "foo1" true,
   "dir/foobar" false · "[a-c].txt": "a.txt" true, "d.txt" false · "[!a].txt" and "[^a].txt":
   "b.txt" true, "a.txt" false · "[[:digit:]].txt": "1.txt" true · "[/a]*": "a/b" true, "x" false ·
   "a\\*b": "a*b" true, "aXb" false · "a\\?b": "a?b" true, "axb" false · "a\\b": "a\\b" true,
   "ab" true · "a?": "a?/f" true, "ab" true · "di?": "dir/file" false · "**/x.txt": "d/x.txt"
   true, "x.txt" false · "[]a]": "]" true, "a" true, "b" false · "?.txt": "é.txt" false ·
   "??.txt": "é.txt" true · "d*/": "dir/f" false · "a[": "a[" true, "ab" false · escape-view
   paths "a" followed by the escape of byte 0xff, "aé", "ab": "a?" → [true,false,true]; "a??" →
   [false,true,false]; "a[^b]" → [true,false,false]; "a[[:alpha:]]" → [false,false,true]; "a*" →
   all true. Fails: `compileWildcard` is not exported.
   GREEN — add `compileWildcard`.
4. RED — `pathspec-glob-dialect-interop.test.ts` (create): `add` rows D2, D3, D5a–D5e, D9, D11,
   D11b, D12, D16 (git vs tsgit `ls-files -s`); E4 and G3 through tsgit `grep`; E5 and C6 through
   tsgit `checkout`; R2, R4, R5, R6 through tsgit `rm`; L1–L3, L5, L6 as described in Context;
   the Linux-only lossy `add` row. They fail today because `compileOne` still uses `compileGlob`
   (D16 is even refused, read as a missing literal). GUARD rows in the same tables: D1, D4, D8a,
   D13, D14, E3, G1, G2, G4, G5, L4, R3 — run them now; each must pass before the GREEN (a GUARD
   that fails is a RED).
   GREEN — rewrite `compileOne` to the target shape; delete `compileLiteral`/`compileDirectory`
   and the `compileGlob`/`containsGlob` import (`containsGlob` stays exported until Part 4).
5. REFACTOR — rewrite the header comment of compile-pathspec.ts (lines 28-36: drop the anchoring
   and RegExp story; say verbatim first, then git's wildmatch over the path's bytes; name no ADR);
   update the `isLiteral` doc (`* ? [ \`). Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/refs test/unit/domain/pathspec test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/grep.test.ts test/unit/application/primitives/snapshot test/unit/adapters/snapshot-resolvers test/integration/pathspec-glob-dialect-interop.test.ts test/integration/glob-double-star-interop.test.ts test/integration/add-interop.test.ts test/integration/rm-interop.test.ts test/integration/grep-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/refs/ref-glob.ts test/unit/domain/refs/ref-glob.test.ts src/domain/pathspec/wildcard.ts test/unit/domain/pathspec/wildcard.test.ts src/domain/pathspec/compile-pathspec.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling && npm run check:test-pyramid; echo "gate exit=$?"
```

Run after the last edit; the printed exit code must be 0. Wireit caveat: `npm run check:types` /
`check:spelling` can print `Ran 0 scripts and skipped 1` on a cached result — the bare oracles are
`npx tsc --noEmit -p tsconfig.json` and `npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): match wildcards with git's wildmatch over the path's bytes`

## Part 2 — Allocation-free wildcard fast paths and the pathspec property suite

### Context

Files this part creates or edits (exactly these):
- `src/domain/pathspec/wildcard.ts` — fast paths inside `compileWildcard` (created by Part 1; a
  module new to this run, so the two parts share no pre-existing file).
- `test/unit/domain/pathspec/wildcard.test.ts` — rows for the shape classifier and evaluator.
- `test/unit/domain/pathspec/compile-pathspec.test.ts` — `isLiteral` and dialect rows through
  `compilePathspec`, and the two retitles. This part is the file's only editor in the run.
- `test/unit/domain/pathspec/compile-pathspec.properties.test.ts` — extended.
- `test/unit/domain/pathspec/arbitraries.ts` — new generators.

Read-only references: src/domain/pathspec/compile-pathspec.ts (Part 1's `compileOne`),
src/domain/refs/ref-glob.ts (`compileRefGlobBytes`, Part 1), src/domain/objects/encoding.ts
(`encodeEscaped`), .claude/workflow/property-testing.md (lenses, `numRuns` tiers: 200 cheap
round-trip, 100 invariant/composition, 50 filter-heavy; generators live in arbitraries.ts; never
commit a seed), test/unit/domain/pathspec/match-pathspec.properties.test.ts (style).

State after Part 1: `compileWildcard(body).test(p) = verbatimLevel(body, p) !== NONE ||
wild(encodeEscaped(p))` — it encodes every tested path.

Target (all internal, not barrelled; decision candidate 2, option A):

    export type WildcardShape =
      | { readonly kind: 'one-star'; readonly prefix: string; readonly suffix: string }
      | { readonly kind: 'general'; readonly literalPrefix: string };
    export const wildcardShape = (body: string): WildcardShape
      // one-star: exactly one '*' and no other of * ? [ \ ; general: literalPrefix = body up to
      // the first glob-special character
    export const oneStarMatches = (prefix: string, suffix: string, path: string): boolean
      // path.startsWith(prefix) && path.endsWith(suffix) && path.length >= prefix.length + suffix.length
    // compileWildcard, after the verbatim check (shape computed once per body):
    //   one-star → oneStarMatches(...)            (no encoding)
    //   general  → !path.startsWith(literalPrefix) ? false : wild(encodeEscaped(path))

Why the string compares equal the byte DP (the property suite proves it; ADR-1033 admits a fast
path only on that condition): prefix and suffix are well-formed strings, so they start and end on
code-point boundaries; the escape view decodes every valid UTF-8 sequence to its character and
every invalid byte to one lone low surrogate, so string prefix/suffix relations and the
non-overlap length test coincide with the byte relations.

Property lenses (name them in each describe): totality (lens 3) — `compilePathspec` over arbitrary
bodies drawn from letters, "/", `é`, `*`, `?`, `[`, `]`, a backslash, `!`, `^`, `-`, `:` returns
one entry per input whose `test` returns a boolean for arbitrary escape-view paths (letters, "/",
`é`, `\uDC80` and the escape of byte 0xff), numRuns 100; fast path ≡ DP (oracle delegated to the
independently tested `compileRefGlobBytes` + `verbatimLevel`, not a copy of the production loop)
— for arbitrary one-star bodies and arbitrary general bodies, `compiled.test(path) ===
(verbatimLevel(body, path) !== MATCH_LEVEL.NONE || compileRefGlobBytes(body)(encodeEscaped(path)))`,
numRuns 100; verbatim invariant (lens 4) — for every non-empty body not ending in "/",
`test(body)` and `test(body + '/' + segment)` are true, numRuns 100. Generators (`arbGlobBody`,
`arbOneStarBody`, `arbEscapedPath`) go in arbitraries.ts. The existing two properties stay.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code. No suppression directives — a dispatch mutant that survives is triaged
at validation (candidate 2).

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows the design names: compile-pathspec.test.ts "Given a glob \"*.ts\"" (verdicts unchanged —
D1; "non-anchored" is now false wording) and "Given an anchored glob \"src/**\"" (verdicts
unchanged — D13; "anchored" goes) — GUARDs retitled in REFACTOR.

### TDD steps

1. GUARD — `compile-pathspec.test.ts`: `isLiteral` false for "a[", "a\\", "[]a]", "a\\b", true for
   "src/foo.ts"; `compilePathspec(["foo*"])[0].compiled.test("dir/foobar")` false and
   `compilePathspec(["src/*.ts"])[0].compiled.test("src/a/b.ts")` true (Part 1 made these pass —
   run to confirm).
2. RED — `wildcard.test.ts`, describes "wildcardShape" ("*.ts" → one-star "" / ".ts"; "src/*.ts"
   → one-star "src/" / ".ts"; "foo*" → one-star "foo" / ""; "a*b*" → general "a"; "src/[ab]*" →
   general "src/"; "a\\*" → general "a") and "oneStarMatches" ("", ".ts", ".ts" true; "a", "a",
   "a" false (overlap); "src/", ".ts", "src/a/b.ts" true; "src/", ".ts", "lib/x.ts" false; "a", "",
   "a" followed by the escape of byte 0xff true). Fails: not exported.
   GREEN — add both (pure, no wiring yet).
3. GUARD — `compile-pathspec.properties.test.ts`: the three properties of Context, written and run
   against the Part 1 code (no fast path wired: they hold by construction). Generators in
   `arbitraries.ts`.
4. REFACTOR — wire the shape into `compileWildcard`; re-run the properties and every pathspec row:
   all green. Retitle the two named rows.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/pathspec test/unit/domain/refs test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/grep.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/pathspec/wildcard.ts test/unit/domain/pathspec/wildcard.test.ts test/unit/domain/pathspec/compile-pathspec.test.ts test/unit/domain/pathspec/compile-pathspec.properties.test.ts test/unit/domain/pathspec/arbitraries.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): match one-star and literal-prefix wildcards without encoding the path`

## Part 3 — describe and name-rev patterns use git's wildmatch dialect

### Context

Files this part creates or edits (exactly these):
- `src/domain/describe/match.ts` — flags-0 matcher on the short tag name.
- `test/unit/domain/describe/match.test.ts`
- `test/integration/describe-interop.test.ts` — DS rows.
- `src/domain/name-rev/ref-pattern.ts` — every-suffix matching, compile once, `abbreviates`.
- `test/unit/domain/name-rev/ref-pattern.test.ts`

Every N interop row (name-rev-interop.test.ts) lands in Part 10, the run's only editor of that
file: most N rows need the `abbreviated` field Part 10 adds, and one owner keeps the twin
fixtures in one place. This part proves its filter with unit rows.

Read-only references: src/domain/refs/ref-glob.ts (`compileRefGlob`), src/application/commands/
describe.ts (`buildNameFilter` caller at :193, `describeContains` at :113 maps patterns to
refs/tags/<pat>), src/application/commands/internal/describe-options.ts (`match`, `exclude`:
string or array), src/application/commands/name-rev.ts (`buildRefFilter` caller at :92 —
`filter.qualifies` only, unchanged here), src/application/commands/internal/name-rev-options.ts
(`refs`, `exclude`, `tags`), test/unit/domain/describe/match.properties.test.ts (GUARD, unchanged).

Current code:
- describe/match.ts: `anchored = (p) => compileGlob(p, { anchored: true })`; `buildNameFilter(include,
  exclude): NameFilter { matches(name) }` (include any-of, exclude wins); `tagNameMatches`.
- name-rev/ref-pattern.ts: `RefFilter { qualifies(ref) }`; `buildRefFilter({ tags, refs, exclude })`
  tests `matchRefGlob(pattern, ref)` on the FULL ref, recompiling per ref; HEAD never qualifies;
  `tags` gate = starts with "refs/tags/".

Target:
- describe/match.ts: include/exclude matchers = `compileRefGlob` (flags 0, `*`/`?` cross "/",
  `[…]`, `\x`); logic unchanged; drop the `compileGlob` import (Part 4 depends on this).
- ref-pattern.ts (internal; `RefFilter` is not barrelled; `buildRefFilter` is exported from
  src/domain/name-rev/index.ts, which no public entry re-exports):

      export interface RefFilter { qualifies(ref: string): boolean; abbreviates(ref: string): boolean }
      // git's subpath_matches: the first offset (0, then after each '/') whose suffix matches
      const subpathOffset = (matches: (text: string) => boolean, ref: string): number | undefined
      // buildRefFilter compiles every include/exclude ONCE with compileRefGlob
      // qualifies: HEAD → false; tags gate; any exclude with an offset → false;
      //            includes empty or any include with an offset → true
      // abbreviates: some include whose FIRST matching offset is > 0 (fact 5)

  Leave `matchRefGlob` exported in ref-glob.ts (its contract is kept; tests use it).

Matrix rows: DS2–DS7, DS14 flip; DS1, DS8–DS13 GUARD. The N rows this filter flips (N7, N8,
N10, N11, N12) are pinned at command level in Part 10.

Fixtures: DS — `v1.0` annotated + `w2` lightweight on c1, "v1/rc1" annotated on c2, HEAD c3; git
side `describe --tags --abbrev=0 [opts]` (DS14: no `--tags`); compare the tag name tsgit reports
(read DescribeResult in describe.ts) or the refusal (git 128 `fatal: No names found, cannot
describe anything.` ↔ tsgit's no-names error code, read `noNames` in describe.ts).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits. Poll, never wait. Commit only these files. No provenance ids in code. Rewrite
the stale headers (describe/match.ts:1-6 says "anchored compileGlob … no character classes";
ref-pattern.ts:1-8 says "matches the full refname") without naming ADRs.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Row the design names: match.test.ts "* does not cross the slash" ("release/v1" with `release*` →
false) is re-pinned to true (DS2: `--match 'v*'` names "v1/rc1").

### TDD steps

1. RED — `match.test.ts`: re-pin the slash row; add "v1.0" with "v[0-9].*" true, "v1/rc1" with
   "v1?rc1" true, "v1.0" with "v1\\.*" true, "v1/rc1" with "v1\\/*" true, "v1.0" with "[v]1.0"
   true; GUARDs "v1.0" with "v1[" false and "v1.0" with "v1\\" false (no match today either).
   In the same step, `describe-interop.test.ts`: the DS1–DS14 table (DS2–DS7, DS14 red today;
   DS1, DS8–DS13 GUARDs). Run: the flips fail because `compileGlob` keeps `*` inside a segment
   and reads `[`/`\` verbatim.
   GREEN — switch describe/match.ts to `compileRefGlob`.
2. RED — `ref-pattern.test.ts`: include through a suffix — refs ["v*"] qualifies
   "refs/tags/v1.0"; ["tags/*"] qualifies it; ["main"] qualifies "refs/heads/main"; GUARD
   ["ags/v1.0"] does not; exclude through a suffix — exclude ["tags/*"] drops "refs/tags/v1.0";
   exclude ["v*"] drops it. Fails: only the full ref is matched.
   GREEN — `subpathOffset` + compile-once in `buildRefFilter`.
3. RED — `ref-pattern.test.ts`, "abbreviates": ["v*"] → true for "refs/tags/v1.0";
   ["refs/tags/*"] → false; ["refs/tags/v*", "v1.*"] → true; ["*1.0"] → false (first offset 0);
   no includes → false. Fails: the method does not exist.
   GREEN — add `abbreviates`.
4. REFACTOR — rewrite both stale headers; gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/describe test/unit/domain/name-rev test/unit/application/commands/describe.test.ts test/unit/application/commands/describe.properties.test.ts test/unit/application/commands/name-rev.test.ts test/unit/application/commands/name-rev-tip-table.test.ts test/unit/application/commands/name-rev-skip.test.ts test/integration/describe-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/describe/match.ts test/unit/domain/describe/match.test.ts test/integration/describe-interop.test.ts src/domain/name-rev/ref-pattern.ts test/unit/domain/name-rev/ref-pattern.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(describe): match tag and ref patterns as git's wildmatch does, on every ref suffix`

## Part 4 — compileGlob keeps only the gitignore dialect

### Context

Files this part creates or edits (exactly these):
- `src/domain/pathspec/compile-glob.ts` — remove the dead mode.
- `test/unit/domain/pathspec/compile-glob.test.ts` — drop the removed mode's rows and `containsGlob`.
- `test/unit/domain/pathspec/compile-glob.properties.test.ts` — CREATED (property sibling).
- `src/domain/ignore/parse-gitignore.ts` — line 101 drops `pathname: true`.
- `src/domain/attributes/parse-gitattributes.ts` — line 125 drops `pathname: true`.
- `src/domain/sparse/non-cone.ts` — line ~29 drops `pathname: true`.

Read-only references: test/unit/domain/pathspec/arbitraries.ts (`arbLiteralPattern`,
`arbCandidatePath`), test/perf/domain/pathspec/compile-glob.perf.test.ts (uses
`{ anchored: true }` only — still compiles), .claude/workflow/property-testing.md,
test/integration/glob-double-star-interop.test.ts (must stay green unchanged — R9).

Precondition (verify with grep before editing): after Parts 1 and 3 no caller passes a
`compileGlob` options object without `pathname: true`:
`grep -rn "compileGlob(" src` lists only parse-gitignore.ts, parse-gitattributes.ts, non-cone.ts.

Current compile-glob.ts: `CompileGlobOptions { anchored; withDirSuffix?; pathname? }`;
`scanToken(pattern, i, options)` dispatches `*` to `scanPathnameStar` when `options.pathname === true`
else `scanStar`; `tokenize(pattern, options)`; `containsGlob` exported; header says it serves
`compilePathspec` and "[abc] NOT supported in v1". Six `Stryker disable next-line` equivalence
lines (:122, :131, :143, :154, :166, :199) — keep them byte-identical.

Target (ADR-1041): `CompileGlobOptions { anchored; withDirSuffix? }`; `scanToken(pattern, i)` sends
every `*` to `scanPathnameStar`; delete `scanStar` and `containsGlob`; `tokenize(pattern)`. Header:
the gitignore-family dialect (gitignore, gitattributes, non-cone sparse) = git's WM_PATHNAME star
rule; `[…]` and `\` are matched verbatim in this dialect; no mention of pathspecs or "v1". The
exported names `compileGlob`, `GlobMatcher`, `CompileGlobOptions` stay (src/domain/pathspec/index.ts
barrel unchanged; internal).

Test file: the regex oracle loses `oracleStar` and the `pathname` branch (always
`oraclePathnameStar`); `arbOptions` loses `pathname`. The `pathname` const block loses its
`pathname: true` and is retitled "Given the gitignore dialect". Rows set without `pathname`
whose verdict depended on the removed star mode fail once the mode goes — they are the removed
mode's own rows and are deleted with it (ADR-1041), not re-pinned; rows that still pass stay. Expect
"Given a `**` NOT followed by "/"" and "Given a `***` run" among them; let the run decide. Delete the
`containsGlob` describe.

Property sibling (lenses): totality (lens 3) — for arbitrary printable-ASCII, NUL-free patterns and
options `{ anchored, withDirSuffix }`, `compileGlob(...).test(path)` returns a boolean for arbitrary
paths, numRuns 100; self-match (lens 2 identity) — a special-free pattern (segments from
`arbLiteralPattern` joined by "/") under `{ anchored: true }` matches exactly itself and rejects
itself + "x", numRuns 100.

House rules: GUARD = already passes; this part has no new behaviour, so it is GUARD + REFACTOR.
`git diff --no-ext-diff --stat` after scripted edits. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code. Exception named by
ADR-1041: rows of the removed non-gitignore star mode are deleted with the mode.

### TDD steps

1. GUARD — create `compile-glob.properties.test.ts` with the two properties; they pass on the
   current code (pathname mode already behaves so).
2. REFACTOR — remove `pathname` from the three callers and the options type, route every `*` to
   `scanPathnameStar`, delete `scanStar` and `containsGlob`; update the oracle, delete the failing
   removed-mode rows and the `containsGlob` describe; retitle; rewrite the header. Every
   gitignore/attributes/sparse suite stays green unchanged.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/pathspec test/unit/domain/ignore test/unit/domain/attributes test/unit/domain/sparse test/integration/glob-double-star-interop.test.ts \
  && npx vitest run --config vitest.perf.config.ts test/perf/domain/pathspec/compile-glob.perf.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/pathspec/compile-glob.ts test/unit/domain/pathspec/compile-glob.test.ts test/unit/domain/pathspec/compile-glob.properties.test.ts src/domain/ignore/parse-gitignore.ts src/domain/attributes/parse-gitattributes.ts src/domain/sparse/non-cone.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`. If a listed test directory does not
exist, drop it from the command (do not invent files).

### Commit

`fix(pathspec): keep only the gitignore dialect in compileGlob`

## Part 5 — One command pathspec intake: positives in argument order, unmatched helper

### Context

Files this part creates or edits (exactly these):
- `src/application/commands/internal/pathspec-intake.ts` — CREATED: the intake every command uses.
- `test/unit/application/commands/internal/pathspec-intake.test.ts` — CREATED.
- `src/application/commands/grep.ts` — switch its one `resolvePathspec` call (:198) to the intake.
- `test/unit/application/commands/checkout-switch-target.test.ts` — shape assertion at :57.
- `test/unit/application/commands/switch-and-tag-target-dwim.test.ts` — shape assertion at :168.
- `test/integration/pathspec-dot-interop.test.ts` — shape assertions at :115 and :169.

Why a new module instead of new `ResolvedPathspec` fields: src/application/commands/internal/
resolve-pathspec.ts then has exactly one editor in the run (Part 9, which relaxes its validator and
deletes the helpers this run retires), and the host policy enters through one function that every
command already calls from its own part (rm 6, add 7, checkout 8, grep here) — Part 9 changes no
command file.

Why the shape edits live here: Part 8 adds `patterns` to `PATHSPEC_NO_MATCH`, which breaks every
`toEqual({ code: 'PATHSPEC_NO_MATCH', pattern })`. Each single-pattern assertion is rewritten to
`toEqual(pathspecNoMatch(<same pattern>).data)` (import from src/domain/commands/error.ts) —
identical today, still exact once the factory fills `patterns`. Parts 6, 7, 8 convert the rows in
the files they own (rm.test.ts, add.test.ts, add-directory-file.test.ts, checkout.test.ts).

Read-only references: src/application/commands/internal/resolve-pathspec.ts
(`resolvePathspec(patterns): ResolvedPathspec { matcher, literalMustMatch, literalSpellings,
hasGlob, symlinkScanTargets }`; `matcher` is index-aligned with the input patterns; whole tree =
body `''`), src/domain/objects/encoding.ts (`wellFormed`), src/domain/pathspec/compile-pathspec.ts
(`PathspecEntry`), src/domain/commands/error.ts (`pathspecOutsideRepo(path)`), src/ports/context.ts
(`Context.windowsPathSyntax?: boolean` at :358 — "the filesystem reads paths the Windows way";
set by the node adapter on Windows, src/adapters/node/node-adapter.ts:155; absent on memory and
browser), src/application/primitives/internal/git-path-syntax.ts:98 and index-path-rules.ts:8
(how primitives read the flag: they take `ctx` structurally as `{ readonly windowsPathSyntax?:
boolean }` — follow the same shape).

Target (internal; not barrelled):

    export interface PathspecHost { readonly windowsPathSyntax?: boolean }   // a Context satisfies it
    export interface PositivePathspec {
      readonly entry: PathspecEntry;
      readonly spelling: string;      // the well-formed raw pattern as typed ('./d', '.', 'nomatch*')
      readonly probesDisk: boolean;   // false for a body holding a backslash (ADR-1044: matching only)
    }
    export interface CommandPathspec extends ResolvedPathspec {
      readonly positives: ReadonlyArray<PositivePathspec>;   // non-negated, argument order, duplicates kept
    }
    export const resolveCommandPathspec = (host: PathspecHost, paths: ReadonlyArray<string>): CommandPathspec
      // 1. under host.windowsPathSyntax === true: the first pattern whose body (leading '!'
      //    stripped) holds a backslash → throw pathspecOutsideRepo(body)  — git for Windows reads
      //    '\' as a separator; tsgit keeps refusing it there (ADR-1044)
      // 2. resolvePathspec(paths), then positives from matcher + wellFormed(paths[i])
    export const unmatchedPositives = (
      positives: ReadonlyArray<PositivePathspec>,
      isSeen: (positive: PositivePathspec) => boolean,
    ): ReadonlyArray<PositivePathspec>   // argument order

Step 1 runs before `resolvePathspec`, so on a Windows host the intake — not the general validator —
is what refuses a backslash; today the general validator also refuses it on every host (Part 9
relaxes that for POSIX). The refusal data stays `{ code: 'PATHSPEC_OUTSIDE_REPO', path }`.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code. No row is expected
to change: grep's behaviour is identical through the intake (G rows stay green).

### TDD steps

1. RED — `pathspec-intake.test.ts`, "positives": `resolveCommandPathspec({}, ['src/foo', '*.ts',
   '!*.test.ts', './d', 'src/foo'])` → spellings `['src/foo', '*.ts', './d', 'src/foo']`, bodies
   `['src/foo', '*.ts', 'd', 'src/foo']`, every `probesDisk` true; `['.']` → one positive, body `''`,
   spelling `.`; `['!x']` → none; the other `ResolvedPathspec` fields equal `resolvePathspec`'s.
   Fails: the module does not exist. GREEN — create it (steps 1–2 of the target, no host check yet).
2. RED — "probesDisk": the positive built from the entry `compilePathspec(['a\\*b'])[0]` (call the
   exported builder directly — the intake still refuses a backslash on every host until Part 9)
   has `probesDisk` false. Export the per-entry builder (`positiveOf(entry, spelling)`) for this.
   Fails: always true. GREEN — `probesDisk = !entry.body.includes('\\')`.
3. GUARD — "Windows host": `resolveCommandPathspec({ windowsPathSyntax: true }, ['ok', '!a\\b'])`
   throws PATHSPEC_OUTSIDE_REPO with `path: 'a\\b'`; a backslash-free spec resolves. It passes
   today through the general validator (collapsePattern refuses every backslash before the budget
   check). REFACTOR under this GUARD: add the host check (target step 1) so the Windows refusal is
   the intake's own; it becomes the only refusal once Part 9 relaxes the general validator, and
   Part 9's POSIX-accept rows are the RED that make it observable (until then its mutants are
   equivalent — say so in the part report, add no suppression).
4. RED — "unmatchedPositives": three positives, `isSeen` true for the second → first and third in
   order; all seen → empty. Fails: not exported. GREEN — add it.
5. GUARD — grep.ts calls `resolveCommandPathspec(ctx, opts.paths)`; the grep suite and G interop
   rows stay green. Convert the three shape assertions to `pathspecNoMatch(…).data`; green.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/internal/pathspec-intake.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/grep.test.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/switch-and-tag-target-dwim.test.ts test/integration/pathspec-dot-interop.test.ts test/integration/grep-interop.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/pathspec-intake.ts test/unit/application/commands/internal/pathspec-intake.test.ts src/application/commands/grep.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/switch-and-tag-target-dwim.test.ts test/integration/pathspec-dot-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): resolve command pathspecs through one intake that keeps positives in argument order`

## Part 6 — rm refuses by match level

### Context

Files this part creates or edits (exactly these):
- `src/application/commands/rm.ts`
- `test/unit/application/commands/rm.test.ts` — this part is its only editor in the run (it also
  converts the shape row at :125, see Part 5).
- `src/domain/pathspec/match-pathspec.ts` — `pathspecMatchLevel`.
- `test/unit/domain/pathspec/match-pathspec.test.ts`
- `test/integration/pathspec-glob-dialect-interop.test.ts` — extend with the R refusal rows
  (created by Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts
(`resolveCommandPathspec(ctx, paths)`, `positives`), src/domain/pathspec/wildcard.ts
(`MATCH_LEVEL`: NONE 0 < RECURSIVE 1 < FNMATCH 2 < EXACT 3, `verbatimLevel`),
src/domain/git-index/index-path-key.ts (`escapedPathOf`), src/domain/commands/error.ts
(`pathspecNoMatch`, `rmRecursiveWithoutR(pattern)`), src/domain/pathspec/compile-pathspec.ts
(`PathspecEntry`).

Current rm.ts (:72): `resolvePathspec(paths)` → `{ matcher, literalSpellings }`; lock; read index
(tolerating `isIndexMissingCode`); `groupByPath`; removal set by `matchesIndexPath(matcher,
first)`; `enforceLiteralMatches(literalSpellings, removed, reach)` (:~176, literals only:
no-match, then `rmRecursiveWithoutR(spelled)` when the literal did not name a path itself); then
the safety valve and removals.

Target (ADR-1042, fact 6):

    // match-pathspec.ts (internal)
    export const pathspecMatchLevel = (entry: PathspecEntry, path: FilePath): MatchLevel
      // verbatimLevel(entry.body, path) if not NONE; else FNMATCH if entry.compiled.test(path);
      // else NONE. matchesPathspec, withoutExactly, matchesUnmergedPath keep their code (ADR-1000).
    // rm.ts: resolveCommandPathspec(ctx, paths); replace enforceLiteralMatches with, at the same
    // point (before enforceSafetyValve and any removeFile), in argument order:
    for p of positives:
      level = max over byPath groups of pathspecMatchLevel(p.entry, escapedPathOf(first stage))
      level === NONE                       → throw pathspecNoMatch(p.spelling)
      level === RECURSIVE && !recursive    → throw rmRecursiveWithoutR(p.spelling)

The whole tree (`.`, body `''`) is RECURSIVE for every path, so `rm .` without `recursive` still
refuses naming `.` and an empty index refuses it as unmatched (rows at rm.test.ts:136-156 stay
GUARDs). rm no longer calls `enforceLiteralMustMatch`; Part 9 deletes it once Parts 7 and 8 drop
the other callers.

Matrix rows: R1, R1b, R4b, R7, R8 flip; R4c, R2–R6 GUARD (R2–R6 landed in Part 1; R4 stays green
because FNMATCH outranks RECURSIVE), K3 GUARD (rm already locks first). ADR-1012 (resolve-undo,
pending operations) is untouched — its rows in rm.test.ts are GUARDs. Interop asserts git's 128 +
`fatal: pathspec '<p>' did not match any files` or `fatal: not removing '<p>' recursively without
-r`, the index, and that the working-tree file still exists (R1).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

Windows: no file name there can hold `*`, `?`, `:` or a backslash, so every interop row whose
FIXTURE creates such a name (R4b's `a?/f`) sits under
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`; the unit rows (memory adapter)
cover those shapes on every OS.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: rm.test.ts:405 "Given a glob \"*.nope\" with no matches" (`removed: []`) →
refuses PATHSPEC_NO_MATCH '*.nope' (R7/R8 shape); :455 and :474 (corrupt index tolerated, `*.nope`
→ `removed: []`) and :505 (readIndex racing to FILE_NOT_FOUND) → now throw PATHSPEC_NO_MATCH
'*.nope' — the tolerance they exist to prove still shows (the parse error does not surface);
:560 (PERMISSION_DENIED propagates) stays a GUARD. :391 "both are removed (no PATHSPEC_NO_MATCH for
globs)" keeps its verdict; only the parenthetical in its title is false — retitle. :125 shape row
→ `toEqual(pathspecNoMatch('./nomatch').data)` (same expectation, Part 8-proof).

### TDD steps

1. RED — `match-pathspec.test.ts`, describe "pathspecMatchLevel": "src" vs "src" EXACT, vs
   "src/a" RECURSIVE; "a?" vs "a?/f" RECURSIVE, vs "ab" FNMATCH, vs "zz" NONE; "d*" vs "dir/f"
   FNMATCH; "" (whole tree) vs "x" RECURSIVE; "!src" negated entry vs "src" EXACT (the level ignores
   negation — callers pass positives). Fails: not exported. GREEN — add it.
2. RED — rm.test.ts R1: `rm(ctx, ['nomatch*', 'tracked.txt'])` throws PATHSPEC_NO_MATCH
   'nomatch*', `tracked.txt` stays in the index and on disk; R1b with the order swapped, same.
   Re-pin :405, :455, :474, :505 here. Interop R1, R1b, R7, R8. Fails: globs never refuse.
   GREEN — intake + per-positive levels, NONE branch.
3. RED — R4b: index `a?/f`, `zz`, `rm(ctx, ['a?'])` → RM_RECURSIVE_WITHOUT_R 'a?', nothing removed;
   with `recursive: true` removes `a?/f`. Interop R4b (R4c GUARD). Fails: the `-r` check covers
   literals only. GREEN — RECURSIVE branch; delete `enforceLiteralMatches`.
4. REFACTOR — convert :125; retitle :391. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/rm.test.ts test/unit/domain/pathspec test/unit/application/commands/internal test/integration/pathspec-glob-dialect-interop.test.ts test/integration/rm-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/rm.ts test/unit/application/commands/rm.test.ts src/domain/pathspec/match-pathspec.ts test/unit/domain/pathspec/match-pathspec.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(rm): refuse an unmatched or directory-reaching pathspec by match level`

## Part 7 — add refuses an unmatched pathspec before any object write

### Context

Files this part creates or edits (exactly these):
- `src/application/commands/add.ts`
- `test/unit/application/commands/add.test.ts`
- `test/unit/application/commands/add-directory-file.test.ts` — the shape assertion at :1064 only.
- `test/integration/pathspec-glob-dialect-interop.test.ts` — extend with the B, D7/D8c/D10, RN, K2
  rows (created by Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts
(`resolveCommandPathspec(ctx, paths)`, `positives`, `PositivePathspec { entry, spelling,
probesDisk }`, `unmatchedPositives`), src/application/commands/internal/resolve-pathspec.ts
(`namesWholeTree`, `ResolvedPathspec`), src/domain/pathspec/match-pathspec.ts
(`pathspecMatchLevel`, Part 6), src/domain/pathspec/wildcard.ts (`MATCH_LEVEL`),
src/domain/git-index/index-path-key.ts (`escapedPathOf`), src/domain/commands/error.ts
(`pathspecNoMatch(pattern)`), src/application/primitives/walk-working-tree.ts (`walkWorkingTree`
yields `WalkWorkingTreeEntry { path, … }`).

Current add.ts anchors (unchanged by Parts 1–6):
- `dispatchPathspec` :218 — `hasGlob` or a missing/directory literal → `addByPathspec`; else
  `addLiteralOnly` (every literal is an existing file; no refusal needed there, unchanged).
- `addByPathspec` :720 — `buildRepoIgnorePredicate`, `acquireIndexLock`, then
  `stageIgnoredWalk(ctx, repoIgnore, matcher, scope, guard)` which hashes and writes blobs, then
  `enforceLiteralMustMatch(mustMatch, [...matched, ...settled.everyRemoval], literalSpellings)` at
  :748 — the refusal comes after the writes (B1/B2 leave loose blobs).
- `stageIgnoredWalk` :883 — `readExistingEntries(ctx)` (:1174, gives `sorted`: every index entry,
  one per stage), `withPathspec(repoIgnore, matcher, unmergedStages)`, then
  `stageWalkedEntries(ctx, walkWorkingTree(ctx, { ignore }), …)`.
- `stageWalkedEntries` :622 (also called by `addAll` :1043) takes `walk: AsyncIterable<WalkWorkingTreeEntry>`
  and passes it to `walkedTrackedFirst` :647 (`for await`, buffers everything in a Map first —
  fact 7). `dispatchInCleanOrder` already accepts `AsyncIterable<T> | Iterable<T>`.
- `addRenormalized` :778 — lock, `readIndexOrEmpty`, `renormalizeEntries` (writes blobs), then
  `literalsOnDisk(ctx, literalMustMatch)` :811 + `enforceLiteralMustMatch(mustMatch, onDisk, …)`
  :799; the `Stryker disable next-line MethodExpression` at :797 sits on the `mustMatch` line that
  this part deletes — the mark goes with its line; add no new mark.
- `lstatOrBeneathFile` :573 (a NOT_A_DIRECTORY probe → undefined) and `lstatOrMissing` :592.

Target:
- `stageWalkedEntries` and `walkedTrackedFirst` accept `AsyncIterable<WalkWorkingTreeEntry> |
  Iterable<WalkWorkingTreeEntry>`.
- `dispatchPathspec` (:223) and `addRenormalized` (:783) call `resolveCommandPathspec(ctx, paths)`
  instead of `resolvePathspec(paths)`; `WHOLE_TREE_MATCHER` (:186) keeps `resolvePathspec` (it only
  ever resolves '.').
- `addByPathspec` reads `{ matcher, positives }`; `stageIgnoredWalk` (gains `positives`) reads the
  index, collects the walk into an array, runs the refusal, then stages from the array. Delete the
  post-staging `enforceLiteralMustMatch` and `mustMatch` in `addByPathspec`.
- Refusal for the walk (git's `seen`, ADR-1035/1036, candidate 3 A):

      candidates = positives minus whole-tree bodies (add never refuses '.')
      seen(p) = sorted.some(e => p.entry.compiled.test(escapedPathOf(e)))
             || walked.some(w => p.entry.compiled.test(w.path))
      for p of unmatchedPositives(candidates, seen):            // argument order
        if (!p.entry.isLiteral && p.probesDisk && await lstatOrBeneathFile(ctx, body) !== undefined) continue
        throw pathspecNoMatch(p.spelling)

  (`compiled.test` true ⇔ `pathspecMatchLevel` ≠ NONE; use whichever reads clearer.)
- `addRenormalized`: `{ matcher, positives, symlinkScanTargets }`; after the lock and
  `readIndexOrEmpty`, BEFORE `renormalizeEntries`: seen = index entries only (git runs no directory
  fill under `--renormalize`); an unseen positive whose verbatim body `lstat`s (literal OR wildcard —
  candidate 4 A; RN4, RN5) and whose `probesDisk` is true is accepted; else `pathspecNoMatch(spelling)`. Delete `literalsOnDisk`
  if nothing else calls it.
- The escape probe uses `lstatOrBeneathFile` (a body beneath a regular file is "missing", not a
  NOT_A_DIRECTORY throw). On Windows a name holding `*` or `?` is an invalid name; libuv reports it
  as ENOENT, which the node adapter maps to FILE_NOT_FOUND — if the Windows CI leg shows another
  code, report it as a blocker rather than widening the catch.
- The shape assertions in add.test.ts (:160, :176, :3433, :4025) and add-directory-file.test.ts
  (:1064) become `toEqual(pathspecNoMatch(<pattern>).data)` (see Part 5 for why; Part 8 adds `patterns`).

Matrix rows: B1, B2, B2b, B3, B3x, B3d, B4, B4b, B4c, B9, B10b, B12, B12r (fact 4), B11′ (fact 2),
D7, D8c, D10, RN1, RN2, RN4, RN6 flip; B6, B7, B8, B10, RN3, RN5, K2 GUARD. B3l/B3m are out of scope.
Interop asserts git's exit 128 + stderr `fatal: pathspec '<p>' did not match any files`
reconstructed from `err.data.pattern`, the index (`git ls-files -s`) and the loose-object count
(`.git/objects/??/*`) on both twins. Unit atomicity: the existing `blobExists(ctx, content)` helper
(add.test.ts:2884) is false after the refusal, and `readIndex` is unchanged.

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

Windows: no file name there can hold `*`, `?`, `:` or a backslash, so every interop row whose
FIXTURE creates such a name (not merely a pathspec spelling) sits under
`describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')`; the unit rows (memory adapter)
cover those shapes on every OS.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits. Poll, never wait. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: add.test.ts:1652 "Given a glob with no match" (`add(['*.ts'])` over
README.md → `added: []`) is re-pinned to refuse `PATHSPEC_NO_MATCH` '*.ts' with the index
unchanged (B9 shape); add.test.ts:296 "Given a glob whose magic sits in the leading path
component…" (`add(['li*/x.ts'])` on an empty repo → empty result) is re-pinned to refuse
`PATHSPEC_NO_MATCH` 'li*/x.ts' — its own title records that git 2.55 "falls through to a plain
no-match"; it must still NOT be PATHSPEC_BEYOND_SYMLINK.

### TDD steps

1. RED — add.test.ts: Given `real.txt`, `add(['nomatch*', 'real.txt'])` throws
   PATHSPEC_NO_MATCH naming 'nomatch*', the index stays empty and `blobExists(ctx, <real.txt
   content>)` is false. Fails: today it stages real.txt and writes its blob. Re-pin the two rows
   named in Context in the same step. Add the interop rows B1, B2, B2b, B3, B3x, B3d, B4, B4b,
   B4c, B9, B10b, B12, B12r, D7, D8c, D10 (red today) with B6, B7, B8, B10, K2 as GUARDs; run.
   GREEN — iterable widening, collect-then-refuse in `stageIgnoredWalk`, delete the post-staging
   check.
2. GUARD — add.test.ts: index-only seen (tracked `gone.txt` deleted from disk, `add(['gone*'])`
   stages the deletion, no refusal); B10b order (`add(['n1*', 'missing'])` names 'n1*'); B12
   (`add(['.', 'nomatch*'])` names 'nomatch*'). They pass on step 1's code — run to confirm.
3. RED — B11′: file `nomatch*`, `.gitignore` `nomatch?`, `add(['nomatch*'])` → no error, index
   empty (unit + interop). Fails: step 1 refuses it. GREEN — the verbatim-body `lstat` escape for
   wildcard entries.
4. RED — RN1 `add(['nomatch*'], RENORMALIZE)` on tracked `a.txt` refuses 'nomatch*'; RN2
   `add(['a*', 'nomatch*'], RENORMALIZE)` refuses with the index unchanged and no new blob; RN6
   `untr*` naming only an untracked file refuses (unit + interop). Fails: globs never refuse
   under renormalize. GREEN — move the check before `renormalizeEntries`, index-only seen, on-disk
   escape for any unseen positive. RN3, RN4, RN5 and the existing renormalize refusal rows
   (add.test.ts:3416, :3443) are GUARDs.
5. REFACTOR — convert the five shape assertions; update the `addByPathspec` comment (:715-719) if
   it mentions the old refusal. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/add.test.ts test/unit/application/commands/add-directory-file.test.ts test/unit/application/commands/add-unmerged.test.ts test/unit/application/commands/add-clean-order.test.ts test/unit/application/commands/add-big-file-threshold.test.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/add-interop.test.ts test/integration/add-all.test.ts test/integration/add-unmerged-interop.test.ts test/integration/pathspec-dot-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/add.ts test/unit/application/commands/add.test.ts test/unit/application/commands/add-directory-file.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`.

### Commit

`fix(add): refuse an unmatched pathspec before any object write, as git does`

## Part 8 — checkout locks and reads the index first, then names every unmatched pathspec

### Context

Files this part creates or edits (exactly these):
- `src/domain/commands/error.ts` — `PATHSPEC_NO_MATCH` gains `patterns`.
- `test/unit/domain/commands/error.test.ts`
- `src/application/commands/checkout.ts`
- `test/unit/application/commands/checkout.test.ts`
- `test/integration/pathspec-glob-dialect-interop.test.ts` — extend with C and K rows (created by
  Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts
(`resolveCommandPathspec(ctx, paths)`, `positives`, `unmatchedPositives`),
src/domain/git-index/index-path-key.ts (`escapedPathOf`).

Public surface (decided here): `PATHSPEC_NO_MATCH` is a member of the public `CommandError` union
(reachable through `TsgitError.data`). Adding `patterns` is an additive member change:
- exhaustiveness switches: none change — the code string is unchanged; the message switch in
  src/domain/error.ts:454 keeps `pathspec did not match any files: ${data.pattern}`;
- barrel-surface/error-code set tests: the set of codes is unchanged, nothing to update;
- every `toEqual({ code: 'PATHSPEC_NO_MATCH', pattern })` was converted in Parts 5, 6 and 7; the
  remaining ones are in this part's files (checkout.test.ts:1870, error.test.ts:147 and the
  `CommandError`-typed message table at error.test.ts:1706, which needs `patterns` to type-check);
- reports/api.json changes — regenerated ONCE in Part 10 (which also changes the public surface),
  before any push; api.json is a prepush gate, not a validate gate.

Target type and factory (ADR-1037; the tuple type makes "non-empty, `patterns[0] === pattern`"
a compile-time fact):

    | { readonly code: 'PATHSPEC_NO_MATCH'; readonly pattern: string;
        readonly patterns: readonly [string, ...string[]] }
    export const pathspecNoMatch = (pattern: string, ...others: string[]): TsgitError =>
      new TsgitError({ code: 'PATHSPEC_NO_MATCH', pattern, patterns: [pattern, ...others] });

Existing one-argument callers (add, submodule.ts:156, checkout.ts:143 for an unresolvable switch
target, renormalize) keep compiling and get a one-entry `patterns`.

Current checkout.ts `pathRestore` (:339): resolves the source, `resolvePathspec`, then
`enumerateSourcePaths` (:466; the index source reads the index BEFORE any lock), filters `matched`,
`enforceLiteralMustMatch(literalMustMatch, …)`, returns a no-op when `pathSet` is empty ("Glob with
zero matches → no-op"), and only then `materializePathRestoreFromIndex` (:397) /
`materializePathRestoreLocked` (:425), each acquiring its own lock and reading the index again.
The post-checkout hook runs after the lock is released.

Target (ADR-1038, candidate 5 A):

    source = await pathSourceFor(...)                 // an unresolvable rev still refuses first
    { matcher, positives } = resolveCommandPathspec(ctx, paths)   // pathspec intake still before the lock
    lock = await acquireIndexLock(ctx)
    try:
      currentIndex = await readIndex(ctx)            // K4/K5: a corrupt index refuses here
      universe = source === undefined ? currentIndex.entries : <tree walk of source.tree>  (C8)
      unmatched = unmatchedPositives(positives, p => universe.some(e => p.entry.compiled.test(escapedPathOf(e))))
      if unmatched non-empty: throw pathspecNoMatch(unmatched[0].spelling, ...rest spellings)
      pathSet = matched paths; if empty: return no-op (lock released by finally, no index write)
      materialize with the held lock and currentIndex; lock.commit(...)
    finally: lock.release()
    then the post-checkout hook, outside the lock, as today

`materializePathRestoreFromIndex` / `materializePathRestoreLocked` take `(ctx, lock,
currentIndex, …)` instead of acquiring and reading; `enumerateSourcePaths` takes the read index for
the index source. Keep the existing `Stryker disable next-line` lines in checkout.ts (:389
ArithmeticOperator on `changedPaths`, :477 ConditionalExpression in `enumerateSourcePaths`)
byte-identical with their code. Fix the stale comments at :345-352 (pre-lock read) and :361
("Glob with zero matches → no-op"); the materialize comment that cites the "L145 guard" is reworded
to the new guard.

Matrix rows: C1, C1b, C3, C4, C5, C7, C8, K1, K1L (fact 4), K4 flip; C2, C9 GUARD; K5 GUARD
(the index source already reads the index before its check today, and errors on the corrupt file). Interop
reconstructs git's report from `err.data.patterns`: one line per pattern,
`error: pathspec '<p>' did not match any file(s) known to git`, exit 1; K rows: git 128
`fatal: Unable to create '…/index.lock': File exists.` ↔ tsgit RESOURCE_LOCKED; K4/K5: git 128
`fatal: .git/index: index file smaller than expected` ↔ the error `readIndex` throws for a
4-NUL-byte index (read it from the existing row at checkout.test.ts:992 by running it). C rows
check `dirty.txt` bytes and `git ls-files -s` on both twins.

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits. Poll, never wait. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: checkout.test.ts:967 "Given a glob with no match on the index source"
(no-op, changedPaths 0) → refuses PATHSPEC_NO_MATCH '*.nomatch' (C7 shape); :992 "Given a
zero-match glob from HEAD AND a corrupted index" (no-op that never reads the index) → refuses with
the index read error and leaves no index.lock (K4); :1380 "Given a glob pathspec with no match"
(HEAD source, no-op) → refuses '*.nope'; :1557 "Given a path restore whose glob matches nothing" →
refuses '*.nomatch' and post-checkout still does not fire; :1870 shape row gains `patterns`.
:509 (held lock, literal `a.txt`) stays a GUARD.

### TDD steps

1. RED — error.test.ts: `pathspecNoMatch('a').data` equals
   `{ code: 'PATHSPEC_NO_MATCH', pattern: 'a', patterns: ['a'] }`; `pathspecNoMatch('n1*', 'n2*')`
   gives `pattern: 'n1*'`, `patterns: ['n1*', 'n2*']`; message still names the first. Fails: no
   `patterns`. GREEN — type + factory; update error.test.ts:147 and the :1706 table literal.
2. RED — checkout.test.ts K1: held `index.lock`, `checkout(ctx, { paths: ['nomatch*'] })` →
   RESOURCE_LOCKED with the lock bytes intact; K1L: same with `paths: ['missing']`. Fails: today
   the pathspec check runs before the lock (no-op success / PATHSPEC_NO_MATCH). Re-pin :992 to K4 in
   this step. Add the interop K1, K1L, K4, K5 rows. GREEN — lock and read first, both materialize functions take
   the held lock.
3. RED — checkout.test.ts C4 `paths: ['n1*', 'n2*']` → `patterns ['n1*','n2*']`; C5
   `['n1*', 'missing']` → `pattern 'n1*'`, `patterns ['n1*','missing']`; C1b `['d*', 'nomatch*']`
   leaves `dirty.txt` dirty; C8 `source: 'HEAD'`, `['new*']` with `new.txt` staged but not in HEAD
   → refuses, index unchanged. Re-pin :967, :1380, :1557, :1870 here. Interop C1, C1b, C3, C4, C5,
   C7, C8 with C2, C9 as GUARDs. Fails: globs never refuse; literals name one. GREEN —
   `unmatchedPositives` over the universe, `pathspecNoMatch(first, ...rest)`; drop
   `enforceLiteralMustMatch`/`literalMustMatch`/`literalSpellings` use in checkout.ts.
4. REFACTOR — comments; keep functions under 20 lines (extract the locked body). Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/domain/commands/error.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/checkout-switch-target.test.ts test/unit/application/commands/checkout-prior.test.ts test/unit/application/commands/checkout-branch-state.test.ts test/unit/application/commands/switch-and-tag-target-dwim.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/add-directory-file.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/pathspec-dot-interop.test.ts test/integration/checkout-leading-symlink-interop.test.ts test/integration/blob-streaming-checkout-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/domain/commands/error.ts test/unit/domain/commands/error.test.ts src/application/commands/checkout.ts test/unit/application/commands/checkout.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`. `check:types` also proves no other
`CommandError` literal lacks `patterns`.

### Commit

`fix(checkout): lock and read the index before refusing every unmatched pathspec`

## Part 9 — A pathspec may hold a backslash on POSIX hosts, for matching only

### Context

ADR-1044 (user-ratified, candidate 1 B). This part lands after the `rm` part (Part 6) and after
add (7) and checkout (8), so every command already resolves pathspecs through Part 5's intake.

Files this part creates or edits (exactly these):
- `src/application/commands/internal/resolve-pathspec.ts` — relax the body validation; scan
  prefix; delete the retired helpers. This part is the file's only editor in the run.
- `test/unit/application/commands/internal/resolve-pathspec.test.ts` — likewise its only editor.
- `test/unit/application/commands/internal/pathspec-intake.test.ts` — POSIX-accept rows (created
  by Part 5; a file new to this run).
- `test/integration/pathspec-glob-dialect-interop.test.ts` — D6, D17, E2 rows and the Windows
  refusal row (created by Part 1; a file new to this run).

Read-only references: src/application/commands/internal/pathspec-intake.ts (Part 5:
`resolveCommandPathspec(host, paths)` already refuses a backslash body when
`host.windowsPathSyntax === true`, before calling `resolvePathspec`; `PositivePathspec.probesDisk`
is false for a backslash body), src/domain/working-tree-path.ts (`validateWorkingTreePath`: :71
refuses any backslash; `validateWalkedEntryPath`), src/application/commands/internal/working-tree.ts
(`validatePath = validateWorkingTreePath`, used at :44, :85, :116-117), src/application/commands/
mv.ts:120/:125, src/application/commands/blame.ts:223, src/ports/context.ts:358
(`Context.windowsPathSyntax`), test/unit/domain/working-tree-path.test.ts:145 ("Given a
backslash in the path … Then rejects" — stays as-is: the general validator is unchanged).

How the host policy reaches the intake: there is no `PathPolicy` object on `Context`; the flag is
the optional field `Context.windowsPathSyntax` (context.ts:358), set by the node adapter on Windows
(src/adapters/node/node-adapter.ts:155, src/index.node.ts:171) and absent on memory/browser.
Primitives read it by passing `ctx` structurally (`gitPathSyntaxOf(ctx)`,
src/application/primitives/internal/git-path-syntax.ts:98; `indexPathRulesOf(ctx)`,
index-path-rules.ts:8). The commands pass `ctx` to `resolveCommandPathspec(ctx, paths)`: rm.ts
(Part 6), add.ts `dispatchPathspec` and `addRenormalized` (Part 7), checkout.ts `pathRestore`
(Part 8), grep.ts (Part 5). `grep -rn "resolveCommandPathspec\|resolvePathspec(" src` must show
exactly those call sites plus add.ts's `WHOLE_TREE_MATCHER` (`resolvePathspec(['.'])`).

Current resolve-pathspec.ts gate point: `collapsePattern` (:107-118) calls `validatePath(body)`
for an empty or "/"-led body (:111) and `validatePath(kept)` on the collapsed body (:115);
`validatePath` refuses any backslash. `symlinkScanTargets` (:65) passes every whole body to
`assertNoSymlinkedLeadingPath` (:185, a `createLeadingPathScanner` lstat walk).

Target (ADR-1044):
- `collapsePattern` validates the collapsed body with every backslash read as an ordinary byte
  (e.g. a private `validatePathspecBody(kept)` that runs `validatePath` on the body with each
  backslash replaced by a byte the validator accepts, returning the original body) — every other
  rule (traversal components, control bytes, `.git` aliases, leading `/`, length in bytes) still
  applies. The intake (Part 5) keeps the refusal under Windows path syntax; `validateWorkingTreePath`
  itself is NOT changed, so `mv`, `blame`, working-tree.ts:44 and every other caller keep refusing a
  backslash, and `validateWalkedEntryPath` is unchanged.
- A backslash body is a wildcard (`hasGlobSpecial`, Part 1), so it is never in `literalMustMatch`,
  never `literalStats`-probed by add's dispatch, never the on-disk escape subject (Part 5's
  `probesDisk` false, read by Part 7's escape) — verify each with a row, not by assumption.
- `symlinkScanTargets`: for a body holding a backslash, the target is its no-wildcard prefix — the
  bytes before the first glob-special byte (`* ? [ \`), git's no-wildcard prefix length — never the
  whole body; empty prefixes are dropped. Other bodies keep today's whole-body target (ADR-1044
  scopes the change to backslash bodies; the existing add rows "link/*.ts", "li*/x.ts",
  "realdir/*.ts" stay GUARDs).
- Delete the helpers this run retired, after `grep -rn "enforceLiteralMustMatch\|literalSpellings"
  src` shows no caller outside this file (Parts 6, 7, 8 removed them): `enforceLiteralMustMatch`,
  `literalSpellings`/`spellLiterals`, `NO_SPELLINGS`, `descendantPrefix`, `WHOLE_TREE_SPELLING` if
  unused; keep `namesWholeTree`, `namesDirectoryOnly`, `literalMustMatch`, `hasGlob` (add's dispatch).
  Delete their describes in resolve-pathspec.test.ts (`describe('enforceLiteralMustMatch'` at
  :324-458 at the base; locate by name).
- Fix the stale comments: lines 17-23 and 54-56 ("compiled to RegExp", "cost of the compiled
  regex") — the matcher is linear; the byte and `**` caps stay as a bound on the work a hostile
  pattern can request (name no ADR); the `hasGlob` doc becomes its dispatch role ("routes add away
  from the literal-only fast path").

Matrix rows: D6 (`a*b`, `aXb`; `add 'a\*b'` stages `a*b`), D17 (`a?b`, `axb`; `add 'a\?b'` stages
`a?b`), E2 (`ab`; `add 'a\b'` stages `ab`) flip at command level on POSIX hosts, interop rows
under `describe.skipIf(!GIT_AVAILABLE || process.platform === 'win32')` (repo convention, e.g.
test/integration/commit-cache-tree-interop.test.ts:571). The Windows CI leg pins the refusal with
a tsgit-only row under `describe.skipIf(process.platform !== 'win32')`: `add(ctx, ['a\\b'])`
through `createNodeContext` → PATHSPEC_OUTSIDE_REPO. D8b and E1 stay pinned follow-ups: they need a
working-tree entry whose name holds a backslash, which `validateWalkedEntryPath` refuses (ADR-1044
Consequences).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.
This part relaxes a path-traversal defence: the review phase's security dimension reviews it
explicitly (ADR-1044) — keep the change confined to `collapsePattern` and the scan targets.

House rules: one RED per function, run before its code; GUARD = already passes.
`git diff --no-ext-diff --stat` after scripted edits. Poll, never wait. Commit only these files.
No provenance ids in code. No suppression directives.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
Rows that change here: any resolve-pathspec.test.ts row expecting PATHSPEC_OUTSIDE_REPO for a
backslash body (grep the file for a backslash in a pattern) is re-pinned to acceptance (D6/D17/E2,
git accepts the pathspec); rows refusing traversal, NUL or a leading "/" stay GUARDs.

### TDD steps

1. RED — written together and run red before any code:
   - `resolve-pathspec.test.ts`, "Given a pattern holding a backslash": `resolvePathspec(['a\\*b'])`
     resolves to one wildcard entry (`isLiteral` false) with `literalMustMatch` empty; GUARDs
     `['../a\\b']` and `['a\\b/../x']` still throw PATHSPEC_OUTSIDE_REPO.
   - `pathspec-intake.test.ts`, "POSIX host": `resolveCommandPathspec({}, ['a\\*b'])` resolves and
     its positive has `probesDisk` false; GUARD: Part 5's Windows-host row still refuses.
   - `pathspec-glob-dialect-interop.test.ts`: D6, D17, E2 (POSIX only) and the Windows-only
     refusal row.
   Fails: `validatePath` refuses every backslash body. GREEN — relaxed body validation in
   `collapsePattern`. Part 5's host check is now the only Windows refusal (its mutants now die).
2. RED — `resolve-pathspec.test.ts`: `['d/a\\b']` → `symlinkScanTargets` `['d/a']`; `['a\\b']` →
   `['a']`; `['\\x']` → `[]` (empty prefix dropped); `['link/*.ts']` → `['link/*.ts']` (GUARD:
   other bodies unchanged). Fails: whole bodies are passed. GREEN — the scan-prefix rule.
3. REFACTOR — `grep` that no caller of `enforceLiteralMustMatch`/`literalSpellings` remains, delete
   them and their describes; comments. GUARD: test/unit/domain/working-tree-path.test.ts and the mv
   and blame suites stay green unchanged. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/internal test/unit/domain/working-tree-path.test.ts test/unit/application/commands/add.test.ts test/unit/application/commands/rm.test.ts test/unit/application/commands/checkout.test.ts test/unit/application/commands/grep.test.ts test/unit/application/commands/mv.test.ts test/unit/application/commands/blame.test.ts test/integration/pathspec-glob-dialect-interop.test.ts test/integration/pathspec-dot-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/internal/resolve-pathspec.ts test/unit/application/commands/internal/resolve-pathspec.test.ts test/unit/application/commands/internal/pathspec-intake.test.ts test/integration/pathspec-glob-dialect-interop.test.ts \
  && npm run check:spelling; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Drop a listed suite only if the file does not exist
(do not invent files). Wireit caveat: `check:types` / `check:spelling` can print `Ran 0 scripts
and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p tsconfig.json`,
`npx cspell --no-progress <touched-files>`.

### Commit

`fix(pathspec): accept a backslash in a pathspec on POSIX hosts, for matching only`

## Part 10 — name-rev reports suffix-matched abbreviation as data

### Context

Files this part creates or edits (exactly these):
- `src/application/commands/name-rev.ts` — `NameRevResult.abbreviated`.
- `test/unit/application/commands/name-rev.test.ts`
- `test/unit/application/commands/name-rev-tip-table.test.ts` — whole-result `toEqual` rows gain
  `abbreviated: false` (:150-156, :191-197, :214-220, :235, :271-277, :293).
- `test/unit/application/commands/describe.test.ts` — `describe --contains` returns a
  `NameRevResult`: rows at :1034-1040 and :1082 gain `abbreviated: false`.
- `test/integration/name-rev-interop.test.ts` — every N row; this part is the file's only editor
  in the run (Part 3 changed the filter with unit rows only).
- `reports/api.json` — regenerated with `npm run docs:json`, committed.

Public surface (decided here): `NameRevResult` is public (src/application/commands/index.ts:215,
`Repository.nameRev`). `readonly abbreviated: boolean` is an additive public field. Gates: no new
command, barrel entry, facade method or error code, so `check:doc-coverage`, the repository
surface snapshot and `audit-browser-surface` are untouched; `reports/api.json` changes and is a
prepush gate — regenerate it here with `npm run docs:json` (it also captures Part 8's
`PATHSPEC_NO_MATCH.patterns`; the large typedoc-id diff is normal) and commit it. The user doc
(docs/use/commands/name-rev.md) is the documentation phase's.

Read-only references: src/domain/name-rev/ref-pattern.ts (`RefFilter.abbreviates(ref)`, Part 3),
src/application/commands/describe.ts (`describeContains` passes the result through),
test/parity/scenarios/name-rev.scenario.ts (maps fields explicitly — unaffected).

Current name-rev.ts: `NameRevResult { oid, ref, tagDeref, steps }` (:42); `nameRevOf` (:83) builds
`filter = buildRefFilter(…)` and calls `exactRefMatch(ctx, refs, id)` (:117) or
`nameCommit(ctx, refs, id)` (:102); both build results in three places (named, unnamed).

Target: `/** True when an include pattern matched the naming ref only through a suffix — git then
prints the ref shortened (the caller shortens; the library returns the full ref). */ readonly
abbreviated: boolean`; pass `filter` (or `filter.abbreviates`) into `nameCommit` and
`exactRefMatch`; `abbreviated: filter.abbreviates(ref)` for a named result, `false` when `ref` is
undefined. `--tags --name-only` stays the caller's own rule (N21).

Interop renderer: add a sibling of `renderNameRev` that, when `r.abbreviated`, takes the base name
from `git(dir, 'rev-parse', '--abbrev-ref=loose', r.ref).trim()` (fact 3 — NOT plain
`--abbrev-ref`), then applies the existing `^0` / step suffix; otherwise defers to `renderNameRev`.
Fixture: c1 holds `v1.0` (annotated) and `w2`; c2 holds "v1/rc1" (annotated); `main` at c3;
target c1 unless noted. Reuse `datedEnv`, `gitNameRev`, `renderNameRev` in the file.
Rows flipped by Part 3's filter, rendered by the existing `renderNameRev` (no abbreviation): N7,
N8, N10, N11, N12; GUARDs N1, N5, N9, N14, N15, N20, N22. Abbreviated rows: N2, N3, N4, N6, N13,
N16, N17, N18, N19 on that fixture; N23, N24 with an added branch
`v1.0` at c1; N25–N28 on a new repo (tag `x` at c1, branch `x` at c2). N21 GUARD (existing row at
name-rev-interop.test.ts:~353).

Environment: git 2.55.0 first on PATH for interop: `PATH="$HOME/.local/git-2.55.0/bin:$PATH"`.

House rules: one RED per function, run before its code; GUARD = already passes. `git diff --no-ext-diff --stat`
after scripted edits (api.json is huge — check it appears in the stat, never read it whole). Poll,
never wait. Commit only these files. No provenance ids in code.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code.
The whole-result rows listed above encode the contract minus the new field: add
`abbreviated: false`, change nothing else (the naming ref does not change — ADR-1040).

### TDD steps

1. GUARD — name-rev-interop.test.ts: the fixture plus N7, N8, N10, N11, N12, N1, N5, N9, N14, N15,
   N20, N22 through `renderNameRev` — they pass since Part 3's filter (run to confirm; one that
   fails is a RED and is reported).
2. RED — written together and run red before any code:
   - name-rev.test.ts: refs ["v*"] on a tag `v1.0` → `{ …, ref: 'refs/tags/v1.0', abbreviated:
     true }`; refs ["refs/tags/*"] → `abbreviated: false`; unnamed → `false`. Fails: no field.
   - name-rev-interop.test.ts: the abbreviated rows with the new renderer. Fail: tsgit's default
     rendering prints `tags/v1.0^0` where git prints `v1.0^0`.
   GREEN — thread the filter, set the field; add `abbreviated: false` to the listed whole-result
   rows in name-rev.test.ts, name-rev-tip-table.test.ts, describe.test.ts.
3. REFACTOR — `npm run docs:json`; confirm `git diff --no-ext-diff --stat reports/api.json` shows
   the change. Gate.

### Gate

```bash
PATH="$HOME/.local/git-2.55.0/bin:$PATH" npx vitest run test/unit/application/commands/name-rev.test.ts test/unit/application/commands/name-rev-tip-table.test.ts test/unit/application/commands/name-rev-skip.test.ts test/unit/application/commands/describe.test.ts test/unit/domain/name-rev test/integration/name-rev-interop.test.ts test/integration/describe-interop.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check src/application/commands/name-rev.ts test/unit/application/commands/name-rev.test.ts test/unit/application/commands/name-rev-tip-table.test.ts test/unit/application/commands/describe.test.ts test/integration/name-rev-interop.test.ts \
  && npm run check:spelling && npm run check:doc-typedoc; echo "gate exit=$?"
```

Run after the last edit; exit code must be 0. Wireit caveat: `check:types` / `check:spelling` can
print `Ran 0 scripts and skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p
tsconfig.json`, `npx cspell --no-progress <touched-files>`. `check:doc-typedoc` regenerates
reports/api.json and runs `git diff --exit-code -- reports/api.json`, so stage this part's files
(`git add` of exactly the six files) before running the gate; it then passes only when the staged
api.json is current.

### Commit

`fix(name-rev): report a suffix-matched ref abbreviation as data`

## Part 11 — Bundle-size measurement, add-by-glob bench, byte-matcher linearity guard

### Context

No src/ delta: a test-infra and config part, standalone by the sizing rules. Runs after every
source part, before review (ADR-1043).

Files this part creates or edits:
- `test/perf/domain/refs/ref-glob.perf.test.ts` — linearity row for `compileRefGlobBytes`; its
  header's "the same ReDoS class compile-glob.perf.test.ts closes for pathspecs" now reads "for
  gitignore rules".
- `test/bench/add.bench.ts` — one new scenario.
- `.size-limit.json` — only if `check:size` is red.
- `docs/design/bundle-size-optimization.md` — a raise section, only if a cap is raised.
- `tooling/verify-tarball.sh` — cap + attribution comment, only if `check:tarball` is red.

Read-only references: docs/lessons/006-size-caps-at-the-headroom-floor-trip-again-on-the-review-round.md
(read first), docs/design/bundle-size-optimization.md (raise-section format, e.g. "Size-limit raise
— gc refuses a size-lying loose blob as git does"), test/bench/support/write-scratch.ts
(`buildAddManyScratch(count)`: `.txt` files across `dir<n>` and `dir<n>/nested`),
test/bench/support/bench-dsl.ts (`benchScenario(given, when, setup)`), vitest.perf.config.ts.

Perf row: Given an adversarial `a*a*…*b` pattern (`'a*'.repeat(64) + 'b'`), When
`compileRefGlobBytes` matches 10 000 bytes of `a`, Then false within 1000 ms — same shape as the
existing `compileRefGlob` row.

Bench row: `benchScenario('Given a freshly built scratch repo with 200 unstaged files across nested
directories', 'When add() stages them by the glob "*.txt", Then measure tsgit', …)` with
`scratch.repo.add(['*.txt'])` (exercises the one-star fast path). Do NOT run `bench:ab` here: the
session runs it after this commit (house rule — never inside a tree where wireit is running).

Size procedure (lesson 006 + ADR-1043):
1. `rm -rf dist .wireit && npm run check:size` then `npm run check:tarball`; read EVERY row of the
   output, not only the browser bundle (stale dist/ chunks fake reds — the clean rebuild is the
   measurement).
2. Main baseline the same way, without touching repo state: `base=$(mktemp -d)`,
   `git archive 8dd442ee | tar -x -C "$base"`, `ln -s "$PWD/node_modules" "$base/node_modules"`,
   then in `$base`: `npm run build && npx size-limit --json > <scratch>/main-size.json`.
3. For each red row: delta = branch − main (gzip bytes); raise that row's limit by exactly the
   delta, rounded up to the next 0.1 kB (ADR-1043), and confirm the new limit is ≥ the branch
   measurement. Record each raise (row, main, branch, delta, attribution: the dialect matcher,
   fast paths, refusal helpers and `subpathOffset`, offset by the removed `scanStar`,
   `containsGlob`, `compileLiteral`/`compileDirectory` and `enforceLiteralMustMatch`) in a new
   section of docs/design/bundle-size-optimization.md, and in the tarball cap comment if that cap
   moved. Lesson 006: the review round will likely add bytes and re-trip a cap raised to the floor;
   the session re-measures after review and asks the user once, listing every failing row.
4. No row red → edit neither `.size-limit.json` nor the design doc.

api.json drift check: `npm run docs:json && git diff --no-ext-diff --stat reports/api.json` must print nothing
(Part 10 regenerated it after the last public change). A diff here means a later part changed the
public surface — stop and report `{ unit: Part 11, reason, options }`, do not commit api.json.

House rules: `git diff --no-ext-diff --stat` after edits. Poll, never wait (`check:size` builds — poll its
output). Commit only this part's files. Never run two `npm run` scripts at once.

Re-pinning rule: When an existing test row breaks, decide whether the OLD expectation encoded the
contract. If it did, fix the code, not the row, and say so. A changed row is re-pinned against real
git 2.55 (or the design's matrix row id), never rewritten to match the new code. No existing row is
expected to change here.

### TDD steps

1. GUARD — perf row for `compileRefGlobBytes` (linear by construction since Part 1; passes).
2. GUARD — the bench scenario type-checks and biome-checks (benches are not run here).
3. Measure per the size procedure; raise only the red rows by the measured delta; record.
4. api.json drift check.

### Gate

```bash
npx vitest run --config vitest.perf.config.ts test/perf/domain/refs/ref-glob.perf.test.ts test/perf/domain/pathspec/compile-glob.perf.test.ts \
  && npm run check:types \
  && ./node_modules/.bin/biome check test/perf/domain/refs/ref-glob.perf.test.ts test/bench/add.bench.ts \
  && npm run check:spelling \
  && rm -rf dist .wireit && npm run check:size && npm run check:tarball; echo "gate exit=$?"
```

Add `.size-limit.json`, `tooling/verify-tarball.sh` and the design doc to the biome/cspell
arguments only when edited (biome checks JSON; cspell the markdown). Run after the last edit; exit
code must be 0. Wireit caveat: `check:types` / `check:spelling` can print `Ran 0 scripts and
skipped 1` on a cached result — bare oracles: `npx tsc --noEmit -p tsconfig.json`,
`npx cspell --no-progress <touched-files>`.

### Commit

Exactly one commit, one of:
- no cap raised: `test(pathspec): bench add by glob and guard the byte matcher's linearity`
- a cap raised: `fix(pathspec): raise the size caps by the measured glob-dialect delta`
