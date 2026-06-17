# Design — int-config-valueless-refusal

> Brief: unblock backlog 24.9s by BUNDLING its prerequisite. Introduce a genuinely-consumed
> int-typed config key into `ParsedConfig` with a faithful git int parser (half 1), then add
> the int-typed valueless refusal on top — a NEW error code distinct from `CONFIG_MISSING_VALUE`,
> reconstructing git's single-line `fatal: bad numeric config value '' for '<key>' in file <F>: invalid unit`
> (half 2).
> Status: self-reviewed ×3 → draft (decision candidates open for the ADR phase)

## Context

git resolves a NULL (valueless) config value lazily, per typed accessor. ADR-314 represents
the valueless entry as `value: null` on the porcelain read surfaces; ADR-315 (D4) merges valueless
**string** fields into `ParsedConfig` as absent. 24.9l (ADRs 327–329) then closed the string-typed
*refusal* divergence for identity + remote-URL, shipping the reusable enabler this change extends;
24.9r (ADRs 346–350) widened it across every remaining string-typed key, including the `[core]`
path-likes via a shared **eager-broad** gate. The valueless infra now in place (all on this branch):

- `findFirstValuelessEntry(ctx, section, subsection, keys)` (`src/application/primitives/config-read.ts` ~L145)
  — cold-path token-stream walk over the per-`Context`-cached config tokens; returns the FIRST
  `value === null` entry by config-file line whose key (case-insensitive) is one of `keys` under
  `[<section> "<subsection>"]`, as `{ key, source, line }` (`key` = section+var lowercased, subsection
  verbatim; `source` = absolute config path; `line` 1-based), else `undefined`. Reused as-is here.
- `assertNoValuelessConfig(ctx, section, subsection, keys)` (`src/application/primitives/internal/valueless-config-guard.ts`)
  — throws `configMissingValue(found.key, found.source, found.line)` for the first valueless entry, no-op
  otherwise. This is the STRING-shape guard; the int refusal needs a SIBLING guard throwing a new error.
- `assertNoValuelessCorePaths(ctx)` + `assertOperationalRepository(ctx)` (`src/application/primitives/internal/repo-state.ts` L41/L51)
  — the eager-broad `[core]` pre-flight (`['excludesfile','attributesfile']`), run by every operational
  command, bypassed by the config porcelain. The empirical pinning below shows the int loose-compression
  keys die on the **same** surface this gate already covers.
- Error model: `CONFIG_MISSING_VALUE { code, key, source, line }` in `src/domain/commands/error.ts`
  (variant ~L131, factory `configMissingValue` ~L465), rendered in `src/domain/error.ts` (~L393) as
  `missing value for '<key>' in file '<source>' at line <line>`.

**The blocker 24.9s names** (BACKLOG L352): git's int-typed valueless death is a *different shape*
(single `fatal:` line, no `error:` prefix, no `at line N`, path token UNquoted) so it needs its own
error code; and it was **blocked because no int-typed key is consumed in `ParsedConfig` today** — there
was nothing to refuse on. `ParsedConfig` (`config-read.ts` L10) has only boolean / `boolean|'always'` /
string / string[] fields and their maps — confirmed NO int field and NO numeric/unit parsing anywhere
in `src`. The user decided to **bundle the prerequisite**: this change introduces the first real
int-typed key AND the int valueless refusal together.

ADR-226 (prime directive) binds observable behaviour byte-for-byte; ADR-249 refines it: faithfulness
binds DATA + on-disk state + refusal conditions, NOT rendered stdout. The library emits the structured
error; the interop test reconstructs git's single line from the fields and diffs against real git.

### Code facts established by exploration (these constrain the design)

- **No int parser exists.** The config layer parses only booleans (`parseGitBoolean`, `null → true`),
  `logAllRefUpdates` (`boolean | 'always'`), and raw strings. An int parser is genuinely new code —
  a total function over an ASCII numeric grammar, a property-test candidate (assessed below).
- **`ctx.compressor.deflate(data)` takes no level.** The `Compressor` port (`src/ports/compressor.ts` L9)
  is `deflate: (data: Uint8Array) => Promise<Uint8Array>`. Two call sites: `write-object.ts` L35
  (loose write) and `build-pack.ts` L56 (pack write). Honouring a compression level requires widening
  the port — see candidate-A blocker below.
- **Loose-object disk bytes are EXPLICITLY OUT of the faithfulness contract.** `loose-object-interop.test.ts`
  (L4): *"Bytes are not pinned (zlib compression level is implementation-defined — git uses 1, Node defaults
  to 6), but the SHA is over the decompressed payload."* The contract is **equivalence-under-readback**, not
  byte-identity. `domain/objects/commit.ts` repeats the caveat. So tsgit deliberately diverges on the loose
  zlib level today (pinned below: git default `7801` = level 1, Node default `789c` = level 6).
- **The memory/browser compressor cannot set a level.** `MemoryCompressor.deflate` /
  `BrowserCompressor.deflate` use `new CompressionStream('deflate')` (`memory-compressor.ts` L19) — the Web
  Streams API exposes NO compression-level parameter. Only `NodeCompressor` (`deflateSync`,
  `node-compressor.ts` L28) can take a `{ level }`. A level-honouring port is unsatisfiable on two of three
  adapters.
