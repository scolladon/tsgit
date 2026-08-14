# Design — write the pack reverse index (`.rev`) beside every `.idx`

> Brief: write `pack-<sha>.rev` alongside every `.pack`/`.idx` tsgit writes, as canonical git
> does since 2.41, gated by `pack.writeReverseIndex` — plus, per ADR-627, repo-wide **strict
> boolean config refusal** so that gate (and every boolean key tsgit already reads) refuses a
> malformed value exactly where git refuses it.
> Status: draft → self-reviewed ×3 → **revised against ADRs 624–632** → self-reviewed ×3
> Backlog: **28.4** (new) · Spike: `docs/spike/pack-aux-write-side.md` · git pinned: **2.55.0**, darwin 25.5.0

## Revision note — ADRs 624–632

Nine decision candidates went to the ADR conversation. **Eight were adopted as recommended**
(ADR-624 = DC-1, 625 = DC-2, 626 = DC-3, 628 = DC-5, 629 = DC-6, 630 = DC-7, 631 = DC-8,
632 = DC-9); their sections below are unchanged apart from being restated as decided.

**ADR-627 deviates from DC-4.** The user rejected both the design's lenient recommendation
*and* the per-key alternative, and ratified **repo-wide strict boolean refusal in this same
change**. That expansion is the substance of this revision: §D6 is rewritten, a new §D6a
specifies the strict parse, Pins K/L are new, requirements 14–19 are new, interop row X7 flips
from a divergence row to a both-tools-refuse row and gains siblings X7b and X11–X16, and the
"strict boolean refusal is a separate entry" line is struck from Out of scope.

### Discrepancy against ADR-627's grammar sketch (for the session to amend)

ADR-627 states the adopted grammar as *"`true`/`yes`/`on`/`1` (and a valueless key) are true;
`false`/`no`/`off`/`0` (and the empty value) are false; case-insensitive; anything else refuses."*
**The numeric arm is wrong** — `1` and `0` are not special. Pinned empirically in Pin K against
git 2.55.0: git falls back to its **full integer grammar** (`git_parse_int`) for any value that is
not one of the six boolean words, and accepts *every* integer it can represent — non-zero ⇒ true,
zero ⇒ false. So `2`, `-1`, `007` (octal), `0x1` (hex), `+1` and `1k` (unit factor) are all **true**;
`00`, `0x0` and `0k` are all **false**. The refusal set is therefore narrower than the ADR implies:
only values that fail that integer parse refuse (`maybe`, `1.0`, `" "`), plus integers that
**overflow C `int`** — `2147483648`, `-2147483649`, `0x80000000`, `2g` all refuse even though they
are well-formed integers, because git's boolean path narrows to a C `int`, while its `--type=int`
path keeps the full 64-bit signed range (Pin K3).

A second, independent gap: ADR-627's consequences say *"every boolean config consumer … moves to
the strict parse"* without saying **where the refusal fires**. Git's refusal is **lazy and
tiered** — it fires only where the key is actually consumed, and the tier differs per key
(Pin L). A single eager gate at config-parse time would refuse where git succeeds and is
therefore *not* faithful. §D6a pins the three-tier placement instead.

Neither point changes ADR-627's decision (strict refusal, repo-wide, this change); both change
the specification the implementation must hit. **This design does not edit the ADR** — the
session should amend ADR-627's grammar paragraph and add the tiering to its consequences.

## Context

### The one divergence this closes

28.3 (`design/rev-index-bitmap-read-support.md`) gave tsgit a full `.rev` **read** side: a domain
parser (`src/domain/storage/rev-index.ts`), an artefact loader
(`src/application/primitives/internal/pack-artefact-source.ts`), a live accelerator in the pack
offset table (ADR-604), and an `fsck` pass (exit bit 64). That design's §D17 **W-1** recorded the
write side as *"a live cross-tool asymmetry, pre-existing and now permanent"*, and ADR-614 spelled
it out: *"Writing `.rev` and `.bitmap` is excluded permanently, not deferred."*

`docs/spike/pack-aux-write-side.md` (2026-08-13) re-opened exactly half of that. Its finding, pinned
against git 2.55.0:

- `.rev` is the **only** auxiliary artefact git writes at pack-receive time. Every `.idx` write —
  `index-pack` on clone/fetch, `pack-objects` — emits a sibling `.rev`, because
  `pack.writeReverseIndex` has defaulted to true since git 2.41.
- `.bitmap`, the multi-pack-index and the commit-graph are born **exclusively** in
  repack/gc/maintenance, surfaces tsgit does not have. Writing them at fetch/clone time would
  itself be unfaithful.
- The `.rev` format is fully deterministic, so — unlike a bitmap, whose contents follow git's
  commit-selection heuristics — **byte identity is an available contract**, not an aspiration.

So ADR-614's blanket exclusion was right about `.bitmap` and wrong about `.rev`: it grouped a
deterministic, everyday-path artefact with a heuristic, maintenance-only one. This design revises
**W-1 for `.rev` only**. `.bitmap`/midx/commit-graph writing stays excluded, on ADR-614's own reason,
and is re-stated in Out of scope.

### What tsgit writes today

One artefact pair, from one module:

| site | file | today |
|---|---|---|
| `src/application/primitives/internal/write-pack-artifacts.ts` | `buildIdx` → `.idx` body + second trailer; `writePackArtifacts` → `.pack`, `.idx`, optional `.promisor` | the whole write surface |
| `src/application/primitives/fetch-pack.ts` `materializePack` (~L155–186) | clone / fetch / partial-clone lazy fetch | calls `buildIdx` then `writePackArtifacts`, then `refreshPackRegistry(ctx)` |
| `src/application/commands/pack-objects.ts` (~L86–100) | Tier-1 `packObjects`, optionally into `opts.outputDirectory` **outside** the repo | same pair; `refreshPackRegistry` only when writing into the repo's own pack dir |
| `src/application/commands/push.ts`, `bundle create` | pack stays in memory, no `.idx` | nothing on disk — correct, git behaves the same (Pin J) |

`src/domain/storage/pack-writer.ts` holds the two serializers and the file-header annotation
`@writes surface: packfile, kind: equivalent-under-readback, format: git-packfile-v2` — the pack
bytes are not bit-exact across writers (deflate level, delta selection), so its contract is
acceptance + readback.

### Subsystems this touches

| area | files |
|---|---|
| domain serializer | `src/domain/storage/rev-index.ts` (parser today), `src/domain/storage/pack-writer.ts` (`serializePackIndex`, `IDX_SHA_LENGTH`, `compareBytes` sort), `src/domain/storage/index.ts` (barrel) |
| application write path | `src/application/primitives/internal/write-pack-artifacts.ts`, `fetch-pack.ts`, `src/application/commands/pack-objects.ts` |
| config | `src/application/primitives/config-read.ts` — `ParsedConfig`, `dispatchSection` (L1057), `parseGitBoolean` (L1622), `parseGitInt` (L1690), `findFirstValuelessEntry` (L196) / `findFirstValuelessInSection` (L238) / `findFirstInvalidCompression` (L299), the per-`Context` token cache `readConfigEntry` (L133) |
| strict boolean (ADR-627) | `src/domain/commands/error.ts` (new `CONFIG_BAD_BOOLEAN_VALUE` variant + factory), `src/domain/error.ts` (message arm), `src/application/primitives/internal/repo-state.ts` (`assertRepository`, `assertCoreConfigValid`, `assertOperationalRepository`), `src/application/primitives/internal/valueless-config-guard.ts` (sibling guard), `src/application/primitives/internal/config-scope.ts` (`isWorktreeScopeActive`), plus the twelve consumer sites enumerated in §D6a |
| read side (verify only, no change) | `internal/pack-offset-table.ts` (`REV_INDEX_MIN_OBJECTS = 5_000`, `resolveSortedOffsets`), `internal/pack-positions.ts` (`packPositionMap`, `gatherByRevIndex`), `pack-registry.ts` `scanPacks` (`fileNames` set, ~L494) |
| audit | `tooling/audit-write-surfaces.ts`, `tooling/audit-write-surfaces.allowlist.json` (currently `{"surfaces": []}`) |
| tests | `test/unit/domain/storage/{rev-index,pack-writer}.test.ts`, `rev-index.properties.test.ts`, `arbitraries.ts` (`RevIndexSpec`/`buildRevIndex`/`arbRevIndexSpec`, L396–458), `test/parity/scenarios/pack-objects.scenario.ts` (**asserts `packDirEntryCount: 2` with the comment "no `.rev`, no bitmap"**), `test/integration/interop-helpers.ts`, `test/integration/rev-bitmap-fixture-helpers.ts` |

### Constraining prior decisions

| decision | binding effect here |
|---|---|
| **ADR-226** (git-faithfulness prime directive) | the whole reason this entry exists; the `.rev` bytes are on-disk state, so byte-for-byte binds |
| **ADR-249** (structured data only) | `.rev` writing is on-disk state, not rendered output — untouched, but it forbids adding a "print what we wrote" surface |
| **ADR-140** (`@writes` grammar) | one `@writes` block per file; `kind` ∈ `byte-identical` \| `equivalent-under-readback` \| `readback-only`; every annotated surface needs a `cross-tool-interop` test naming it in `interopSurface:` |
| **ADR-604** (`.rev` is a live accelerator) | the freshly written file is *consumed* by tsgit's own next open — but only above `REV_INDEX_MIN_OBJECTS = 5_000` objects; below it the artefact is deliberately never opened |
| **ADR-606** (body trusted on the read path) | tsgit never verifies a `.rev` body on read; correctness of what we write is therefore proven by the interop byte-compare, not by a later self-check |
| **ADR-614** (`pack-objects` ships closure-to-pack only) | **revised for `.rev` by this design**; its `.bitmap`/delta-compression exclusions stand |
| **ADR-602 / ADR-592** (midx read) | a new pack the midx does not name is outside the midx's universe; a new `.rev` changes nothing there |
| **ADR-627** (this change, ratified deviation) | strict boolean refusal is repo-wide and lands **here**, not as a follow-up; every boolean key in `ParsedConfig` is in scope, each refusal pinned against real git |
| **ADR-327 / ADR-328** (`CONFIG_MISSING_VALUE`) | fixes the *shape* the boolean refusal must mirror: a typed error carrying `{ key, source, … }`, the key token lower-cased with the subsection verbatim, and an interop test that reconstructs git's line from the fields |
| **ADR-346** (eager broad `[core]` gate vs per-accessor) | fixes the *placement* rule: refuse exactly where git refuses — eagerly for keys git reads in its default-config pass, per-accessor for the lazy ones, and keep the config porcelain alive where git keeps it alive |
| **ADR-314** (porcelain config reads stay faithful) | constrains the Tier-1/Tier-2 split in §D6a: `core.bare` kills tsgit's `config` porcelain (git does), `core.sparseCheckout` must not (git does not) |

### House patterns this must follow

1. **Body/trailer split.** `serializePackIndex` (domain, pure, sync) emits everything up to and
   including the embedded pack checksum; `buildIdx` (application, async, has `ctx.hash`) appends the
   file's own digest. The `.rev` has the identical two-digest tail and gets the identical split.
2. **`writeExclusive` for pack artefacts** — `.pack`, `.idx`, `.promisor` all use it today.
3. **Branded/typed inputs, no primitive obsession**, no boolean parameters (the existing
   `promisor: boolean` positional is already a smell; do not add a second).
