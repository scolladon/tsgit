# Design — `rm` staged-change safety valve (faithful to `git rm`)

## Goal

`repo.rm` is currently unconditionally permissive: it removes any index-matched
path with no check against HEAD or the working tree. Canonical `git rm` runs a
**safety valve** (`check_local_mod`) that refuses to destroy un-recoverable
changes unless overridden. 21.2a's `rm-interop` had to seed via a *commit* to
sidestep this valve. This phase adds the valve to `repo.rm` so it refuses the
same removals git refuses, with the same `--cached` / `-f` overrides, and a
co-refusal interop case proving parity.

## `git rm` valve semantics (verified empirically, git 2.54.0)

For each path in the index, git lstats the working file, then:

- If the **working file is absent** → never refuse (the deletion is what `rm`
  wants); just drop the index entry. git `continue`s past all checks on ENOENT.
- Else compute two booleans:
  - `staged` — the index entry `(id, mode)` differs from the **HEAD** tree entry
    `(id, mode)`. A path absent from HEAD (newly added / staged-but-uncommitted)
    counts as `staged`. **Mode-only** index/HEAD differences count (`chmod +x` +
    `git add` ⇒ staged).
  - `local` — the working file differs from the **index** entry. (git uses
    content **and** mode; see Faithfulness boundaries.)
- Classify and refuse (atomically — nothing is removed if any path refuses):

| `local` | `staged` | category | message | override |
|---|---|---|---|---|
| ✓ | ✓ | both | `the following file has staged content different from both the file and the HEAD` | **`-f` only** |
| ✗ | ✓ | staged-only | `the following file has changes staged in the index` | `--cached` or `-f` |
| ✓ | ✗ | local-only | `the following file has local modifications` | `--cached` or `-f` |
| ✗ | ✗ | clean | — | removed |

Override truth table (verified):

| state | plain `rm` | `rm --cached` | `rm -f` |
|---|---|---|---|
| staged-only | refuse | **allow** | allow |
| local-only | refuse | **allow** | allow |
| both | refuse | **refuse** (`-f` only) | allow |
| clean | allow | allow | allow |
| work file absent | allow | allow | allow |

So `--cached` suppresses the `staged-only` and `local-only` valves but **not**
the `both` valve; `-f` (force) suppresses all three.

## Scope decision (→ ADR)

**Recommended: implement the full valve (all three categories).** A
*staged-only* valve in isolation — the literal wording of the backlog entry —
would be **actively unfaithful**: for the `both` case it would emit the
staged-only message and wrongly accept `--cached` (git requires `-f`); for the
`local-only` case it would not refuse at all (git does). Faithfulness is the
project's first principle, so the design implements all three categories. The
alternative (staged-only) is documented in the ADR and rejected.

## Types

```ts
export interface RmOptions {
  readonly cached?: boolean;          // existing — --cached (index-only)
  readonly force?: boolean;           // NEW — -f, suppress the whole valve
  readonly breakStaleLockMs?: number; // existing
}
// RmResult unchanged: { removed: ReadonlyArray<FilePath> }
```

### Error taxonomy (three granular `RM_*` codes, mirroring `MV_*`)

```ts
| { code: 'RM_STAGED_CHANGES';            paths: ReadonlyArray<FilePath> } // staged-only
| { code: 'RM_LOCAL_MODIFICATIONS';       paths: ReadonlyArray<FilePath> } // local-only
| { code: 'RM_STAGED_AND_LOCAL_CHANGES';  paths: ReadonlyArray<FilePath> } // both
```

Factories in `domain/commands/error.ts`: `rmStagedChanges(paths)`,
`rmLocalModifications(paths)`, `rmStagedAndLocalChanges(paths)`. Each carries the
refused paths (already pathspec-validated, embedded verbatim like the `mv`
factories).

**Atomicity + multi-path:** validate every matched path, bucket the refusals,
and if any bucket is non-empty throw **before** mutating anything. When refused
paths span multiple buckets in one call (rare), throw by precedence
**both → staged-only → local-only** (the strongest required override first),
carrying that bucket's paths. Behaviour — atomic refusal, nothing removed — is
identical to git regardless of which message surfaces; git prints all categories,
tsgit surfaces the most-severe. Documented as a cosmetic divergence (ADR).

## Algorithm

```
rm(ctx, paths, opts):
  assertRepository / assertNotBare / assertNoPendingOperation
  if paths empty → EMPTY_PATHSPEC
  resolve pathspec → matcher
  acquire index lock
  index ← readIndex (missing-index tolerated → empty)
  matched ← [entry for entry in index if matcher matches entry.path]
  enforceLiteralMustMatch(matched)            // PATHSPEC_NO_MATCH, unchanged
  if not force:
    head ← headEntries(ctx)                   // Map<path,{id,mode}>; unborn ⇒ ∅
    buckets = { both:[], staged:[], local:[] }
    for entry in matched:
      if not (await workFileExists(ctx, entry.path)): continue   // absent ⇒ safe
      staged ← headMissing(entry) or head.id≠entry.id or head.mode≠entry.mode
      local  ← await workDiffersFromIndex(ctx, entry)            // content vs index.id
      if staged and local:        buckets.both.push(path)
      elif staged and not cached: buckets.staged.push(path)      // --cached suppresses
      elif local  and not cached: buckets.local.push(path)
    throwIfAnyRefused(buckets)   // precedence both→staged→local; nothing removed
  // ... existing removal: delete from index map; unless cached remove work file ...
  lock.commit(remaining entries); return { removed }
```

