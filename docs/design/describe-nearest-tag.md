# Design — `describe` (nearest tag distance)

> Tier-1 `repo.describe(input?, opts?)` — name a commit by its nearest reachable
> tag, faithful to `git describe`. Returns a structured `DescribeResult` carrying
> the chosen tag, the commit distance, the abbreviated object id, and `bytes` —
> the byte-faithful `git describe` stdout line.

## 1. What `git describe` computes

Given a commit-ish, `git describe` finds the **nearest tag reachable from it**
and renders `<tag>-<depth>-g<abbrev>`, where:

- `<tag>` is the closest tag's short name (e.g. `v2.0`),
- `<depth>` is the number of commits between that tag and the target
  (`= rev-list --count <tag>..<target>`), and
- `<abbrev>` is the abbreviated target object id, prefixed `g` (for "git").

When the target commit is itself tagged, only `<tag>` is printed (depth 0). The
default tag source is **annotated tags only**; lightweight tags require `--tags`.

Grounded against real `git` (probed, signing off, pinned dates):

| Invocation | Output |
|------------|--------|
| `describe` (HEAD = c4, nearest annotated tag v2.0 at c3) | `v2.0-1-g<7hex>` |
| `describe --long` | `v2.0-1-g<7hex>` (forces the suffix even at depth 0) |
| `describe --abbrev=0` | `v2.0` (suppresses `-<depth>-g<hash>`) |
| `describe --abbrev=12` | `v2.0-1-g<12hex>` |
| `describe <commit exactly tagged>` | `v2.0` |
| `describe --long <commit exactly tagged>` | `v2.0-0-g<7hex>` |
| `describe --tags` (only lightweight tags) | `light1-1-g<7hex>` |
| `describe --exact-match <untagged>` | **fatal** `no tag exactly matches '<40hex>'` |
| `describe --always <untagged, no tags>` | `<7hex>` |
| same commit, two annotated tags | the one with the **newer tagger date** wins |
| `--match 'v*'` / `--exclude 'rc*'` | filter candidate tags by short-name glob |
| merge: `describe` vs `--first-parent` | second-parent tag vs first-parent tag |

Two distinct refusals were observed:

- target reachable from **no** tag and no `--always`:
  - some lightweight tags exist (default mode) → `No annotated tags can describe
    '<oid>'. However, there were unannotated tags: try --tags.`
  - no tags exist at all → `No names found, cannot describe anything.`
- `--exact-match` (≡ `--candidates=0`) with no tag on the exact commit →
  `no tag exactly matches '<40hex>'`.

## 2. The algorithm (faithful port of `describe.c`)

`git describe` runs a **single date-ordered breadth-first walk** that
simultaneously discovers candidate tags and counts each one's depth.

### 2.1 Name map

Enumerate the tag refs (`refs/tags/*`, loose + packed), peel each to a commit,
and build a `Map<commitOid, DescribeName>` where `DescribeName = { name, prio,
taggerDate? }`. The map holds **both** annotated and lightweight tags; the
tag-source mode (`--tags`) is applied later, during the walk, not here — so a
lightweight tag still populates the map and still contributes to the
"unannotated tags exist" refusal hint below.

- `prio = 2` — **annotated** tag (the ref points at a `tag` object). Peel the tag
  chain to its terminal object; record the outermost tagger timestamp.
- `prio = 1` — **lightweight** tag (the ref points straight at a commit).
- A tag peeling to a **non-commit** (tree/blob) is dropped (cannot describe).

With **`--all`**, every ref is a name, not just tags. A non-tag ref
(`refs/heads/*`, `refs/remotes/*`, …) enters the map at `prio = 0`; its short
name strips only `refs/` (`refs/heads/main` → `heads/main`,
`refs/remotes/origin/x` → `remotes/origin/x`, `refs/tags/v1.0` → `tags/v1.0`).
Without `--all` only `refs/tags/*` is enumerated and the name strips the full
`refs/tags/` (`v1.0`). `HEAD` is never a name. Selection is by **depth then
found-order** regardless of prio — a depth-0 branch beats a depth-1 annotated tag
(verified: `describe --all` of a branch tip yields `heads/<branch>`); prio only
governs the per-commit dedup below and the tag-source qualification in §2.3.

When two refs name the **same commit**, git's `replace_name` keeps one:

- higher `prio` wins;
- two annotated (`prio == 2`) → the **newer tagger date** wins; equal dates keep
  the first encountered;
- equal lower prio (`1` or `0`) → keep the first encountered.

"First encountered" is **refname-sorted** order, so the map is built by iterating
refs sorted by name (matching `tagList`'s existing sort and git's sorted
`for_each_rawref`).