4. **Positive allow-list error classification**, never a bare `catch`.
5. **Property test beside the example test** when a parse/serialize pair exists — it now does.

## Pinned matrices — git 2.55.0, darwin 25.5.0

All probes ran in a `mktemp -d` throwaway with `HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, `GIT_*`
scrubbed and signing off. Fixture **F1**: 5 blobs + 1 tree + 1 commit = **7 objects**, SHA-1.

### Pin A — which surfaces write a `.rev`

| # | surface | command | `.rev`? |
|---|---|---|---|
| A1 | clone (`index-pack`) | `git clone --no-local repo clone1` | **yes** — `pack-<sha>.rev` beside the pair |
| A2 | fetch that keeps a pack | `git -c fetch.unpackLimit=1 fetch origin` | **yes**, for the new pack |
| A3 | fetch below `unpackLimit` | `git fetch origin` (default 100) | no pack at all → no `.rev` (not a divergence) |
| A4 | raw index-pack to an arbitrary dir | `git index-pack -o p.idx p.pack` | **yes** — `p.rev`; note it runs **outside any repository**, which is what makes it usable as the interop oracle |
| A5 | `pack-objects` with a prefix | `… \| git pack-objects <dir>/prefix` | **yes** — `prefix-<sha>.rev` |
| A6 | `repack -adq` / `gc` | (spike §Results) | **yes**, plus auto-heal on a `.rev`-less repo |
| A7 | `bundle create` | `git bundle create b.bundle --all` | **no** `.rev` anywhere |
| A8 | `push` (client side) | `git push <bare> --all` | no local pack written → no `.rev` |

**Rule for A4/A5:** the `.rev` path is the **`.idx` path with the suffix replaced**, not a name
derived from the pack checksum. `p.idx` → `p.rev`; `prefix-<sha>.idx` →
`prefix-<sha>.rev`. tsgit always names its idx `pack-<sha>.idx`, so the same rule yields
`pack-<sha>.rev` in both the repo pack dir and an `outputDirectory`.

### Pin B — `pack-<sha>.rev`, byte for byte (F1, SHA-1, 80 bytes)

```
00000000: 5249 4458 | 0000 0001 | 0000 0001    R I D X | version=1 | hashId=1
0000000c: 0000 0003 0000 0004 0000 0005        body: 7 × u32BE
          0000 0001 0000 0006 0000 0002
          0000 0000                            … ends at 0x28
