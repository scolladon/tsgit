# Design — `name-rev` + `describe --contains` (name a commit by a ref that contains it)

> Tier-1 `repo.nameRev(rev?, opts?)` — git's `git name-rev`: name a commit by the
> nearest ref that **contains** it (a descendant-or-self ref), expressed as a
> path down from that ref via git's `~`/`^` notation (`v2.0~3^2~1`). The inverse
> of `describe`'s nearest-*ancestor*-tag walk. Returns **structured data only**
> (ADR-249): the chosen ref (full name), whether it is an annotated tag (the `^0`
> peel), and the ordered navigation `steps` — the library renders no `name`
> string and abbreviates no oid. `describe({ contains: true })` delegates to it.

## 1. What `git name-rev` computes

`git name-rev <commit>` finds a symbolic name for the commit based on a ref that
**contains** it (i.e. the commit is reachable from the ref by walking *parents*).
The name is the ref's short name followed by a path describing how to walk down
from the ref to the commit:

- `~<n>` — follow the **first parent** `n` times.
- `^<n>` — follow the **`n`-th parent** (`n ≥ 2`); first-parent is always `~`.
- `^0` — peel an **annotated tag** to its commit (shown only at the tip itself).

So `v2.0~3^2~1` means: from the commit `v2.0` names, go back 3 first-parents,
then take the 2nd parent, then 1 more first-parent.

Grounded against real `git` 2.54 (probed, signing off, pinned dates):

| Target | Refs | Output |
|--------|------|--------|
| commit an **annotated** tag `v1.0` points at | `v1.0` | `tags/v1.0^0` |
| commit a **lightweight** tag / branch points at | `light` / `main` | `tags/light` / `main` |
| a first-parent ancestor of tag `rel` (3 back) | `rel` | `tags/rel~3` |
| a 2nd-parent (merged side) of `rel~1` | `rel` | `tags/rel~1^2` |
| one first-parent below that | `rel` | `tags/rel~1^2~1` |
| commit reachable from **no** ref (default) | — | `undefined` (printed, not an error) |
| same, `--always` | — | the abbreviated oid |
| a **far tag** (dist 3) vs a **near branch** (dist 1) | both | the **tag** (`fartag~3`) |
| two **equal-distance** tags, different tagger dates | both | the **older**-tagged one |
| a **near tag** (dist 1) vs a **far tag** (dist 2) | both | the **nearer** (`near~1`) |

This table documents git's **rendered** strings for reference. tsgit returns the
underlying data (`ref`, `tagDeref`, `steps`) and the caller assembles the string
(§3) — pinned by reconstructing git's output in the interop test.

### 1.1 Default ref scope, `--tags`, `--refs`, `--exclude`

- **Default**: every ref under `refs/` is a naming source (branches, remotes,
  tags). `HEAD` is never used as a name. Verified: with branch + remote + tag all
  on one commit, the **tag** wins (the tag preference, §2.2).
- **`--tags`**: restrict the naming sources to `refs/tags/*` (a prefix filter,
  not a glob). A commit reachable from no tag then resolves to `undefined`.
- **`--refs=<glob>`** / **`--exclude=<glob>`**: include/exclude refs whose **full
  name** matches a shell glob where `*`/`?` **cross `/`** (git uses `wildmatch`
  *without* `WM_PATHNAME` here). Verified: `--refs='refs/tags/*'` matches the
  nested `refs/tags/rel/v1`; `--refs='*rel*'` matches it too. This is a different
  glob dialect from `describe`'s `--match` (anchored short-name globs where `*`
  stops at `/`, via `compileGlob`), so it needs its own tiny matcher (§5).

### 1.2 The short name (a rendering choice — caller's, not the library's)

git abbreviates the chosen ref for display, and the rule is **flag-dependent**:

- default / `--name-only` / under `--all`: strip `refs/heads/` to the bare branch
  name, else strip only `refs/` (`refs/tags/v1.0 → tags/v1.0`,
  `refs/remotes/origin/x → remotes/origin/x`).
- `describe --contains` (which runs name-rev with `--tags --refs=refs/tags/*`):
  the rev-parse "shortest unambiguous" form — `refs/tags/v1.0 → v1.0`.

Because the abbreviation is a display layout that depends on the *invocation*,
it is a **caller** concern (ADR-249). The library returns the **full** `ref`
(`RefName`); the interop test applies whichever strip rule the compared git
command uses. The library never emits the short name.

## 2. The algorithm (faithful port of `name-rev.c`)

