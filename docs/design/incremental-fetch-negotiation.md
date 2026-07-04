# Design — Incremental fetch negotiation (Smart-HTTP protocol v2, v1 fallback)

> Brief: make `fetch` retrieve new objects when the client holds a base — the remote
> advances `C0 → C1`, the client has `C0`, and `fetch` must pull `C1`. Backlog 25.3.
> Status: revised against ratified [ADR-450](../adr/450-fetch-protocol-v2-with-v1-fallback.md) /
> [ADR-451](../adr/451-fetch-v1-fallback-framing-and-multi-ack.md) /
> [ADR-452](../adr/452-empty-pack-suppression-and-everything-local.md) → self-reviewed ×3.

## Context

`fetch` and `clone` share one discovery + upload-pack client
(`application/commands/internal/upload-pack-client.ts` + `refs-discovery.ts`) and one
pack-fetch primitive (`application/primitives/fetch-pack.ts` → `downloadPack`). Discovery and
exchange both go through the transport-agnostic `GitServiceSession` seam
([ADR-434](../adr/434-git-service-session-transport-seam.md)) so the same code path serves HTTP
and SSH. Two prior ADRs shaped the current v1-only wire:

- [ADR-005](../adr/005-clone-protocol-v1.md) — Smart-HTTP **protocol v1** only; single round.
- [ADR-010](../adr/010-fetch-haves-strategy.md) — **Strategy 1**: derive `have`s from a capped
  (`MAX_HAVES = 256`) graph walk over `refs/remotes/<remote>/*`, send them all plus `done`, and
  receive the pack in **one round-trip**.

The 25.3 defect: the client cannot fetch new objects when it holds a base —
`want C1 / have C0 / done` returns *no pack*. `clone` (no haves) and a no-op `fetch` (remote
unchanged) both work — the first because it sends no haves, the second because "no pack" is
coincidentally the right answer. Only the "remote advanced" case is broken. Backlog 25.3; also
blocks the submodule incremental-update path (24.1b refuses `OBJECT_NOT_FOUND`).

### Ratified architecture (what changed vs the first design)

The first design recommended the minimal v1 framing fix. The user **ratified a larger
architecture**:

- **[ADR-450]** — Adopt smart-HTTP **protocol v2 as the primary negotiation** for discovery
  (hence clone) and fetch, opting in via the `Git-Protocol: version=2` request header. When the
  server does not advertise `version 2`, **fall back to a corrected v1**. Neither path regresses.
- **[ADR-451]** — On the **v1 fallback**, fix the `compute-end` request framing (the spurious
  `0000` before `done`) and **advertise `multi_ack_detailed`** (stop stripping it).
- **[ADR-452]** — Protocol-agnostic faithfulness: **suppress empty-pack artifacts** (a 0-object
  pack writes nothing to disk) and **short-circuit fully-local fetches** (`everything_local` —
  skip the negotiation exchange when every want is already present locally).

v2 is HTTP-only (ADR-450 says "smart-HTTP"); SSH continues on the corrected v1 path (see
sub-decision **D5**). The `decodePktStream` `v2` flag ADR-005 preserved "for the future
implementation" is now used.

### Empirical root cause of the v1 defect (pinned against real `git` + `git-http-backend`, git 2.55.0)

*This section is preserved verbatim from the first design — it is the pinned root-cause work and
still governs the v1 fallback path (ADR-451).*

The domain layer is already negotiation-capable: `domain/protocol/upload-pack.ts`
`buildUploadPackRequest` emits `have` lines + an optional `done`, and `parseUploadPackResponse`
already parses `AckEntry` (`ack | continue | common | ready`) and `nak`. The bug is a
**request-framing defect**, not a missing negotiation loop.

git's request grammar (pack-protocol.txt) is:

```
upload-request = want-list flush-pkt *shallow *depth [filter]
upload-haves   = have-list compute-end
compute-end    = flush-pkt / PKT-LINE("done" LF)     ← EITHER a flush OR done, never both
```

`buildUploadPackRequest` builds `haveStream` via `encodePktStream(...)`, which **unconditionally
appends a `0000` flush** (`domain/protocol/pkt-line.ts:68`). So for haves + `done: true` it emits:

```
want C1 <caps>\n | 0000 | have C0\n | 0000 | done\n
                          ^^^^^^^^^^^^^^^^ spurious flush = compute-end
```

The server reads `have C0\n 0000` as `compute-end = flush-pkt` — a **non-final negotiation
round** — so it answers with ACKs and **no pack**, then ignores the trailing `done`.
`downloadPack` drains a zero-byte body and returns the "already up to date" empty result. For
`clone`, `haves` is empty, so no flush is emitted (`want … 0000 done`) and the pack arrives —
which is why clone works and hid the bug.

The existing unit tests encode the gap exactly: `upload-pack.test.ts` covers `haves: []` +
`done: true` (clone → `want / flush / done`) and `haves: [...]` + **no** `done` (negotiation
round → `want / flush / have / have / flush`), but there is **no test for `haves: [...]` +
`done: true`** — the incremental case.

### Pinned v1 wire matrix (the fallback path — ADR-451)

