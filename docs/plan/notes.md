# Plan — `notes` (add / read / list / remove)

> Source: design doc `docs/design/notes.md` · ADRs 431, 432, 433
> The plan is the implementation script AND the knowledge handoff. Part agents start
> with zero context: whatever a part block omits is paid later as agent rediscovery.
> `plan-lint.sh` enforces the schema below — the plan phase cannot close without it.

## Sizing rules

- Every part costs a full agent lifecycle (spin-up, zero-context rebuild, gate) — it
  must earn it. No standalone test-only parts for FEATURE code: coverage/interop/property
  tests fold into the implementation part whose code they exercise. EXCEPTION:
  test-infra-only and docs-only parts (tooling config, test helpers, fixtures,
  harness/property suites, docs/prose) with no `src/` delta ARE standalone — they have no
  implementation part to fold into.
- A part that would be a pure test pass over already-landed code merges into its
  neighbour.

## Plan-wide notes (read before any part)

- **Layering is strict** (`check:architecture` gate). `domain/notes/*` is PURE — it may
  import only other `domain/*` (it imports `domain/objects` for `TreeEntry` / `ObjectId` /
  `FileMode` / `sortTreeEntries`), zero `ports`/`application`/platform deps; lazy-subtree
  I/O is injected as a caller-supplied **reader callback** so the module stays pure (ADR-432
  §11.10). The new env **port** lives in `src/ports/`; the bridge **primitives**
  (`load-notes-tree`, `write-notes-tree`) live in `src/application/primitives/` (may import
  `domain` + `ports` + sibling primitives); the **verbs** + namespace binder live in
  `src/application/commands/`; the **facade** is `src/repository.ts`. Domain never imports
  outward.
- **Per-part gate is the light triple** (`npx vitest run <touched> && npm run check:types &&
  biome check <touched>`). The full `npm run validate` (which includes `check:dead-code`,
  `check:exports`, `check:architecture`, `test:coverage`, `test:integration`, `test:parity`,
  `check:doc-coverage`, browser-surface) runs only at the **phase boundary**. Because
  `check:dead-code`/`check:exports` are in validate, a foundation part (P1/P2/P3) may carry
  an export whose only in-`src` consumer lands in a later part — that is red only at phase
  end, not at the part boundary. By P5 every export is wired, so phase-boundary validate is
  green.
- **`reports/api.json` is a `prepush` gate, not a validate gate** — regenerated **once**,
  in P5 (the part that makes the public surface final), via `npm run docs:json` and committed.
  Earlier parts that add public surface (the two NOTES error codes in P3, the new `EnvReader`
  port type in P2, the verb types in P4) do NOT regenerate it — one P5 regen captures
  everything (the huge typedoc-id diff is normal — see MEMORY `api.json prepush gate`).
- **Three design-prose corrections the implementer must honour over the design text**
  (verified in the worktree NOW; the design predates these code facts):
  1. **`core.notesRef` is NOT a typed `ParsedConfig` field, and there is no
     `readConfigEntry`/`loadConfigEntry` single-key getter** (design §2/§7/§10 names them —
     they do not exist). The real reader is `readConfig(ctx) → ParsedConfig`
     (`src/application/primitives/config-read.ts`), whose `core` subset is a fixed typed set
     (`excludesFile`, `hooksPath`, `attributesFile`, …). P3 **extends** that subset with
     `notesRef?: string` and wires `applyCoreEntry` (the `if (lowered === 'notesref') return
     { ...core, notesRef: value };` branch, mirroring `excludesFile`). Reading
     `(await readConfig(ctx)).core?.notesRef` is then the `core.notesRef` source.
  2. **`resolveRef(ctx, name) → Promise<ObjectId>`** (a function that throws `REF_NOT_FOUND`
     when absent), NOT an async generator. `tagCreate` (`src/application/commands/tag.ts`)
     resolves its target as `const id = /^[0-9a-f]{40}$/.test(target) ? (target as ObjectId)
     : await resolveRef(ctx, target as RefName);` — the notes verbs resolve `object` exactly
     this way (oid-regex else `resolveRef`); short oids / rev-expressions are out of scope by
     design.
  3. **`notes.add`/`remove` take NO identity/date input** (surface §6) — the notes commit's
     author==committer==date come from `resolveCurrentIdentity(ctx)`
     (`src/application/commands/internal/current-identity.ts`), which reads the system clock
     (`Math.floor(Date.now()/1000)`) and hardcodes tz `'+0000'`. So unlike `commit-interop`
     (which pins the date by passing an explicit dated `AuthorIdentity` into `createCommit`),
     the notes interop test (P6) pins tsgit's commit date by **faking `Date`**
     (`vi.useFakeTimers({ toFake: ['Date'] })` + `vi.setSystemTime(...)`, leaving real timers
     for the spawned `git` subprocess) and matching `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`.
     Tree-oid and blob-oid assertions need no clock pin (timestamp-free).
- **Faithfulness authority order**: design §11 + the clean-room fanout spec are the algorithm;
  the **real `git` 2.54.0 interop suite (P6) is the ground truth**. If the implementation and
  the prose ever disagree at a SHA, follow real `git` and fix the code, never the test
  (ADR-226 / ADR-432 §11.11). The library emits NO rendered strings (ADR-249) — interop
  reconstructs git's stdout/stderr from the structured fields.

## Decision-candidates — RESOLVED

All load-bearing product forks were ratified in ADRs 431 (surface, `read`→`null`, inline
bytes, `force` boolean, `Uint8Array`, the two error codes), 432 (full faithful fanout at all
N, reading+writing), and 433 (ref precedence explicit → `GIT_NOTES_REF` → `core.notesRef` →
default, via a new minimal `Context` env capability). No open product fork remains. Three
**implementation-only** clarifications the planner resolved (behaviour-identical, no product
fork — flagged for transparency, not decision):

- **Env capability shape** — mirror the cited `command?: CommandRunner` precedent EXACTLY:
  optional `env?: EnvReader` on `Context`/`CreateContextParts`, real `NodeEnvReader` in the
  node adapter, **pass-through option** on the memory adapter (for unit testability), **absent**
  on browser. No always-undefined "stub class" is introduced (design §8.2's "browser/memory
  stub" wording reconciles to "field absent" — identical observable outcome: `GIT_NOTES_REF`
  is always unset there — and is the minimal surface ADR-433's consequences ask the
  architecture pass to favour). Verb reads `ctx.env?.get('GIT_NOTES_REF')` (optional-chaining
  ⇒ `undefined` when absent).
- **`core.notesRef` reader** — extend the typed `ParsedConfig.core` (plan-wide note 1), the
  faithful + minimal mechanism in this codebase.
- **Interop clock pin** — fake `Date` only (plan-wide note 3).

---

## Part 1 — Domain notes fanout trie (pure 16-way nibble-trie + `determineFanout`)

### Context

The riskiest, most self-contained part: an ORIGINAL TypeScript reimplementation of git's
notes nibble-trie + fanout heuristic (ADR-432; clean-room — `notes.c` read only to understand
behaviour, no source copied — §11.11). PURE domain, zero platform deps; lazy-subtree loading
is a **caller-supplied async reader callback**. The authority is design §11 (read it in full)
plus the clean-room spec; this block is the implementation contract.