A single shared `revNames: Map<oid, RevName>` is filled by walking **down** (via
parents) from every qualifying ref, in **ref-name-sorted** order. Each commit
keeps the *best* name found so far; a parent is (re-)queued only when its name
**improves**, which is also what guarantees termination (names only get better,
and "better" is bounded).

### 2.1 `RevName` (per-commit walk state)

```
interface RevName {
  ref: RefName;          // the naming ref (full name)
  tagDeref: boolean;     // ref is an annotated tag (peels via ^0)
  fromTag: boolean;      // ref is under refs/tags/
  taggerDate: number;    // annotated tagger time, else the tip commit's date
  generation: number;    // pending first-parent hops (the trailing ~g)
  distance: number;      // selection metric (+1 per ~, +65535 per ^n)
  steps: NameRevStep[];  // completed segments before the pending generation
}
```

`steps` + `generation` *are* the structured form of git's `tip_name` string: a
first-parent step just bumps `generation`; crossing a merge **flushes** the
pending `generation` and the `^n` jump into `steps` and resets `generation` to 0
(exactly as git rewrites `tip_name` to `<base>~<gen>^<n>`).

`MERGE_TRAVERSAL_WEIGHT = 65535` (git's constant) makes any non-first-parent hop
dominate the distance metric, so name-rev prefers the most first-parent-ish path.

### 2.2 `isBetterName(existing, incoming)` — the selection comparator

Empirically pinned against git 2.54 (the in-tree comment about "prefer the older
tag even if farther" does **not** match observed 2.54 behaviour — distance
dominates; tagger date is only the final tie-break):

```
incoming wins iff:
  1. existing.fromTag !== incoming.fromTag → incoming.fromTag   // a tag beats a non-tag, at any distance
  2. else if existing.distance !== incoming.distance → existing.distance > incoming.distance   // nearer wins
  3. else → existing.taggerDate > incoming.taggerDate           // equal distance ⇒ older tag wins
```

A commit with **no** name yet always accepts the incoming name (git's
`if (name->tip_name && !is_better_name(...)) return NULL` — the empty slot is
unconditionally filled). Rule 1 is the **tag preference**; rule 2 makes the
metric distance-primary; rule 3 (older tagger date) breaks equal-distance ties,
and on a full tie the first ref in **ref-name-sorted** order is kept.

### 2.3 The walk

```
revNames = new Map()
for ref of sortedQualifyingRefs:                      // §2.4 filter, then .sort()
  tip = peel(ref) → commit;  tagDeref = ref pointed at a tag object
  taggerDate = annotated ? outermost tagger time : tip commit date
  fromTag = ref under refs/tags/
  seed = { ref, tagDeref, fromTag, taggerDate, generation: 0, distance: 0, steps: [] }
  if !accept(tip, seed): continue                     // an earlier ref already names the tip better
  stack = [tip]
  while stack not empty:
    c = stack.pop()                                   // LIFO (git's prio_queue w/o compare)
    name = revNames.get(c)
    queued = []
    c.parents.forEach((parent, i) => {
      pn = i + 1
      cand = pn === 1
        ? { ...name, generation: name.generation + 1, distance: name.distance + 1 }
        : { ...name, steps: [...name.steps,
                              ...(name.generation > 0 ? [{ kind:'ancestor', count:name.generation }] : []),
                              { kind:'parent', number: pn }],
            generation: 0, distance: name.distance + MERGE_TRAVERSAL_WEIGHT }
      if accept(parent, cand): queued.push(parent)    // accept = create-or-update under isBetterName
    })
    for p of queued.reverse(): stack.push(p)          // reverse-push ⇒ first parent popped first
```

`accept(commit, cand)` writes `cand` into `revNames` and returns `true` iff the
slot was empty or `isBetterName(existing, cand)`; otherwise leaves it and returns
`false`. The shared map across refs means a later (worse-sorted) tag can still
override a branch name at any commit (rule 1), re-queuing the affected subgraph.

Reading commits: each popped commit is read with `readObject` for its
`data.parents` (no new primitive). The walk is **not** date-ordered — it is a
reverse-reachability flood with an improvement gate, fundamentally different from
`describe`/`shortlog`'s `walkCommitsByDate`, so it does not reuse those walkers.

### 2.4 Ref qualification

A ref qualifies as a naming source iff:
`ref !== 'HEAD'` **and** (`!tags` or `ref.startsWith('refs/tags/')`) **and**
(`refs` empty or some `refs`-glob matches the full ref) **and** no `exclude`-glob
matches. The surviving refs are **sorted by name** before the walk (so tie-broken
selection is deterministic and matches git's sorted `for_each_ref`).

### 2.5 Result projection

The queried commit's `RevName` (if any) folds into the public result. The pending
`generation` becomes a trailing ancestor step:

```
steps = gen > 0 ? [...name.steps, { kind:'ancestor', count: gen }] : name.steps
return { oid: target, ref: name.ref, tagDeref: name.tagDeref, steps }
```

If the commit has no name, return `{ oid: target, ref: undefined, tagDeref:
false, steps: [] }` — git's `undefined` line. `name-rev` itself **never throws**
on an unnameable commit (git prints `undefined`); the refusal lives in
`describe --contains` (§4).

### 2.6 Deferred: the date cutoff (perf only, observationally inert)

git prunes the walk at `cutoff = min(targetDates) − 1 day` (`commit_is_before_cutoff`):
a commit older than every target can never *be* a target, so naming it is wasted.
Omitting it yields **identical** output for the named commit (those commits are
never the target and never improve the target's name) — it only changes how much
history is walked. v1 ships the correct full flood; the cutoff is a perf
follow-up (backlog **26.2b**, mirroring `describe`'s early-termination deferral
to 26.2a). Including it now would add a guard mutation testing flags as an
equivalent mutant; deferring keeps the surface mutation-clean.

## 3. No output rendering (data only)

The library returns the navigation data; the caller assembles git's string:

```ts
// caller-side, not in the library:
const render = (r: NameRevResult, short: (ref: RefName) => string): string => {
  if (r.ref === undefined) return r.oid;                 // or 'undefined' — caller's choice (git --always vs default)
  const base = short(r.ref);
  if (r.steps.length === 0) return r.tagDeref ? `${base}^0` : base;
  const suffix = r.steps
    .map((s) => (s.kind === 'ancestor' ? `~${s.count}` : `^${s.number}`))
    .join('');
  return base + suffix;                                  // ^0 is dropped once any step exists (git strips it)
};
```

Consequently the git flags that only steer rendering are **not** options:
`--name-only` (drop the `<oid> ` prefix), `--always` (oid vs the literal
`undefined` for an unnameable commit — both derivable from `ref === undefined`
plus `oid`), and the ref **abbreviation** (`tags/v1.0` vs `v1.0`, §1.2). The
library never abbreviates and never prints a name.

## 4. `describe --contains`

`git describe --contains <c>` is literally `git name-rev --tags --no-undefined
--peel-tag --name-only [--refs=refs/tags/<match>…] [--exclude=refs/tags/<x>…]`
(and, with `--all`, drops `--tags` and the `refs/tags/` prefixing). So tsgit's
`describe({ contains: true })` **delegates** to `nameRev`, mapping the existing
`DescribeOptions`:

| describe option | name-rev mapping |
|-----------------|------------------|
| `contains: true` | enter contains mode |
| (default, no `all`) | `tags: true` |
| `all: true` | all refs (no `tags`) |
| `match` | `refs: match.map(p => 'refs/tags/' + p)` (default mode); under `all`, the patterns pass through verbatim |
| `exclude` | `exclude: exclude.map(p => 'refs/tags/' + p)` (default mode); verbatim under `all` |
| `always` | on `ref === undefined`, return the result as-is (caller renders the oid) instead of refusing |

Unnameable behaviour differs from bare name-rev: `describe --contains` carries
`--no-undefined`, so an unnameable commit **refuses** (new `CANNOT_DESCRIBE`
error) unless `always` is set. The other `DescribeOptions`
(`candidates`/`exactMatch`/`firstParent`/`dirty`/`broken`) are **ancestor-walk**
concepts with no meaning in contains mode; whether to **silently ignore** them
(git's behaviour) or **refuse** with `INVALID_OPTION` (illegal-state-unrepresentable,
but a divergence from git's refusal set) is an open decision (§10.4).

Return shape: `describe({ contains: true })` returns a **`NameRevResult`** (git's
describe --contains *is* name-rev), via a TypeScript overload — the same
hand-written-binding pattern `show`/`diff` already use. Normal `describe` keeps
returning `DescribeResult`. The exact `--all`+`--match` prefixing is re-verified
against real git during implementation and pinned by interop.

## 5. Module layout (hexagonal)

```
domain/name-rev/                 # pure — no I/O, no rendering
  types.ts            NameRevStep (public union), RevName (internal walk state)
  is-better-name.ts   isBetterName(existing, incoming) — tag > nearer > older
  step.ts             firstParentName / mergeParentName (next RevName for a parent), foldSteps (state → public steps)
  ref-pattern.ts      matchRefGlob (fnmatch, * crosses /), buildRefFilter(tags, refs[], exclude[])
  index.ts            barrel (internal — NOT added to objects barrel / api.json)
application/commands/
  name-rev.ts         Tier-1 nameRev: enumerate+filter+sort refs, flood walk, project NameRevResult
  internal/
    name-rev-options.ts  parse NameRevOptions → ResolvedNameRevPlan (string|string[] → string[])
  describe.ts         + contains branch: map options, delegate to nameRev, no-undefined refusal
```

Ref enumeration reuses `enumerateRefs` (HEAD + loose + packed). Each ref is
resolved + peeled via the ref store / `readObject`, reusing `describe`'s
`peelToCommit` shape (commit oid + annotated-tag flag + outermost tagger date) —
the architecture pass (Step 7) considers extracting the now-two-consumer
`peelToCommit` into a shared internal helper.

### Public API

```ts
repo.nameRev(rev?: string, opts?: NameRevOptions): Promise<NameRevResult>;

export interface NameRevOptions {
  readonly tags?: boolean;                                // restrict sources to refs/tags/*
  readonly refs?: string | ReadonlyArray<string>;        // full-refname globs to include (* crosses /)
  readonly exclude?: string | ReadonlyArray<string>;     // full-refname globs to drop
}

export type NameRevStep =
  | { readonly kind: 'ancestor'; readonly count: number }   // ~count (first-parent chain, count ≥ 1)
  | { readonly kind: 'parent'; readonly number: number };   // ^number (number-th parent, number ≥ 2)

export interface NameRevResult {
  readonly oid: ObjectId;                          // queried commit, full 40-hex
  readonly ref: RefName | undefined;               // naming ref (full name); undefined ⇒ unnameable
  readonly tagDeref: boolean;                      // ref is an annotated tag (caller renders ^0 at the tip)
  readonly steps: ReadonlyArray<NameRevStep>;      // navigation from the ref's commit down to oid
}

// describe gains:
export interface DescribeOptions { /* …existing… */ readonly contains?: boolean; }
export function describe(ctx, rev, opts & { contains: true }): Promise<NameRevResult>;
export function describe(ctx, rev?, opts?): Promise<DescribeResult>;
```

`rev` resolves through the full grammar (`resolveCommit` — `~`/`^`/`@{…}`/oid
prefix, tags peeled), default `HEAD`, consistent with the other read commands.

## 6. Errors (structured, co-refusal-pinned)

- `name-rev` adds **no** error — an unnameable commit returns `ref: undefined`.
- `describe --contains` adds `CANNOT_DESCRIBE { oid }` (git: `fatal: cannot
  describe '<oid>'`) for the `--no-undefined` refusal, and reuses `INVALID_OPTION`
  for the ancestor-only options supplied with `contains`.

As a library tsgit raises typed errors, not git's stderr strings; the interop
asserts **co-refusal** (git and tsgit both fail on the same inputs), the
established pattern for `rm` / `describe`.

## 7. Test plan

### Unit (example, GWT/AAA, `sut`, 100% coverage, 0 surviving mutants)

- `is-better-name.ts` — each guard isolated: tag beats non-tag (and the reverse);
  nearer beats farther (same tag-ness); equal distance ⇒ older tagger date wins;
  full tie ⇒ keep existing (returns false). try/catch-free pure asserts.
- `step.ts` — first-parent bumps generation only; merge-parent flushes
  `generation`+`^n` into steps and zeroes generation (gen > 0 and gen = 0 cases);
  `foldSteps` appends the trailing ancestor iff generation > 0.
- `ref-pattern.ts` — `*`/`?` cross `/`; `refs/tags/*` matches nested; include set
  empty ⇒ all pass; matching exclude drops; tags-only prefix gate. Each guard
  isolated.
- `name-rev.ts` — annotated-tag tip (`tagDeref`, `^0`), lightweight-tag tip (no
  `^0`), branch tip, first-parent ancestor (`~n`), merged-side (`~m^2`,
  `~m^2~k`), tag-beats-near-branch, near-tag-beats-far-tag, equal-distance
  older-tag tie-break, `tags` restriction → `undefined`, `refs`/`exclude`
  filtering, unnameable → `ref: undefined`. HEAD default.
- `describe.ts` (contains branch) — delegates and maps `all`/`tags`/`match`/
  `exclude`; `always` returns undefined-ref result; unnameable without `always`
  → `CANNOT_DESCRIBE`; an ancestor-only option + `contains` → `INVALID_OPTION`.

### Property (`*.properties.test.ts`)

- `isBetterName` — **case 2 (compositional comparator)**: a tag always beats a
  non-tag regardless of distance; for same tag-ness the relation is a strict
  weak order on `(distance, taggerDate)` (irreflexive, asymmetric).
- `matchRefGlob` — **case 3 (total function over a grammar)**: never throws on
  any ASCII pattern/ref; a pattern of all-`*` matches every ref; literal pattern
  matches iff equal.
- `foldSteps` / render round-trip — **case 1**: rendering a `RevName`'s
  `(steps, generation)` and re-parsing the `~`/`^` tokens recovers the same step
  sequence (the test owns the parser; production never parses).

### Interop (`name-rev-interop.test.ts`, cross-tool parity vs real `git`)

Build repos with canonical git (pinned dates, signing off). A test-only `render`
+ `shortName` helper reconstructs git's line from the structured fields and
asserts equality with `git name-rev` / `git name-rev --tags` / `--refs` /
`--exclude` for: annotated-tag `^0`, lightweight tag, branch, first-parent `~n`,
the full `~m^2~k` merge path, tag-vs-branch + tag-vs-tag selection, and
`undefined` (unnameable). A `describe-contains` interop reconstructs `git
describe --contains` / `--all` / `--match` and asserts **co-refusal** on an
unnameable commit (`--no-undefined`).

### Parity scenario (`name-rev.scenario.ts`)

A small linear+merge history asserting the same `NameRevResult` on node / memory
/ browser.

## 8. Faithfulness invariants (prime directive)

- The chosen ref + path reconstruct `git name-rev`'s string byte-for-byte (every
  case above), under both the default and the `describe --contains` short-name
  rules — pinned by interop.
- Selection (tag > nearer > older-tagger-date, ref-name-sorted tie-break) matches
  git 2.54's observed behaviour, **not** the stale in-tree comment.
- Refusal conditions (`describe --contains` `--no-undefined`) co-refuse with git.
- The library renders no name and never abbreviates: faithfulness is a property
  of the **data** (`ref`, `tagDeref`, `steps`), per ADR-249. The cutoff (perf
  only) is deferred without changing output.

## 9. Surface gates (Tier-1 checklist)

- `src/application/commands/name-rev.ts` + barrel export (`commands/index.ts`).
- `repository.ts`: interface field + facade binding (overloaded `describe` for
  the contains mode, hand-written like `show`/`diff`; `nameRev` sorted in place).
- `repository.test.ts`: add `'nameRev'` to the facade key-set assertion.
- `reports/api.json`: regenerated (new command + `NameRev*` types + `describe`
  overload + `DescribeOptions.contains`).
- `docs/use/commands/name-rev.md` + a row in `docs/use/commands/README.md`
  (doc-coverage gate); bump "36 entries" → "37" there and in `README.md`.
- `test/integration/name-rev-interop.test.ts` + `describe-interop` contains cases.
- `test/parity/scenarios/name-rev.scenario.ts` (+ index registration).
- `docs/BACKLOG.md`: flip `23.8` to `[x]`; add the `26.2b` cutoff perf follow-up.

## 10. Open decisions (→ ADR conversation)

1. **`name-rev` output shape** — structured `{ ref, tagDeref, steps }` (caller
   renders `v2.0~3^2~1`) vs a pre-rendered `name` string. _Recommend structured_
   (ADR-249: no pre-rendered lines; `~n`/`^n` are counts, i.e. data).
2. **`describe --contains` surface** — overloaded `repo.describe` returning
   `NameRevResult` in contains mode vs a separate field on `DescribeResult` vs
   not adding `contains` (name-rev only). _Recommend the overload_ (mirrors git:
   describe --contains *is* name-rev; clean typing via the show/diff pattern).
3. **`--refs`/`--exclude` glob dialect** — own fnmatch (`*` crosses `/`, full
   refname) vs reusing `describe`'s anchored short-name `compileGlob`. _Recommend
   the own matcher_ (the dialects genuinely differ; verified `refs/tags/*` must
   match nested refs).
4. **Ancestor-only options + `contains`** — silently ignore (git-faithful) vs
   refuse with `INVALID_OPTION` (illegal-state-unrepresentable, diverges from
   git's refusal set). _Recommend refuse_ — a library boundary should reject
   meaningless combinations, and an unused-but-accepted option is a silent
   footgun; documented as a faithful divergence in the ADR.