00000028: 3c60 3ae3 …13e0                      embedded pack checksum (= .pack trailer)
0000003c: cf48 51b5 …71a7                      the .rev's own digest over [0, len − 20)
```

| field | rule |
|---|---|
| magic | `{'R','I','D','X'}` = `0x52494458` |
| version | u32BE `1` |
| hash id | u32BE — `1` = SHA-1, `2` = SHA-256 (Pin F) |
| body | `objectCount` × u32BE; `body[p]` = **index position** of the object at **pack position** `p` |
| embedded checksum | `digestLength` bytes, a copy of the `.pack` trailer |
| trailer | `digestLength` bytes = digest of **everything before it** — verified: `head -c 60 … \| shasum -a1` = `cf4851b5…71a7`; the alternative "over the header+body only" hypothesis gives `670507ad…`, ≠ |
| total size | exactly `12 + 4·N + 2·digestLength` (matches `parsePackRevIndex`'s existing rule) |

**Body derivation, confirmed against `git verify-pack -v`.** The `.idx` order (oid-ascending) is
`035f9b74, 4d4bc1c7, 75db9909, 7ee14440, 9a554c2e, a0054e49, f1f36270` with offsets
`333, 276, 314, 94, 106, 257, 295`. Sorting index positions by ascending offset gives
`[3, 4, 5, 1, 6, 2, 0]` — **exactly the bytes on disk**. The body is a permutation of `[0, N)` and
is strictly offset-ascending by construction.

### Pin C — the file is a pure function of the pack

| # | probe | result |
|---|---|---|
| C1 | `git index-pack -o p.idx p.pack` on a copy of a git-written pack | regenerated `.rev` digest `ca698775…b17e` = the original's, byte for byte |
| C2 | same, `.idx` | also byte-identical (`a79206c2…5410`) |
| C3 | run it a second time | identical again |

**Byte identity is therefore a sound contract**, and it gives the interop test its method: copy a
tsgit-written `.pack` into a scratch dir, run `git index-pack -o <stem>.idx <stem>.pack`, compare
`<stem>.rev` to tsgit's byte for byte.

### Pin D — the `pack.writeReverseIndex` gate

| # | config | surface | outcome |
|---|---|---|---|
| D1 | unset | clone | `.rev` written (default true) |
| D2 | `pack.writeReverseIndex=false` | clone | **absent** — only `.pack` + `.idx` |
| D3 | `=false` | fetch (`fetch.unpackLimit=1`) | **absent** for the new pack |
| D4 | `=false` | `index-pack -o` | **absent** |
| D5 | `=false` | `pack-objects <prefix>` | **absent** |
| D6 | valueless key (`writeReverseIndex` with no `=`) | `index-pack -o` | `.rev` **written** ⇒ valueless boolean is **true** (matches tsgit's `parseGitBoolean(null) === true`) |
| D7 | `=maybe` | `index-pack -o` | **refused**: `fatal: bad boolean config value 'maybe' for …` (git names the key lower-cased), **exit 128**, no `.idx`, no `.rev` |
| D8 | another non-boolean string | `clone` | the same `bad boolean config value` fatal, then `fatal: fetch-pack: invalid index-pack output`; the target's pack dir is empty — the clone does not complete |
| D9 | `=false` **plus** `index-pack --rev-index` | `index-pack -o` | `.rev` written — the CLI flag overrides the config |

D7/D8 are the strict-refusal behaviour tsgit does **not** have for any boolean today. ADR-627
(DC-4) closes that repo-wide in this change; Pin K generalises D7's grammar and Pin L pins where
each key's refusal lands.
D9 concerns a CLI flag on a plumbing command tsgit does not expose (see DC-9).

### Pin E — degenerate object counts

| # | pack | `.rev` size | body |
|---|---|---|---|
| E1 | 0 objects (`: \| git pack-objects <prefix>`) | **52** = 12 + 0 + 40 | empty — **git still writes the file** |
| E2 | 1 object | 56 = 12 + 4 + 40 | `[0]` |
| E3 | 7 objects (F1) | 80 | Pin B |

E1 matters: `packObjects` with an empty closure writes a `.pack` + `.idx` today, so tsgit must write
the header-only `.rev` too. (`fetchPack` suppresses the whole artefact set at zero entries and keeps
doing so — no `.idx` means no `.rev`, consistent with A3.)

### Pin F — hash width

| repo `--object-format` | `hashId` | fixture | size |
|---|---|---|---|
| sha1 | `1` | 7 objects | 80 = 12 + 28 + 20 + 20 |
| sha256 | `2` | 3 objects | 88 = 12 + 12 + 32 + 32 |

`hashId` follows the **repository's** object format; both digests are that width. Nothing else in
the format branches on width. (Consistent with 28.3's Pin G.)

### Pin G — overwrite semantics and file mode

| # | probe | result |
|---|---|---|
| G1 | `.rev` exists holding 7 bytes of `GARBAGE`, mode `0444`, `.idx` deleted, re-run `index-pack -o` | exit 0, the file is **replaced** with the correct 80 bytes — git writes a temp file and renames over, so a read-only target is no obstacle |
| G2 | mode of git-written artefacts | `.pack`, `.idx`, `.rev` are all **`-r--r--r--` (0444)** |

G2 is a **pre-existing, unrelated divergence**: tsgit's `writeExclusive` creates 0644 artefacts for
`.pack`/`.idx` today. The `.rev` inherits whatever the pack/idx do — this design does not change
permission behaviour for any artefact, and does not open the question (see §D14 blind spot 3).

### Pin H — git tolerates the states we can produce

| # | state | git |
|---|---|---|
| H1 | `.pack` + `.idx`, **no** `.rev` | `fsck --strict` clean, `verify-pack` ok, `gc` auto-heals by writing one (spike) |
| H2 | corrupt `.rev` body | `verify-pack` still **ok** — it does not read the `.rev` |
| H3 | truncated `.rev` | `cat-file --batch-all-objects --batch-check` prints `error: reverse-index file … is too small` and **falls back**, exit 0 |

H1 is why a `pack.writeReverseIndex=false` repo stays healthy, and H2/H3 bound the blast radius of a
writer bug: git degrades, it does not corrupt. They do **not** license a sloppy writer — the byte
compare is the contract.

### Pin K — git's boolean grammar (ADR-627 scope)

Probed with `git config --file <tmpfile> --type=bool --get pack.writeReverseIndex` in a `mktemp -d`
throwaway (`HOME` isolated, `GIT_CONFIG_NOSYSTEM=1`, all `GIT_*` scrubbed). Every row was
re-confirmed at a real consumer (Pin L), so this is git's actual `git_config_bool`, not a porcelain
artefact.

**K1 — the word arm (case-insensitive).**

| raw | verdict | raw | verdict |
|---|---|---|---|
| `true`, `TRUE`, `TrUe` | true | `false`, `FALSE` | false |
| `yes`, `Yes`, `yEs` | true | `no`, `No` | false |
| `on`, `ON` | true | `off`, `OFF`, `oFf` | false |

**K2 — the presence arm.**

| raw | verdict |
|---|---|
| key with **no `=`** (git's internal NULL) | **true** |
| `key =` (empty value) | **false** |
| `key = ""` (explicitly empty) | **false** |
| `key = " "` (one space, quoted) | **refuse** — a space is not empty |

The config tokenizer strips unquoted surrounding whitespace *before* the boolean parse, so
`key =  1  ` is `1` ⇒ true, and `key = " 1"` is also true (`git_parse_int` skips leading blanks
itself).

**K3 — the integer arm. This is where ADR-627's sketch is wrong.** Any value that is not a K1 word
is handed to `git_parse_int`: optional `+`/`-`, radix auto-detected `strtoimax`-style (`0x`/`0X`
hex, leading `0` octal, else decimal), one optional `k`/`K`/`m`/`M`/`g`/`G` unit factor (×1024ⁿ).
**Non-zero ⇒ true, zero ⇒ false.** The result must fit a C `int`.

| raw | verdict | why |
|---|---|---|
| `1`, `2`, `-1`, `+1` | **true** | non-zero |
| `007` | **true** | octal 7 |
| `0x1`, `0x7fffffff` | **true** | hex, in range |
| `1k`, `1K`, `1m`, `1M`, `1g`, `1G` | **true** | unit factor, in range |
| `0`, `00`, `0x0`, `0k` | **false** | zero in every radix |
| `2147483647` (`INT_MAX`) | **true** | boundary, accepted |
| `-2147483648` (`INT_MIN`) | **true** | boundary, accepted, non-zero |
| `2147483648`, `-2147483649` | **refuse** | overflows `int` |
| `0x80000000`, `2g` | **refuse** | same overflow, hex / scaled |
| `maybe`, `truthy`, `1.0`, `" "` | **refuse** | not an integer at all |

**K4 — the range asymmetry, stated because it is a live trap.** The same value refuses as a boolean
but succeeds as an integer: `git config --type=bool` on `2147483648` is `fatal`, `--type=int` on the
same file returns `2147483648`. git's boolean path narrows to `int`; its integer path is
the full 64-bit signed range. tsgit's existing `parseGitInt` implements the **64-bit** grammar (its
own comment pins `GIT_INT_MAX = 9223372036854775807`), so the boolean parser may reuse it for
tokenisation but **must apply its own `int32` range check on top** (§D6a).

**K5 — the refusal itself.**

```
fatal: bad boolean config value '<raw value>' for '<key>'
exit 128
```

`<raw value>` is the post-tokenizer value, verbatim. `<key>` is the fully-qualified key with the
**section and variable segments lower-cased and the subsection preserved verbatim** —
`core.bare`, `core.sparsecheckout`, `submodule.sm.active`, `diff.d.cachetextconv`. Identical
convention to `CONFIG_MISSING_VALUE`'s key token, so `findFirstValuelessEntry`'s existing
qualified-key construction is reusable as-is.

One documented exception: a **tri-state** key whose extra literal is checked before the boolean
fallback reports its own message. `push.gpgSign = maybe` gives
`error: invalid value for 'push.gpgsign'` (still exit 128) rather than the K5 line.
`core.logAllRefUpdates = maybe`, the other tri-state, does **not** — it reports the standard K5
line. The two tri-states differ and both are pinned individually in Pin L.

### Pin L — where each boolean key refuses (three tiers)

git's refusal is **lazy**: a malformed value is inert until something reads that key. Each row was
probed in its own fresh `mktemp -d` repo (one commit, `f.txt` tracked), value `maybe`.

| tier | meaning |
|---|---|
| **T1 — discovery** | read during repository setup; refuses **every** command, the `config` porcelain included |
| **T2 — default-config pass** | read by `git_default_config` on the operational surface; refuses operational commands, **`config --list`/`--get` still succeed** |
| **T3 — consumer** | read only at the point of use; unrelated commands and the porcelain all succeed |

| # | key | tier | probes: refuses | probes: succeeds |
|---|---|---|---|---|
| L1 | `core.bare` | **T1** | `status`, `log`, **`config --list`**, **`config --get core.bare`** | — |
| L2 | `extensions.worktreeConfig` | **T1** | `status`, `worktree list`, **`config --list`** | — |
| L3 | `core.sparseCheckout` | T2 | `status`, `log` | `config --list`, `config --get` |
| L4 | `core.sparseCheckoutCone` | T2 | `status` | `config --list` |
| L5 | `core.logAllRefUpdates` | T2 | `status`, `log` | — (K5 message, not a tri-state special) |
| L6 | `diff.<d>.cachetextconv` | T2 | `status`, `log` | `config --list` |
| L7 | `commit.gpgSign` | T3 | `commit` | `status`, `log`, `config --list` |
| L8 | `tag.gpgSign` | T3 | `tag <name>` (**lightweight too**), `tag -a` | `status`, `log` |
| L9 | `push.gpgSign` | T3 | `push` — **`error: invalid value for 'push.gpgsign'`** | `status`, `log` |
| L10 | `filter.<d>.required` | T3 | `status`, `checkout -- f`, `add` — *only with a matching `filter=<d>` attribute in play* | (no attribute ⇒ inert) |
| L11 | `submodule.<n>.active` | T3 | `submodule status`, `submodule update --init` | `status`, `log` |
| L12 | `remote.<n>.promisor` | T3 | `status`, `fsck` | `log`, `rev-list --all`, `cat-file -p HEAD`, `config --list` |

**L-order — which key wins when several are malformed.** Within T2, and **cross-class against the
existing valueless-string refusal**, git reports the entry with the **lowest config-file line**:

| fixture (in file order) | git reports |
|---|---|
| `core.sparseCheckout = maybe` then valueless `core.excludesFile` | `bad boolean … 'core.sparsecheckout'` |
| valueless `core.excludesFile` then `core.sparseCheckout = maybe` | `missing value for 'core.excludesfile'` |

T1 preempts line order entirely: with `core.sparseCheckout = alpha` on the earlier line and
`core.bare = beta` on the later one, git still reports `core.bare` — and it reports `core.bare` even
when a valueless `core.excludesFile` precedes it. **Tier beats line; line breaks ties within a
tier.** That is exactly the rule `assertCoreConfigValid` already implements for its two classes, so
T2 booleans slot into its existing lowest-line comparison and T1 sits in front of it.

**L-values — the accepted values are not inert either.** `core.bare` with no `=` ⇒ true ⇒
`rev-parse --is-bare-repository` prints `true` and `status` fails with
`fatal: this operation must be run in a work tree`. `core.bare = 2` behaves identically. A strict
parser that refused `2` would break a repository git considers valid — which is why K3's integer
arm is a correctness requirement, not a detail.

## Requirements

1. Every `.idx` tsgit writes to disk is accompanied by a sibling `.rev` at the same path with the
   suffix replaced (`pack-<sha>.idx` → `pack-<sha>.rev`), in the repository pack dir **and** in
   `packObjects`' `outputDirectory` (Pin A4/A5).
2. The `.rev` bytes are **byte-identical** to what `git index-pack` produces for the same `.pack`
   (Pin B, Pin C) — magic, version, hashId, offset-ordered index positions, embedded pack checksum,
   and the file's own digest over everything preceding it.
3. A pack of **zero** objects still gets a 52-byte (SHA-1) header-only `.rev` when its `.idx` is
   written (Pin E1). A pack whose artefacts are suppressed entirely (`fetchPack`, zero entries) gets
   nothing, as today.
4. `pack.writeReverseIndex = false` in the repository config suppresses the `.rev` and only the
   `.rev` (Pin D2–D5). Absent key ⇒ written. Valueless key ⇒ written (Pin D6). A value git accepts
   as an integer-true (`2`, `0x1`, `1k`) ⇒ written; integer-false (`0`, `00`) ⇒ suppressed (Pin K3).
   A value git refuses ⇒ **tsgit refuses too** (requirement 14), so the pack write never happens —
   matching Pin D8, where git's clone fails outright and leaves an empty pack dir.
5. `serializePackRevIndex` is hash-width generic: `digestLength` comes from the pack checksum's
   length and every size/offset expression is written in terms of it. The only literal widths in the
   function are the accepted-width guard and the `hashId` mapping (Pin F) — the format's own
   enumeration, not arithmetic.
6. `parsePackRevIndex(serialize(x)) ≡ x` for every spec in the writer's declared domain, and the
   file tsgit writes is loadable by tsgit's own `loadPackRevIndex` as `kind: 'usable'`.
7. The read path is **unchanged**: `scanPacks`' `fileNames` set picks the new sibling up after the
   existing `refreshPackRegistry(ctx)`, and `resolveSortedOffsets` consumes it for packs at or above
   `REV_INDEX_MIN_OBJECTS`. Verified, not assumed.
8. `git verify-pack` and `git fsck --strict` accept a pack directory tsgit wrote, `.rev` included.
9. `push` and `bundle create` write no `.rev` — they write no `.idx` (Pin A7/A8).
10. No `.bitmap`, no multi-pack-index, no commit-graph is written.
11. The `.rev` write surface carries a `@writes` block with `kind: byte-identical` and is covered by
    a `cross-tool-interop` test naming its surface, so `audit-write-surfaces` stays green with an
    **empty allowlist**.
12. A failure to write the `.rev` is never swallowed: it propagates with context, exactly as a
    failed `.idx` write does today.
13. `test/parity/scenarios/pack-objects.scenario.ts`'s `packDirEntryCount` expectation moves from
    `2` to `3` — one shared expectation that every parity driver must now satisfy — and its
    "no `.rev`" comment is corrected.

### Strict boolean refusal (ADR-627)

14. A boolean config value git refuses (Pin K) makes tsgit refuse, with a typed
    `CONFIG_BAD_BOOLEAN_VALUE { key, source, value }` — structured fields only, no rendered
    message (ADR-249). `key` is git's lower-cased qualified token with the subsection verbatim
    (Pin K5); `value` is the raw post-tokenizer string; `source` is tsgit's absolute config path.
15. tsgit's accepted grammar **is** Pin K, integer arm included. `2`, `-1`, `007`, `0x1`, `+1`,
    `1k`, `-2147483648` and `2147483647` are true; `0`, `00`, `0x0`, `0k` and the empty value are
    false; a valueless key is true; the six words are case-insensitive. Only Pin K's refusal set
    refuses — including the `int`-overflow rows (`2147483648`, `0x80000000`, `2g`), which tsgit's
    existing `parseGitInt` would otherwise accept (Pin K4).
16. The refusal fires **exactly where git's fires**, per Pin L's three tiers, and nowhere else:
    - **T1** (`core.bare`, `extensions.worktreeConfig`) refuses every command including tsgit's
      `config` porcelain;
    - **T2** (`core.sparseCheckout`, `core.sparseCheckoutCone`, `core.logAllRefUpdates`, and
      `diff.<d>.cachetextconv` across **every** `[diff *]` subsection) refuses the operational
      surface while `config --get`/`--list` keep succeeding (ADR-314);
    - **T3** (`commit.gpgSign`, `tag.gpgSign`, `push.gpgSign`, `filter.<d>.required`,
      `submodule.<n>.active`, `remote.<n>.promisor`, `pack.writeReverseIndex`) refuses only at the
      consuming command.
    A malformed value in a key the running command never reads must **not** refuse.
17. When several entries are malformed, tsgit reports the same one git does: **tier first, then
    lowest config-file line** (Pin L-order), cross-class with the existing `CONFIG_MISSING_VALUE`
    and `CONFIG_BAD_NUMERIC_VALUE` refusals — one shared ordering rule, not three.
18. `push.gpgSign`'s refusal keeps its own distinct discriminant, because git's message differs
    (`error: invalid value for 'push.gpgsign'`, Pin K5/L9). `core.logAllRefUpdates`, the other
    tri-state, uses the standard boolean refusal.
19. Every previously-lenient read keeps its accepted-value behaviour byte for byte, with exactly
    **two** documented exceptions — both corrections required by requirement 15, and both witnessed
    by a test rather than assumed:
    - **the integer arm** (Pin K3): values tsgit read as `false` that git reads as true/false by
      magnitude. `core.bare = 2` (Pin L-values) is the witness, and it flips a repo from non-bare
      to bare without any error being raised (§D14 blind spot 10).
    - **`extensions.worktreeConfig`** (B12): its bespoke `value === 'true'` comparison rejects
      `TRUE`, `yes`, `on` and `1`, which git accepts. Adopting the shared parse turns the
      per-worktree config file **on** in repositories where tsgit silently ignored it.
    No other key changes verdict on any value git accepts.

## Design

### §D1 — shape of the change

Three layers, mirroring what already exists for the `.idx`:

```
domain      serializePackRevIndex(entries, packChecksum) -> Uint8Array   [whole file, trailer region reserved and zeroed]
application buildRev(ctx, entries, packSha)              -> Uint8Array   [same buffer, trailer filled from ctx.hash]
application writePackArtifacts(...)                      -> writes .pack, .idx, [.promisor], .rev
```

Nothing else moves. The read path, the registry, `fsck`, the closure engine and the bitmap code are
untouched.

### §D2 — the domain serializer

```ts
export function serializePackRevIndex(
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packChecksum: Uint8Array,
): Uint8Array
```

`PackIndexWriterEntry` is the existing `{ id, crc32, offset }` shape `serializePackIndex` consumes,
so both serializers take the same input and cannot disagree about the entry set.

Body, in order:

1. Refuse a `packChecksum` whose length is neither 20 nor 32 —
   `invalidPackRevIndex('hash-id', …)`, reusing the parser's closed `RevIndexCheck` union rather
   than widening it. This mirrors `serializePackIndex`'s `IDX_SHA_LENGTH` guard and is the only
   refusal the writer has.
2. `digestLength = packChecksum.length`; `hashId = digestLength === 32 ? 2 : 1`.
3. Obtain **index positions in pack-offset order** (§D3).
4. Allocate exactly `12 + 4·N + 2·digestLength`, write magic / `1` / `hashId` / the N u32BE body
   words / `packChecksum` at `12 + 4·N`. The final `digestLength` bytes are left zero — the caller
   fills them.
5. Return the whole buffer (trailer region included, zeroed) so the caller hashes
   `bytes.subarray(0, len − digestLength)` and writes into the tail in place — one allocation, no
   concat. (`buildIdx` concatenates today because `serializePackIndex` does not reserve the tail;
   the `.rev` writer does, and the difference is deliberate, not an inconsistency to "fix".) The
   in-place fill is not a violation of the immutability rule: the buffer is freshly allocated and
   exclusively owned by `buildRev`, which has not published it — the same discipline
   `serializePackIndex` already uses inside its own body.

The guard in step 1 is unreachable from every production call site (`packSha` is always a verified
pack trailer), which makes it a mutation-testing hazard: it needs its own unit cases per rejected
width, or the mutant that deletes it survives.

Everything is `DataView`/`Uint8Array` arithmetic over a length the function itself computed — no
input-declared length is ever trusted, because there is no input length.

### §D3 — where the ordering comes from

The body needs *"for each pack position `p` (rank by ascending offset), the index position (rank by
ascending oid)"*. `serializePackIndex` already computes the oid-sorted array
(`withBytes.sort(compareBytes)`); the `.rev` needs that same array re-ranked by offset.

The recommended shape (DC-2) extracts the shared step out of `serializePackIndex`:

```ts
export function sortPackIndexEntries(
  entries: ReadonlyArray<PackIndexWriterEntry>,
): ReadonlyArray<SortedEntry>   // { shaBytes, entry }, oid-ascending
```

Sub-choice inside DC-2(a): the helper (and the `SortedEntry` shape) can live in `pack-writer.ts`
and be imported directly by the `.rev` writer, or in a small `src/domain/storage/pack-order.ts` that
both import. The second keeps the dependency arrow out of a parser-bearing file and into a leaf;
either way the helper is **not** added to `src/domain/storage/index.ts` — only
`serializePackRevIndex` is (which is itself a public-surface change; see Gates).

`serializePackIndex` keeps using it verbatim; `serializePackRevIndex` calls it, then builds a
`Uint32Array` of `[0, N)` and sorts it by `sorted[a].entry.offset − sorted[b].entry.offset` — the
same shape `packPositionMap` (`internal/pack-positions.ts`) uses on the read side, which stays the
independent oracle the interop and `fsck` paths compare against. Two implementations of one
computation is deliberate here: `packPositionMap` consumes a **parsed** `PackIndex`, this one
consumes writer entries, and collapsing them would make the `fsck` cross-check tautological.

`Uint32Array.prototype.sort` with a comparator is used (not the comparator-free numeric sort of
`resolveSortedOffsets`) because the values being sorted are positions, not the offsets they are
keyed by. `N < 2³²` by format definition, so `Uint32Array` is exact.

**Offsets are unique by construction** — each pack entry begins where the previous one ends, and
both producers (`walkPackEntries`, `serializePackfile`) emit strictly increasing offsets. Tie
behaviour is therefore undefined *because ties cannot occur*, not because it was overlooked; no
tie-break rule is invented, and no test pretends to cover one.

### §D4 — the application assembler

```ts
export const buildRev = async (
  ctx: Context,
  entries: ReadonlyArray<PackIndexWriterEntry>,
  packSha: string,
): Promise<Uint8Array>
```

`hexToBytes(packSha)` → `serializePackRevIndex` → `ctx.hash.hash(bytes.subarray(0, len − d))` →
`bytes.set(digest, len − d)`. Exactly `buildIdx`'s role and exactly its file
(`internal/write-pack-artifacts.ts`), so the module keeps its single responsibility: "assemble the
byte images of a pack's sibling files".

`ctx.hash` (not `ctx.hashConfig`) supplies the digest; `digestLength` is derived from the checksum
bytes, so a mismatch between `packSha`'s width and the hash service is structurally impossible —
`packSha` **is** the pack trailer.

### §D5 — the gate and the write

`writePackArtifacts` becomes the single place that knows a pack has three files. Recommended shape
(DC-3), which also retires the existing `promisor: boolean` positional smell:

```ts
export interface WritePackArtifactsInput {
  readonly packDir: string;
  readonly packBytes: Uint8Array;
  readonly entries: ReadonlyArray<PackIndexWriterEntry>;
  readonly packSha: string;
  readonly promisor: boolean;      // stays a field of an options object, not a positional flag
}