`--match <glob>` / `--exclude <glob>` filter on the **short tag name** before
insertion (an annotated tag's name is its ref tail, `refs/tags/` stripped). The
existing `domain/pathspec/compile-glob` matcher (anchored) is reused — `*` does
not cross `/`, matching git's `wildmatch(... , WM_PATHNAME)` for tag names.
Character classes (`[a-z]`) are unsupported by `compile-glob` (a documented
codebase-wide limitation); `*` / `?` / `**` cover the common `v*` / `release/*` /
`rc-?` patterns.

### 2.2 Exact-commit short-circuit

Peel `input` to the target commit `T`. If `nameMap` has an entry for `T.oid` that
qualifies under the current tag-source mode, return it immediately at depth 0
(this is the `<tag>` / `--long` `<tag>-0-g<hash>` output). `--exact-match` /
`--candidates=0` stop here: no exact entry → `NO_EXACT_MATCH` refusal.

### 2.3 The walk

A priority queue ordered by **committer date descending** (object-id ascending on
ties — the same ordering `merge-base` already uses). State is two structures
keyed by commit oid: a `seen: Set<oid>` (enqueued-once guard) and a `reach:
Map<oid, Set<candidateIndex>>` recording, for each commit, which candidates' tags
it is an ancestor-or-self of — i.e. which tags it is reachable *from*. (A
`Set<index>` rather than a 32-bit bitfield, so `--candidates` is not silently
capped at 31.)

```
seed T into seen; push T
seen.add(T)
counter = 0
candidates: Candidate[] = []           // { name, commitOid, depth, foundOrder }
gaveUp: oid | undefined
while queue not empty:
  c = popNewest()
  counter++
  n = nameMap.get(c.oid)
  if n qualifies (annotated, or --tags ⇒ prio≥1):
    if candidates.length < maxCandidates:
      index = candidates.length
      push candidate { depth: counter - 1, foundOrder: index }
      reach(c.oid).add(index)
    else:
      gaveUp = c.oid; break          // cap reached (default 10)
  for t in candidates:
    if !reach(c.oid).has(t.index): t.depth++      // c sits between t and T
  parents = firstParent ? c.parents.slice(0, 1) : c.parents
  for p in parents:
    if !seen.has(p): { push p; seen.add(p) }
    for index in reach(c.oid): reach(p).add(index)   // propagate reachability
```

Because every parent's date ≤ its child's, a commit is popped only after all its
children have contributed reachability — so `reach(c)` is exact when `c` is
counted. Each candidate's final `depth` is therefore exactly `|tag..target|`.

git carries one extra micro-optimisation — `if (annotated_cnt && !queue) break`
*before* enqueuing a commit's parents. It only ever skips commits that are
ancestors of the already-found annotated tag (hence reachable from it), which
never increment any candidate's depth; the walk here omits it and lets those
commits fall through the reach-guarded increment as no-ops, for an identical
result with simpler control flow.

### 2.4 Selection + depth finalisation

Sort candidates by `compareCandidates` = **depth ascending, then foundOrder
ascending** (git's `compare_pt`). The winner is `candidates[0]`. If the walk hit
the cap, re-seed `gaveUp` and run `finish_depth_computation`: keep popping the
remaining queue, incrementing only the **winner's** depth for each commit not
reachable from it, so the reported depth stays exact even when the candidate
search stopped early.

If no candidate was found, the refusal mirrors git's three distinct conditions
(`--always` overrides all three by rendering the abbreviated oid instead):

- name map **empty** after `--match`/`--exclude` filtering → `NO_NAMES`
  (git: *No names found, cannot describe anything.*);
- map non-empty, no qualifying candidate, **lightweight tags present** in default
  mode → `NO_ANNOTATED_NAMES` (git: *No annotated tags can describe … however,
  there were unannotated tags: try --tags.*);
- map non-empty, no qualifying candidate, no lightweight tags (e.g. the only tags
  are unreachable) → `NO_REACHABLE_NAMES` (git: *No tags can describe … Try
  --always, or create some tags.*).

`maxCandidates` defaults to `10`; `--candidates=<n>` overrides; `--exact-match`
sets it to `0` (handled by §2.2).

### 2.5 `--dirty` / `--broken` (working-tree mark)

`--dirty[=<mark>]` describes **HEAD** and appends `<mark>` (default `-dirty`) when
the working tree has **tracked** changes; untracked files do not count (verified).
It is **incompatible with an explicit commit-ish** — git refuses `describe --dirty
HEAD` with *option '--dirty' and commit-ishes cannot be used together*, so the API
raises `INVALID_OPTION` when `input` is supplied alongside `dirty`/`broken`.

Dirtiness is derived from the existing `status` command (the `pull → fetch/merge`
command-composes-command precedent): dirty iff `indexChanges` is non-empty **or**
any `workingTreeChanges` entry has a kind other than `untracked`. This is the
`git diff-index --quiet HEAD` predicate over tracked paths.

`--broken[=<mark>]` (default `-broken`) covers the case where dirtiness cannot be
computed (a corrupt working tree): the `status` call is wrapped, and on failure
the broken mark is appended instead of propagating the error. When the check
succeeds, `--broken` behaves like `--dirty`.

The mark is appended to `text`/`bytes` after the tag/abbrev rendering
(`v2.0-1-g0f3a9c1-dirty`); the structured result carries `dirty: boolean`.

## 3. Output formatting (pure)

`formatDescribe({ tag, depth, oid, long, abbrev })`:

- `abbrev === 0` → `tag` (no suffix; `--long` is ignored, as in git).
- `long || depth > 0` → `${tag}-${depth}-g${oid.slice(0, abbrev)}`.
- otherwise (`depth === 0`, not long) → `tag`.

The `--always` fallback (no tag) renders `oid.slice(0, abbrev)` alone.

**Abbreviation length.** git uses `find_unique_abbrev` (shortest unambiguous
prefix, floor `DEFAULT_ABBREV = 7`). tsgit's existing `show` / pretty / combined-
diff renderers already abbreviate with a **fixed 7-char slice**, which is
byte-identical to git in every repository where 7 hex is already unique (all
interop fixtures). `describe` follows that established precedent: default abbrev
`7`, `--abbrev=<n>` slices to `n` (and `0` suppresses the suffix). Unique-prefix
abbreviation is out of scope here, consistent with the rest of the codebase.

## 4. Public API

```ts
export interface DescribeOptions {
  readonly tags?: boolean;            // include lightweight tags (prio ≥ 1)
  readonly all?: boolean;             // include every ref (branches/remotes; prio 0)
  readonly long?: boolean;            // always emit -<depth>-g<hash>
  readonly abbrev?: number;           // hash length; 0 suppresses the suffix. Default 7
  readonly exactMatch?: boolean;      // ≡ candidates: 0
  readonly candidates?: number;       // max tags considered. Default 10
  readonly always?: boolean;          // fall back to the abbreviated oid
  readonly firstParent?: boolean;     // follow only first parents
  readonly match?: string | ReadonlyArray<string>;    // short-name globs to include
  readonly exclude?: string | ReadonlyArray<string>;  // short-name globs to drop
  readonly dirty?: boolean | string;  // mark HEAD's tree dirty; string = custom mark
  readonly broken?: boolean | string; // mark on a corrupt tree; string = custom mark
}

export interface DescribeResult {
  readonly tag: RefName | undefined;  // chosen ref (a tag, or any ref under --all); undefined on --always
  readonly name: string;              // chosen short-name or '' on --always fallback
  readonly distance: number;          // commits between ref and target (0 = exact)
  readonly abbreviated: string;       // abbreviated target oid (no 'g' prefix)
  readonly exact: boolean;            // distance === 0 && tag !== undefined
  readonly dirty: boolean;            // a --dirty/--broken mark was appended
  readonly text: string;              // rendered line, no trailing newline
  readonly bytes: Uint8Array;         // text + '\n' — byte-faithful `git describe` stdout
}

export async function describe(
  ctx: Context,
  input?: string,          // default 'HEAD'
  opts?: DescribeOptions,
): Promise<DescribeResult>;
```

Bound on the facade as `repo.describe` (single Tier-1 method, like `show` /
`status`). Input is a single commit-ish resolved through the existing
`resolveCommitIsh` ladder (40-hex → ref-DWIM with tag peeling → abbreviated oid).

### Deferred (follow-up `23.2a`)

`--contains` (a forward `name-rev` walk — a different algorithm, a candidate for
its own backlog item) and multi-commit-ish argument lists (git's `describe A B
C`). Both are additive and land without breaking the v1 surface.

## 5. Module layout (hexagonal)

```
domain/describe/                 # pure — no I/O
  types.ts            DescribeName, Candidate, DescribeRenderInput
  replace-name.ts     shouldReplaceName(existing, incoming) — prio + tagger date
  compare-candidates.ts compareCandidates(a, b) — depth then foundOrder
  match.ts            tagNameMatches(name, include[], exclude[]) via compileGlob
  format.ts           formatDescribe(input) → string
  index.ts            barrel (internal — NOT added to objects barrel / api.json)
application/commands/
  describe.ts         Tier-1: peel, enumerate refs, build map, walk, format
  internal/
    describe-options.ts  parse/validate DescribeOptions → ResolvedDescribePlan
```

Ref enumeration reuses the `enumerateRefs` primitive (HEAD + loose + packed),
dropping `HEAD` and — unless `--all` — keeping only `refs/tags/*`. Each ref is
resolved + peeled via the ref-store / `readObject`; unresolvable refs are skipped.
The `--dirty` predicate reuses the `status` command. The date-ordered priority
queue is written locally in `describe.ts`. `merge-base` has the only other copy;
two consumers is below rule-of-three, so extraction is deferred (revisited in the
Step 7 architecture pass).

## 6. Errors (structured, co-refusal-pinned)

New `CommandError` variants (factories in `domain/commands/error.ts`, messages in
`domain/error.ts`):

- `NO_NAMES` `{ oid }` — name map empty (no tags, or all filtered out).
- `NO_ANNOTATED_NAMES` `{ oid }` — only lightweight tags exist, default mode.
- `NO_REACHABLE_NAMES` `{ oid }` — tags exist but none qualify/reach the target.
- `NO_EXACT_MATCH` `{ oid }` — `--exact-match` and the commit is not tagged.

`abbrev` / `candidates` validation reuses `INVALID_OPTION` (negative abbrev,
negative candidates), as does the `--dirty`/`--broken`-with-commit-ish refusal
(git: *option '--dirty' and commit-ishes cannot be used together*). As a library
tsgit raises typed errors rather than git's stderr strings; the interop test
asserts **co-refusal** (git and tsgit both fail on the same inputs), the
established pattern for `rm` / `mv` / rev-parse.

## 7. Test plan

### Unit (example, GWT/AAA, `sut`, 100 % coverage, 0 surviving mutants)

- `format.ts` — every branch: exact (`tag`), `--long` at depth 0
  (`tag-0-ghash`), depth > 0 (`tag-N-ghash`), `--abbrev=0` (`tag`), custom abbrev
  width, `--always` fallback (`hash`).
- `replace-name.ts` — higher prio replaces; annotated newer-date replaces;
  annotated equal/older keeps; lightweight keeps first. Each guard isolated
  (separate tests trigger each condition alone, per the mutation-resistant rules).
- `compare-candidates.ts` — depth ordering; foundOrder tie-break; equal returns 0.
- `match.ts` — include-only, exclude-only, both, no patterns (identity), `*`
  not crossing `/`.
- `describe.ts` — peel input, exact short-circuit, nearest over farther,
  `--tags` vs default, `--all` (branch name + `heads/…` formatting, depth beats
  prio), `--first-parent` across a merge, `--always` fallback, `--dirty` mark
  (clean vs tracked-dirty vs untracked-only) + custom mark + commit-ish refusal,
  cap/gaveUp depth-finalisation, and each refusal (`NO_NAMES`,
  `NO_ANNOTATED_NAMES`, `NO_REACHABLE_NAMES`, `NO_EXACT_MATCH`) via try/catch +
  `.data` assertions.

### Property (`*.properties.test.ts`)

- `compareCandidates` — total order invariants (reflexive 0, antisymmetric sign,
  depth dominates foundOrder). *(case 2: compositional comparator.)*
- `formatDescribe` — round-trip shape: for any `depth ≥ 0`, abbrev `n ∈ 1..40`,
  the rendered suffix re-parses to the same `(tag, depth, hash[0..n])`.
  *(case 4: counting/parse invariant.)*
- `tagNameMatches` — empty include ⇒ identity (everything passes); adding an
  exclude that matches flips to false. *(case 2.)*

### Interop (`describe-interop.test.ts`, cross-tool parity vs real `git`)

Build a repo with canonical git (pinned dates, signing off) and assert
`decode(describe(ctx, rev, opts).bytes) === git('describe', …)` for: nearest
annotated, `--long`, `--abbrev=0`/`=12`, exact-tagged commit, `--tags` with
lightweight, `--all` (branch/remote names), merge default vs `--first-parent`,
`--match`/`--exclude`, same-commit newer-tagger-date win, `--always` fallback,
`--dirty` (clean → no mark; tracked change → `-dirty`; custom mark), and
**co-refusal** on `--exact-match` of an untagged commit, a no-tags repo, and
`--dirty` with a commit-ish.

## 8. Faithfulness invariants (prime directive)

- Depth equals `git rev-list --count <tag>..<target>` for the chosen tag.
- Tag selection (nearest, then earliest in date-BFS, then newer tagger date for
  a shared commit) matches `git describe` byte-for-byte on the chosen line.
- Refusal conditions match git's (co-refusal interop), even though the thrown
  message is tsgit's structured error, not git's stderr string.
- Abbreviation is a fixed 7-char (or `--abbrev=n`) slice — the existing codebase
  precedent, byte-identical to git wherever 7 hex is unique.