- **`core.repositoryformatversion` is WRITE-only.** `bootstrap.ts` L28 and `clone.ts` L185 write it; nothing
  in `src` reads or validates it. Candidate B would ADD a repo-open read gate tsgit lacks entirely.
- **Interop harness:** `test/integration/missing-value-refusal-interop.test.ts` is the 24.9l/24.9r structure
  to extend — `runGit`/`tryRunGit`/`runGitEnv` from `interop-helpers.ts`, valueless line written by `writeFile`
  into `<dir>/.git/config` (git's CLI cannot emit a valueless entry), per-field `.data` assertions, and the
  `source` path-token normalization (`expect(data.source).toMatch(/\/config$/)`, reconstruct `.git/config`).

## Requirements

When this ships:

1. `ParsedConfig` carries ONE genuinely-consumed int-typed field, populated by a faithful git int parser
   (the chosen key — candidate 1). `api.json` updates for the new public field (a Tier-data surface gate).
2. The valid (parseable, in-range) value drives a REAL tsgit behaviour git also has (the consumed site),
   verified against real git — not an invented site.
3. When the chosen key is present-but-valueless (git's internal NULL — a `key` line with no `=`), the
   consuming read refuses with a **NEW** error code (candidate 2), distinct from `CONFIG_MISSING_VALUE`,
   carrying the fields needed to reconstruct git's exact single line
   `fatal: bad numeric config value '' for '<key>' in file <F>: invalid unit` (exit-128 equivalent).
   The library emits no rendered string (ADR-249).
4. The refusal fires **precisely** where git dies and never where git succeeds. The pinned matrix below
   fixes the exact command boundary (operational surface dies; config porcelain `--list`/`--get` survives —
   the same split 24.9r's eager gate already reproduces).
5. The int parser is faithful to git's `git_parse_int` → `git_parse_signed`: base-0 strtoimax (decimal, `0x`
   hex, `+`/`-` sign, leading whitespace), optional single k/K/m/M/g/G unit suffix (×1024^n), trailing
   garbage/empty → `invalid unit`, magnitude past C `int` → `out of range`. The scope of *which* of these
   error suffixes tsgit reproduces is candidate 4.
6. No regression on the **absent** path: a wholly-absent key keeps git's documented default (the consumed
   behaviour's fallback — e.g. loose level defaults to `Z_BEST_SPEED`).
7. Porcelain `config --get`/`--list`/`getRegexp` still succeed on the valueless int entry (it stays
   `value: null` on the porcelain surface per ADR-314 — unchanged).
8. The new int field and refusal are scoped to the ONE chosen key; other int-ish keys git reads numerically
   stay unparsed (lenient, as today) — see Out of scope.

## Design

### Pinned git matrix (git 2.54.0)

All probes ran in fresh `mktemp -d` repos, ambient `GIT_*` scrubbed, isolated `HOME`,
`GIT_CONFIG_NOSYSTEM=1`, signing off. Valueless lines were hand-written (git's CLI cannot emit a
valueless entry). State-mutating probes never touched the working dir.

#### Int-typed valueless death shape — the 24.9s target (authoritative)

Exact stderr bytes for a valueless `core.loosecompression`, captured via `od -c` (single physical line,
trailing `\n`, exit 128):

```
fatal: bad numeric config value '' for 'core.loosecompression' in file .git/config: invalid unit
```

Discriminators vs the STRING shape (`CONFIG_MISSING_VALUE`):

| facet | INT shape (24.9s) | STRING shape (`CONFIG_MISSING_VALUE`) |
|---|---|---|
| line count | **1** (`grep -c '^error:'` = 0) | 2 (`error:` line + `fatal:` line) |
| prefix | `fatal:` only, no `error:` | `error:` then `fatal:` |
| value token | `bad numeric config value ''` (the read value, quoted) | (none) |
| key token | `for 'core.loosecompression'` (quoted) | `for '<key>'` / `variable '<key>'` (quoted) |
| file token | `in file .git/config` — **UNquoted** | `in file '.git/config'` — **quoted** |
| line ref | **none** | `at line <N>` |
| suffix | `: invalid unit` (or `: out of range`) | — |
| path (from subdir) | repo-relative `.git/config` (resolved to top-level) | repo-relative `.git/config` |

So the int shape is `bad numeric config value '<value>' for '<key>' in file <source>: <reason>`, where for
the valueless case `<value>` is the empty string and `<reason>` is `invalid unit`. **No `line` field** —
distinct fields from `CONFIG_MISSING_VALUE`.

#### The three distinct int error suffixes for `core.loosecompression` (pinned)

| config value | git stderr (first line) | exit | shape class |
|---|---|---|---|
| valueless (NULL) | `fatal: bad numeric config value '' for 'core.loosecompression' in file .git/config: invalid unit` | 128 | **24.9s target** (`invalid unit`) |
| `abc` / `10x` / `5 ` (trailing) / `1.5` / `1kb` | `... value '<v>' for 'core.loosecompression' ... : invalid unit` | 128 | `invalid unit` (same shape, non-empty value) |
| `2147483648` (≥ INT_MAX after unit) | `... value '2147483648' for 'core.loosecompression' ... : out of range` | 128 | `out of range` (same framing, different suffix) |
| `10` / `99` / `1k` (=1024) | `fatal: bad zlib compression level <N>` | 128 | **THIRD shape** — key-specific, AFTER a successful int parse |
| `-1` | exit 0 (→ `Z_DEFAULT_COMPRESSION`) | 0 | valid |
| `0` | exit 0 (stored, header `7801`) | 0 | valid |
| `1` (default when unset) / `6` / `9` | exit 0, header `7801`/`789c`/`78da` | 0 | valid |

The `bad zlib compression level` row is a **third, separate** error shape (the int parsed fine; the *zlib
consumer* range-checked it to 0–9 with `-1` allowed). It is NOT the 24.9s shape and is its own scope
decision (candidate 4). Note `1k → 1024` proves units are applied by the int parser BEFORE the zlib
range-check.

#### Int parser semantics (`git_config_int` → `git_parse_signed`, pinned via `git config --type=int`)

| raw value | `--type=int` result | note |
|---|---|---|
| `10` | `10` | decimal |
| `0x10` | `16` | base-0 hex |
| `+5` / `-7` | `5` / `-7` | sign |
| ` 5` (leading ws) | `5` | leading whitespace skipped |
| `1k` / `1K` | `1024` | unit k = ×1024, case-insensitive |
| `2g` | `2147483648` | unit g = ×1024³ |
| `5 ` (trailing ws) | `invalid unit` (exit 128) | trailing garbage rejected |
| `1kb` / `1.5` | `invalid unit` (exit 128) | multi-char/decimal rejected |
| `` (valueless) | `invalid unit` (exit 128) | NULL read as `""` |

Faithful int parser spec: strtoimax base 0 over the trimmed-leading value, then at most one trailing
k/K/m/M/g/G applying ×1024^n; any other trailing byte, or no digits consumed (incl. empty), → `invalid
unit`; magnitude exceeding the signed 32-bit `int` range after scaling → `out of range`.

#### Eager-broad death breadth for `core.loosecompression` (pinned, HEAD intact)

A valueless `core.loosecompression` (and `core.compression`) dies in `git_default_config` at config load —
the SAME eager-broad surface as `excludesfile`/`attributesfile`, even broader (also kills `rev-parse HEAD`,
`for-each-ref`, `cat-file`, `show`):

| command | valueless `core.loosecompression` |
|---|---|
| `status`, `log`, `branch`, `tag`, `for-each-ref`, `ls-files`, `diff`, `show HEAD`, `rev-parse HEAD`, `cat-file -p HEAD`, `add <new>` | **DIES** (exit 128, int shape) |
| `config --list`, `config --get core.loosecompression`, `config --get-regexp` | **OK** (exit 0; key prints as bare/empty) |

This is decisive: the int loose-compression keys die on exactly the surface
`assertOperationalRepository` already gates and survive on exactly the porcelain `assertRepository`
keeps — so the int refusal can RIDE the existing eager-broad gate, adding only a new keyset + new error
(candidate 2 / consuming-site map below).

#### Valid-path consumed behaviour: loose-object zlib header (pinned)

`git hash-object -w` of `hello world\n`, varying the keys, observing the loose-file zlib header:

| config | loose header | note |
|---|---|---|
| none (default) | `7801` | `Z_BEST_SPEED` (level 1) is git's loose default |
| `loosecompression=9` | `78da` | level 9 |
| `compression=9` (no loosecompression) | `78da` | `compression` is the fallback |
| `loosecompression=1, compression=9` | `7801` | **`loosecompression` wins** |
| `loosecompression=9, compression=1` | `78da` | `loosecompression` wins |

Precedence: `core.loosecompression` > `core.compression` > `Z_BEST_SPEED`(1). **tsgit currently produces
`789c` (Node default level 6)** — already divergent from git's `7801` default, which the loose-object
contract explicitly permits (equivalence-under-readback). This is the candidate-A faithfulness tension
(decision 1 below).

#### Candidate-B pin: `core.repositoryformatversion` (pinned)

| state | behaviour |
|---|---|
| valueless | `fatal: bad numeric config value '' for 'core.repositoryformatversion' in file .git/config: invalid unit` — same int shape |
| valueless: `config --list` | **DIES too** (exit 128) — NO porcelain-survives split (read in repo-setup, even earlier than `git_default_config`) |
| `=99` (unknown high) | `fatal: Expected git repo version <= 1, found 99` — a FOURTH, separate validation shape |

Candidate B's valueless death has **no porcelain bypass** (even `config --list` dies), so its faithful
gate cannot reuse the operational-vs-porcelain split; and its valid path needs a brand-new repo-open
version-validation gate plus the `Expected git repo version` error. Larger, less reuse, sharper new
surface. (See decision 1.)

### Recommended design shape (subject to decision 1 — candidate A)

**Half 1 — prerequisite (int key + parser).** Add a new application primitive
`parseGitInt(value: string | null): number` (a sibling of `parseGitBoolean`, same file
`config-read.ts`) implementing the pinned int grammar, returning a number on success and **throwing**
the new int error on failure (it has the `key`/`source` from its caller — see below). Widen
`ParsedConfig.core` with `readonly looseCompression?: number` (and, if `core.compression` is the
fallback source, resolve the two at read time into a single `looseCompression` effective value, or carry
both — plan decides the field shape). `applyCoreEntry` (config-read.ts ~L949) gains an `loosecompression`/
`compression` branch that, on a NON-null value, parses via `parseGitInt`. The valueless (`null`) case
keeps merging as absent (ADR-315 D4 unchanged) — the refusal is NOT at merge time (porcelain must
survive); it rides the eager gate.

**Half 2 — the refusal.** Add `INT` error + an int sibling guard:

- New `CommandError` variant `CONFIG_BAD_NUMERIC_VALUE { code, key, source, value, reason }` (candidate 2)
  with factory `configBadNumericValue(...)` in `domain/commands/error.ts`, rendered in `domain/error.ts`
  as `bad numeric config value '<value>' for '<key>' in file <source>: <reason>` (UNquoted file token; no
  `at line`). `reason` is `'invalid unit' | 'out of range'` (and `'bad zlib compression level'` only if
  candidate 4 puts the third shape in scope — plan picks the enum).
- New guard `assertNoBadNumericCorePaths(ctx)` (or a generalized `assertNoBadNumericConfig(ctx, section,
  subsection, keys)` sibling of `assertNoValuelessConfig`) that finds the valueless int entry via the
  EXISTING `findFirstValuelessEntry` (same NULL detection — for the valueless case the read value is
  always `''`, so the guard hardcodes `value: ''`, `reason: 'invalid unit'`; a valued-invalid extension
  per candidate 4 would instead carry the actual read string + computed reason) and throws
  `configBadNumericValue(found.key, found.source, '', 'invalid unit')`.
- **Two key CLASSES, one file-line scan — NOT two fixed-order calls.** The existing
  `assertNoValuelessCorePaths` calls `assertNoValuelessConfig(ctx,'core',undefined,['excludesfile',
  'attributesfile'])` and throws the STRING error. The int keys must NOT be added to THAT call (they would
  throw the wrong, string-shaped error). But a naive "string call THEN int call" is ALSO wrong: when a
  valueless string key AND a valueless int key both exist under `[core]`, git reports whichever is
  **earlier in the config file**, across both classes (pinned below — order A reports the string key,
  order B reports the int key, both in `git_default_config`'s per-entry callback order). A fixed
  string-then-int call order would always report the string key, diverging from order B.
  The faithful shape is therefore ONE file-line scan over the UNION of both keysets that dispatches the
  error SHAPE by which key the first valueless entry is. The exact mechanism (a new union-aware finder, or
  reuse `findFirstValuelessEntry` for each class and compare the two results' `line`, throwing the lower)
  is candidate 6 — an implementation-shape sub-question for the plan/ADR, the same kind ADR-346 left to
  the 24.9r design.

This keeps the int refusal a SMALL addition to a proven gate (the eager-broad surface is already wired and
tested by 24.9r), and the valid path a localized `ParsedConfig` widening + (if candidate 3 honours the
level) one NodeCompressor-only `deflate(data, level)` change at `write-object.ts`.

### Hexagonal placement

- The int error factory + variant: domain (`domain/commands/error.ts` + `domain/error.ts` render),
  consistent with every other `CommandError`.
- `parseGitInt` + the `ParsedConfig.core.looseCompression` widening: application primitive
  (`config-read.ts`), alongside `parseGitBoolean`.
- The int guard: `application/primitives/internal/`, sibling of `valueless-config-guard.ts`; wired through
  `repo-state.ts`'s eager gate.
- Honouring the valid level (if candidate A): the `Compressor` port widens to `deflate(data, level?)`
  (`src/ports/compressor.ts`), `NodeCompressor` passes `{ level }` to `deflateSync`, `Memory`/`Browser`
  adapters ACCEPT the param and IGNORE it (documented — `CompressionStream` cannot set a level; this
  preserves the existing equivalence-under-readback contract for those adapters). `write-object.ts` L35 /
  `build-pack.ts` L56 read `config.core?.looseCompression` and pass it. The decision on whether to honour
  the valid path at all (vs. parse-and-refuse-only) is candidate 3.

### Why the refusal is faithful (and safe)

The int guard reuses `findFirstValuelessEntry` — identical NULL detection to the string guard — so it
fires ONLY for a present-but-valueless int key, never for a valued or absent one (no over-refusal). Placed
on the eager-broad gate, it refuses on exactly the operational surface git's `git_default_config` kills and
is bypassed by the porcelain `assertRepository`, exactly as pinned. A VALUED-but-invalid int (`abc`, `99`,
`2147483648`) is a different scope (candidate 4): the valueless case alone is 24.9s's named requirement.

## Decision candidates

The designer NEVER decides these; the user does, in the ADR phase.

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Which int config key + consuming site** (the prerequisite) | **(A)** `core.loosecompression` (fallback `core.compression`) consumed at loose-object write — `ParsedConfig.core.looseCompression: number`; valueless rides the EXISTING eager-broad `assertNoValuelessCorePaths` gate (pinned: same death surface). **(B)** `core.repositoryformatversion` read+validated at repo open — no port change, but a NEW repo-open gate, valueless death has NO porcelain bypass (config --list dies too), plus a separate `Expected git repo version` validation shape. **(C)** another int key — none is consumed by tsgit today (`abbrev`/`bigFileThreshold`/`gc.*` all unread), so any other choice ALSO invents a consuming site. | **(A)** | A is the ONLY candidate whose valueless death reuses the proven 24.9r eager-broad gate verbatim (pinned identical surface), making half 2 nearly free; its consumed behaviour is real and always-exercised. Its tension — loose disk bytes are out of the faithfulness contract (equivalence-under-readback) and 2/3 adapters can't set a level — is bounded and isolated to candidate 3 (whether/where to honour the valid level); the int *parse + refusal* (24.9s's actual subject) is fully faithful regardless. B adds the most NEW surface (repo-open gate + version validation), has no porcelain split to reuse, and `repositoryformatversion` is genuinely needed only when tsgit starts enforcing repo formats — a larger feature than 24.9s. C has no free lunch. **User decides the key + site.** |
| 2 | **New error code name + exact data fields** | **(a)** `CONFIG_BAD_NUMERIC_VALUE { key, source, value, reason }` — `value` is the read string (`''` for valueless), `reason` ∈ `{'invalid unit','out of range'[, 'bad zlib compression level']}`; render `bad numeric config value '<value>' for '<key>' in file <source>: <reason>` (UNquoted file). **(b)** `CONFIG_BAD_NUMERIC_VALUE { key, source }` only — hardcode `value: ''` + `reason: 'invalid unit'` in the renderer (valueless-only scope). **(c)** extend `CONFIG_MISSING_VALUE` with a `numeric?: true` discriminator instead of a new code. | **(a)** | (a) carries every byte the interop test reconstructs (value + reason vary across git's int suffixes) and leaves room for candidate 4 without reshaping; the field set mirrors git's message structure 1:1. (b) is minimal but can't represent `out of range` / non-empty-value rows, forcing a reshape the moment candidate 4 widens scope. (c) conflates two genuinely different git messages (different line count, prefix, file-token quoting, presence of `line`) — the same discriminated-union-clarity argument ADR-328 used to reject overloading `CONFIG_PARSE_ERROR`. The int shape has NO `line` field, unlike `CONFIG_MISSING_VALUE` — a structural mismatch. **User decides the name + fields.** |
| 3 | **Whether/where to HONOUR the valid level** (only meaningful for candidate 1=A; determines whether the prerequisite is genuinely "consumed") | **(a)** Honour on `NodeCompressor` only — widen the `Compressor` port `deflate(data, level?)`, NodeCompressor passes `{ level }`, memory+browser accept+ignore (CompressionStream has no level), `write-object.ts` passes `config.core?.looseCompression`. **(b)** Honour on ALL adapters that can — same, and additionally try a level-capable Web-Streams path on memory/browser if one exists (none does today → effectively (a)). **(c)** Do NOT honour — parse-and-refuse only; the key is read into `ParsedConfig` but its valid value never changes loose bytes. | **(a)** | Requirement 2 (the prerequisite must be GENUINELY consumed, not invented) is met by (a): a valid level changes real loose-object bytes on the production adapter, verified against git's pinned `78da`. The cross-adapter gap is faithful, not a divergence — loose disk bytes are explicitly out of contract (equivalence-under-readback), and memory/browser already produce a non-git level today; accepting+ignoring `level` preserves that exactly. (b) is (a) in practice (no level-capable Web-Streams API exists). (c) makes the key NOT actually consumed — it would parse a value that does nothing, hollowing the prerequisite and failing requirement 2 (the refusal would still work, but "genuinely-consumed int key" would be false). Recommend (a). **User decides whether/where to honour.** |
| 4 | **Int parser scope: which valued-invalid suffixes** | **(a)** Faithful parser (units k/m/g, `0x`, sign), refuse ONLY the valueless case (`invalid unit` on `''`); leave VALUED-but-invalid (`abc`, `2147483648` out-of-range, `99` zlib-range) as documented follow-ups. **(b)** Faithful parser + refuse ALL generic int-parse failures (`invalid unit` AND `out of range`), leave the key-specific `bad zlib compression level` range-check as a follow-up. **(c)** Full parity: `invalid unit` + `out of range` + `bad zlib compression level`, all three shapes. | **(b)** | 24.9s's named requirement is the valueless (`invalid unit`) shape; (a) delivers exactly that but ships a parser whose `out of range` branch is dead until a follow-up — a half-built total function. (b) makes the parser a COMPLETE faithful int parser (both generic numeric shapes), the natural unit for a "faithful int parser" primitive and a clean property-test target, deferring only the *consumer-specific* zlib range-check (a different concern from int parsing). (c) is fullest fidelity but couples the generic int primitive to one consumer's range rule and adds a third error shape — more than 24.9s needs. Recommend (b): a complete int parser, defer only the consumer-specific zlib check. **User decides the scope.** |
| 5 | **Backlog / ADR split for the bundled prerequisite** | **(a)** One ADR covering both halves (key choice + error shape), 24.9s checks off, NO new backlog entry. **(b)** Two ADRs — one for the prerequisite (int key + parser + honouring, decisions 1/3/4), one for the refusal (error shape, decision 2) — 24.9s checks off, prerequisite recorded as a sub-bullet. **(c)** Split into two backlog entries: a new prerequisite entry + 24.9s (the refusal), each its own PR. | **(b)** | The two halves are genuinely separable load-bearing decisions (the consuming-site choice is independent of the error shape), matching how 24.9l split detection (ADR-327) / error shape (ADR-328) / scope (ADR-329) into distinct ADRs — the house style. (a) under-records a real architectural decision (the FIRST int-typed config surface + a port change). (c) over-fragments delivery: the user explicitly chose to BUNDLE them in one change, so two PRs contradicts the brief. Recommend (b): two ADRs, one PR, 24.9s closes. **User decides the split.** |
| 6 | **Cross-class file-line ordering mechanism** (implementation-shape; only for candidate 1=A's eager gate) | **(a)** A new union-aware finder that scans `[core]` once and returns the first valueless entry plus which key-CLASS it is (string vs int), so the gate throws the matching shape. **(b)** Reuse `findFirstValuelessEntry` per class, compare the two results' `line`, throw the lower-line one's shape (tie impossible — distinct lines). **(c)** Accept a documented divergence: fixed string-then-int order (always reports the string key when both co-exist). | **(b)** | git reports the earlier-by-file-line `[core]` key across both classes (pinned: order A → string, order B → int). (b) reproduces this with ZERO new primitive — two existing finder calls + a `line` compare — and stays mutation-test-friendly. (a) is cleaner conceptually but adds a new finder paralleling the proven one for a rare co-existence case. (c) is a real refusal-condition divergence the prime directive forbids (order B would report the wrong key) — only acceptable if the co-existence case is judged impossible, which it is not. Recommend (b). **User decides (or ratifies the impl-shape in the plan).** |

## Consuming-site map (verified against worktree source)

For the recommended candidate A. Each `file:symbol` confirmed in this worktree.

- **Half-1 parse + field:**
  - `src/application/primitives/config-read.ts` — `ParsedConfig.core` (interface ~L10) gains
    `looseCompression?: number`; `MutableCore` / `MutableParsedConfig.core` / `finalizeCore` /
    `finalize`'s inline `out.core` shape (L934–L1153) mirror it; new `parseGitInt` alongside
    `parseGitBoolean` (~L1208); `applyCoreEntry` (~L949) gains the `loosecompression`/`compression`
    branch (NON-null → `parseGitInt`).
  - `reports/api.json` — regenerated for the new public `ParsedConfig.core.looseCompression` field
    (prepush `check:doc-typedoc` gate — see project memory "api.json prepush gate").
- **Half-1 valid-path honouring (if candidate 3 honours the level):**
  - `src/ports/compressor.ts` — `deflate: (data, level?) => Promise<Uint8Array>`.
  - `src/adapters/node/node-compressor.ts` L28 — `deflateSync(data, { level })`.
  - `src/adapters/memory/memory-compressor.ts` L18 / `src/adapters/browser/browser-compressor.ts` L13 —
    accept + ignore `level` (CompressionStream has no level; documented).
  - `src/application/primitives/write-object.ts` L35 — read `config.core?.looseCompression`, pass to
    `deflate`. **Only this site.** `build-pack.ts` L56 also calls `deflate`, but git's PACK path uses
    `pack.compression` (a DIFFERENT key), NOT `core.loosecompression` — so build-pack stays on the
    no-level `deflate` (passing the loose level there would be UNfaithful). Pack-level int keys are out of
    scope.
- **Half-2 refusal:**
  - `src/domain/commands/error.ts` — new `CONFIG_BAD_NUMERIC_VALUE` variant + `configBadNumericValue`
    factory (next to `CONFIG_MISSING_VALUE` ~L131 / `configMissingValue` ~L465).
  - `src/domain/error.ts` — render arm (~L393, next to `CONFIG_MISSING_VALUE`).
  - `src/application/primitives/internal/` — new int guard (sibling of `valueless-config-guard.ts`).
  - `src/application/primitives/internal/repo-state.ts` — wire the int keys into the eager gate
    (`assertNoValuelessCorePaths` L41 / `assertOperationalRepository` L51).

## Test strategy

### Interop pins (faithfulness — the load-bearing layer)

Extend `test/integration/missing-value-refusal-interop.test.ts` (24.9l/24.9r structure). For the chosen
key:

1. **git int-death pin** — hand-write a valueless `core.loosecompression` fixture into a fresh `mktemp`
   repo's `.git/config`; run a pinned operational command (`git status` / `git add <new>`) via
   `tryRunGit`; assert `g.ok === false`, exit 128, stderr is the SINGLE line, `grep -c '^error:'` is 0,
   contains `bad numeric config value ''`, `for 'core.loosecompression'`, `: invalid unit`, and does NOT
   contain `at line`.
2. **tsgit structured pin** — same fixture, drive a `[core]`-gated operational command
   (`repo.status`/`repo.log`/`repo.add`); try/catch + per-field `.data` assertions: `code ===
   'CONFIG_BAD_NUMERIC_VALUE'`, `key === 'core.loosecompression'`, `value === ''`, `reason === 'invalid
   unit'`, `source` matches `/\/config$/`. Mutation-resistant per-field, never bare `toThrow(Class)`.
3. **single-line reconstruction** — run both; reconstruct git's single line from tsgit's
   `{value,key,source,reason}` with the path-token normalization (UNquoted file token; reconstruct
   repo-relative `.git/config`) and assert byte equality, INCLUDING the absence of `error:`/`at line`.
4. **shape-distinctness from `CONFIG_MISSING_VALUE`** — a sibling fixture with a valueless STRING `[core]`
   key (`excludesfile`) on the same surface refuses `CONFIG_MISSING_VALUE` (two lines, quoted file,
   `at line`), while the int key refuses `CONFIG_BAD_NUMERIC_VALUE` (one line, unquoted file, no line) —
   pins the two coexisting shapes don't bleed.
5. **eager-broad breadth matrix** — with the valueless int fixture, assert MULTIPLE operational commands
   die in BOTH git and tsgit (at minimum `status`, `log`, and a ref-listing `branch`/`tag` — pinned in
   git's broad set), each with the right `{key,value,reason,source}`; and the config porcelain SURVIVES
   (`configList`/`configGet`/`configGetRegexp` exit-ok, the int key visible as `value: null`). This pins
   the operational-vs-porcelain split the eager gate must preserve.
6. **valid-path consumed behaviour** (if candidate 3 honours the level) — write a valid
   `core.loosecompression=9` fixture; `repo.add`/write a loose object via tsgit and via git; assert the
   loose object is readable cross-tool (equivalence-under-readback — the existing loose-object-interop
   contract) and, on NodeCompressor, the zlib header matches git's pinned `78da`. The absent case →
   default behaviour (no level set).
7. **absent-vs-valueless distinctness** — a `[core]` section with the int key ABSENT keeps the default
   (no refusal), proving the guard fires only on present-but-valueless.
8. **cross-class file-line ordering** (candidate 6) — a `[core]` fixture with BOTH a valueless string key
   (`excludesfile`) and a valueless int key (`loosecompression`), in EACH order, asserting tsgit reports
   the EARLIER-by-line key with ITS shape (string-first → `CONFIG_MISSING_VALUE` two-line; int-first →
   `CONFIG_BAD_NUMERIC_VALUE` one-line), matching real git. **Pinned (git 2.54.0, mktemp):** order A
   (`excludesfile` then `loosecompression`) → `error: missing value for 'core.excludesfile'` / `fatal: bad
   config variable 'core.excludesfile' … at line N`; order B (`loosecompression` then `excludesfile`) →
   `fatal: bad numeric config value '' for 'core.loosecompression' in file .git/config: invalid unit`.
   Both classes share `git_default_config`'s per-entry callback, so file-line order — not class — decides.

Follow the interop-helper isolation: isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing off, scrubbed
`GIT_*`. Latch the fixture line to a known position (line number is NOT in the int shape, but the
ordering fixture and the string-shape co-existence row both need deterministic lines). Reuse a shared
`beforeAll` repo where the matrix allows (project memory: heavy interop times out hooks under validate
concurrency).

### Unit tests

- **`parseGitInt`** (its own file) — drive the pinned table: decimal, `0x` hex, `+`/`-`, leading
  whitespace, units k/K/m/M/g/G (×1024^n), and the FAILURE rows (`5 `, `1kb`, `1.5`, `''` → `invalid
  unit`; out-of-range → `out of range` if candidate 4 (b)/(c)). Each failure asserts the thrown error's
  `.data` (`code`, `value`, `reason`) individually, isolated per row (mutation-resistant). Each guard
  condition (unit suffix vs trailing garbage vs empty) gets an isolated test.
- **`applyCoreEntry` / `ParsedConfig`** — valued int → `core.looseCompression` populated;
  `loosecompression` over `compression` precedence; valueless int → field absent (ADR-315 D4), NOT a
  parse-time throw (porcelain survival).
- **int guard + eager gate** — valueless int → `CONFIG_BAD_NUMERIC_VALUE` with the right
  `{key,value,reason,source}`; valued or absent int → no-op; an isolated test that the config porcelain
  path does NOT invoke the gate (`configList`/`configGet` succeed on the valueless fixture at the unit
  layer).
- **write-object** (if candidate 3 honours) — valid level threads to `deflate(data, level)`; absent →
  default. NodeCompressor honours; memory/browser accept+ignore (documented behaviour test). `build-pack`
  stays on no-level `deflate` (negative test: the loose level does NOT change pack bytes).

### Property tests

**Warranted for `parseGitInt`** — it is a **total function over an algebraic grammar** (lens 3 in the
CLAUDE.md four-lens test) and a **decode half** (lens 1 — git's value text → int). Ship a
`config-int.properties.test.ts` (or fold into the existing `config-read.properties.test.ts` family if that
is where number-grammar arbitraries belong) asserting:

- **Round-trip / decode invariant:** for an arbitrary in-range integer `n` rendered as a faithful git int
  string (decimal, optionally `0x`-hex, optionally a k/m/g suffix with the scaled value), `parseGitInt(s)
  === n` (modulo the documented scaling).
- **Totality over the safe subset:** `parseGitInt` over any ASCII string either returns a number OR throws
  `CONFIG_BAD_NUMERIC_VALUE` — never throws an unstructured error, never returns NaN.
- **Negative grammar:** an arbitrary string with a trailing non-unit byte, a multi-char unit, or no
  digits, throws `invalid unit`.

Tiered `numRuns` per the project budget (200 for the round-trip, 100 for totality, 50 for the
filter-heavy negative). Same describe/it / AAA / `sut` conventions; `Given an arbitrary integer string`.
Additive — never replaces the example table (which documents the literal pinned git encodings).

The refusal WIRING (guard placement, eager gate) is NOT a property target — it is command-site wiring
(covered by example + interop), same as 24.9l/24.9r.

## TDD slices

Ordered so each slice is green on its own and lands as one atomic conventional commit. Slice count and
exact shape depend on the ADR outcomes; the order below assumes the recommendations (candidate
1=A / 2=a / 3=a-honour / 4=b-scope / 6=b-ordering). The planner expands each with its full pre-chewed
context block.

1. **`feat(config): faithful git int parser`** — add `parseGitInt` to `config-read.ts` + the
   `CONFIG_BAD_NUMERIC_VALUE` error variant/factory (`domain/commands/error.ts`) and render arm
   (`domain/error.ts`), since `parseGitInt` throws it. Unit table + `config-int.properties.test.ts`.
   Context: `parseGitBoolean` (config-read.ts ~L1208) as the sibling pattern; `configMissingValue`
   (error.ts ~L465) as the factory precedent; render arm next to `CONFIG_MISSING_VALUE` (error.ts ~L393).
   Green: parser + error compile and pass with no consumer yet.
2. **`feat(config): parse core.loosecompression/compression into ParsedConfig`** — widen
   `ParsedConfig.core` (+ `MutableCore`, `finalizeCore`, `finalize`'s `out.core`), add the
   `applyCoreEntry` branch (NON-null → `parseGitInt`; precedence loosecompression > compression). Unit
   tests for valued/precedence/absent + valueless-merges-as-absent. Regenerate `reports/api.json`.
   Context: `applyCoreEntry` config-read.ts ~L949, `finalizeCore` ~L1128, api.json prepush gate.
   Green: field populates; porcelain unaffected.
3. **`feat(config): refuse valueless int core path on the operational surface`** — add the int guard
   (sibling of `valueless-config-guard.ts`) reusing `findFirstValuelessEntry`, wire it into the eager gate
   with cross-class file-line ordering vs the existing string keys (candidate 6 mechanism — two finder
   calls + `line` compare, throw the lower-line shape). Unit tests (valueless → throw, valued/absent →
   no-op, porcelain bypass, cross-class ordering both directions) + the interop pins (death shape,
   reconstruction, breadth matrix, shape-distinctness, absent distinctness, cross-class ordering). Context:
   existing eager gate `repo-state.ts` L41–L55; `assertNoValuelessConfig`/`findFirstValuelessEntry`;
   interop structure in `missing-value-refusal-interop.test.ts`.
   Green: refusal fires on the pinned surface in file-line order, porcelain survives.
4. **`feat(config): honour core.loosecompression at loose-object write`** *(only if candidate 3 honours
   the valid level)* — widen the `Compressor` port `deflate(data, level?)`, NodeCompressor honours,
   memory/browser accept+ignore, `write-object.ts` passes `config.core?.looseCompression` (build-pack
   stays no-level). Unit + the valid-path interop pin (header `78da`, equivalence-under-readback). Context:
   compressor.ts L9, node-compressor.ts L28, memory/browser compressors, write-object.ts L35.
   Green: valid level honoured on Node; readback parity preserved everywhere.

(If candidate 4 = (a), slice 1's parser ships only the `invalid unit` branch; if (c), an extra slice adds
the `bad zlib compression level` range-check + third reason. If candidate 3 = (c) no-honour, slice 4 is
dropped (the field is parsed but unconsumed — note this fails requirement 2). If candidate 1 = B, slices
2–4 are replaced by a repo-open version-read gate + `Expected git repo version` validation — a different
slice set the planner derives from the B pins.)

## Out of scope

- **Valued-but-invalid int refusal** — `abc`/`99`/`2147483648` (the `out of range` and `bad zlib
  compression level` shapes) are scoped by candidate 4; under the recommendation (b) the parser handles
  `out of range` but the key-specific `bad zlib compression level` zlib-range check is a documented
  follow-up (it is a consumer-specific validation, not int parsing).
- **Honouring the level on the memory/browser adapters** — `CompressionStream('deflate')` has no level
  parameter; those adapters accept-and-ignore, consistent with the existing equivalence-under-readback
  contract for loose objects. Byte-level parity across all adapters is not a faithfulness requirement
  (loose disk bytes are out of contract — `loose-object-interop.test.ts` L4).
- **Pack-write compression level** — `build-pack.ts` also calls `deflate`; whether pack entries honour
  `core.loosecompression`/`pack.compression` is a separate behaviour (git uses `pack.compression`, a
  DIFFERENT key). This change touches only the loose-write level; pack-level int keys are not introduced.
- **Other int-typed config keys** — `core.bigFileThreshold`, `core.abbrev`, `gc.*`, `pack.*`,
  fetch `depth`, etc. stay unparsed (lenient) until a consuming site needs them; their int valueless
  refusal would each be a new guard call on the proven pattern.
- **`core.repositoryformatversion` validation** (the `Expected git repo version` shape) — only relevant if
  candidate 1 = B; otherwise out (tsgit does not enforce repo format today).
- **The string-typed mechanism / error shape** — fixed by ADRs 327/328 and unchanged; the int shape is a
  PARALLEL code, not a reshaping of `CONFIG_MISSING_VALUE`.
- **Writing valueless int entries** — git's CLI cannot; not a surface (ADR-314/315 D5).