export interface WrittenPackArtifacts {
  readonly packPath: string;
  readonly idxPath: string;
  readonly objectCount: number;
  readonly indexBytes: number;            // pack-objects needs it; no longer recomputed by callers
  readonly packSha: string;
}
```

No `revPath` is returned: no production caller needs it, and a field only tests read is dead code by
the repo's own guardrail. Tests compose `${packDir}/pack-${packSha}.rev` or read the directory.

Order of operations:

0. **Gate first** — resolve `writeReverseIndex(ctx)` (below) *before* any file is created, so a
   refused `pack.writeReverseIndex` leaves the pack dir untouched exactly as git's does (Pin D8).
   The resulting boolean is carried to step 5.
1. `mkdir(packDir)`.
2. `buildIdx` → `writeExclusive(.pack)` → `writeExclusive(.idx)` (unchanged).
3. `.promisor` sentinel — **kept immediately after the `.idx`**, exactly where it is today, so the
   window in which a promisor pack is visible without its sentinel does not widen.
4. If the step-0 gate said false, return.
5. `buildRev` → `writeExclusive(.rev)`.

**`.rev` last** is load-bearing: pack discovery keys on the `.pack`/`.idx` pair
(`pack-registry.ts` `scanPacks`, which registers a pack only when its `.pack` exists by name), so a
concurrent reader that observes the pair before the `.rev` lands simply takes the absent-artefact
arm and sorts — the correct answer, and the state git itself leaves behind under
`pack.writeReverseIndex=false` (Pin H1). The reverse order would create a window in which a `.rev`
exists for a pack with no `.idx`, which nothing reads but which an `fsck` orphan check could one day
notice.

**All adapters, not just node.** `writeExclusive` is a `FileSystem` port method implemented by the
node, memory and browser (OPFS) adapters, and `ctx.hash` is a port too — so the `.rev` lands
wherever the `.pack`/`.idx` land, with no adapter-specific branch and no new port method. The parity
suite (which runs every scenario across all drivers) is what proves it.

The gate helper lives beside the writer. **It must guard before it reads** — §D6a leaves a refused
boolean *absent* in `ParsedConfig`, so the obvious one-liner
(`(await readConfig(ctx)).pack?.writeReverseIndex ?? true`) would map `= maybe` onto the default and
silently **write** the `.rev` where git refuses to run at all. The T3 guard is what makes the `??`
safe:

```ts
const writeReverseIndex = async (ctx: Context): Promise<boolean> => {
  await assertValidBooleanConfig(ctx, 'pack', undefined, [WRITE_REVERSE_INDEX_KEY]);
  return (await readConfig(ctx)).pack?.writeReverseIndex ?? true;
};
```

This is the general shape of every T3 guard in §D6a, and the reason the rule is "guard immediately
before the consuming read" rather than "guard on the refusal path": for a boolean, absent and
refused are indistinguishable downstream, so the guard has to run on the *success* path too. Any
T3 site that reads the field without the preceding assert re-opens exactly this bug — which is why
the guard sits inside the same helper as the read, not at the call sites.

Reading the config **inside** `writePackArtifacts` (rather than at each call site) means a future
third caller cannot forget it, and adds no parameter. `readConfig` is memoised per `Context`, so on
the fetch path the read is almost always already paid, and the guard walks the same cached tokens.

Ordering note: the guard runs at step 4, **after** the `.pack`/`.idx`/`.promisor` are on disk. Git
refuses earlier — its config read precedes `index-pack`'s output entirely (Pin D8 leaves an empty
pack dir). Matching that exactly means hoisting the guard to the top of `writePackArtifacts`, before
step 1, which costs nothing and makes requirement 4's "the pack write never happens" literally true
rather than approximately true. **Hoist it.**

### §D6 — the config surface

`config-read.ts` gains, following the `[commit]`/`[tag]` precedent exactly:

- `ParsedConfig.pack?: { readonly writeReverseIndex?: boolean }` with a doc comment naming git's
  default;
- a `mergePack(acc, sec)` merger using the shared boolean parse of §D6a (so `null` ⇒ `true`,
  matching Pin D6, and `2` ⇒ `true`, matching Pin K3);
- one `else if (sec.section === 'pack')` arm in `dispatchSection` (L1057);
- the matching `MutableParsedConfig` field.

Key comparison is on the lower-cased key, as every sibling merger does — git lower-cases config keys
(Pin K5's error message names the key in lower case).

`pack.writeReverseIndex` is a **T3** key (Pin L): a malformed value must not disturb `status`, `log`
or the `config` porcelain, only the pack write. Its guard therefore sits in `writePackArtifacts`'
gate helper, which is the only consuming read — see §D6a's T3 table and §D5 step 4.

**Known, pre-existing divergence, stated not fixed:** `readConfig` reads only
`${commonGitDir}/config`. A `pack.writeReverseIndex=false` in `~/.gitconfig` or `/etc/gitconfig` is
invisible to tsgit, where git honours it. This is systemic (it applies equally to `core.*`,
`commit.gpgSign`, …), it is not made worse here, and the interop test therefore sets the key in the
**local** repo config. A corollary: during `clone`, `writeCloneConfig` runs *after* `fetchPack`
(`clone.ts` — `fetchPack` ~L133, `writeCloneConfig` ~L162), so a clone always sees the default and
always writes the `.rev`. That is faithful: git's clone also cannot read a config the new repository
does not have yet, and reaches the same default.

### §D6a — strict boolean refusal, repo-wide (ADR-627)

#### The enumeration — every boolean consumer in `src/`

Found by following `parseGitBoolean` (eleven call sites, all in `config-read.ts`) plus a sweep for
equivalent hand-rolled coercions elsewhere, which turned up exactly one more (B12). Twelve keys in
total; nothing else in `src/` turns a config string into a boolean.

| # | key | read at | tier | tsgit today | git today |
|---|---|---|---|---|---|
| B1 | `core.bare` | `config-read.ts` L1134 → `isBare` / `assertNotBare` (`internal/repo-state.ts` L105) | **T1** | `maybe` ⇒ `false`; `2` ⇒ `false` | refuses everywhere incl. porcelain; `2` ⇒ **bare** |
| B2 | `core.sparseCheckout` | L1137 → `read-sparse-checkout.ts` L61, `commands/sparse-checkout.ts` L86 | T2 | `maybe` ⇒ `false` (sparse silently off) | refuses operationally, porcelain lives |
| B3 | `core.sparseCheckoutCone` | L1139 → `read-sparse-checkout.ts` L63, `sparse-checkout.ts` L89/L128/L145/L162 | T2 | `maybe` ⇒ `false` (cone silently off) | refuses operationally |
| B4 | `core.logAllRefUpdates` | L1166 `parseLogAllRefUpdates` → `domain/reflog/should-log.ts` L23–25 | T2 | `maybe` ⇒ `false` ⇒ **reflogs silently stop** | refuses operationally (standard K5 message) |
| B5 | `remote.<n>.promisor` | L1210 → partial-clone / promisor-remote resolution | T3 | `maybe` ⇒ `false` (remote silently non-promisor) | refuses `status`/`fsck`, not `log` |
| B6 | `submodule.<n>.active` | L1282 → submodule status/update | T3 | `maybe` ⇒ `false` | refuses `submodule status`/`update` |
| B7 | `diff.<d>.cachetextconv` | L1326 → **parsed, never read** in `src/` | T2 | inert | refuses `status`/`log` |
| B8 | `filter.<d>.required` | L1337 → `resolve-filter-driver.ts` L34, `apply-changeset.ts` L188, `commands/add.ts` L398 | T3 | `maybe` ⇒ `false` ⇒ **a required filter silently becomes optional** | refuses once the `filter=<d>` attribute matches |
| B9 | `commit.gpgSign` | L1376 → commit creation | T3 | `maybe` ⇒ `false` | refuses `commit` |
| B10 | `tag.gpgSign` | L1384 → tag creation | T3 | `maybe` ⇒ `false` | refuses `tag`, lightweight included |
| B11 | `push.gpgSign` | L1389 `parsePushGpgSign` → `commands/push.ts` L365 `resolveSignedPushMode` | T3 | `maybe` ⇒ `'false'` | refuses `push`, **distinct message** |
| B12 | `extensions.worktreeConfig` | `internal/config-scope.ts` L60 — **not** `parseGitBoolean`: a bare `entry.value === 'true'` | **T1** | **doubly wrong**: `TRUE`/`yes`/`on`/`1` ⇒ `false` (git: true); `maybe` ⇒ `false` (git: refuses) | refuses everywhere incl. porcelain |

B4, B8 and B12 are why this expansion is worth its cost: today a typo in `core.logAllRefUpdates`
silently disables reflog writing, a typo in `filter.<d>.required` silently downgrades a required
clean filter to best-effort, and `extensions.worktreeConfig = TRUE` silently ignores the whole
per-worktree config file. All three are data-losing failures that git refuses outright.

**One enumerated site stays lenient, deliberately.** `commands/internal/sequencer-state.ts` L108
(`hasTrueKey`) coerces `.git/sequencer/opts` entries. That file is not user-authored config — git
and tsgit both write it, always as `true` — so it is repository *state*, not configuration, and its
guard is a corruption question, not a faithfulness one. Recorded here so the enumeration is
complete; out of scope, and listed as such.

#### The parse

`parseGitBoolean` (`config-read.ts` L1622) becomes total-and-typed, mirroring `parseGitInt`'s
existing result-union shape rather than inventing a second idiom:

```ts
type GitBooleanResult =
  | { readonly ok: true; readonly value: boolean }
  | { readonly ok: false };