New files under `src/domain/notes/` (split for <20-line functions / cohesion):

- `types.ts` — node + plan types. Reuse `TreeEntry` (`{ mode: FileMode; name: string; id:
  ObjectId }`), `FileMode`, `sortTreeEntries` from `../objects/tree.js`; `ObjectId` from
  `../objects/object-id.js`. Declare:
  - `export type SubtreeReader = (oid: ObjectId) => Promise<ReadonlyArray<TreeEntry>>;`
  - a slot discriminated union: `EMPTY` | `{ kind: 'note'; key: ObjectId; val: ObjectId }`
    (NOTE leaf — `key` = full-hex annotated oid, `val` = note-blob oid) |
    `{ kind: 'subtree'; prefix: string; oid: ObjectId }` (lazy on-disk fanout dir — `prefix`
    = consumed hex, `oid` = its tree oid) | `{ kind: 'internal'; node: NotesTrie }`.
  - `export interface NotesTrie { readonly slots: ReadonlyArray<Slot>; /* length 16 */
    readonly preserved: ReadonlyArray<TreeEntry>; }` — `preserved` carries the §11.3 non-note
    entries at this level (verbatim, re-emitted unchanged).
  - `export interface WritePlan { readonly entries: ReadonlyArray<WritePlanEntry>; }` and
    `export interface WritePlanEntry { readonly name: string; readonly mode: FileMode; readonly
    oid?: ObjectId; readonly child?: WritePlan; }` — ONE tree level, UNSORTED (the bridge sorts
    via `sortTreeEntries`). `oid` present for notes (mode `'100644'`) and REUSED lazy subtrees
    (mode `'040000'`); `child` present for fanout dirs the bridge must write first.
- `fanout.ts` —
  - `export const determineFanout = (node: NotesTrie, n: number, fanout: number): number` —
    the heart (§11.6): if `n` is **odd** OR `n > 2 * fanout` → return `fanout`; else if **every**
    of the 16 slots is `subtree` or `internal` → `fanout + 1`; else `fanout`.
  - `export const constructPathWithFanout = (oid: ObjectId, fanout: number): string` — the
    first `fanout` bytes (2 hex each) become `XX/` directory components, the rest is remaining
    hex (§11.8). `fanout = 0` → full 40-hex; `1` → `ab/<38>`; `2` → `ab/cd/<36>`.
  - `export const parseFanoutPath = (path: string): ObjectId` — inverse: strip `/` and brand
    via `ObjectId.from` (used by `list`'s de-slash and the round-trip property).
  - Name a constant `HEX_OID_LENGTH` from `ctx.hashConfig`? NO — domain is hashConfig-free;
    derive the full-hex length from the entry data at load (`prefix.length + name.length`), and
    in `constructPathWithFanout` from `oid.length`. No magic `40`.
- `load.ts` —
  `export const loadTrieRoot = (entries: ReadonlyArray<TreeEntry>): NotesTrie` — classify each
  root entry (§11.2), building only THIS level (subtrees stay lazy placeholders — never read
  here): blob whose `prefix('')+name` is full-hex → NOTE in slot `nibble(name[0])`; a directory
  (`mode '040000'`) whose name is exactly 2 hex chars → SUBTREE placeholder in slot
  `nibble(name[0])` with `prefix = name`, `oid = entry.id`; anything else → push to `preserved`.
  (A future-proof note: a single-level root may legitimately hold colliding-nibble notes only
  as NOTE/SUBTREE — never two notes in one slot on disk, because git wrote a subtree there;
  loadTrieRoot mirrors the on-disk shape exactly.)
- `mutate.ts` (all PURE, return a NEW trie — immutability; structural recursion returning new
  nodes):
  - `export const createEmptyTrie = (): NotesTrie`.
  - `export const insert = (trie: NotesTrie, key: ObjectId, val: ObjectId, read: SubtreeReader,
    n?: number): Promise<NotesTrie>` — walk nibbles from `n=0` (§11.4): empty → place NOTE;
    NOTE same key → overwrite `val` (git `combine_notes_overwrite`; the no-force refusal is
    raised earlier in the verb); NOTE different key → **split** into an INTERNAL, demote the
    existing note at `nibble(n+1)`, recurse the new note; INTERNAL → recurse `n+1`; SUBTREE →
    unpack via `read` (build that subtree's level via `loadTrieRoot`-style classification at the
    consumed prefix), replace the slot with the loaded INTERNAL, retry.
  - `export const remove = (trie: NotesTrie, key: ObjectId, read: SubtreeReader, n?: number):
    Promise<NotesTrie>` — drop the NOTE; then **consolidate walking up** (§11.5): an INTERNAL
    holding ≤1 non-empty slot AND no `preserved` collapses into that single entry at its parent.
    Consolidation only touches nodes ALONG THE LOADED PATH — untouched SUBTREE siblings stay
    lazy (the stickiness mechanism). Removing an absent key returns the trie unchanged (the verb
    decides the refusal).
  - `export const lookup = (trie: NotesTrie, key: ObjectId, read: SubtreeReader, n?: number):
    Promise<ObjectId | undefined>` — fanout-aware descent over `key`'s nibbles, unpacking
    SUBTREE via `read`; returns the note-blob oid or `undefined`.
- `write-plan.ts` —
  `export const planWrite = (trie: NotesTrie, read: SubtreeReader, n?: number, fanout?: number):
  Promise<WritePlan>` — the §11.7 walk-for-write. **Fanout is PER-SUBTREE and threaded** (§11.6
  "Recurses per subtree"): at each node compute `F = determineFanout(node, n, fanout)` and use
  THAT `F` for this node's leaf naming AND pass it DOWN to children (a child INTERNAL may
  increment again) — NOT a single global fanout. For each slot: INTERNAL → recurse
  `planWrite(child, n+1, F)` (pass the computed `F`) and splice its result into the CURRENT
  level under the right path component(s); NOTE → emit `{ name: constructPathWithFanout(key, F),
  mode: '100644', oid: val }`; SUBTREE → if `n < 2*F` emit the reused dir as a single 2-hex
  segment `{ name: <last byte of prefix>, mode: '040000', oid }` (reuse the on-disk oid as-is,
  lazy — never read); if `n >= 2*F` unpack via `read` and re-process the slot; plus every
  `preserved` entry emitted unchanged at this level. This mirrors git's `write_notes_tree` =
  `for_each_note` collecting `(construct_path_with_fanout(key, F), oid)` pairs then a path-tree
  builder — so the faithful primary form is a flat per-level `WritePlan` whose multi-segment
  note names (`ab/cd/rest`) the BRIDGE groups by `/` into nested trees, with `F` already baked
  into the path. (The `child` field exists for an equivalent explicitly-nested reformulation;
  pick whichever keeps each function <20 lines and document the choice in a `why` comment. Either
  is validated byte-for-byte by P6.)