Raw POSTs of each request framing to a real `git-http-backend` serving a repo advanced
`C0 → C1` (`have C0`, `want C1`; `GIT_*` scrubbed, signing off, `GIT_CONFIG_NOSYSTEM=1`):

| # | Request framing | multi_ack | Server response | Pack? |
|---|---|---|---|---|
| A | `want C1 / 0000 / have C0 / 0000 / done` (tsgit **today**) | stripped | `ACK C0` only | **no** |
| B | `want C1 / 0000 / have C0 / done` (framing fix) | stripped | `ACK C0` + PACK | **yes** |
| C | `want C1 / 0000 / have C0 / done / 0000` (git's exact bytes) | requested | `ACK C0 common` + `ACK C0` + PACK | yes |
| D | `want C1 / 0000 / have C0 / done` (framing fix) | requested | `ACK C0 common` + `ACK C0` + PACK | yes |
| E | `want C0 / 0000 / have C0 / done` (no-op, framing fix) | requested | `ACK C0 common` + `ACK C0` + **empty PACK** (0 objects, 32 B) | yes (empty) |
| F | `want C1 / 0000 / done` (no haves = clone) | requested | `NAK` + full PACK | yes |

Findings that drive the v1 fallback design:

1. **The framing fix alone fixes the v1 bug** (B): removing the spurious flush before `done` makes
   the server return the pack — *without* `multi_ack_detailed`.
2. **`multi_ack_detailed` changes only the ACK wire, not the result** (B vs D produce the *same*
   pack for the same `have`/`want`/`done`). ADR-451 un-strips it for wire fidelity to git; the
   `common` ACK lines are already parsed by `parseAckLine`.
3. **The trailing flush after `done` is optional** (C vs D are identical). tsgit emits none; no change.
4. **After the fix, a no-op fetch returns an empty (0-object) pack, not zero bytes** (E) —
   handled by ADR-452's empty-pack suppression + `everything_local` short-circuit.

### Pinned v2 wire matrix (the primary path — ADR-450, NEW empirical work)

Captured with `GIT_TRACE_PACKET=1` against real git 2.55.0 upload-pack — both stateless-rpc over
`git-http-backend` (with the `Git-Protocol` header forwarded to `GIT_PROTOCOL`) and file://
transport; incremental case = client at `C0`, remote advanced to `C1`. `<oid>` = 40-hex.

**1. Capability advertisement** (GET `info/refs?service=git-upload-pack`, `Git-Protocol:
version=2`) — after the HTTP `# service=git-upload-pack\n0000` prologue:

```
version 2\n
agent=git/2.55.0-Darwin\n
ls-refs=unborn\n
fetch=shallow wait-for-done\n
server-option\n
object-format=sha1\n
0000
```

**2. `ls-refs` request** (POST `git-upload-pack`) — command header, `0001` delim, then args,
then flush:

```
command=ls-refs\n
agent=<tsgit-agent>\n
object-format=sha1\n
0001
peel\n
symrefs\n
ref-prefix HEAD\n
ref-prefix refs/heads/\n
ref-prefix refs/tags/\n
0000
```

**3. `ls-refs` response** — one line per ref, `0000` terminates:

```
<oid> HEAD symref-target:refs/heads/main\n     ← symref-target present because `symrefs` was sent
<oid> refs/heads/main\n
<oid> refs/tags/v1\n
<oid> refs/tags/v1^{}\n   -OR-  peeled:<oid> suffix when `peel` was sent
0000
```

(An unborn HEAD serializes `unborn HEAD symref-target:refs/heads/<name>`.)

**4. `fetch` request** (POST `git-upload-pack`) — command header, `0001` delim, capability args,
`want`/`have`, terminator:

```
command=fetch\n
agent=<tsgit-agent>\n
object-format=sha1\n
0001
ofs-delta\n              ← tsgit sends its supported arg subset (strips thin-pack, no-progress — see below)
want <C1>\n
have <C0>\n              ← ≤ MAX_HAVES, single round
done\n                   ← tsgit appends `done` to force a single round (ADR-010 Strategy 1)
0000
```

git's own client advertises `thin-pack no-progress include-tag ofs-delta` here; tsgit strips
`thin-pack` and `no-progress` to match its v1 capability policy (`transport.md`), keeping
`ofs-delta` (and `include-tag` on the fetch path). Argument selection is the v2 analog of v1's
capability intersection.

**5. `fetch` response** — section-based: an `acknowledgments` section, then `0001` delim, then a
`packfile` section carrying side-band data, then `0000`:

```
acknowledgments\n
ACK <C0>\n
ready\n                  ← server has enough common history; will send the pack
0001                     ← delim: section boundary
packfile\n
<side-band-64k framed PACK bytes>
0000
```

When the client sends `done` (tsgit's single-round path), the server MAY skip the
`acknowledgments` section and open with `packfile\n` directly. The section parser dispatches on
the section-header pkt-line and tolerates any subset of `{acknowledgments, shallow-info,
wanted-refs, packfile}` (D3/section-parser design below). The interop test pins tsgit's actual
`want/have/done` response byte-for-byte against real `git-http-backend`.

**6. No-op fetch (everything already local)** — pinned: git issues `command=ls-refs` for
discovery but **no `command=fetch`** and delivers **no packfile**. This is `everything_local`
(ADR-452): git performs no negotiation exchange when every want is present locally.

The two v2 additions vs v1: **section framing** (`0001` delim separating named sections,
side-band inside `packfile`) and **the two-step discovery** (a capability-advertisement GET
followed by an `ls-refs` POST, instead of v1's single ref-advertisement GET).

## Requirements

- **R1 (the gap).** After the remote advances `C0 → C1` with the client holding `C0`, `fetch`
  retrieves `C1`'s objects, updates `refs/remotes/<remote>/main` to `C1`, and `C1` is reachable —
  on **both** the v2 primary path and the v1 fallback.
- **R2 (no regression).** `clone` and no-op `fetch` are unchanged in observable on-disk state; a
  no-op `fetch` writes **no** pack file (no empty `pack-*.pack`) and performs no negotiation
  exchange (`everything_local`).
- **R3 (faithful wire).** v2 `ls-refs`/`fetch` framing and the v1-fallback `compute-end` framing
  each match real git's bytes, pinned against real git.
- **R4 (faithfulness pin).** Resulting pack objects and `refs/remotes/*` oids are byte-for-byte
  identical to canonical git performing the same incremental fetch — proven by cross-tool interop
  tests for **v2** and the **v1 fallback**.
- **R5 (mutation-testable).** Version dispatch, the v2 request builders/section parser, the v1
  framing decision, and the `everything_local`/empty-pack handling are unit-testable in the
  domain/application tier (`test/unit` only — Stryker skips `test/integration/*`), with interop as
  the faithfulness pin.
- **R6 (`pull` composes).** `pull`'s over-the-wire fast-forward / merge works for the
  advanced-remote case with **no** change to `pull` — it composes `fetch` + merge.
- **R7 (fallback covers v2-incapable servers & SSH).** A server that does not advertise `version 2`
  (and every SSH remote) fetches incrementally via the corrected v1 path.

## Design

The change has two orthogonal axes that meet in `clone`/`fetch`:

1. **Negotiation protocol** — a new v2 discovery+fetch surface (primary) that falls back to the
   corrected v1 surface, dispatched on the server's advertised version.
2. **Protocol-agnostic faithfulness** — `everything_local` short-circuit + empty-pack suppression,
   guarding both paths.

### 1. Version negotiation & fallback dispatch

**Opt-in header (session).** `createHttpSession` (`git-service-session.ts`) sends
`Git-Protocol: version=2` on the discovery GET and every exchange POST (added to the
`ADVERTISEMENT_ACCEPT`/`EXCHANGE_HEADERS` header maps). The SSH session does not set it, so SSH
stays v1 (D5). No change to `network-pipeline.ts`/transport middleware — the header is a
per-service constant, not retry/auth policy.

**v2-capable decode.** The session decodes the pkt stream with `decodePktStream(..., { v2: true })`
so `0001` (delim) and `0002` (response-end) frames are recognised. This is safe on v1 streams: v1
upload-pack never emits length-`0001`/`0002` frames, so a v1 response decodes identically either
way (sub-decision **D2** — recommend always-v2 decode over a per-session flag).

**Version detection is response-driven, not request-driven.** tsgit sends `version=2`, but the
authoritative signal is the *advertisement's first data pkt-line*: `version 2` → v2 path;
anything else (a v1 ref line) → v1 path. This makes tsgit robust against servers (and the
un-extended interop harness) that ignore the header and answer v1 — exactly the fallback R7 needs.

**Dispatch home (D6).** A new internal module `application/commands/internal/fetch-negotiation.ts`
owns the whole negotiation, so `clone` and `fetch` share one seam:

```
negotiateDiscovery(session) : Promise<DiscoveryResult>
  DiscoveryResult = { version: 'v1' | 'v2', advertisement: Advertisement, fetchArgs?: … }
```

- Reads `session.advertisement()`. Consumes the shared `# service=git-upload-pack\n0000` HTTP
  prologue once (via `servicePrologue`, as `parseAdvertisedRefs` does today), then peeks the first
  data pkt-line.
- **v2** (first line `version 2`) → parse the capability advertisement
  (`domain/protocol/v2/capabilities.ts`), then POST an `ls-refs` command via `session.exchange()`
  and parse its response into the **existing** `Advertisement` shape (`{ refs, capabilities,
  head }`) so `clone`/`fetch` consumers are unchanged.
- **v1** (first line is a ref line) → hand the peeked line back (the WeakMap pushback already in
  `upload-pack.ts`) and run `parseAdvertisedRefs` exactly as today.

And a pack-negotiation seam consumed by `fetchPack`:

```
negotiatePackBytes(ctx, session, version, { wants, haves, args }) : Promise<PackDownload>
```

- **v2** → build the v2 `fetch` request (`domain/protocol/v2/fetch.ts`), `session.exchange()`,
  parse the section response into `{ packBody, shallow, unshallow }`.
- **v1** → today's `buildUploadPackRequest` + `parseUploadPackResponse`.

Both return the same `PackDownload` shape; the shared pack-materialization tail (verify trailer,
walk entries, empty-pack guard, write artifacts) is unchanged (D3 splits it out of `fetchPack`).

### 2. v2 discovery — `ls-refs`

`domain/protocol/v2/ls-refs.ts`:

- **Request builder** `buildLsRefsRequest({ symrefs, peel, refPrefixes })` → command header
  (`command=ls-refs`, `agent`, `object-format=sha1`), `0001` delim, then `symrefs\n`, `peel\n`,
  and one `ref-prefix <p>\n` per prefix, then `0000`. Framed via the new no-flush/section
  encoder (Part 3). tsgit's negotiation seam calls it with `symrefs: true` only — `peel` and
  `refPrefixes` are deliberately left unset (see "Deliberate minimalism in the v2 request arg
  set" below) — so the mapped `Advertisement` carries symref-HEAD from the `symrefs` capability,
  matching the v1 advertisement's `symref=HEAD:` line.
- **Response parser** `parseLsRefsResponse(pktStream)` → `Advertisement`. Each data line is
  `<oid> <name>[ symref-target:<t>][ peeled:<o>]`; map `symref-target:` → the existing
  `findHead`-style HEAD synthesis, `peeled:` → `AdvertisedRef.peeled`. `0000` terminates. Reuses
  `ObjectId.from` + the `SHA_ANY_RE` validation already in `upload-pack.ts`.

Because the output is the current `Advertisement`, `uniqueRefOids`, `applyRemoteRefs`, `prune`,
and clone's want-derivation are untouched.

### 3. v2 `fetch` command

`domain/protocol/v2/fetch.ts`:

- **Request builder** `buildV2FetchRequest({ wants, haves, args, done })` → command header
  (`command=fetch`, `agent`, `object-format=sha1`), `0001` delim, then arg lines (tsgit's
  negotiation seam passes only `deepen <n>` when a depth is set and `filter <spec>` when a
  filter is set — **no** `ofs-delta`/`include-tag`/`thin-pack`/`no-progress`; see "Deliberate
  minimalism in the v2 request arg set" below), `want <oid>` per want, `have <oid>` per have
  (≤ `MAX_HAVES`), `done` (tsgit forces single-round per ADR-010), `0000`.
- **Section response parser** `parseV2FetchResponse(pktStream, { sideBand })`. A section-header
  dispatcher: read a data pkt-line = section name; consume that section until the next `0001`
  delim or the terminating `0000`; dispatch:
  - `acknowledgments` → parse `ACK <oid>` / `NAK` / `ready` (reuse the `AckEntry`/`parseAckLine`
    logic from `upload-pack.ts`; `ready` becomes a boolean on the result).
  - `shallow-info` → reuse the `shallow`/`unshallow` parsing already in `upload-pack.ts`
    (`tryConsumeShallowLine`).
  - `wanted-refs` → `<oid> <refname>` lines (parsed, currently informational; carried on the result
    for future tag-following, not consumed by 25.3).
  - `packfile` → side-band body via the **existing** `parseSideBand`; expose as
    `packBody: AsyncIterable<Uint8Array>`, identical to v1's `UploadPackResponse.packBody`.
  - Tolerates any subset (a `done` request may yield `packfile` first with no `acknowledgments`).

Result shape mirrors `UploadPackResponse` (`{ acks, nak, ready, packBody, shallow, unshallow,
wantedRefs }`) so `downloadPack`'s drain logic is shared.

### Deliberate minimalism in the v2 request arg set

The `domain/protocol/v2/ls-refs.ts` and `domain/protocol/v2/fetch.ts` builders accept the full
set of args the spec allows (`peel`, `refPrefixes`, arbitrary `args` for `fetch`), but the
negotiation seam (`application/commands/internal/fetch-negotiation.ts`) deliberately calls them
with a minimal subset:

- **`ls-refs`**: only `symrefs: true`. `peel` and `ref-prefix` are omitted.
- **`fetch`**: only `deepen <n>` (when `depth` is set) and `filter <spec>` (when a filter is
  set). `ofs-delta`, `include-tag`, `thin-pack`, and `no-progress` are never sent.

This is intentional, not an oversight — each omitted arg only steers *how* the server searches,
filters, or packs bytes on the wire, never *what* ends up on tsgit's disk:

- `ref-prefix` filters which refs the server advertises; tsgit always wants the full ref set
  (clone/fetch already prune locally), so server-side filtering buys nothing.
- `peel` asks the server to include a `peeled:<oid>` hint per tag. tsgit's on-disk peeled-tag
  tracking (`domain/refs/packed-refs.ts`) is derived from the fetched tag objects themselves,
  not from this wire hint, so requesting it would be a pure no-op for what gets persisted.
- `ofs-delta`/`include-tag` only affect how the server encodes the packfile (offset- vs
  ref-deltas, whether unreferenced tag objects ride along); the unpacked objects tsgit writes
  are byte-identical either way.
- `thin-pack`/`no-progress` are v1-only holdovers with no v2 equivalent tsgit's negotiation
  needs — no-progress in particular is superseded by v2's `sideband-all` framing, which tsgit
  already parses via `parseSideBand`.

Because the wire differs from what canonical `git fetch` sends while the resulting objects,
refs, and pack contents are byte-identical, this is a narrow, deliberate divergence from the
git-faithfulness prime directive's wire-format expectation — pinned by the interop test suite's
v2 negotiation goldens rather than by matching git's exact arg list.

### 4. v1 fallback correctness (ADR-451)

**Framing fix** in `domain/protocol/upload-pack.ts` `buildUploadPackRequest`. The have-list
terminator depends on `done`:

- **`done === true`** → want-list flush (from `encodePktStream(wantPayloads)`), then have
  pkt-lines with **no** trailing flush, then the `done` pkt-line: `want-list flush have-list done`.
- **`done` falsy** (genuine negotiation round) → keep current behaviour: have-list terminated by a
  flush.
- **`haves` empty** → unchanged (clone: `want-list flush done`).

Requires a no-flush pkt-line concatenation helper (the flush-appending `encodePktStream` is the
source of the bug and must not be reused for the `done` branch). This helper is shared with the v2
builders (Part 3 introduces `encodePktLines` = concat without the terminating flush, plus the
delim/section framing on top of it).

**Un-strip `multi_ack_detailed`** in `upload-pack-client.ts` `selectFetchCapabilities`: drop
`multi_ack_detailed` from the filter list (keep `thin-pack`/`no-progress` stripped). The parser
already tolerates the resulting `ACK … common` lines. Single-round strategy retained: all
(≤256) haves + `done` in one POST; the `common` acks are read but the client terminates in that
one round (not multi-round negotiation).

### 5. everything_local + empty-pack suppression (ADR-452, protocol-agnostic)

**Existence probe (D1).** A **new** `hasObject(ctx, id): Promise<boolean>` primitive
(`application/primitives/`) returns true iff `id` is present in a loose file **or** a pack
(`getPackRegistry(ctx).lookup(id) !== undefined` || `ctx.fs.exists(loosePath)`), **without**
inflating and **without** the promisor lazy-fetch fallback. `readObject` is the wrong probe: on a
partial repo it fires a promisor **network** fetch (defeating a local-only short-circuit), fully
inflates/verifies the object (wasteful for a boolean), and signals absence by throwing. `hasObject`
is a cheap, side-effect-free CQS query, reusable by the 24.1b submodule path and future
partial-clone work.

**`everything_local` short-circuit** in `fetch.ts` `negotiateAndApply` (fetch-only — clone never
holds all wants, so it always negotiates): after computing `wants`, if
`await Promise.all(wants.map(w => hasObject(ctx, w)))` are all true,
**skip the pack-negotiation exchange entirely** (no POST) and proceed straight to
`applyRemoteRefs`/`prune`. Mirrors git's pinned no-op behaviour (case 6). Refs/reflogs still
update. Guard against a partial repo: a repo with a stored filter never short-circuits (its wants
may be promised-absent), so gate the short-circuit off `filter === undefined`.

**Empty-pack write guard** in `fetch-pack.ts` `fetchPack`: when the negotiated response is a
0-object pack, skip `writePackArtifacts` (no `pack-*.pack`/`.idx` on disk), returning the existing
empty result shape. `parsePackHeader`/`walkPackEntries` already expose the count; the guard is a
single `entries.length === 0` check before artifact writing. The existing zero-byte guard is
retained (defensive, still reachable for a server that closes without a pack). This is the D3
materialization split's natural seam.

### Error semantics

Unchanged. A non-200 discovery/exchange still raises `HTTP_ERROR`; a malformed pack still raises
via `verifyPackTrailer` / `walkPackEntries`; an unknown ACK status still raises `unknownAckStatus`.
The 0-object pack is a *success* (empty result), not an error. New v2 failure modes: an
advertisement that claims `version 2` but omits the `fetch`/`ls-refs` command, or a section header
tsgit does not recognise → a new typed protocol error (`unexpectedV2Section` /
`v2CommandUnsupported`) in `domain/protocol/error.js`, never a swallowed default.

## Ratified decisions (ADRs 450–452) and open sub-decisions

### Ratified (pre-decided by the user — recorded here, not re-opened)

| ADR | Decision |
|---|---|
| [450](../adr/450-fetch-protocol-v2-with-v1-fallback.md) | **v2 primary, v1 fallback.** Adopt smart-HTTP protocol v2 as the primary negotiation for discovery (clone) and fetch via `Git-Protocol: version=2`; fall back to corrected v1 when the server does not advertise `version 2`. Supersedes ADR-005's v1-only deferral. |
| [451](../adr/451-fetch-v1-fallback-framing-and-multi-ack.md) | **v1 fallback correctness.** Fix the `compute-end` framing (no flush before `done`); advertise `multi_ack_detailed`. Amends ADR-010 §Neutral. Retains ADR-010 single-round strategy. |
| [452](../adr/452-empty-pack-suppression-and-everything-local.md) | **Faithfulness guards.** Suppress empty-pack artifacts; `everything_local` short-circuit. Protocol-agnostic. |

### Open sub-decisions the ADRs left to design (≤3 alternatives each, with a recommendation)

| # | Choice | Alternatives | Recommendation | Why |
|---|---|---|---|---|
| D1 | **Existence probe for `everything_local`** (ADR-452 says "the plan decides") | **A.** New `hasObject` primitive (loose + pack membership, no inflate, no promisor). **B.** Reuse `readObject` and catch `OBJECT_NOT_FOUND`. | **A** | B fires promisor network fetches on partial repos (defeats a local-only check), inflates/verifies for a boolean, and signals via exception. A is a cheap CQS query reusable by 24.1b + partial-clone. |
| D2 | **v2 frame decoding** | **A.** The HTTP session always decodes `{ v2: true }` (SSH stays v1-decode). **B.** Thread a per-session version flag set after discovery. | **A** | v1 never emits `0001`/`0002` length frames, so always-v2 decode is byte-identical on the HTTP v1-fallback and avoids a stateful flag the session cannot know until after its first call. |
| D3 | **`fetchPack` v1/v2 structure** | **A.** Split `fetchPack` into `negotiatePackBytes` (version-specific, injected) + shared `materializePack` (verify/walk/guard/write). **B.** Parameterise `downloadPack` with a builder+parser strategy pair. **C.** Sibling `fetchPackV2`. | **A** | The heavy tail (verify trailer, walk entries, empty-pack guard, write, `refreshPackRegistry`) is identical across versions; A shares it once and isolates the wire. C duplicates the tail; B tangles two response shapes in one function. |
| D4 | **v2 module layout** | **A.** `domain/protocol/v2/` subfolder (`capabilities.ts`, `ls-refs.ts`, `fetch.ts`, `sections.ts`) re-exported from the protocol barrel. **B.** Flat `v2-*.ts` files in `domain/protocol/`. | **A** | Matches the many-small-files + kebab-case house style; keeps the ~600 LOC v2 surface cohesive and independently testable; barrel re-export keeps import sites stable. |
| D5 | **v2 over SSH** | **A.** SSH stays on corrected v1 now; v2-over-SSH is a follow-on. **B.** Add `GIT_PROTOCOL=version=2` to the SSH channel env now. | **A** | ADR-450 scopes v2 to "smart-HTTP". v2-over-SSH needs the server to receive `GIT_PROTOCOL` (env-forwarding / `SetEnv`), a separate transport concern; the corrected v1 (ADR-451) already delivers incremental fetch over SSH (R7). |
| D6 | **Where version dispatch lives** | **A.** New `application/commands/internal/fetch-negotiation.ts` seam shared by clone+fetch. **B.** Fold into `refs-discovery.ts`/`upload-pack-client.ts`. **C.** Transport middleware. | **A** | A gives clone and fetch one dispatch seam (discovery + pack negotiation) without bloating the transport-agnostic discovery helper; C is wrong-layer (protocol parsing is not retry/auth policy). |

## Surface map (dependency-ordered, with proposed part boundaries)

Domain-tier logic (Parts 1–5) is unit-testable in `test/unit`; only Part 7 is
`test/integration`. Front-loads the deliverable: Parts 1–2 make incremental fetch work on the v1
fallback and hold faithfulness before the larger v2 surface lands.

**Part 1 — v1 fallback framing fix + `multi_ack_detailed` (ADR-451).** Smallest, self-contained;
delivers incremental fetch on the fallback immediately.
- `src/domain/protocol/upload-pack.ts` — `buildUploadPackRequest`: `done`-dependent have-list
  terminator (no flush before `done`).
- `src/domain/protocol/pkt-line.ts` — new `encodePktLines(payloads)` (concat, **no** trailing
  flush); shared with Part 3.
- `src/application/commands/internal/upload-pack-client.ts` — `selectFetchCapabilities`: stop
  filtering `multi_ack_detailed`.
- Tests: `test/unit/domain/protocol/upload-pack.test.ts` (new `Given haves and done=true` kill
  test), `upload-pack.properties.test.ts` (grammar invariant), `upload-pack-client` cap test.

**Part 2 — empty-pack suppression + `everything_local` + `hasObject` (ADR-452).**
Protocol-agnostic; holds R2; composes with Part 1.
- `src/application/primitives/has-object.ts` (new) — `hasObject(ctx, id)`; composes
  `getPackRegistry(ctx).lookup` (`pack-registry.ts`) + loose `ctx.fs.exists`.
- `src/application/primitives/index.ts` / barrel — export `hasObject`.
- `src/application/primitives/fetch-pack.ts` — `fetchPack`: 0-object-pack write guard
  (`entries.length === 0` → skip `writePackArtifacts`); extract shared `materializePack` tail (D3).
- `src/application/commands/fetch.ts` — `negotiateAndApply`: `everything_local` short-circuit
  (skip exchange when all wants local; gated `filter === undefined`).
- Tests: `has-object.test.ts`, `fetch-pack.test.ts` (0-object pack writes no artifact),
  `fetch.test.ts` (no `exchange` call when everything local).

**Part 3 — v2 pkt framing + section decoder foundation.**
- `src/domain/protocol/v2/sections.ts` (new) — `encodeCommandRequest(command, args, payloads)`
  (command header + `0001` delim + payloads + `0000`); `readSections(pktStream)` section-header
  dispatcher over the v2-flagged `decodePktStream`.
- `src/domain/protocol/v2/capabilities.ts` (new) — parse the `version 2 … 0000` capability
  advertisement into `{ version, agent, commands, objectFormat }`; `supportsV2Fetch(...)`.
- `src/domain/protocol/error.ts` — `unexpectedV2Section`, `v2CommandUnsupported`.
- `src/domain/protocol/index.ts` — re-export the `v2/` barrel.
- Tests: `v2/sections.test.ts`, `v2/capabilities.test.ts` (+ properties for the section decoder —
  round-trip lens).

**Part 4 — v2 `ls-refs`.**
- `src/domain/protocol/v2/ls-refs.ts` (new) — `buildLsRefsRequest(...)`,
  `parseLsRefsResponse(...) → Advertisement` (symref-target/peeled mapping).
- Tests: `v2/ls-refs.test.ts` (+ properties: parse∘build round-trip).

**Part 5 — v2 `fetch` command.**
- `src/domain/protocol/v2/fetch.ts` (new) — `buildV2FetchRequest(...)`,
  `parseV2FetchResponse(...)` (acknowledgments/shallow-info/wanted-refs/packfile via
  `parseSideBand`).
- Tests: `v2/fetch.test.ts` (each section subset; `done`-first packfile; ACK/ready/NAK) +
  properties for the request builder.

**Part 6 — version negotiation + fallback dispatch (wires 1–5 into commands).**
- `src/application/commands/internal/git-service-session.ts` — `createHttpSession`: add
  `Git-Protocol: version=2` to advertisement + exchange headers; decode `{ v2: true }` (D2).
- `src/application/commands/internal/fetch-negotiation.ts` (new) — `negotiateDiscovery(session)`
  (v1/v2 detect + ls-refs) and `negotiatePackBytes(...)` (v1/v2 dispatch). (D6)
- `src/application/primitives/fetch-pack.ts` — inject the negotiator into `fetchPack` (consume
  `negotiatePackBytes`), keep `materializePack` shared.
- `src/application/commands/fetch.ts` + `src/application/commands/clone.ts` — call
  `negotiateDiscovery` instead of `discoverRefs`; version threads to `fetchPack`.
- Tests: `fetch-negotiation.test.ts` (v1/v2 detect, fallback on non-`version 2` advertisement),
  `fetch.test.ts`/`clone.test.ts` (v2 + v1 dispatch), session header test.

**Part 7 — interop harness extension + faithfulness pins (R3/R4/R7).**
- `test/bench/support/http-backend-server.ts` — **harness extension** (see below): forward the
  `Git-Protocol` request header to the `GIT_PROTOCOL` CGI env.
- `test/integration/network/incremental-fetch-http-backend.test.ts` (new) — mutable-source v2
  incremental fetch + v1-fallback incremental fetch, twinned against real git.
- `test/integration/network/pull-http-backend.test.ts` — advanced-remote `pull` case (R6).
- `test/integration/ssh-transport-interop.test.ts` — optional SSH v1 incremental case (R7).

**Proposed part order (one line each):**

1. **v1 fallback framing fix + `multi_ack_detailed`** — no-flush before `done`; un-strip cap.
2. **empty-pack + `everything_local` + `hasObject`** — 0-object write guard, local-only probe, short-circuit.
3. **v2 section decoder foundation** — command-request encoder, section dispatcher, capability-advertisement parser.
4. **v2 `ls-refs`** — request builder + response→`Advertisement`.
5. **v2 `fetch` command** — request builder + section response parser.
6. **version negotiation + fallback dispatch** — session `Git-Protocol` header, `fetch-negotiation` seam, clone/fetch/fetchPack wiring.
7. **interop harness + faithfulness pins** — `Git-Protocol`→`GIT_PROTOCOL` forward; v2 + v1-fallback interop; pull; SSH.

## Interop harness extension (the CRITICAL gap flagged in the first design)

`test/bench/support/http-backend-server.ts` `handleRequest` builds the CGI `env` (lines ~103–113)
and forwards `PATH_INFO`, `QUERY_STRING`, `REQUEST_METHOD`, `CONTENT_TYPE`, `CONTENT_LENGTH`,
`GIT_PROJECT_ROOT`, `GIT_HTTP_EXPORT_ALL` — but **not** the `Git-Protocol` request header. Per
RFC 3875, `git-http-backend` reads the protocol version from the `GIT_PROTOCOL` env var; with the
header dropped it **silently serves v1**, so the v2 path would go unexercised and the interop test
would pin the fallback while claiming to pin v2.

**Extension:** add one line to the `env` object —
`GIT_PROTOCOL: req.headers['git-protocol'] ?? ''`. Empirically confirmed necessary and sufficient:
the v2 wire matrix above was captured through exactly this forwarding (a local CGI server that
maps `git-protocol` → `GIT_PROTOCOL`); removing it downgrades the same client to v1.

**Fallback pinning without the header.** Because tsgit's version detection is response-driven, the
v1-fallback path is pinned by pointing the same mutable-source scenario at a harness instance that
**does not** forward `Git-Protocol` (or a v1-only server): tsgit sends `version=2`, the server
answers v1, tsgit detects the absence of `version 2` and fetches via the corrected v1 path. The
new interop suite runs the scenario **twice** — forwarding on (v2) and off (v1 fallback) — and
asserts byte-identical results both times. (The existing `fetch-http-backend.test.ts` inlines its
own CGI handler without the forward; leaving it as-is exercises the fallback — optionally refactor
it to the shared `startGitHttpBackend` in Part 7.)

## Test strategy

**Unit (`test/unit`, mutation-visible — R5):**

- `domain/protocol/upload-pack.test.ts` — **new** `Given haves and done=true` → decode the built
  request; assert `data(want) / flush / data(have) / data(done)` with **no flush between the last
  have and `done`**, `done` payload `done\n`. Primary kill-test for the v1 fix. Keep the existing
  `Given haves and no done` and `Given wants and done=true`.
- `domain/protocol/upload-pack.properties.test.ts` — `buildUploadPackRequest` grammar: for any
  non-empty `wants`, any `haves`, any `done`, decode yields
  `want⁺ [depth] [filter] flush have* (flush XOR done)` — have-list terminated by flush **iff**
  `done` false, by `done` **iff** true, never both. `numRuns: 100`.
- `domain/protocol/v2/sections.test.ts` + `.properties.test.ts` — `encodeCommandRequest` /
  `readSections` round-trip (parse∘build ≡ identity for any command+args+section set); delim/flush
  boundaries.
- `domain/protocol/v2/ls-refs.test.ts` (+ properties) — request framing (`symrefs`/`peel`/prefix);
  response→`Advertisement` (symref-target→HEAD, peeled→`.peeled`), pinned against the captured bytes.
- `domain/protocol/v2/fetch.test.ts` (+ properties) — request args (`ofs-delta`, want/have/`done`,
  strips `thin-pack`/`no-progress`); section parser for each subset — `acknowledgments`
  (ACK/ready/NAK) then `packfile`; `packfile`-first (post-`done`); `shallow-info`; `wanted-refs`.
- `application/primitives/has-object.test.ts` — true for loose, true for packed, false for absent,
  and **no** promisor fetch on a partial repo (assert `ctx.promisor` never called).
- `application/primitives/fetch-pack.test.ts` — a 0-object pack (32-byte header+trailer) drains to
  an empty result **without** `writeExclusive` for the pack path; `materializePack` split intact.
- `application/commands/internal/fetch-negotiation.test.ts` — advertisement starting `version 2`
  → v2 (issues `ls-refs`); a v1 ref line → v1 (no `ls-refs`); `negotiatePackBytes` dispatch.
- `application/commands/fetch.test.ts` — advanced-remote path threads real `have`/`want` and
  updates the remote-tracking ref (both v1 and v2 dispatch); `everything_local` makes **no**
  `exchange` call when every want is local; partial repo (`filter` set) does **not** short-circuit.
- `git-service-session.test.ts` — HTTP session sends `Git-Protocol: version=2`; SSH does not.

**Interop (`test/integration/network`, the faithfulness pin — R4):**
`incremental-fetch-http-backend.test.ts` (sibling of `fetch-http-backend.test.ts`, reusing the
extended `startGitHttpBackend`). Mutable source (not the static `clone-source` fixture):
`git init --bare` in a mktemp dir, seed `C0`, tsgit-clone over HTTP, advance the remote to `C1`
(real `git push` from a seed worktree — `GIT_*` scrubbed, signing off), tsgit `fetch` over HTTP,
assert `refs/remotes/origin/main == C1`, `C1`'s objects present, full history reachable. **Twin**
with real `git fetch` into a parallel clone; compare `refs/remotes/*` oids + the fetched object
set byte-for-byte. Run the scenario **twice** — `Git-Protocol` forwarding on (pins v2) and off
(pins v1 fallback). Gate on `git --version` + discoverable `git-http-backend`; skip under Stryker
(`process.cwd().includes('.stryker-tmp')`), per the existing suites. Peer git pinned with
`-c protocol.version=2` (v2 leg) / `-c protocol.version=1` (fallback leg) and
`-c merge.conflictStyle=merge` (global-config guard).

**`pull` composition (R6):** an advanced-remote fast-forward case in `pull-http-backend.test.ts`
confirms `pull` composes with no `pull` change (v2 primary).

**SSH (R7):** an advanced-remote case in `ssh-transport-interop.test.ts` optionally pins SSH
incremental fetch over the corrected v1 path; HTTP is the primary faithfulness pin.

## Out of scope

- **v2 partial-clone `filter` args** — v2 unblocks them (ADR-005 §Negative), but 25.3 delivers
  incremental fetch only; the `filter` arg is future partial-clone work.
- **v2 over SSH** — sub-decision D5; SSH uses the corrected v1 path. A follow-on adds
  `GIT_PROTOCOL` env-forwarding to the SSH channel.
- **Multi-round v2 negotiation** (`ready`-driven progressive have batches, `wait-for-done`) — tsgit
  forces a single round with `done` (ADR-010). The `wanted-refs`/multi-round machinery is parsed
  but not driven.
- **`thin-pack` / `no-progress`** — still stripped on both v1 and v2 (`transport.md`); unrelated
  to negotiation.
- **Changing `MAX_HAVES` or the haves-derivation walk** — ADR-010's 256-cap single walk retained
  as-is for the v1 fallback; v2 sends the same haves + `done`.
- **`pull` changes** — none; it composes (R6).
