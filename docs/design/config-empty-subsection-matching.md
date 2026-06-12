# Design — Empty-subsection identity: `[s ""]` vs `[s]`

## Goal

Close the section-identity faithfulness gap in the config writer's two section matchers (backlog 24.9k, surfaced by 24.9g; twin matcher noted by 24.9i):

- git treats an explicitly empty subsection as a **distinct section**: `s.k` never matches `[s ""]`, and `s..k` (empty subsection in the dotted key) never matches `[s]` (pinned below).
- tsgit's line-based `matchesSection` and token-based `matchesTarget` both conflate the two — a query with `subsection === undefined` matches `[s]` **and** `[s ""]` — so writes targeting `s.k` can replace, insert into, or delete entries belonging to `[s ""]`.
- The read path is already exact (`matchesSectionHeader`, `qualifyKey`, `parseConfigKey`) — the fix realigns the write matchers with the identity rule the readers already apply, restoring one rule across the whole surface.

Both matchers express one identity rule and are fixed together (the brief's requirement): line-based section ops (rename/remove-section) and token-based entry surgery (set/unset/append) share it.

## git's exact behaviour (pinned against git 2.54.0)

All pinned empirically via `git config --file` with a scrubbed environment (`env -i`, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, no signing). Fixtures:

- `both.conf` = `[s]\n\tk = a\n[s ""]\n\tk = b\n`
- `rev.conf` = the same two blocks in reverse order
- `empty-only.conf` = `[s ""]\n\tk = b\n` ; `plain-only.conf` = `[s]\n\tk = a\n`

### Read identity

| Command | Result | Exit |
| --- | --- | --- |
| `git config --file both.conf s.k` | `a` | 0 |
| `git config --file both.conf s..k` | `b` | 0 |
| `git config --file rev.conf s.k` / `s..k` | `a` / `b` — order-independent | 0 |
| `git config --file empty-only.conf s.k` | no output — `s.k` does NOT match `[s ""]` | 1 |
| `git config --file plain-only.conf s..k` | no output — `s..k` does NOT match `[s]` (reverse identity) | 1 |
| `git config --file both.conf --get-all s.k` / `s..k` | `a` / `b` | 0 |
| `git config --file both.conf --list` | `s.k=a` and `s..k=b` — empty subsection renders as the double-dot key | 0 |
| `git config --file both.conf --list -z` | `s.k\na\0s..k\nb\0` | 0 |
| `git config --file both.conf --get-regexp '.*'` | `s.k a` and `s..k b` | 0 |
| `git config --file both.conf --get-regexp '^s\.k$'` / `'^s\.\.k$'` | `s.k a` only / `s..k b` only | 0 |
| `git config --file <[S ""] k=caps> s..k` | `caps` — section part case-insensitive, identity preserved | 0 |
| `git config --file <[s     ""] k=b> s..k` | `b` — header whitespace before the quote is not identity | 0 |

### Write identity (`set` / `--add`)

| Command | Resulting bytes | Note |
| --- | --- | --- |
| `git config --file both.conf s.k v` | `[s]\n\tk = v\n[s ""]\n\tk = b\n` | only `[s]` rewritten |
| `git config --file both.conf s..k v` | `[s]\n\tk = a\n[s ""]\n\tk = v\n` | only `[s ""]` rewritten |
| `git config --file rev.conf s.k v` | `[s ""]\n\tk = b\n[s]\n\tk = v\n` | first-in-file `[s ""]` never captures the write |
| `git config --file rev.conf s..k v` | `[s ""]\n\tk = v\n[s]\n\tk = a\n` | |
| `git config --file empty-only.conf s.k v` | `[s ""]\n\tk = b\n[s]\n\tk = v\n` | a NEW `[s]` is appended — git does not reuse `[s ""]` |
| `git config --file plain-only.conf s..k v` | `[s]\n\tk = a\n[s ""]\n\tk = v\n` | a NEW `[s ""]` is appended |
| `git config --file empty s..k v` | `[s ""]\n\tk = v\n` | from-scratch creation renders `[s ""]` |
| `git config --file <prev> --add s..k v2` | `[s ""]\n\tk = v\n\tk = v2\n` | append lands inside `[s ""]` |
| `git config --file empty-only.conf --add s.k x` | `[s ""]\n\tk = b\n[s]\n\tk = x\n` | `--add` appends a new `[s]` too |

### Unset identity

| Command | Resulting bytes | Exit |
| --- | --- | --- |
| `git config --file both.conf --unset s.k` | `[s ""]\n\tk = b\n` — `[s]` entry removed, emptied block pruned, `[s ""]` untouched | 0 |
| `git config --file both.conf --unset s..k` | `[s]\n\tk = a\n` | 0 |
| `git config --file empty-only.conf --unset s.k` | file unchanged — nothing matched | 5 |
| `git config --file <[s]k=a · [s ""]k=b · [s]k=c> --unset-all s.k` | `[s ""]\n\tk = b\n` — both `[s]` blocks cleared and pruned | 0 |
| `git config --file <[s ""]k=a · [s ""]k=b · [s]k=c> --unset-all s..k` | `[s]\n\tk = c\n` | 0 |

### Section ops (`--rename-section` / `--remove-section`)

git addresses the empty subsection with a **trailing-dot name** `s.` (and only that — `s.""` is the two-quote-char subsection, "no such section"):

| Command | Result | Exit |
| --- | --- | --- |
| `--remove-section s` on `both.conf` | `[s ""]\n\tk = b\n` — only `[s]` removed | 0 |
| `--remove-section s.` on `both.conf` | `[s]\n\tk = a\n` — only `[s ""]` removed | 0 |
| `--remove-section 's.""'` on `both.conf` | `fatal: no such section: s.""` | 128 |
| `--remove-section s.` on `plain-only.conf` | `fatal: no such section: s.` | 128 |
| `--remove-section s` on `empty-only.conf` | `fatal: no such section: s` | 128 |
| `--rename-section s t` on `both.conf` | `[t]…[s ""]…` — plain form renamed, empty form untouched | 0 |
| `--rename-section s. t.` on `both.conf` | `[s]…[t ""]…` | 0 |
| `--rename-section s. t` on `both.conf` | `[s]…[t]…` — empty form renamed TO a plain section | 0 |
| `--rename-section s s.` on `both.conf` | `[s ""]…[s ""]…` — plain renamed TO the empty form (duplicate headers allowed) | 0 |
| `--rename-section s.x s.` on `[s "x"]k=a` | `[s ""]\n\tk = a\n` | 0 |

Two adjacent observations land outside this item's scope (recorded for the follow-up decision below): git's `--rename-section` freely renames **across section families** (`s t`, `s. t.`) where tsgit refuses, and git accepts plain (subsectionless) names for both ops where tsgit requires a dotted name.

### Key-shape edge: the empty section name

`git config --file f ..k v` succeeds and writes `[ ""]\n\tk = v\n`; `--list` on such a file prints `..k=x`; the GET form exits 1 silently. An **empty section name** with an empty subsection is therefore representable in git. tsgit's `parseConfigKey` refuses an empty section (`empty-section`). This is a separate identity axis (section-name grammar, not subsection identity) — scoped out below.

## Current state

One identity rule, three implementations — one exact, two conflating:

| Site | File / symbol | Rule today |
| --- | --- | --- |
| Read matcher | `src/application/primitives/internal/config-key.ts` `matchesSectionHeader` (line 16) | **exact** — `undefined` matches only `undefined`, `''` only `''` |
| Line-based write matcher | `src/application/primitives/update-config.ts` `matchesSection` (line 41) | **conflating** — `undefined` matches `undefined` OR `''` |
| Token-based write matcher | `src/application/primitives/update-config.ts` `matchesTarget` (line 140) | **conflating** — same arm, copied verbatim per ADR-316 ("preserved verbatim") |

Call-site inventory (every place the identity rule reaches):

- **Exact already (no change):**
  - `collectValues` / `collectScopedValues` (`internal/config-key.ts`) → `configGet`, `configGetAll`, `configUnset`/`configUnsetAll` existence + multiplicity checks, scoped reads.
  - `qualifyKey` (`internal/config-key.ts` line 8) → `configList` / `configGetRegexp` key rendering: `[s ""]` qualifies as `s..k`, byte-equal to git's `--list` rendering (pinned).
  - `parseConfigKey` (`src/domain/commands/config-key.ts`) → `s..k` parses to `subsection: ''` (first-dot/last-dot split), so the empty subsection is **already addressable** through every key-taking surface, matching git's key grammar.
  - `dispatchSection` (`src/application/primitives/config-read.ts` line 580) → `[core ""]` / `[user ""]` are NOT merged into `core`/`user` (`subsection === undefined` guards), and `[remote ""]`-style sections merge under the `''` name — consistent with exact identity.
- **Conflating (the fix):**
  - `matchesSection` → `findSectionHeader` (existence checks in `renameConfigSection` / `removeConfigSection`, update-config.ts lines 875/909), `removeConfigSectionInText` (line 462), `renameConfigSectionInText` (line 491). Today every porcelain caller passes a non-empty subsection (`parseSectionName` refuses both `s` and `s.`), so the conflating arm is latent here — but `removeConfigSectionInText` / `renameConfigSectionInText` are exported primitives, and a direct caller passing `undefined` silently drops/renames `[s ""]` blocks too.
  - `matchesTarget` → `findEntry` (replace target selection), `insertionLine` (new-key placement, also used by `appendConfigEntry`), `removeConfigEntry` block matching (line 423), and the batch `applyConfigOpInText` — i.e. **every entry write**.

Observable divergences today (each is a pinned-matrix row tsgit gets wrong):

1. `setConfigEntry('s.k', v)` on `rev.conf` replaces the `k` inside `[s ""]` (first matching block in line order); git rewrites `[s]`.
2. New-key insertion targets the end of the **last** matching block (ADR-316), so with `both.conf` + a new key, the entry lands inside `[s ""]`; git puts it at the end of `[s]`.
3. `unsetConfigEntry('s.k')` on `both.conf`: the multiplicity guard (`collectValues`, exact) counts **1** match, but `removeConfigEntry` (conflating) deletes the `k` from **both** blocks and prunes both — silent data loss, and an internal contradiction between counter and surgery.
4. `setCoreConfigEntryInText` on a file holding only `[core ""]` edits that block in place; git appends a real `[core]`. The unit test at `test/unit/application/primitives/update-config.test.ts` ("Given an explicitly empty `[core ""]` header → Then it is treated as the [core] section") pins the divergence and flips with the fix.
5. `removeConfigSection` / `renameConfigSection` cannot address `[s ""]` at all: `parseSectionName` (update-config.ts line 822) refuses the trailing-dot form git uses (`s.`).

## Design

### Matcher fix — one exact identity rule (forced by the pinned evidence)

Drop the conflation arm in both matchers; subsection identity becomes strict equality over `string | undefined`:

- `matchesSection`: `if (subsection === undefined) return header.subsection === undefined; return header.subsection === subsection;` — equivalently `header.subsection === subsection` after the section check (both sides are `string | undefined`; `undefined === undefined` and `'' === ''` hold, cross-pairs do not).
- `matchesTarget`: same one-line collapse (`header.subsection === target.subsection`).

After the collapse the "rule" is a single `===` in each matcher — no shared helper is warranted (the abstraction would be larger than the duplication). Doc comments on both matchers, `setConfigEntryInText`, and `removeConfigEntry` are updated to state the distinct-identity rule.

Everything downstream inherits the fix with zero signature changes: `findEntry`, `insertionLine`, `appendConfigEntry`, `removeConfigEntry`, `applyConfigOpInText`, `removeConfigSectionInText`, `renameConfigSectionInText`, `findSectionHeader`. The pinned write matrix (replace / insert / append / unset / unset-all / prune, both orders) falls out of ADR-316's existing span machinery once the block matcher is exact. Divergence 3's counter-vs-surgery contradiction closes for free because counter and surgery now share the rule.

`renderSectionHeader(section, '')` already emits `[s ""]` and `parseSectionHeader` round-trips it (24.9g), so from-scratch creation of the empty form needs no writer change.

### Addressing — `s..k` keys already work; section ops gain git's trailing-dot form (open decision 1)

The dotted-key surface needs nothing: `parseConfigKey('s..k')` → `{section: 's', subsection: '', name: 'k'}` today, and with exact matchers every get/set/unset against `s..k` lands on `[s ""]` exactly as pinned.

For `configRenameSection` / `configRemoveSection`, the recommended change is to extend `parseSectionName` to git's name grammar for the empty form: a trailing-dot input (`'s.'`) yields `{section: 's', subsection: ''}` instead of refusing. `rejectSubsection('')` already passes; `renameConfigSectionInText` accepts `''` for either side, giving the pinned `s. → t.`-shape conversions (within the current same-family constraint, i.e. `s. ↔ s.x`). The `s.""` form needs no special handling — it naturally parses to subsection `'""'`, which matches nothing, mirroring git's "no such section". Plain-name (`s`) addressing and cross-family renames remain refused — a pre-existing, now-pinned scope boundary (see below); the docstring claim that "top-level sections cannot be renamed by canonical git either" is corrected (pinned: git renames them freely).

### Error/refusal shapes

No new error codes. `CONFIG_SECTION_NOT_FOUND` already carries the dotted name (`'s.'` for the empty form — byte-equal to git's `no such section: s.` rendering per ADR-249). `parseSectionName`'s `INVALID_OPTION` shape is unchanged for still-refused inputs (`s`, `.x`).

## Ripple inventory

| Site | Change |
| --- | --- |
| `update-config.ts` `matchesSection` | drop `\|\| header.subsection === ''` arm + doc comment |
| `update-config.ts` `matchesTarget` | drop the twin arm + doc comment |
| `update-config.ts` `parseSectionName` | (decision 1) trailing-dot → `subsection: ''`; doc comment corrected |
| `update-config.ts` rename/remove docstrings | distinct-identity + `s.` form documented |
| `test/unit/.../update-config.test.ts` `[core ""]` case | expectation flips to git's (new `[core]` appended) |
| `reports/api.json` | unchanged — no public type changes |

No domain, port, or adapter changes; no new public surface (the `s.` name form flows through the existing `oldName`/`sectionName` string inputs).

## Test plan

### Unit (`test/unit/application/primitives/update-config.test.ts`)

GWT/AAA with `sut`, byte-exact output assertions (mutation-resistant — full-string `toBe`, not `toContain`):

- **Replace**: `setConfigEntryInText` with `subsection: undefined` on both-form text, both orders → only `[s]` rewritten; with `subsection: ''` → only `[s ""]` rewritten. Separate tests per direction (guard isolation: `undefined`-query-vs-`''`-header and `''`-query-vs-`undefined`-header each get their own test so each side of the identity is independently proven).
- **Insert**: new key with both forms present → lands at end of the last `[s]` block, never inside `[s ""]`; only `[s ""]` present + `undefined` target → a new `[s]` section appended (and the mirror case).
- **Append** (`appendConfigEntry`): same placement matrix.
- **Unset** (`removeConfigEntry`): `undefined` target removes/prunes only `[s]` blocks across the three-block fixture; `''` target only `[s ""]` blocks; the flipped `[core ""]` case.
- **Section ops**: `removeConfigSectionInText` / `renameConfigSectionInText` with `undefined` vs `''` on both-form text; `parseSectionName('s.')` (decision 1) and porcelain rename/remove of the `s.` form incl. `CONFIG_SECTION_NOT_FOUND` data assertions via try/catch (code + name + scope, not `toThrow(Class)`).
- **Consistency**: `unsetConfigEntry('s.k')` on both-form text no longer throws/over-deletes — exactly the `[s]` entry goes, `CONFIG_MULTIPLE_VALUES` data asserted on the true-multi fixture.

### Interop (`test/integration/config-interop.test.ts`)

Twin git/tsgit over a shared scrubbed-env repo (one `beforeAll` repo, 60s timeout per the harness conventions): every row of the pinned matrix above —

- get/get-all on `both.conf`/`rev.conf`/single-form files (`s.k`, `s..k`), absence exits ↔ `value: undefined`;
- `--list` / `--get-regexp` reconstruction from structured entries (`s.k=a`, `s..k=b` key shapes byte-equal);
- set/add matrix (8 write rows) → byte-identical files;
- unset/unset-all matrix (5 rows) → byte-identical files incl. pruning;
- rename/remove-section: `s.` form via porcelain (decision 1); plain-`s` rows pinned at primitive level (`removeConfigSectionInText(text, 's', undefined)` vs `git --remove-section s` bytes) until plain-name addressing lands;
- from-scratch `s..k` set → `[s ""]` header bytes.

### Property (four-lens assessment per CLAUDE.md)

- **Lens 1 (round-trip)** — already covered: `subsectionName()` in `test/unit/application/primitives/arbitraries.ts` includes `''`, and the 24.9g properties prove `parse(render(s)) ≡ s`. No new round-trip property.
- **Lens 2 (compositional matcher)** — fits: the matchers reduce a header/target pair to a verdict. New property in `update-config.properties.test.ts`: for an arbitrary identity pair drawn from `{undefined, '', <non-empty subsection>}` with distinct values, `setConfigEntryInText` targeting identity A leaves every byte of the identity-B block unchanged (and modifies the A block). Uses the existing config-file generators; numRuns 100. This is an invariant over the grammar, not a re-implementation of the matcher — no tautology.
- **Lens 3 (totality)** — n/a: no new parser/compiler.
- **Lens 4 (idempotence/counting)** — n/a beyond existing writer properties.

### Mutation

The production diff *removes* the conflation arm, so the prior surviving-mutant surface disappears. Remaining `===` comparisons are killed by the direction-isolated unit fixtures (each cross-pair has a test whose byte-exact expectation fails under `===`→`!==` or operand swaps). No equivalent mutants anticipated.

## Risks

- **Behaviour break by design**: files written by pre-fix tsgit that used `[s ""]` interchangeably with `[s]` (e.g. a `[core ""]` block edited in place) now read/write as distinct sections — exactly git's reading of those bytes, so the break converges with canonical git (ADR-226). The flipped unit test documents it.
- **Latent-arm exposure**: `removeConfigSectionInText`/`renameConfigSectionInText` semantics change for direct primitive callers passing `undefined` — none exist in-tree beyond tests; covered by the unit matrix.
- **Order sensitivity**: `insertionLine`'s last-matching-block rule now sees fewer matching blocks; the both-order fixtures pin that no placement regression hides in block iteration.

## Scope boundaries (out — pinned here, decided elsewhere)

- **Plain-name (`s`) rename/remove + cross-family renames** — git supports both (pinned above); tsgit's `parseSectionName`/family guard refuse. A separate addressing-breadth gap, recorded as a backlog follow-up; the plain-side identity rows are still interop-pinned at primitive level here.
- **Empty section name** (`..k`, `[ ""]`) — git representable (pinned); `parseConfigKey` refuses `empty-section`. Separate identity axis, backlog follow-up.
- **`--unset` exit-code surface (5 vs 1)** — rendering of absence is the caller's concern (ADR-249); tsgit's no-op unset stays.

## Open decisions (for the ADR phase)

1. **Section-op addressing of the empty form** — recommended: `parseSectionName` accepts git's trailing-dot `s.` → `subsection: ''` (two-line change, byte-faithful name grammar). Alternatives: structured `{section, subsection}` porcelain input (new surface for one form — heavier, ADR-249 does not require it for *inputs*); or leave the empty form non-addressable in section ops (fails the pinned rename/remove rows at porcelain level).
2. **Follow-up packaging** — recommended: one backlog entry covering plain-name + cross-family section-op parity, one for the empty-section-name axis. Alternative: fold either into this item (widens a two-line matcher fix into an addressing-grammar rework).