- `index.ts` — internal barrel re-exporting the types + functions. **NOT** wired into the
  package entry (`src/index.ts`) — these stay library-internal (consumed only by P3's bridge).

**Public-surface decision.** The entire `src/domain/notes/` module is **INTERNAL** (no package-
entry re-export, no facade, no error code). It trips NO surface gate. It is exercised only by
its own unit/property tests here and by P3's bridge primitives.

Tests (fold in) — `src/domain/notes/` is under the **100% line/branch/function coverage** gate
(domain) AND Stryker mutation; write isolated, data-asserting tests (CLAUDE test patterns):

- `fanout.test.ts` (example): `determineFanout` truth table with ISOLATED tests per guard
  (each kills a distinct mutant): `n` odd returns `fanout` even when all 16 are branches; `n >
  2*fanout` returns `fanout`; `n` even & `n <= 2*fanout` with all 16 `subtree`/`internal` →
  `fanout+1`; same but ONE slot empty → `fanout`; same but ONE slot a NOTE → `fanout`.
  `constructPathWithFanout` for fanout 0/1/2 (exact strings); `parseFanoutPath` inverse.
- `load.test.ts`: a hand-built `TreeEntry[]` mixing a full-hex blob (→ NOTE in the right slot),
  a 2-hex `'040000'` dir (→ SUBTREE placeholder, prefix=name, lazy — assert `read` was NOT
  called), and a `README` blob + a non-hex dir (→ `preserved`, verbatim).
- `mutate.test.ts`: insert into empty (lookup finds it); insert two keys sharing the first k
  nibbles → split nests down to the first differing nibble (lookup both); overwrite same key →
  `val` replaced (lookup returns new); remove a colliding pair member → consolidates back to a
  single NOTE at the parent; **stickiness**: a node with 15 SUBTREE placeholders + 1 INTERNAL
  holding one note → `determineFanout` returns `fanout+1` (stays fanned) and `planWrite` emits
  the 15 subtrees reusing their on-disk oids (assert `read` NOT called on the untouched 15).
  Use a fake `SubtreeReader` test double; assert call/no-call to kill laziness mutants.
- `<module>.properties.test.ts` + `arbitraries.ts` (ADR-136 lenses 1+3+4):
  - **Round-trip (lens 1, `numRuns: 200`)** — arbitrary 40-hex oid + `fanout ∈ {0,1,2}`:
    `parseFanoutPath(constructPathWithFanout(oid, fanout)) ≡ oid`.
  - **Load totality + non-note preservation (lens 3, `numRuns: 100`)** — arbitrary well-formed
    root `TreeEntry[]` (full-hex note blobs, 2-hex fanout dirs, arbitrary non-note entries):
    `loadTrieRoot` never throws; every non-note entry appears verbatim in `preserved`; NOTE-slot
    count == full-hex-blob count.
  - **Insert/emit count invariant (lens 4, `numRuns: 100`)** — inserting K distinct
    `(oid→blob)` into the empty trie then `planWrite` (with a never-called reader) emits exactly
    K note entries.
  `Given an arbitrary …` describe phrasing; never commit a seed.

### TDD steps

- RED: write `fanout.test.ts` (truth table + path round-trip) → fails (module missing).
- RED: write `load.test.ts` + `mutate.test.ts` (split / overwrite / consolidate / stickiness)
  → fail.
- GREEN: implement `types.ts`, `fanout.ts`, `load.ts`, `mutate.ts`, `write-plan.ts`, `index.ts`;
  make the example tests pass. Keep every function <20 lines, early returns, no nesting >2, no
  magic numbers, immutable updates (return new nodes).
- RED→GREEN: add the three property files + `arbitraries.ts`; make them pass (shrink any
  counterexample → fix code, not test).
- REFACTOR: extract a `nibbleAt(hex, n)` helper and a shared `classifyEntry` used by both
  `loadTrieRoot` and the SUBTREE-unpack in `insert`/`lookup`/`planWrite`; confirm 100% coverage
  + zero surviving mutants (triage suspected false survivors per `.claude/workflow/mutation.md`
  before writing kill tests — equivalent loop-bound mutants documented, not contrived).

### Gate

`npx vitest run src/domain/notes && npm run check:types && ./node_modules/.bin/biome check src/domain/notes`

### Commit

`feat: notes fanout nibble-trie domain`

## Part 2 — Environment-read port + node adapter + `Context` wiring + contract test

### Context

The minimal env capability ADR-433 introduces, mirroring the established `command?:
CommandRunner` optional-capability pattern EXACTLY (`src/ports/command-runner.ts` +
`src/ports/context.ts` + the three adapters). Scoped to a single named-var read — NOT a general
env bag.

- **Port** — new `src/ports/env-reader.ts`:
  ```ts
  export interface EnvReader {
    /** A single named environment variable's value, or `undefined` when unset. */
    readonly get: (name: string) => string | undefined;
  }
  ```
- **Ports barrel** — `src/ports/index.ts`: add `export type { EnvReader } from './env-reader.js';`
  (alphabetical — between the `DirEntry/FileStat/FileSystem` line and `GenerationView`).
- **`Context` + `CreateContextParts`** — `src/ports/context.ts`: add
  `readonly env?: EnvReader;` to BOTH interfaces (place next to `readonly command?:
  CommandRunner;` at `Context` lines ~121-126 and `CreateContextParts` line ~157), with a doc
  comment: `/** Optional environment-variable reader. Absent ⇒ every variable is unset (browser /
  memory, where there is no process env). Notes-ref selection reads GIT_NOTES_REF through it. */`.
  Import `EnvReader` from `./env-reader.js`.
- **Node adapter** — new `src/adapters/node/node-env-reader.ts`:
  ```ts
  import type { EnvReader } from '../../ports/env-reader.js';
  export class NodeEnvReader implements EnvReader {
    get(name: string): string | undefined { return process.env[name]; }
  }
  ```
  Wire it in `src/adapters/node/node-adapter.ts` in the `CreateContextParts` object literal,
  next to `command: new NodeCommandRunner(),` → add `env: new NodeEnvReader(),` (import the
  class).
- **Memory adapter** — `src/adapters/memory/memory-adapter.ts`: mirror the `command` option
  pass-through — add `...(options.env !== undefined ? { env: options.env } : {})` to the `parts`
  object, and add `readonly env?: EnvReader;` to `MemoryAdapterOptions` (wherever `command?:
  CommandRunner` sits in that options type; import `EnvReader`). This is the testability hook —
  a memory repo can be created with a fake env reader to exercise the `GIT_NOTES_REF` precedence
  branch in P4's command tests.
- **Browser adapter** — `src/adapters/browser/browser-adapter.ts`: leave `env` ABSENT (exactly
  as it leaves `command` absent — no process env in the browser). No code change beyond a one-line
  `why` comment if useful. (Faithful "unset".)

**Public-surface decision.** `EnvReader` is **PUBLIC** (exported from the ports barrel and
reachable via `Context`). Its surface gate is the ports barrel (paid here). It changes
`reports/api.json` — that regen is DEFERRED to P5 (single regen; plan-wide note). No
facade/command/doc-coverage gate (it is a port type, not a Tier-1 command).

Tests (fold in) — adapters are under the **100% coverage** gate; the contract proves the narrow
port:

- `test/unit/ports/env-reader.contract.ts` — the `compressorContractTests` shape:
  ```ts
  export function envReaderContractTests(createSut: () => EnvReader): void {
    describe('EnvReader contract', () => { /* Given/When/Then, AAA, sut */ });
  }
  ```
  Universal assertions (hold for every adapter): reading an UNSET name → `undefined`; `get`
  never throws for any string name (including `''`). (The "present → value" assertion is
  node-specific and lives in the node test, since only a real process env can be set.)
- `test/unit/adapters/node/node-env-reader.test.ts` — `import { envReaderContractTests }` and
  run it with `() => new NodeEnvReader()`; PLUS a node-only block: set a temp `process.env` key
  in `beforeEach`/`afterEach` (restore it) and assert `sut.get(key)` returns the set value, and
  a deliberately-absent key returns `undefined`. Isolated assertions; restore env in `afterEach`
  (no swallowed state).

### TDD steps

- RED: write `env-reader.contract.ts` + `node-env-reader.test.ts` → fail (`EnvReader` /
  `NodeEnvReader` missing; `check:types` red on the missing module).
- GREEN: add `env-reader.ts`, the ports-barrel export, the `Context`/`CreateContextParts`
  fields, `NodeEnvReader`, the node-adapter wiring, the memory-adapter option pass-through →
  tests pass.
- REFACTOR: confirm `NodeEnvReader` is a 3-line class (no nesting); confirm the memory option
  spread matches the `command` precedent byte-for-byte; 100% coverage on the new adapter.

### Gate

`npx vitest run test/unit/ports/env-reader.contract.ts test/unit/adapters/node/node-env-reader.test.ts && npm run check:types && ./node_modules/.bin/biome check src/ports/env-reader.ts src/ports/index.ts src/ports/context.ts src/adapters/node/node-env-reader.ts src/adapters/node/node-adapter.ts src/adapters/memory/memory-adapter.ts`

### Commit

`feat: environment-read port and node adapter`

## Part 3 — Notes error codes, `core.notesRef` config, ref-selection, bridge primitives

### Context

The application-tier foundations the verbs (P4) compose: the two refusal codes, the
`core.notesRef` config read, the §10 ref-selection precedence, and the two ctx-aware bridge
primitives that join the pure trie (P1) to the object store.

**Error codes** — `src/domain/commands/error.ts` (the `CommandError` union + factories;
`TsgitError` from `../error.js`, `ObjectId` from `../objects/object-id.js`):
- Add two union members (place near the other read/refusal members, e.g. after the
  `CANNOT_DESCRIBE` / before the `BUNDLE_*` block):
  - `{ readonly code: 'NOTES_ALREADY_EXIST'; readonly object: ObjectId }`
  - `{ readonly code: 'NOTES_OBJECT_HAS_NONE'; readonly object: ObjectId }`
- Add factories (one-liners; `object` is a validated 40-hex oid → embed verbatim, no sanitise):
  - `export const notesAlreadyExist = (object: ObjectId): TsgitError =>` `new TsgitError({ code:
    'NOTES_ALREADY_EXIST', object });`
  - `export const notesObjectHasNone = (object: ObjectId): TsgitError =>` `new TsgitError({ code:
    'NOTES_OBJECT_HAS_NONE', object });`
- **Exhaustiveness (TWO switches — both compile-gated; omitting either is a `check:types`
  error):**
  1. `test/unit/domain/exhaustiveness.ts` — add `case 'NOTES_ALREADY_EXIST':` and `case
     'NOTES_OBJECT_HAS_NONE':` arms before the `return;` in `assertExhaustiveSwitch(data:
     TsgitErrorData)`.
  2. `src/domain/error.ts` — add arms to the `extractDetail(data: TsgitErrorData)` switch (the
     display/`message` renderer, ~line 161). The returned detail is library-internal diagnostic
     text (NOT git porcelain — ADR-249); make it a faithful-ish structured summary, e.g.
     `NOTES_ALREADY_EXIST` → `` `notes already exist for object ${data.object}` ``;
     `NOTES_OBJECT_HAS_NONE` → `` `object ${data.object} has no note` ``. (No `error:` prefix —
     callers reconstruct git's exact §4.4 lines from `.data`.)

**Config `core.notesRef`** — `src/application/primitives/config-read.ts` (plan-wide note 1):
- Add `readonly notesRef?: string;` to the `core` subset interface (~line 13, alphabetical with
  `excludesFile`/`hooksPath`) AND to the mutable `core` accumulator type (~line 1024).
- In `applyCoreEntry`, add the branch (mirroring `excludesFile`/`hooksPath` — string value,
  taken verbatim): `if (lowered === 'notesref') return { ...core, notesRef: value };`. (`value`
  is the parsed config value; an absent key never reaches here → `core.notesRef` stays
  `undefined`.)

**Ref selection** — new `src/application/commands/internal/notes-ref.ts`:
```ts
export const DEFAULT_NOTES_REF = 'refs/notes/commits' as RefName;
export const resolveNotesRef = async (ctx: Context, explicit?: string): Promise<RefName>;
```
Precedence (§10, ADR-433): if `explicit` defined → use it; else `ctx.env?.get('GIT_NOTES_REF')`
if defined → use it; else `(await readConfig(ctx)).core?.notesRef` if defined → use it; else
`DEFAULT_NOTES_REF`. The chosen string (from ANY source) is **validated** before return:
`validateRefName(name as RefName)` (`src/domain/refs/ref-validation.ts` — throws the existing
`INVALID_REF` on a bad value), then return it branded. "Present" for the env/config sources
means **defined** (`string | undefined`) — an unset `GIT_NOTES_REF` falls through (faithful
"no such variable"). Isolated early-returns, no nesting >2.

**Bridge primitives** (`src/application/primitives/`; import `readObject` from `./read-object.js`,
`writeTree` from `./write-tree.js`, `resolveRef` from `./resolve-ref.js`, the P1 domain trie from
`../../domain/notes/index.js`, `sortTreeEntries` + `TreeEntry` from `../../domain/objects/…`,
`REF_NOT_FOUND` / object error shapes from the domain object error module):
- `load-notes-tree.ts`:
  ```ts
  export interface LoadedNotesTree {
    readonly trie: NotesTrie;
    readonly readSubtree: SubtreeReader;       // (oid) => (readObject(ctx, oid) as Tree).entries
    readonly parentCommit?: ObjectId;          // previous notes-ref commit, for the parent chain
  }
  export const loadNotesTree = (ctx: Context, ref: RefName): Promise<LoadedNotesTree>;
  ```
  Resolve `ref` via `resolveRef`; **catch `REF_NOT_FOUND` only** → `{ trie: createEmptyTrie(),
  readSubtree, parentCommit: undefined }` (rethrow anything else — no swallow). Else
  `parentCommit = commitOid`; read the commit (`readObject`), read its `data.tree`, read the
  tree's `entries`, `trie = loadTrieRoot(entries)`. `readSubtree(oid)` = `(await readObject(ctx,
  oid) as Tree).entries` (type-narrow; a non-tree here is store corruption → let the existing
  `UNEXPECTED_OBJECT_TYPE` propagate).
- `write-notes-tree.ts`:
  ```ts
  export const writeNotesTree = (ctx: Context, loaded: LoadedNotesTree): Promise<ObjectId>;
  ```
  `plan = await planWrite(loaded.trie, loaded.readSubtree)`; then build trees **bottom-up**: a
  local recursive `materialise(plan): Promise<ObjectId>` groups the flat plan entries by their
  first path segment — leaf (single-segment note / reused-subtree / preserved) entries become
  `TreeEntry { mode, name, id }` directly; multi-segment note names (`ab/cd/rest`) and `child`
  plans recurse into a sub-`WritePlan`, `materialise` it to a child oid, and add a `{ mode:
  '040000', name: segment, id: childOid }` entry — then `writeTree(ctx, sortTreeEntries(entries))`
  and return its oid. The empty plan → `writeTree(ctx, [])` = the empty-tree oid
  `4b825dc642cb6eb9a060e54bf8d69288fbee4904` (§4.3). (Confirm no pre-existing nested-tree writer
  to reuse — none was found in `src/application/primitives/`; if one surfaces, DRY against it.)

**Public-surface decision.** The two NOTES error codes are **PUBLIC** (exported `CommandError`/
`TsgitErrorData` union members) → they trip BOTH exhaustiveness switches (pre-paid here) and
change `reports/api.json` (regenerated once in P5, NOT here). `resolveNotesRef`,
`DEFAULT_NOTES_REF`, `loadNotesTree`, `writeNotesTree` are **INTERNAL** (imported by P4's verbs;
no barrel/facade entry). `core.notesRef` is an internal config field. No Tier-1 / doc-coverage /
browser gate fires here.

Tests (fold in) — `error.ts` is domain (**100% coverage**); `config-read`/`notes-ref`/bridge are
app-tier (outside line-coverage, under Stryker — isolated, data-asserting, kill mutants):

- `test/unit/domain/commands/error.test.ts` — per-factory `.data`-shape tests for
  `notesAlreadyExist` / `notesObjectHasNone` (full `.data` object: `code` + `object`), mirroring
  the existing `Given the <factory> error helper` blocks. The two exhaustiveness `case` arms are
  covered by the existing exhaustiveness test asserting `assertExhaustiveSwitch`.
- `src/application/commands/internal/notes-ref.test.ts` (colocated with its source) —
  `resolveNotesRef` precedence with ONE isolated test per level (each kills a fall-through
  mutant): explicit wins
  over a set env + config; env wins over config + default (inject via a memory repo created with
  a fake `EnvReader` option, or a hand-built `Context` with `env`); config wins over default;
  unset-everywhere → `DEFAULT_NOTES_REF`; an invalid value (from each source) → `INVALID_REF`
  (try/catch + `.data.code`).
- `load-notes-tree.test.ts` / `write-notes-tree.test.ts` (in-memory repos via the memory
  adapter): build a flat single-note tree by hand (`writeObject` a blob, `writeTree` a flat
  `TreeEntry`, `createCommit`, `updateRef`) → `loadNotesTree` → `lookup` finds the note,
  `parentCommit` = the commit; absent ref → empty trie + `parentCommit` undefined. Round-trip:
  `loadNotesTree` → `writeNotesTree` of an unchanged trie reproduces the SAME tree oid
  (idempotence — kills sort/grouping mutants); an empty trie → the empty-tree oid. A bridge
  round-trip **property** (lens 1, `numRuns: 100`) is appropriate here (load↔write of an
  arbitrary small flat note-set reproduces the tree oid) — add it as `write-notes-tree.properties
  .test.ts` if it is not a tautology; otherwise the example round-trips suffice.

### TDD steps

- RED: write the two error-factory `.data` tests + add the two exhaustiveness arms in BOTH
  switches → factory tests fail (undefined) and `check:types` fails until the union members +
  both switch arms exist.
- RED: write `notes-ref.test.ts` (5 isolated precedence/validation tests) → fail.
- RED: write the bridge load/write tests (lookup, parentCommit, round-trip, empty-tree) → fail.
- GREEN: add the union members + factories; add both exhaustiveness arms; extend
  `config-read.ts` (`core.notesRef`); implement `notes-ref.ts`, `load-notes-tree.ts`,
  `write-notes-tree.ts` → all pass.
- REFACTOR: keep `resolveNotesRef` a flat early-return ladder; extract `materialise` in
  `writeNotesTree` (<20 lines, nesting ≤2); no mutable shared state beyond the local recursion;
  triage any Stryker survivors before adding kill tests.

### Gate

`npx vitest run test/unit/domain/commands/error.test.ts test/unit/domain/exhaustiveness.ts src/application/commands/internal/notes-ref.test.ts src/application/primitives/load-notes-tree.test.ts src/application/primitives/write-notes-tree.test.ts && npm run check:types && ./node_modules/.bin/biome check src/domain/commands/error.ts src/domain/error.ts test/unit/domain/exhaustiveness.ts src/application/primitives/config-read.ts src/application/commands/internal/notes-ref.ts src/application/primitives/load-notes-tree.ts src/application/primitives/write-notes-tree.ts`

### Commit

`feat: notes error codes, ref selection and tree bridge`

## Part 4 — Notes command verbs (`add` / `read` / `list` / `remove`)

### Context

The four context-aware verbs composing P1 (trie), P3 (bridge + ref-selection + errors), and the
existing object-store primitives — the `tag` command shape. Tested DIRECTLY as `notesAdd(ctx,
input)` etc. (the namespace binder + facade land in P5, like `bundle`).

New file `src/application/commands/notes.ts`. Surface types are exactly ADR-431 / design §6:
```ts
export interface NotesAddInput { readonly object: string; readonly content: Uint8Array; readonly force?: boolean; readonly ref?: string; }
export interface NotesAddResult { readonly notesCommit: ObjectId; readonly note: ObjectId; }
export interface NotesReadInput { readonly object: string; readonly ref?: string; }
export type NotesReadResult = { readonly object: ObjectId; readonly note: ObjectId; readonly content: Uint8Array } | null;
export interface NotesListInput { readonly ref?: string; }
export type NotesListResult = ReadonlyArray<{ readonly object: ObjectId; readonly note: ObjectId }>;
export interface NotesRemoveInput { readonly object: string; readonly ref?: string; }
export interface NotesRemoveResult { readonly notesCommit: ObjectId; }
export const notesAdd = (ctx: Context, input: NotesAddInput): Promise<NotesAddResult>;
export const notesRead = (ctx: Context, input: NotesReadInput): Promise<NotesReadResult>;
export const notesList = (ctx: Context, input?: NotesListInput): Promise<NotesListResult>;
export const notesRemove = (ctx: Context, input: NotesRemoveInput): Promise<NotesRemoveResult>;
```

Imports: `resolveNotesRef` + `DEFAULT_NOTES_REF` (`./internal/notes-ref.js`); `loadNotesTree` /
`writeNotesTree` (`../primitives/load-notes-tree.js` / `write-notes-tree.js`); `insert` /
`remove` / `lookup` (`../../domain/notes/index.js`); `writeObject` (`../primitives/write-object
.js`) + the `Blob` shape (`{ type: 'blob', id: '' as ObjectId, content }`); `createCommit`
(`../primitives/create-commit.js`); `updateRef` (`../primitives/update-ref.js`); `readBlob`
(`../primitives/read-blob.js`); `walkTree` (`../primitives/walk-tree.js`); `resolveRef`
(`../primitives/resolve-ref.js`); `resolveCurrentIdentity` (`./internal/current-identity.js`);
`notesAlreadyExist` / `notesObjectHasNone` (`../../domain/commands/error.js`);
`assertOperationalRepository` (the repo-state gate `tagCreate` uses — confirm the exact name in
`tag.ts`); `parseFanoutPath` (`../../domain/notes/index.js`) for `list`; `ObjectId` regex resolve
(mirror `tagCreate`).

**Message + reflog constants** (named — no magic strings, no provenance refs in code; byte-
faithful to git's STORED commit subject, §7/§4.1-4.2; the commit serializer owns git's single
trailing newline — pinned in P6):
```ts
const NOTES_ADD_MESSAGE = "Notes added by 'git notes add'";
const NOTES_REMOVE_MESSAGE = "Notes removed by 'git notes remove'";
const NOTES_ADD_REFLOG = `notes: ${NOTES_ADD_MESSAGE}`;
const NOTES_REMOVE_REFLOG = `notes: ${NOTES_REMOVE_MESSAGE}`;
```

`resolveObject(ctx, object): Promise<ObjectId>` shared helper — `/^[0-9a-f]{40}$/.test(object) ?
(object as ObjectId) : await resolveRef(ctx, object as RefName)` (tagCreate-faithful; an
unresolvable object propagates `REF_NOT_FOUND` — no new code, §9).

- **`add`** (§7): `assertOperationalRepository(ctx)`; `obj = resolveObject(...)`; `ref =
  resolveNotesRef(ctx, input.ref)`; `loaded = loadNotesTree(ctx, ref)`; `existing = lookup(
  loaded.trie, obj, loaded.readSubtree)`; if `existing !== undefined && input.force !== true` →
  `throw notesAlreadyExist(obj)`; `noteOid = writeObject(ctx, blob{content})`; `trie2 = insert(
  loaded.trie, obj, noteOid, loaded.readSubtree)`; `treeOid = writeNotesTree(ctx, { ...loaded,
  trie: trie2 })`; `id = resolveCurrentIdentity(ctx)`; `notesCommit = createCommit(ctx, { tree:
  treeOid, parents: loaded.parentCommit ? [loaded.parentCommit] : [], author: id, committer: id,
  message: NOTES_ADD_MESSAGE })`; `updateRef(ctx, ref, notesCommit, { reflogMessage:
  NOTES_ADD_REFLOG })`; return `{ notesCommit, note: noteOid }`.
- **`remove`** (§7): `resolveObject`; `ref = resolveNotesRef`; `loaded = loadNotesTree`; if
  `loaded.parentCommit === undefined` (ref absent) OR `lookup(...) === undefined` → `throw
  notesObjectHasNone(obj)` (isolate BOTH guards in tests); `trie2 = remove(loaded.trie, obj,
  readSubtree)`; `treeOid = writeNotesTree(ctx, { ...loaded, trie: trie2 })` (empty → empty-tree
  oid); `notesCommit = createCommit(..., parents: [loaded.parentCommit], message:
  NOTES_REMOVE_MESSAGE)`; `updateRef(..., { reflogMessage: NOTES_REMOVE_REFLOG })` — the ref is
  **never deleted** (§4.3); return `{ notesCommit }`.
- **`read`** (§7): `resolveObject`; `ref = resolveNotesRef`; `loaded = loadNotesTree`; if ref
  absent (`parentCommit === undefined`) → `return null`; `noteOid = lookup(...)`; absent →
  `return null` (ADR-431 — NOT an error); `blob = readBlob(ctx, noteOid)`; return `{ object:
  obj, note: noteOid, content: blob.content }`.
- **`list`** (§7): `ref = resolveNotesRef`; `resolveRef(ctx, ref)` (catch `REF_NOT_FOUND` only →
  `return []`; rethrow else) → commit oid; `readObject(ctx, commit).data.tree` → notes tree oid;
  `walkTree(ctx, treeOid)` yields each leaf `{ path, id, mode }` at any fanout depth (no trie
  build needed — `walkTree` recurses fanout dirs and arbitrary non-note dirs alike); for each
  leaf strip `/` from `path`; KEEP it iff the de-slashed string is full-hex AND `mode ===
  '100644'` (non-note entries / non-hex paths skipped — §11.3); `object = parseFanoutPath(path)`,
  `note = id`; **sort by `object` ascending** (= git tree order) and return.

**Public-surface decision.** The four verbs + their 8 input/result types ARE public, but they
are barrelled/faceted in P5 — NO surface gate fires HERE (no barrel/facade/doc/browser/api.json
edit in this part). The error codes they raise were pre-paid in P3.

Tests (fold in) — app-tier (outside line-coverage, under Stryker); in-memory repos seeded via
the existing object/commit helpers sibling command tests use; isolated + data-asserting:
- `add`: annotate a commit → `read` returns `{ object, note, content }` with the verbatim bytes;
  the notes ref now resolves to a commit whose tree has the flat entry; `note` oid is
  deterministic for the bytes. Parent chaining: a second `add` on another object → the new notes
  commit's parent is the first (assert via `readObject`), the tree has both entries.
- `add` refusals: re-`add` same object no force → `NOTES_ALREADY_EXIST` (try/catch + `.data.object`);
  `add({ force: true })` overwrites (new note oid, message still `NOTES_ADD_MESSAGE`).
- `add` verbatim/empty: `content: new Uint8Array(0)` stores an empty blob (NOT a remove — §5,
  the sanctioned ADR-249 divergence).
- `remove`: remove one of two → other remains, tree keeps it; commit message
  `NOTES_REMOVE_MESSAGE`; reflog `NOTES_REMOVE_REFLOG`. Remove the LAST → tree oid is the
  empty-tree `4b825dc6…`, ref NOT deleted. Two ISOLATED refusal tests: remove on an absent ref
  → `NOTES_OBJECT_HAS_NONE`; remove an object with no note in a present ref →
  `NOTES_OBJECT_HAS_NONE`.
- `read` absent: object with no note → `null`; ref absent → `null`.
- `list`: multi-note ref → array sorted by object oid; a hand-committed non-note tree entry
  (e.g. a `README` blob in the notes tree) is skipped by `list`; empty/absent ref → `[]`.
- ref-selection at the verb level: `add({ ref: 'refs/notes/custom' })` targets that ref; a
  memory repo created with a fake `EnvReader` returning `GIT_NOTES_REF` selects that ref when no
  explicit `ref`; `core.notesRef` selects when neither explicit nor env (set it via the repo
  config). (Cross-adapter unset-env behaviour is covered by P5's parity scenario; real-git
  precedence parity by P6.)
- reflog assertion: after `add`, the `refs/notes/<name>` reflog's top subject equals
  `NOTES_ADD_REFLOG` (use the interop/`topReflogSubject` helper if available at unit level, else
  read the reflog file).

### TDD steps

- RED: write the `add` happy-path + `read` round-trip test → fails (module missing).
- RED: parent-chaining, force, empty-content, remove (others-remain / last→empty-tree),
  `read`-absent, `list` (sort / non-note skip / empty), and the FOUR isolated refusal/precedence
  tests → fail.
- GREEN: implement `notes.ts` (the four verbs + the shared `resolveObject` + the message
  constants) → all pass.
- REFACTOR: extract the common `(ref, loaded)` prelude if it keeps each verb <20 lines; CQS
  (queries `read`/`list` never mutate); early returns; no boolean-param smells (the `force`
  boolean is part of the ratified input shape, not a control-flow boolean param); triage Stryker
  survivors per `.claude/workflow/mutation.md`.

### Gate

`npx vitest run src/application/commands/notes.test.ts && npm run check:types && ./node_modules/.bin/biome check src/application/commands/notes.ts src/application/commands/notes.test.ts`

### Commit

`feat: notes add, read, list and remove verbs`

## Part 5 — Surface: `repo.notes` namespace, facade, barrel, docs, parity scenario, api.json

### Context

Wire the four verbs into the single public `repo.notes` Tier-1 namespace (the `tag` shape) and
pre-pay EVERY Tier-1 surface gate in-slice (`.claude/workflow/surface-gates.md`).

- **Namespace binder** — new `src/application/commands/internal/notes-namespace.ts` (mirror
  `internal/tag-namespace.ts` exactly — each method runs `guard()` first, forwards to the
  ctx-aware verb, `Object.freeze`):
  ```ts
  export interface NotesNamespace {
    readonly add: (input: NotesAddInput) => Promise<NotesAddResult>;
    readonly read: (input: NotesReadInput) => Promise<NotesReadResult>;
    readonly list: (input?: NotesListInput) => Promise<NotesListResult>;
    readonly remove: (input: NotesRemoveInput) => Promise<NotesRemoveResult>;
  }
  export const bindNotesNamespace = (ctx: Context, guard: () => void): NotesNamespace;
  ```
  Imports the verbs + their types from `../notes.js`.
- **Barrel** — `src/application/commands/index.ts` (two slots, matching the file's existing
  split):
  1. The namespace export between the `merge-namespace` export (line ~159) and the
     `rebase-namespace` export (line ~163): `export { bindNotesNamespace, type NotesNamespace }
     from './internal/notes-namespace.js';`.
  2. The verb-type export between the `name-rev` value export (line ~196-200) and the `pull`
     value export (line ~201): `export { type NotesAddInput, type NotesAddResult, type
     NotesReadInput, type NotesReadResult, type NotesListInput, type NotesListResult, type
     NotesRemoveInput, type NotesRemoveResult } from './notes.js';`.
- **Facade** — `src/repository.ts`:
  - `Repository` interface: insert `readonly notes: commands.NotesNamespace;` between
    `readonly nameRev` (~line 210) and `readonly pull` (~line 211), with a doc comment `/** Nested
    repo.notes.{add,read,list,remove} namespace over refs/notes/*. */`.
  - In the frozen `repo` object: add `notes: commands.bindNotesNamespace(ctx, guard),` next to
    the other namespace bindings (placement is cosmetic — `Object.keys().sort()` orders the
    snapshot).
- **Repository surface-snapshot test** — `test/unit/repository/repository.test.ts`:
  - Add `'notes'` to the sorted top-level-keys array between `'nameRev'` (line ~224) and
    `'primitives'` (line ~225).
  - Add `'notes'` to the `namespaceKeys` `Set` (line ~290 — alongside `'tag'`, `'bundle'`, …;
    the "typeof every binding is a function" test treats namespaces as frozen objects).
- **`check:doc-coverage`** — add `docs/use/commands/notes.md` (follow `docs/use/commands/tag.md`
  shape: the four sub-ops, what each returns as STRUCTURED data (oids/bytes — NO rendered lines),
  the `force` overwrite, the ref-selection precedence explicit → `GIT_NOTES_REF` → `core.notesRef`
  → `refs/notes/commits`, the two refusal codes, the verbatim-bytes / caller-owns-normalisation
  note per ADR-249). Add the alphabetical index row to `docs/use/commands/README.md` (`| [\`notes\
  `](notes.md) | Attach / read / list / remove out-of-band notes in refs/notes/*. |`, placed
  after the `nameRev` row, before `pull`/`push`) and bump its header count `42 entries` →
  `43 entries` (line 3).
- **Count + api.json** — `README.md` line 46: `42 Tier-1 commands` → `43 Tier-1 commands`. Then
  regenerate `reports/api.json` via `npm run docs:json` and commit it — this is the SINGLE regen
  for the whole feature (captures the two P3 NOTES error codes, the P2 `EnvReader` port type, and
  all P4/P5 notes exports). `check:doc-typedoc` (prepush) then passes. (Re-run cspell fresh +
  regenerate api.json AFTER all edits — a cached green validate can precede a red prepush; MEMORY
  `Cached validate vs prepush`.)
- **`docs/design/commands.md`** line 189 (`- Notes, signed commits, GPG verification. v2.`) —
  update so it no longer lists notes as pending (drop `Notes,` or annotate it landed; do not
  embed a phase/ADR ref in the doc body beyond what the line already carries).
- **`audit-browser-surface`** — new `test/parity/scenarios/notes.scenario.ts` (follow an existing
  scenario, e.g. `tag`/`archive`, + `types.ts`): `run(repo)` seeds a tiny repo, `repo.notes.add`
  a note on a commit, `repo.notes.read` / `repo.notes.list` / `repo.notes.remove`, projecting to
  **counts/oids only** (`noteCount`, a boolean `present`, the `notesCommit` existence) — NO
  rendered strings — runnable on node/memory/browser (where `GIT_NOTES_REF` is always unset, so
  the default ref is used — the cross-adapter env-fallthrough coverage §8.2 mentions). Register it
  in `test/parity/scenarios/index.ts`.
- **Browser** — `test/browser/surface-parity.spec.ts`: add a `test.describe('notes', …)` block
  invoking `add`→`read`/`list`→`remove`, asserting counts/oids only.
- **`cspell`** — add any new prose terms the spell-check flags (run `cspell` fresh before
  finishing — `check:spelling` is the review-batch gate; cached runs mask new words).

**Public-surface decision.** This part makes the ENTIRE notes surface PUBLIC and pays ALL Tier-1
gates here: barrel (two slots), facade (interface + binding + the two `repository.test`
snapshots), doc-coverage page + index row + index count, README count, parity/browser-surface
scenarios, and the ONE `reports/api.json` regen (which also finalises P2's `EnvReader` + P3's
error codes).

Tests (fold in): the two `repository.test.ts` snapshot edits ARE the facade tests; the
`notes.scenario.ts` + the browser block are the parity/browser-surface tests. The `src/` delta
(namespace binder + facade binding) makes this a legitimate non-test-only part.

### TDD steps

- RED: add `'notes'` to the two `repository.test.ts` snapshots → fails (key absent / binding
  missing) and `check:types` fails (`commands.bindNotesNamespace` / `commands.NotesNamespace`
  undefined until the barrel + binder land).
- GREEN: implement `notes-namespace.ts`; add the two barrel slots; add the interface field +
  binding in `repository.ts` → snapshots pass.
- RED→GREEN: write `notes.scenario.ts`, register it, run the parity suite → green on node/memory;
  add the browser `notes` block.
- GREEN (gates): create `notes.md` + the index row + bump both counts; update `commands.md`
  line 189; `npm run docs:json`; commit `reports/api.json`; run `cspell` fresh.
- REFACTOR: none expected (pure wiring) — confirm alphabetical placement everywhere.

### Gate

`npx vitest run test/unit/repository/repository.test.ts test/parity && npm run check:types && ./node_modules/.bin/biome check src/application/commands/internal/notes-namespace.ts src/application/commands/index.ts src/repository.ts test/parity/scenarios/notes.scenario.ts`

### Commit

`feat: notes namespace, facade and docs`

## Part 6 — Faithfulness interop suite (real `git` 2.54.0 parity)

### Context

Test-infra-only, standalone (NO `src/` delta — it has no implementation part to fold into). New
file `test/integration/notes-interop.test.ts`, modelled on the recent interop tests
(`commit-interop.test.ts` for the date pin, `bundle-interop.test.ts` for shape). Use the
env-hardened `test/integration/interop-helpers.ts` (the `runGit`/`runGitBytes`/`makePeerPair`/
`initBothRepos`/`topReflogSubject`/`writeTreeOf` family — confirm exact exports in the file):
real `git` spawned with `GIT_*` scrubbed, isolated `HOME`, `GIT_CONFIG_NOSYSTEM=1`, signing OFF.
One shared seeded repo in `beforeAll`, **60s timeout** (heavy git-spawning interop times out hook
concurrency otherwise — MEMORY `Interop load → validate flake`). Pin `-c
merge.conflictStyle=merge` defensively only if comparing marker bytes (N/A here). The library
emits NO rendered strings — reconstruct git's stdout/stderr from the structured fields and diff
(ADR-249).

**Clock pin (plan-wide note 3):** `notes.add`/`remove` date comes from `resolveCurrentIdentity`
reading `Date.now()`. To compare the notes-COMMIT oid byte-for-byte, fake `Date` ONLY (leave
real timers for the spawned subprocess): `vi.useFakeTimers({ toFake: ['Date'] })` +
`vi.setSystemTime(new Date(FIXED_EPOCH * 1000))` for the whole suite (`afterAll` →
`vi.useRealTimers()`), set the repo config `user.name`/`user.email` to a fixed identity, and pass
`GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE = "${FIXED_EPOCH} +0000"` to every `git notes` invocation —
so both tools stamp the same author/committer/date. TREE-oid and BLOB-oid assertions are
timestamp-free (no clock dependency).

**Seed** a repo exercising the pins: a small commit history (so there are objects to annotate),
plus a deterministic pool of ≥~120 distinct objects (or commits) to drive the fanout flip — the
SAME object set + SAME operation order in both tools (fanout is history-dependent — ADR-432).
Feed the library the SAME pre-normalised note bytes git stored (so blob SHAs compare): git's
`-m "x"` stores `x\n`; the library stores verbatim, so the test passes `content` = exactly the
bytes git produced (ADR-249 — the test owns the normalisation).

Pinned assertions (design §12, each a `git`-parity test; drive the same op sequence in both):
1. **add → byte-identical store** — `repo.notes.add` then assert vs git goldens for the same
   object+bytes: the TREE oid and NOTE-BLOB oid byte-for-byte (timestamp-free), and the
   notes-commit's parsed `tree`/`parent`/`message`/`author`==`committer`; the notes-commit OID
   byte-identical WITH the clock+identity pinned. Cross-check both directions: a tsgit-built
   notes ref is read by real `git notes show`/`list`; a real-`git`-built notes ref is read by
   tsgit `read`/`list`.
2. **parent chaining + sorted multi-entry tree** — two adds → child notes commit + two-entry
   tree in git tree-entry order, matching git.
3. **force** — `add({ force: true })` overwrites; commit message still `Notes added by 'git
   notes add'`; reflog `notes: Notes added by 'git notes add'`.
4. **reflog** — add/force/remove reflog top-subjects match §4.2 exactly (`topReflogSubject`).
5. **remove + empty-tree-on-last** — remove one (others remain) → tree keeps them (fanout
   preserved); remove the LAST → tree oid `4b825dc642cb6eb9a060e54bf8d69288fbee4904`, ref NOT
   deleted, commit message `Notes removed by 'git notes remove'`.
6. **list / read parity** — reconstruct git's `notes list` (`<note-blob> <annotated-oid>`,
   oid-sorted) and `notes show` bytes from the structured results; diff.
7. **refusal parity (isolated)** — add-on-existing no force → `NOTES_ALREADY_EXIST` reconstructs
   the exact §4.4 line (`error: Cannot add notes. Found existing notes for object <oid>. Use
   '-f' to overwrite existing notes`) + exit 1; remove-on-missing → `NOTES_OBJECT_HAS_NONE`
   reconstructs `Object <oid> has no note` (NO `error:` prefix — pin via the captured stderr) +
   exit 1.
8. **full fanout, twin-tool, equal oids at all N** — same op sequence in git + tsgit, assert
   EQUAL notes-commit / tree / blob oids across: **flat region** (N≈1..50); **flip region**
   (N≈70..110 — must match git's exact distribution-dependent flip for the seeded set, §4.7/
   §11.6); **deep multi-level fanout** (N in the hundreds → 2-byte fanout); **add→remove→add
   stickiness** (remove back below the flip → tree stays fanned exactly as git's, §11.5);
   **force-overwrite inside a fanned tree**; **a preserved non-note tree entry** committed into
   the notes tree survives every mutation unchanged (§11.3).
9. **ref selection (ADR-433, §10)** — `ref: 'refs/notes/custom'` targets that ref; a memory/node
   repo whose `EnvReader` returns `GIT_NOTES_REF` (node: set a process-env fixture for the test;
   the node adapter's `NodeEnvReader` reads it) selects it; `core.notesRef` (config) selects it;
   explicit `ref` overrides both — matching §4.5 precedence. (Browser/memory always-unset env is
   the P5 parity scenario's job — note that here.)

Per the project rule, cross-adapter parity does NOT prove faithfulness — only this interop
harness does. If a pinned `git` behaviour cannot be reproduced (e.g. a fanout SHA divergence from
the P1 trie / P3 bridge), escalate as `{ slice, reason, ≤3 options }` and fix the owning module —
never the test, never an ignore directive.

### TDD steps

- RED: scaffold `beforeAll` seeding + the clock pin + assertion 1 (add → byte-identical store).
  It fails only if a P1–P4 byte bug exists (the goldens are live-`git`-derived — this is the true
  faithfulness gate; fix the code if it diverges).
- RED→GREEN: add assertions 2–9 incrementally; the fanout twin-tool sweep (8) is the deepest —
  build the shared object pool + op-sequence helper first. Each assertion either passes against
  P1–P5 or surfaces a faithfulness bug to fix in the owning trie/bridge/verb (escalate per the
  blocker protocol if a pinned behaviour is unreproducible).
- REFACTOR: extract helpers — `gitNotes(args)`, `seedObjects(n)`, `driveBoth(ops)`,
  `reconstructListStdout(result)`, `reconstructShowStdout(result)` — so each `it` is a thin
  Arrange/Act/Assert; `Given/When/Then`, AAA, `sut`.

### Gate

`npx vitest run test/integration/notes-interop.test.ts && npm run check:types && ./node_modules/.bin/biome check test/integration/notes-interop.test.ts`

### Commit

`test: notes real-git faithfulness interop suite`