```

No `reason` field: git's boolean refusal has exactly one shape (Pin K5), unlike
`CONFIG_BAD_NUMERIC_VALUE`'s `'invalid unit' | 'out of range'` pair. The order of arms is Pin K's:

1. `value === null` ⇒ `{ ok: true, value: true }` (K2, valueless).
2. `value === ''` ⇒ `{ ok: true, value: false }` (K2, empty).
3. lower-cased match against the frozen word sets (K1).
4. otherwise delegate to `parseGitInt`; on `ok`, apply the **`int32` range check** and return
   `value !== 0`; on failure, or out of `[-2147483648, 2147483647]`, `{ ok: false }`.

Step 4's range check is the load-bearing new code, and it is the one thing `parseGitInt` cannot be
trusted for: it validates against `int64` (Pin K4), so `2147483648` returns `ok` there and must be
rejected here. Two named constants (`GIT_BOOL_INT_MIN` / `GIT_BOOL_INT_MAX`) sit beside the existing
`GIT_INT_MIN`/`GIT_INT_MAX` with a comment pinning why they differ. Reusing `parseGitInt` for
tokenisation is what keeps the radix/unit/sign grammar from being written twice — the two functions
must never disagree about *what an integer is*, only about the range that fits.

`parseGitBoolean` keeps its module-private scope; the section mergers call it and, on
`{ ok: false }`, leave the field **absent** rather than guessing. The refusal is raised by the
guards, not the merger — because the merger runs for every key on every `readConfig`, and raising
there would make every key T1 (requirement 16 forbids it, and `git config --list` surviving a bad
`core.sparseCheckout` is the proof, Pin L3).

**B12 needs the parse, not just a guard.** `isWorktreeScopeActive` (`internal/config-scope.ts` L60)
does its own raw tokenize and compares `entry.value === 'true'`, so it bypasses `parseGitBoolean`
entirely. It adopts the shared parse, which fixes the accepted-value half of its double bug
(`TRUE`/`yes`/`on`/`1`/`2` must all activate the per-worktree config file) independently of the T1
guard that fixes the refusal half. It is the only row where the *accepted* values are wrong today,
and the only row whose fix is therefore not purely additive.

#### The error

`src/domain/commands/error.ts` gains one variant and one factory, modelled on
`configBadNumericValue` (which already sanitises the raw value for display and carries
`{ key, source, value }`):

```ts
| { readonly code: 'CONFIG_BAD_BOOLEAN_VALUE'; readonly key: string; readonly source: string; readonly value: string }
| { readonly code: 'CONFIG_BAD_BOOLEAN_LITERAL'; readonly key: string; readonly source: string; readonly value: string }
```

The second discriminant carries requirement 18: `push.gpgSign` is the only key whose message git
shapes differently (`error: invalid value for '<key>'`), and a *separate code* is how ADR-249 wants
that expressed — the consumer reconstructs whichever line it needs from the fields, and the library
never renders either. `src/domain/error.ts` gains the two matching message arms beside
`CONFIG_BAD_NUMERIC_VALUE` (L433).

Both factories run the value through the same `sanitizeForDisplay` the numeric factory uses, so a
config value carrying control characters cannot inject into a consumer's log line — the guarantee
§D13 T-7 claims for the `.rev` extends here, where a **text** field genuinely exists.

#### Finding the offender

A new `findFirstInvalidBoolean(ctx, section, subsection, keys)` joins the finder family in
`config-read.ts`, structurally identical to `findFirstInvalidCompression` (L299) — walk the cached
token stream from `readConfigEntry`, match section/subsection/key, run the parse, return
`{ key, source, line, value }` for the first failing entry. A `…InSection` wildcard sibling
(mirroring `findFirstValuelessInSection`, L238) covers the subsectioned families B5/B6/B8.

It consumes the **cached** token stream, so the eager gates pay an in-memory scan, not a re-read —
the property that made the valueless gates affordable on ~50 call sites applies unchanged.

The guard wrapping it is `assertValidBooleanConfig(ctx, section, subsection, keys)`, the exact
sibling of `assertNoValuelessConfig` (`internal/valueless-config-guard.ts`) — throw
`CONFIG_BAD_BOOLEAN_VALUE` for the first invalid entry, return silently for valid, absent and
out-of-section entries. `push.gpgSign` takes a thin variant that throws
`CONFIG_BAD_BOOLEAN_LITERAL` instead, since only its message shape differs (requirement 18); it
shares the finder, so the two can never disagree about *what is invalid*, only about which code
reports it.

#### Placement — one tier per gate

| tier | gate | keys | why there |
|---|---|---|---|
| T1 | `assertRepository` (`internal/repo-state.ts`) | B1 `core.bare`, B12 `extensions.worktreeConfig` | `assertRepository` is the one gate **both** the operational surface and the `config` porcelain pass through — precisely git's discovery pass (Pin L1/L2) |
| T2 | the eager gate called by `assertOperationalRepository` | B2, B3, B4 (`[core]`) **and B7** (`[diff *]`) | already the eager gate the porcelain deliberately skips (ADR-346); the boolean class joins its existing lowest-line comparison as a third class |
| T3 | per-consumer, on the consuming read | B5, B6, B8, B9, B10, B11, `pack.writeReverseIndex` | the guard sits beside the read that made git die — `resolveSignedPushMode`, `resolveFilterDriver`, the commit/tag creation paths, submodule status/update, promisor resolution, `writePackArtifacts`' gate |

This mapping is not a new mechanism: it is the ADR-346 split, already implemented and already
load-bearing for the string class, extended by one class. `assertRepository` gaining a gate is the
only structural addition, and it is forced — B1/B12 refuse the porcelain and nothing downstream of
`assertOperationalRepository` can express that.

**B7 forces the T2 gate to outgrow its name.** `assertCoreConfigValid` is `[core]`-only by
construction (`matchesSection(…, 'core', undefined)`), but `diff.<d>.cachetextconv` is subsectioned
and git refuses on it across every `[diff *]` block regardless of whether any attribute selects that
driver (Pin L6, probed with no matching `.gitattributes`). The gate therefore takes a second scan
via the `…InSection` wildcard finder and is renamed to what it now does — `assertEagerConfigValid`
or similar. `assertOperationalRepository` keeps its name and its ~50 call sites; only the inner
helper is renamed, so the churn is one symbol. Leaving B7 out instead would be a deliberate
under-refusal against ADR-226 for the sake of a function name, which is the wrong trade.

**T3 guards go on the consuming path, not the refusal path.** The valueless guards could sit on a
command's fallback arm because a valueless key is always a defect; a boolean key with a *valid*
value must still resolve normally, so the guard runs immediately before the read and no-ops for
every accepted value. `findFirstInvalidBoolean` returning `undefined` for valid and absent entries
alike is what makes that safe.

#### Ordering across three classes

`assertCoreConfigValid` today compares two finders' `line` fields and throws the lower. It becomes
three, and the comparison generalises to "smallest `line` wins" over the non-`undefined` results —
one `Promise.all`, one reduce, three throw shapes. Requirement 17's cross-class rows (Pin L-order)
are the tests that hold it honest.

The existing equivalent-mutant comment on the two-class comparison ("`str.line === comp.line` can
never occur") **must be re-proven, not carried forward**: with three classes the argument is still
that distinct keys occupy distinct lines, but the comment names specific finders and a specific
operator. Re-derive it against the new structure or delete it.

#### Migration and blast radius

Each of B1–B11 moves from "a `ParsedConfig` field that silently absorbed a bad value" to "a field
that only ever holds a value git accepts, with the bad case refused at its tier gate". B12 is not a
`ParsedConfig` field at all — it is read straight from tokens — so it migrates by adopting the
shared parse plus the T1 guard, as above.

`ParsedConfig`'s **public shape does not change** — every field stays `boolean | undefined`, so
`reports/api.json` is untouched by the boolean work (the `pack` field is a separate, additive
change), and no consumer of `ParsedConfig` needs editing beyond the guards. The two new error codes
are the only public-surface delta the expansion contributes.

What does change for callers: commands that previously succeeded against a malformed config now
throw. That is ADR-627's stated point ("a behaviour change that is the point, not a regression"),
and it is bounded by Pin L — a key a command never reads still cannot make it fail.

### §D7 — call sites

| site | change |
|---|---|
| `fetch-pack.ts` `materializePack` | passes `entries` instead of pre-built `idxBytes`; the `buildIdx` call moves inside `writePackArtifacts`. It currently returns `{ ...written, shallow, unshallow }` — that spread must become an **explicit construction** of the four `FetchPackResult` fields, or `indexBytes` silently rides along at runtime on a type that does not declare it (TypeScript's excess-property check does not fire on spreads) |
| `pack-objects.ts` | same; `indexBytes` now comes from `written.indexBytes` rather than a local `idxBytes.length`. `PackObjectsResult` is unchanged — no `revPath` is exposed (ADR-249: ship data the caller asked for, and no caller asked for a path) |
| `push`, `bundle create` | untouched — no `.idx`, no `.rev` (Pin A7/A8) |

`packObjects`' `outputDirectory` mode writes the `.rev` there too, because git does (Pin A5) and
because the artefact is a property of the `.idx`, not of the directory it lands in.

### §D8 — read-side pickup (verification, no change)

`refreshPackRegistry(ctx)` already drops the generation after a write, so the next `scanPacks`
`readdir` builds a `fileNames` set containing `pack-<sha>.rev`, and `loadPackRevIndex` is handed
`present: true`. `resolveSortedOffsets` then reads it **only** when the pack carries at least
`REV_INDEX_MIN_OBJECTS = 5_000` objects (ADR-604) — below that the accelerator is deliberately
skipped and the file is never opened. Two consequences to state plainly:

- For ordinary test-sized packs the newly written `.rev` is **never read by tsgit**. A test that
  "proves the accelerator now fires" on a 7-object pack would prove nothing.
- Verification is therefore split (DC-8): a cheap, direct assertion that
  `loadPackRevIndex(ctx, <written path>, true, digestLength, objectCount)` returns
  `kind: 'usable'` and that `revIndexPositions` reproduces `packPositionMap(parsedIdx)`, plus a
  single scaled case at or above the threshold.

### §D9 — error semantics

| failure | behaviour |
|---|---|
| `packChecksum` width neither 20 nor 32 | `invalidPackRevIndex('hash-id', …)` from the domain writer — a defect signal, unreachable from production call sites |
| `.rev` `writeExclusive` fails (already exists, out of space, permission denied, containment refusal) | **propagates**, exactly as a failed `.idx` write does; the fetch/pack-objects call fails. This matches git, which `die`s when it cannot write the rev file (Pin D8 shows the whole clone failing on the config error). See DC-7 |
| config file unreadable | `readConfig` already propagates non-`FILE_NOT_FOUND` faults; absent file ⇒ `{}` ⇒ default true |
| `pack.writeReverseIndex` holds a value git refuses | `CONFIG_BAD_BOOLEAN_VALUE { key, source, value }` — `key` being `pack.writeReverseIndex` lower-cased per Pin K5 — from the T3 gate in `writePackArtifacts`, **before** any artefact is written, so the whole fetch/`packObjects` fails and the pack dir stays empty, matching Pin D8 |
| any other boolean key holds a value git refuses | `CONFIG_BAD_BOOLEAN_VALUE` (or `CONFIG_BAD_BOOLEAN_LITERAL` for `push.gpgSign`) from that key's tier gate (§D6a), at the tier Pin L pins |

No new `catch` is introduced anywhere. Requirement 12 forbids a "best effort, warn and continue"
arm, and §D14 blind spot 1 records what that costs. The boolean refusals are never swallowed
either: a guard throws or returns, it never downgrades to a default.

### §D10 — the `@writes` annotation and the audit

The file that emits the `.rev` bytes carries (ADR-140 grammar):

```
 * @writes
 *   surface: packRevIndex
 *   kind:    byte-identical
 *   format:  pack-rev-index-v1