Notes:
- `--cached` (`cached: true`) only suppresses the `staged-only` and `local-only`
  buckets — the `both` bucket still refuses, exactly as git. So the `cached`
  check is applied per-category, not as a blanket skip.
- `force` short-circuits the entire valve (no HEAD read, no work hashing) — cheap
  and matches git's `if (!force) check_local_mod(...)`.

## Implementation / reuse

- **HEAD tree map:** `resolveRef(ctx, 'HEAD')` → `readObject` (commit) →
  `commit.data.tree` → `flattenTree(ctx, treeId)` ⇒ `Map<FilePath,{id,mode}>`.
  `flattenTree` is currently `@internal` (only `merge` uses it); rm is the
  "second caller" its doc anticipates — **promote it to the primitives barrel**
  (`primitives/index.ts`). Unborn HEAD (`resolveRef` throws `REF_NOT_FOUND`) ⇒
  empty map ⇒ every tracked entry is `staged` (matches git: pre-first-commit
  `rm` of a staged file refuses with "changes staged in the index").
- **work-vs-index:** extract `status.ts`'s `isModified` content-hash into a
  shared `internal/working-tree-diff.ts` helper (`workDiffersFromIndex(ctx,
  entry)`) and have both `status` and `rm` call it (DRY). The helper hashes the
  working bytes without persisting and compares to `entry.id`. **rm gates on
  file-existence first**, so unlike `status` it never treats a missing file as
  modified.
- **work-file-exists:** `ctx.fs.lstat(workPath).catch(()=>undefined) !==
  undefined`.

## Faithfulness boundaries (→ ADR consequences)

- **Working-tree-only *mode* change** (`chmod +x` with no `git add`): git refuses
  with "local modifications" via `ie_match_stat` mode bits. tsgit's `local`
  detection is **content-only** (the same basis `status` uses), so this narrow
  case is not detected. Rationale: cross-adapter mode fidelity is unreliable
  (memory/OPFS do not surface an executable bit), and the project's faithfulness
  target is **cross-adapter readback equivalence**, not host-mode parity. Staged
  mode changes (index vs HEAD) *are* detected — tsgit tracks index mode exactly.
- **`intentToAdd` (`git add -N`) entries:** git has a special-case (an i-t-a
  entry is not bucketed as `staged` under `--cached`). tsgit models the flag but
  treats i-t-a like any staged entry in the valve for now (YAGNI — no backlog
  item exercises `add -N` + `rm`). Documented; revisit if needed.

## Testing strategy

- **Unit (`rm.test.ts`)** — one isolated test per valve branch (per the
  guard-clause rule: each `staged` / `local` / `cached` / `force` condition gets
  its own test that triggers it alone):
  - staged-only → `RM_STAGED_CHANGES`; `--cached` allows; `-f` allows.
  - local-only → `RM_LOCAL_MODIFICATIONS`; `--cached` allows; `-f` allows.
  - both → `RM_STAGED_AND_LOCAL_CHANGES`; `--cached` **refuses**; `-f` allows.
  - clean → removed (regression guard).
  - work file absent + staged → removed (the ENOENT gate).
  - mode-only staged change → `RM_STAGED_CHANGES`.
  - unborn HEAD + staged file → `RM_STAGED_CHANGES`.
  - multi-path multi-bucket → precedence (both wins).
  - Error assertions use try/catch + `.data.code` **and** `.data.paths` (specific,
    StringLiteral-mutant-resistant per CLAUDE.md).
  - Nothing-removed assertions on every refusal (index unchanged, work file present).
- **Interop (`rm-interop.test.ts`)** — add co-refusal cases: stage a change (and a
  local-mod, and both) in tsgit and the peer, run `repo.rm` vs `git rm`, assert
  both refuse and the index (`git ls-files --stage`) + working tree are unchanged
  and identical. Add `--cached`-allows and `-f`-allows parity cases. The existing
  "seed via commit to sidestep the valve" comment stays accurate for the
  *clean-removal* cases.
- **No property tests:** `rm` is orchestration over the index + working tree (an
  I/O command facade), not a parser/matcher/round-trip — none of the four lenses
  fit (per CLAUDE.md).
- **Coverage:** 100%; **mutation:** target 0 survivors (the per-branch isolated
  tests kill the `&&`/`||`/comparison mutants in the classifier).

## Key decisions

1. **Full valve, not staged-only** — faithfulness; staged-only diverges for the
   `both` and `local-only` cases. (ADR.)
2. **Three granular `RM_*` codes + atomic precedence throw** — mirrors `MV_*`;
   lets tests assert the exact category. (ADR.)
3. **`local` detection is content-only** — cross-adapter consistency; documents
   the working-tree-mode-only gap. (ADR consequence.)
4. **Promote `flattenTree` to the primitives barrel** — rm is the anticipated
   second caller; no new HEAD-tree-flattening code.
5. **Add `force` to `RmOptions`; reuse `cached`** — the two overrides the backlog
   names; no `dryRun`/`skipErrors` (YAGNI — git `rm` refusal is atomic, no `-k`).