```

`kind: byte-identical` — justified by Pin C, and it is the first use of that value for a pack
artefact (`pack-writer.ts`'s `packfile` surface is `equivalent-under-readback` because deflate and
delta selection are implementation-defined; none of that applies here).

`tooling/audit-write-surfaces.ts` then requires a `cross-tool-interop` test whose `@proves` header
carries `interopSurface: packRevIndex`. §Test provides it, so
`tooling/audit-write-surfaces.allowlist.json` stays `{"surfaces": []}` — no allowlist entry is added
(requirement 11).

ADR-140 permits at most one `@writes` block per file, which is why the serializer cannot simply be
appended to `pack-writer.ts` (already annotated `packfile`, and a different `kind`). DC-1 chooses
between the two remaining homes.

### §D11 — hash-width genericity (explicit checklist)

| # | site | rule |
|---|---|---|
| H-1 | `serializePackRevIndex` | `digestLength` derived from `packChecksum.length`; no literal `20`/`32` in size or offset arithmetic |
| H-2 | `hashId` | `digestLength === 32 ? 2 : 1` — the only width→field mapping, pinned by Pin F, and the mirror of the parser's "record, never gate" rule |
| H-3 | size formula | `12 + 4·N + 2·digestLength` — **two** digests, symmetric with the parser's own rule |
| H-4 | trailer digest | `ctx.hash.hash(bytes.subarray(0, len − digestLength))` in `buildRev` — the repository's algorithm, exactly as `verifyMidxTrailer` and 28.3's H-5 |
| H-5 | `REV_HEADER_SIZE = 12` | reused from `rev-index.ts`, hash-independent |
| H-6 | surrounding subsystem | `IDX_SHA_LENGTH = 20` in `pack-writer.ts` stays a pre-existing SHA-1-only limit of the **`.idx`** writer. This design neither widens nor depends on it; the `.rev` writer's SHA-256 arm is proven by unit + property tests, not by an unreachable production path |
| H-7 | filenames | `pack-${packSha}.rev` composes from the hex the `.idx` already used — no width assumption |

### §D12 — write-path symmetry (explicit checklist)

| # | surface | verdict after this change |
|---|---|---|
| W-1 | `fetchPack` (clone / fetch / lazy fetch) | writes `.pack` + `.idx` + `.rev` — **28.3 §D17 W-1 is hereby revised for `.rev`**; the asymmetry closes |
| W-2 | `packObjects`, repo pack dir | same; `refreshPackRegistry` makes all three visible together |
| W-3 | `packObjects`, `outputDirectory` | same three files outside the repo (Pin A5). No registry refresh — correct, nothing was added to the repo |
| W-4 | `push` / `bundle create` | unchanged, and pinned as faithful (Pin A7/A8) |
| W-5 | overwriting a pack in place | structurally impossible — pack names are content-addressed, so a rewritten pack has a new name and its own artefacts. `writeExclusive` on all three keeps it that way |
| W-6 | a stale `.rev` from an older tsgit / from git | cannot arise for a *new* pack (content-addressed name). For an existing pack tsgit never rewrites artefacts, so nothing goes stale |
| W-7 | any future `gc`/`repack`/`prune` | must delete a pack's `.rev` with it. Orphans are harmless in both tools (Pin H1), so this stays hygiene — **but it is now tsgit's own hygiene**, where before it was only inherited. Recorded for the parked entry |
| W-8 | midx interaction | a new pack the midx does not name is outside the midx's universe (ADR-592). A new `.rev` is per-pack and changes nothing about the midx or its own reverse-index chunk |
| W-9 | `.bitmap`, midx, commit-graph | still never written (requirement 10, ADR-614's surviving half) |

### §D13 — threat model

The `.rev` is a **locally derived** artefact: no transport delivers one (a fetched pack arrives as
`.pack` bytes only), and its content is a pure function of a pack tsgit itself just verified.

| # | concern | assessment |
|---|---|---|
| T-1 | **Attacker-controlled input reaching the serializer** | The entries come from `walkPackEntries` (fetch) or `buildPack` (pack-objects), both already validated: the pack trailer is verified, the entry count is capped (`DEFAULT_MAX_OBJECT_COUNT`), and the body is bounded (`maxResponseBytes`). The serializer adds no new ingest point |
| T-2 | **Unbounded allocation** | The single allocation is `12 + 4·N + 2·d` with `N = entries.length` — a count that already survived the pack-header cap, and one whose memory cost is ~4 bytes/object against the `.idx`'s 28. No declared length from any file is consulted |
| T-3 | **A hostile server steering our `.rev` body** | It can only steer object offsets/oids, i.e. the same permutation the `.idx` already encodes. A malicious permutation written faithfully is still a faithful mirror of the pack we accepted; ADR-606 already accepts that the read path trusts this body, and the attacker who controls it controls the pack itself |
| T-4 | **Path traversal via the artefact name** | `pack-${packSha}.rev` — `packSha` is a verified hex trailer, and the directory is the caller's already-vetted `packDir`/`outputDirectory` (the same string the `.pack`/`.idx` used). No new path component is introduced |
| T-5 | **Symlink / containment escape on write** | `writeExclusive`'s port contract mandates the symlink-safe ancestor check and O_EXCL. Using it (not `write`) for the `.rev` inherits that guarantee unchanged — a reason beyond consistency to prefer it in DC-5 |
| T-6 | **TOCTOU between `.idx` and `.rev`** | A concurrent writer racing us loses the `.pack`/`.idx` exclusive create first, so it never reaches the `.rev`. Two tsgit processes writing the same pack cannot both proceed |
| T-7 | **Information disclosure** | The file contains integers and a checksum already present in the `.idx`/`.pack`. Nothing new is exposed; there is no text field, so no log-injection vector (28.3 T-10 remains satisfied) |
| T-8 | **Denial of service by write amplification** | One extra file per pack write, `4·N + 52` bytes — 0.4 MB for a 100k-object pack against a `.pack` of tens of MB. The extra CPU is one `Uint32Array` sort plus one digest over that buffer, both dominated by the pack's own inflate + hash |
| T-9 | **A wrong `.rev` silently degrading reads** | The write path is byte-pinned against git (requirement 2) and the read path range-validates every stored position before use (`gatherByRevIndex` returns `undefined` and falls back to the sort). A writer bug degrades to the sort; it cannot mis-read objects. Detection is not hypothetical: `fsck`'s `.rev` pass verifies our trailer and cross-checks the full permutation, so a wrong file we wrote makes tsgit's own `fsck` red (X4) |
| T-10 | **Log injection through a refused config value** (ADR-627) | `CONFIG_BAD_BOOLEAN_VALUE` carries a raw, attacker-influenceable string (`value`) — the first genuine text field in this change. Both factories route it through the same `sanitizeForDisplay` the numeric factory already uses, so control characters cannot break a consumer's log line. The `key` token is built from the tokenizer's parsed section/key, not from raw bytes |
| T-11 | **Denial of service through a hostile config value** (ADR-627) | The integer arm delegates to `parseGitInt`, whose `MAX_SIGNIFICANT_DIGITS = 32` cap already bounds the `BigInt` work — a megabyte-long digit run is rejected without being converted. The added `int32` range check is two comparisons on an already-bounded value. The eager gates scan the **cached** token stream, so a large config file is parsed once per `Context`, not once per gate |

### §D14 — blind spots, named

1. **A `.rev` write failure now fails an otherwise successful fetch.** Objects are already durably
   on disk when step 4 runs, so a full-disk condition turns "clone succeeded, accelerator missing"
   into "clone failed". This is git's own posture (Pin D8) and requirement 12 forbids swallowing it,
   but it is a genuine new failure mode on the everyday path, and DC-7 is where it gets decided.
2. ~~**Strict-boolean refusal is not implemented anywhere in tsgit.**~~ **Closed by ADR-627** —
   the gap is systemic, and this change closes it repo-wide rather than recording it (§D6a). The
   blind spots the closure *creates* are 8–12 below.
3. **File mode is not addressed.** git writes all three artefacts `0444` (Pin G2); tsgit writes
   `0644`. Pre-existing for `.pack`/`.idx`, now inherited by a third file. Not in scope, but the
   count of divergent files goes from two to three.
4. **git overwrites an existing `.rev`; `writeExclusive` will not (Pin G1).** Unreachable today —
   the `.pack` exclusive create fails first in every state that has a leftover `.rev` — so the
   divergence is latent, not live. It becomes live the moment any surface writes an `.idx` for a
   pack whose `.pack` is already present (a future `repack`, or an `index-pack`-style command).
5. **`index-pack --rev-index` / `--no-rev-index` has no tsgit equivalent** (Pin D9). Irrelevant
   while tsgit exposes no plumbing `index-pack`; DC-9 records the choice not to invent one.
6. **The parity scenario's `packDirEntryCount` is the only structural pack-dir assertion in the
   suite.** After it moves 2 → 3, nothing else counts pack-dir entries — a future artefact could
   land unnoticed by everything except the interop byte compare.
7. **Below `REV_INDEX_MIN_OBJECTS` tsgit writes a file it will never read** (§D8). That is
   deliberate — the artefact exists for *git* and for tsgit's large-pack path — but it means the
   common case pays a small write for no local benefit.

### Blind spots the ADR-627 expansion introduces

8. **`assertRepository` gains a gate, and it is on every path.** It is the cheapest correct home
   for the T1 keys (§D6a) and the scan is over cached tokens, but it is also the single hottest
   pre-flight in the codebase. If the token cache is cold — the first operation on a `Context` — the
   T1 gate now forces the config read that `assertRepository` previously did not need. For a
   command that reads no config at all this is a new I/O on the critical path.
9. **Repositories that worked yesterday stop working today.** Requirement 19 bounds the change to
   Pin K's refusal set, but the blast radius is every tsgit consumer with a typo in a boolean key.
   There is no opt-out and no deprecation window — ADR-627 chose that deliberately, and this is the
   honest statement of its cost.
10. **`core.bare = 2` is a behaviour change beyond refusal.** Under Pin K3 it becomes *true*, so a
    repo tsgit previously treated as non-bare is now bare (Pin L-values). Nothing refuses; the
    verdict flips. It is the only accepted-value flip in the whole change, and the only one where
    "strict parsing" silently alters an outcome rather than producing an error.
11. **B7 `diff.<d>.cachetextconv` has no tsgit consumer, so its T2 refusal has no natural home.**
    git refuses `status`/`log` on it; tsgit parses the key and never reads it. §D6a resolves this
    by putting it in the eager gate anyway (and renaming that gate), but the result is a guard whose
    only job is faithfulness — the one place in §D6a where the "guard sits beside the consuming
    read" rule has no read to sit beside. If the key ever gains a real consumer, check that the
    eager gate is still the tier git uses rather than assuming this row still holds.
12. **Pin L is a snapshot of git's *current* consumption points, not a contract.** Where a key
    refuses is an artefact of which git code path happens to read it; upstream could move
    `remote.<n>.promisor` out of `status` without anyone calling it a breaking change. The tier
    assignments are therefore the most fragile pins in this document, and the interop rows are what
    will notice when one moves.
13. **The T1 gate's tokenize widens the blast radius beyond the boolean class.** The discovery
    finders read the config through the shared tokenizer, so a repository whose `.git/config`
    carries a line the tokenizer refuses (`bad!key`, an unclosed quote) now surfaces
    `CONFIG_PARSE_ERROR` from every command — including the config porcelain editing a *sibling*
    section, which previously tolerated it. That is the faithful behaviour (in-repo git exits 128
    `bad config line N` on the same state; its `--file` mode, which skips discovery, is the only
    tolerant surface and tsgit has no equivalent), but it is a behaviour change this design causes
    without naming a boolean anywhere, pinned by the malformed-sibling refusal rows in
    `config-interop.test.ts`.

## Decision candidates — all settled

Every candidate went to the ADR conversation and carries a decision. Nothing below is open.

| # | Choice | ADR | Status | Outcome |
|---|---|---|---|---|
| DC-1 | Home of the domain serializer | **624** | adopted-as-recommended | (a) — the serializer joins the parser in `src/domain/storage/rev-index.ts`; `pack-writer.ts` is blocked by its existing `@writes` block |
| DC-2 | How pack-offset ordering is derived | **625** | adopted-as-recommended | (a) — one shared oid/offset ordering helper feeds both `serializePackIndex` and `serializePackRevIndex`, keeping `fsck`'s cross-check an independent oracle |
| DC-3 | Where the gate and artefact assembly live | **626** | adopted-as-recommended | (a) — `writePackArtifacts` absorbs `buildIdx`/`buildRev` + the config read behind an options object, retiring the `promisor: boolean` positional |
| DC-4 | `pack.writeReverseIndex=<not a boolean>` | **627** | **ratified (user judgment) — DEVIATES from the recommendation** | **(c), widened**: not lenient (rec) and not per-key, but **repo-wide strict boolean refusal in this change**. Both narrower options were rejected — the first preserves a known unfaithfulness, the second trades one inconsistency for another. Specified in §D6a; Pins K/L are new; see the Revision note for the grammar discrepancy against the ADR's own sketch |
| DC-5 | `writeExclusive` vs `write` for the `.rev` | **628** | adopted-as-recommended | (a) — `writeExclusive` like all three siblings; the overwrite divergence is unreachable while the `.pack` create fails first, and ADR-628 makes that premise explicit for any future revisit |
| DC-6 | Interop coverage shape | **629** | adopted-as-recommended | (a) — a new `test/integration/rev-write-interop.test.ts` declaring `interopSurface: packRevIndex`, keeping the audit allowlist empty |
| DC-7 | Failure posture when the `.rev` write fails | **630** | adopted-as-recommended | (a) — propagate; the enclosing `fetch`/`clone`/`packObjects` fails, matching git's `die` |
| DC-8 | How requirement 7 (read-side pickup) is proven | **631** | adopted-as-recommended | (c) — the always-on `loadPackRevIndex` assertion **and** one ≥5,000-object scaled case; the scaled case moves to the bench family rather than being dropped if it is too slow |
| DC-9 | A per-call override on `packObjects` / `fetchPack` | **632** | adopted-as-recommended | (a) — config only; the flag would belong on a plumbing `index-pack` if one ever lands |

The full alternatives and reasoning for each candidate live in its ADR; the recommendations they
adopted were this design's, unchanged, except DC-4 as noted.

## Test strategy

### Unit — `test/unit/domain/storage/rev-index.test.ts` (extend)

| case | assertion |
|---|---|
| the F1 fixture's 7 entries (oids + offsets from Pin B) | bytes `[0, 60)` equal **Pin B's literal** — magic, version, `hashId = 1`, body `[3,4,5,1,6,2,0]`, embedded checksum at `0x28` — and bytes `[60, 80)` are zero. The real trailer is `buildRev`'s test, since the domain function does not hash |
| offsets already ascending / descending / interleaved | body is offset-ordered regardless of input order |
| zero entries | 52 bytes, empty body, checksum at offset 12 (Pin E1) |
| one entry | 56 bytes, body `[0]` (Pin E2) |
| SHA-256 checksum (32 bytes) | `hashId = 2`, size `12 + 4N + 64` (Pin F) |
| checksum length 0 / 19 / 21 / 33 | throws `INVALID_PACK_REV_INDEX` with `check: 'hash-id'` — **each width tested separately** (isolated guard clauses), asserting `data.check` and `data.reason`, never bare `toThrow(Class)` |
| large offsets (> 0x7fffffff) | ordering still correct — the writer sorts real offsets, not their `.idx` encoding |

### Unit — `test/unit/application/primitives/internal/write-pack-artifacts.test.ts` (**new** — no such file exists today)

`buildRev`: trailer equals `ctx.hash.hash(bytes[0, len−20))`; `.rev` re-parses through
`parsePackRevIndex`; body matches `packPositionMap` over the `.idx` `buildIdx` produced for the same
entries (the independent oracle).

`writePackArtifacts` with a memory adapter: three files with the gate absent; two with
`pack.writeReverseIndex=false`; `revPath` `undefined` in that case; `.promisor` unaffected either
way; a `writeExclusive` rejection on the `.rev` propagates with its code.

### Unit — `test/unit/application/primitives/config-read.test.ts` (extend)

`[pack] writeReverseIndex` → `true`/`false`/valueless(⇒`true`, Pin D6)/mixed case key/absent section
(⇒ `undefined`), plus an integer row (`= 2` ⇒ `true`, `= 0` ⇒ `false`, Pin K3).

**The boolean grammar gets its own table-driven sweep** over the parse of §D6a, one case per Pin K
row and no fewer — the accepted words in mixed case (K1), valueless ⇒ true and empty ⇒ false (K2),
every integer row including both `int` boundaries and all four overflow rejects (K3), and the
quoted-single-space reject. The boundaries are the mutation-critical pairs: `2147483647` accepted
against `2147483648` refused, and `-2147483648` accepted against `-2147483649` refused, are what
kill an off-by-one on the range check, and `0x80000000` / `2g` are what prove the check runs on the
**scaled, radix-resolved** value rather than on the source text.

Refusal assertions go through try/catch on `.data`, asserting `code`, `key` and `value` — never a
bare `toThrow(Class)`, per the repo's mutation-resistance rule. `CONFIG_BAD_BOOLEAN_LITERAL`
(`push.gpgSign`) is asserted as a distinct code, not as a message variant.

### Unit — the tier gates (extend `repo-state` and each T3 consumer's suite)

`findFirstInvalidBoolean` and its `…InSection` sibling: first-offender-by-line within a class;
`undefined` for valid, absent and out-of-section entries; the subsection preserved verbatim in the
qualified key while section and variable lower-case (Pin K5).

`assertCoreConfigValid`'s three-class ordering (requirement 17): boolean-before-valueless and
valueless-before-boolean fixtures, plus boolean-before-numeric, asserting the **code** that comes
back — this is the test that catches a reduce written over two classes and extended to three by
copy-paste. `assertRepository`'s new T1 gate gets its own cases for `core.bare` and
`extensions.worktreeConfig`, including the negative: a malformed **T2** key must leave
`assertRepository` silent.

Each T3 consumer gets one refusal case and one no-op case (valid value resolves normally, absent
value falls through to the existing default) — eleven pairs, one per B-row that has a consumer.

### Property — the boolean grammar (`config-read.properties.test.ts`, extend)

Lens 3 (total function over an algebraic grammar) fits: **the parse never throws** for any input in
the safe subset (arbitrary ASCII strings without NUL, plus `null`), `numRuns: 100`. Lens 4
(counting invariant) gives the sharper one: for an arbitrary integer in `[-2147483648, 2147483647]`
rendered in any of decimal / octal / hex, with an optional sign and an optional unit factor that
keeps it in range, the parse **is `ok` and its value is `n !== 0`** — that generates the whole K3
arm rather than enumerating the eight rows the example test pins.

The oracle here is arithmetic (`n !== 0`), not a re-implementation of the parse, so it is a real
property and not a tautology.

### Property — `test/unit/domain/storage/rev-index.properties.test.ts` (extend)

Lens 1 (round-trip pair) applies directly:

- **`parse(serialize(x)) ≡ x`**, `numRuns: 200`. Generate `ReadonlyArray<PackIndexWriterEntry>` with
  distinct offsets and distinct oids plus a `digestLength ∈ {20, 32}` checksum; assert `version`,
  `hashId`, `objectCount`, `packChecksum` and every `revIndexPositionAt(p)`; assert the body is a
  **permutation of `[0, N)`** and that mapping it through the entries yields strictly ascending
  offsets. The parser ignores the trailer's value, so the zeroed tail parses — the real digest is
  proven by the `buildRev` unit test and the interop compare.
- **`serialize` is total over its declared domain**, `numRuns: 100`: no input in the safe subset
  (any N, either width) throws or produces a size other than `12 + 4N + 2d`.

Keep `arbitraries.ts`' existing hand-rolled `buildRevIndex`/`arbRevIndexSpec` (L396–458) **as they
are**: they generate hostile specs (bad `hashId`, non-permutation bodies, width disagreement) that
the production serializer cannot emit and that the negative parser properties need. Replacing them
with the production writer would silently narrow the parser's input space.

### Integration / interop — `test/integration/rev-write-interop.test.ts` (new)

`@proves surface: packRevIndex · bucket: cross-tool-interop · interopSurface: packRevIndex`.
One shared `beforeAll` fixture, 60 s timeout, `GIT_*` scrubbed, signing off, every `Context`
disposed per row.

| # | row | assertion |
|---|---|---|
| X1 | tsgit `packObjects` writes a pack; copy the `.pack` to a scratch dir; `git index-pack -o <stem>.idx <stem>.pack` | tsgit's `.rev` bytes **equal** git's, byte for byte (Pin B/C) |
| X2 | same, SHA-1 fixture with ≥ 3 objects at non-monotonic oid/offset correlation | the permutation is non-trivial — a fixture whose body is the identity would pass for the wrong reason |
| X3 | `git verify-pack -v` and `git fsck --strict` over a repo whose pack dir tsgit wrote | exit 0, no `.rev` finding (requirement 8) |
| X4 | tsgit `fsck` over the same repo | no `.rev` finding, exit bit 64 clear. This is the **strongest cheap oracle available**: `internal/fsck/rev-index-health.ts` already verifies the trailer with `ctx.hash` over `[0, len − digestLength)` **and** cross-checks every body position against `packPositionMap`, so a green `fsck` proves the digest and the whole permutation against an independently written reader |
| X5 | `pack.writeReverseIndex=false` in the **local** repo config, then `packObjects` | no `.rev`; `git fsck --strict` still clean (Pin D2/H1) |
| X6 | `pack.writeReverseIndex` valueless in the local config | `.rev` written (Pin D6) |
| X7 | `pack.writeReverseIndex=maybe`, same repo state handed to both tools | **both refuse** — git exits 128 with `bad boolean config value` (Pin D7); tsgit throws `CONFIG_BAD_BOOLEAN_VALUE` carrying the lower-cased key and `value: 'maybe'`, and writes **no** pack artefacts, matching git's empty pack dir (Pin D8). A faithfulness row now, not a divergence row |
| X7b | `pack.writeReverseIndex=2` and `=0` | both tools accept; `2` ⇒ `.rev` written, `0` ⇒ suppressed (Pin K3) — the integer arm proven end-to-end, not just in the unit sweep |
| X8 | tsgit clone/fetch against a local `git` peer (whichever the existing helpers already support) | the fetched pack has all three files, and git reads objects out of it |
| X9 | `packObjects` into an `outputDirectory` outside the repo | `.rev` present there (Pin A5) |
| X10 | tsgit re-reads its own artefact: `loadPackRevIndex` ⇒ `kind: 'usable'` and `revIndexPositions` ≡ `packPositionMap(parsedIdx)` | requirement 6/7 (DC-8a) |

#### Pre-existing boolean keys — the ADR-627 rows

These prove the expansion, not the `.rev`. They belong in a **separate**
`test/integration/config-boolean-interop.test.ts`: they carry no `interopSurface` (nothing here is a
`@writes` surface), and folding them into the `.rev` file would make one interop file answer to two
unrelated contracts. Each row writes one malformed key into a repo both tools open, then asserts
**both refuse, and both refuse at the same tier** — a row that only checked tsgit's refusal would
pass while over-refusing.

| # | key / tier | both refuse | both succeed (the tier boundary) |
|---|---|---|---|
| X11 | `core.bare = maybe` (**T1**) | git `status` exit 128; tsgit's equivalent command throws `CONFIG_BAD_BOOLEAN_VALUE` | — and additionally: git `config --list` **also** refuses, so tsgit's `config` porcelain must refuse too (Pin L1) |
| X12 | `core.sparseCheckout = maybe` (**T2**) | git `status` exit 128; tsgit's operational command throws | git `config --get core.sparsecheckout` exits 0 printing `maybe` ⇒ tsgit's `config` porcelain must **still succeed** (Pin L3, ADR-314) |
| X13 | `commit.gpgSign = maybe` (**T3**) | git `commit` exit 128; tsgit's `commit` throws | git `status` and `log` exit 0 ⇒ tsgit's `status`/`log` must **not** refuse (Pin L7) |
| X14 | `core.bare = 2` (accepted integer) | neither refuses | both report the repository as **bare** (Pin L-values) — the accepted-value flip of §D14 blind spot 10, and the only row here asserting agreement rather than refusal |
| X15 | `push.gpgSign = maybe` (**T3**, distinct shape) | git `push` exit 128 with `error: invalid value for 'push.gpgsign'`; tsgit throws `CONFIG_BAD_BOOLEAN_LITERAL` | git `status` exits 0 ⇒ tsgit's `status` must not refuse (Pin L9) |
| X16 | `core.sparseCheckout = maybe` on line 1, valueless `core.excludesFile` on line 2 — then the reverse order | both tools name the **lower-line** entry, and tsgit's error **code** switches between `CONFIG_BAD_BOOLEAN_VALUE` and `CONFIG_MISSING_VALUE` accordingly (Pin L-order, requirement 17) |

X11 and X12 together are the load-bearing pair: they pin the porcelain boundary in **both**
directions, which is the single thing a one-tier implementation would get wrong.

Reuse `test/integration/interop-helpers.ts` (`GIT_AVAILABLE`, `git`, `makePeerPair`,
`initBothRepos`) and `rev-bitmap-fixture-helpers.ts` (`DIGEST_LENGTH`, `packArtefactPaths`,
`packArtefactPathsNamed`) rather than adding a third fixture vocabulary. The boolean file needs one
extra helper — writing a raw config line, since git's CLI cannot emit a valueless entry and refuses
to `git config` a key into a repo whose config it already rejects (pinned: with `core.bare = maybe`
in place, even `git config --unset core.bare` exits 128).

### Integration — scaled read-side pickup (DC-8b)

One case building a pack at or above `REV_INDEX_MIN_OBJECTS` (5,000) so `resolveSortedOffsets`
takes the gathered arm on tsgit's own freshly written `.rev`; assert reads succeed and, if a seam
allows it without new production code, that the fallback warning never fires. If the build cost
proves incompatible with the integration tier, move it to `test/bench/support/fixture-generator.ts`'s
family rather than dropping the coverage.

### Parity

`test/parity/scenarios/pack-objects.scenario.ts`: `packDirEntryCount` `2 → 3`, and the interface
comment corrected from *"no `.rev`, no bitmap"* to *"`.pack` + `.idx` + `.rev`; no bitmap"*.
Regenerate the goldens for every driver — parity runs across node/memory/browser/workerd, so all
five drivers must agree (a stale parity bundle shows up as uniform e2e timeouts, not as a diff).

### Gates

- `npm run validate` green before any commit; `check:types`, biome, ls-lint, cspell.
- Coverage 100 % on `src/domain/**` and adapters; the new domain serializer is fully covered by the
  unit + property tests. Application-layer additions are gated by Stryker, not by the coverage tool.
- Mutation: the size/`hashId` arithmetic and the offset comparator are prime mutant sites — the
  exact-byte literal test (Pin B) and the permutation property are the intended killers. Expect to
  need an isolated test per guard-clause width in the checksum check.
- `audit-write-surfaces` must stay green with the allowlist untouched (requirement 11).
- `serializePackRevIndex` joins `src/domain/storage/index.ts`, which is a **public export** — the
  pre-push gate requires a regenerated `reports/api.json` in the same commit, and the `.d.ts`
  truthfulness checks must stay green. The two new error codes are also public surface;
  `ParsedConfig`'s field types are not changed by the boolean work (§D6a), so the api.json delta is
  the serializer, the `pack` field and the error variants — nothing else.
- **Existing suites will go red, and that is the signal to read, not to silence.** Any test today
  asserting a malformed boolean coerces to `false` encodes the divergence ADR-627 removes; each one
  is re-pointed at the refusal. A test that merely *uses* a sloppy value incidentally is a different
  case and gets a valid value instead. Neither is a reason to weaken a gate.
- No bench gate: the added cost is one `Uint32Array` sort plus one digest over `4N + 52` bytes per
  pack write (T-8), invisible beside the pack's own inflate and hash. If a fetch bench moves, that
  is a defect, not a budget negotiation.

### Docs (for the documentation phase, not this design)

`docs/use/commands/pack-objects.md`, `docs/use/primitives/internals.md`,
`docs/understand/architecture.md`, `docs/understand/performance.md` all currently describe tsgit as
writing `.pack` + `.idx` only; `docs/use/commands/fsck.md` describes the `.rev` read side.
`docs/BACKLOG.md` gains **28.4** and 28.3's entry keeps its wording (it was accurate when written).

The ADR-627 expansion is a **user-visible behaviour change** and needs more than a mention: the
config documentation gains Pin K's accepted grammar (the integer arm especially — callers will
otherwise assume `1`/`0`), Pin L's tier table so a caller can predict *which* command refuses, and
the two new error codes in whatever page enumerates them. Any page that currently describes tsgit's
boolean handling as lenient is now wrong.

## Out of scope

- **`.bitmap` writing** — requires an EWAH *encoder* plus git's commit-selection policy, and git
  itself only writes bitmaps in repack/gc. ADR-614's exclusion stands unchanged.
- **Multi-pack-index and commit-graph writing** — likewise maintenance-only in git; writing them at
  fetch time would be the unfaithful choice.
- **`repack` / `gc` / `prune` / `maintenance`** — the parked entry (BACKLOG "gc / repack / prune",
  was 24.1). This design adds one hygiene constraint to it (§D12 W-7).
- **Global/system config reading** — `readConfig` stays local-only; systemic, pre-existing,
  unchanged (§D6). The boolean refusal inherits this boundary exactly: a malformed boolean in
  `~/.gitconfig` refuses in git and is invisible to tsgit. The expansion does not widen the
  divergence, but it does make it sharper — tsgit now refuses on local malformed values while still
  ignoring global ones.
- **Artefact file mode (0444)** — pre-existing for `.pack`/`.idx` (Pin G2); this design does not
  change permission behaviour for any artefact.
- **Non-boolean config type strictness** — int-typed keys already refuse
  (`CONFIG_BAD_NUMERIC_VALUE`), string-typed valueless keys already refuse
  (`CONFIG_MISSING_VALUE`). Other typed families git validates (colour, path, expiry dates) are
  untouched; ADR-627 is scoped to booleans.
- **`.git/sequencer/opts` boolean coercion** — `sequencer-state.ts`'s `hasTrueKey` (§D6a). Tool-written
  repository state, not user configuration; a bad value there is corruption, not misconfiguration.
- **`extensions.*` beyond `worktreeConfig`** — tsgit reads no other `extensions` boolean today.
  `extensions.partialClone` is string-typed and out of this class.
- **Delta compression in the pack writer** — ADR-614's other permanent exclusion, untouched.
- **A plumbing `index-pack` command or a `--rev-index` style flag** — DC-9.
