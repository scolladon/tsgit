# Design — Incremental fetch negotiation (Smart-HTTP)

> Brief: make `fetch` retrieve new objects when the client holds a base — the remote
> advances `C0 → C1`, the client has `C0`, and `fetch` must pull `C1`. Backlog 25.3.
> Status: draft → self-reviewed ×3 → accepted

## Context

`fetch` and `clone` share one v1 `git-upload-pack` client (`application/commands/internal/upload-pack-client.ts`)
and one pack-fetch primitive (`application/primitives/fetch-pack.ts` → `downloadPack`).
Ref discovery goes through the transport-agnostic `GitServiceSession` seam
([ADR-434](../adr/434-git-service-session-transport-seam.md)) so the same code path serves HTTP and SSH.

Two accepted ADRs govern the current shape:

- [ADR-005](../adr/005-clone-protocol-v1.md) — Smart-HTTP **protocol v1** only; single round.
- [ADR-010](../adr/010-fetch-haves-strategy.md) — **Strategy 1**: derive `have`s from a capped
  (`MAX_HAVES = 256`) graph walk over `refs/remotes/<remote>/*`, send them all, then `done`, and
  receive the pack in **one round-trip**. `multi_ack_detailed` is deliberately *not* requested.

ADR-010 asserts Strategy 1 "returns the pack in one round-trip … works with `multi_ack_detailed`
disabled." **That premise is sound; the implementation contradicts it.** The client cannot fetch new
objects when it holds a base: `want C1 / have C0 / done` returns *no pack*. `clone` (no haves) and a
no-op `fetch` (remote unchanged) both work — the first because it sends no haves, the second because
"no pack" is coincidentally the right answer. Only the "remote advanced" case is broken. Backlog 25.3;
also blocks the submodule incremental-update path (24.1b currently refuses `OBJECT_NOT_FOUND`).

### Empirical root cause (pinned against real `git` + `git-http-backend`, git 2.55.0)

The domain layer is **already negotiation-capable**: `domain/protocol/upload-pack.ts`
`buildUploadPackRequest` emits `have` lines + an optional `done`, and `parseUploadPackResponse` already
parses `AckEntry` (`ack | continue | common | ready`) and `nak`. The bug is a **request-framing defect**,
not a missing negotiation loop.

git's request grammar (pack-protocol.txt) is:

```
upload-request = want-list flush-pkt *shallow *depth [filter]
upload-haves   = have-list compute-end
compute-end    = flush-pkt / PKT-LINE("done" LF)     ← EITHER a flush OR done, never both
```

`buildUploadPackRequest` builds `haveStream` via `encodePktStream(...)`, which **unconditionally appends
a `0000` flush** (`domain/protocol/pkt-line.ts:68`). So for haves + `done: true` it emits:

```
want C1 <caps>\n | 0000 | have C0\n | 0000 | done\n
                          ^^^^^^^^^^^^^^^^ spurious flush = compute-end
```

The server reads `have C0\n 0000` as `compute-end = flush-pkt` — a **non-final negotiation round** — so it
answers with ACKs and **no pack**, then ignores the trailing `done`. `downloadPack` drains a zero-byte
body and returns the "already up to date" empty result. For `clone`, `haves` is empty, so no flush is
emitted (`want … 0000 done`) and the pack arrives — which is why clone works and hid the bug.

The existing unit tests encode the gap exactly: `upload-pack.test.ts` covers `haves: []` + `done: true`
(clone → `want / flush / done`) and `haves: [...]` + **no** `done` (negotiation round → `want / flush /
have / have / flush`), but there is **no test for `haves: [...]` + `done: true`** — the incremental case.

### Pinned wire matrix

Raw POSTs of each request framing to a real `git-http-backend` serving a repo advanced `C0 → C1`
(`have C0`, `want C1`; `GIT_*` scrubbed, signing off, `GIT_CONFIG_NOSYSTEM=1`):

| # | Request framing | multi_ack | Server response | Pack? |
|---|---|---|---|---|
| A | `want C1 / 0000 / have C0 / 0000 / done` (tsgit **today**) | stripped | `ACK C0` only | **no** |
| B | `want C1 / 0000 / have C0 / done` (framing fix) | stripped | `ACK C0` + PACK | **yes** |
| C | `want C1 / 0000 / have C0 / done / 0000` (git's exact bytes) | requested | `ACK C0 common` + `ACK C0` + PACK | yes |
| D | `want C1 / 0000 / have C0 / done` (framing fix) | requested | `ACK C0 common` + `ACK C0` + PACK | yes |
| E | `want C0 / 0000 / have C0 / done` (no-op, framing fix) | requested | `ACK C0 common` + `ACK C0` + **empty PACK** (0 objects, 32 B) | yes (empty) |
| F | `want C1 / 0000 / done` (no haves = clone) | requested | `NAK` + full PACK | yes |

Real git's incremental-fetch POST body, captured with `GIT_TRACE_PACKET`:

```
want <C1> multi_ack_detailed no-done side-band-64k thin-pack no-progress include-tag ofs-delta \
     deepen-since deepen-not agent=git/2.55.0-Darwin
0000
have <C0>
done
```

Findings that drive the design:

1. **The framing fix alone fixes the bug** (B): removing the spurious flush before `done` makes the
   server return the pack — *without* `multi_ack_detailed`. This is exactly ADR-010's Strategy 1 working
   as specified.
2. **`multi_ack_detailed` changes only the ACK wire, not the result** (B vs D produce the *same* pack for
   the same `have`/`want`/`done`). The prime directive binds observable **data and on-disk state**
   ([ADR-226](../adr/226-git-faithfulness-prime-directive.md), [ADR-249](../adr/249-describe-structured-data-only.md)),
   which is byte-identical either way. The `common` ACK lines are already parsed.
3. **The trailing flush after `done` is optional** (C vs D are identical). tsgit emits none today; no change.
4. **After the fix, a no-op fetch returns an empty (0-object) pack, not zero bytes** (E). Real git never
   sends this round at all — it short-circuits via `everything_local` (verified: a no-op fetch sends
   **0** want/have/ACK lines and writes **no pack**). tsgit must not write an empty pack on the no-op path.

## Requirements

- **R1 (the gap).** After the remote advances `C0 → C1` with the client holding `C0`, `fetch` retrieves
  `C1`'s objects, updates `refs/remotes/<remote>/main` to `C1`, and `C1` is reachable locally.
- **R2 (no regression).** `clone` and no-op `fetch` are unchanged in observable on-disk state. In
  particular, a no-op `fetch` writes **no** pack file (no empty `pack-*.pack`).
- **R3 (faithful framing).** For haves + `done`, the request frames the have-list per git's `compute-end`
  grammar (terminated by `done`, not by a flush), pinned against real git bytes.
- **R4 (faithfulness pin).** Resulting pack objects and `refs/remotes/*` oids are byte-for-byte identical
  to canonical git performing the same incremental fetch — proven by a cross-tool interop test. (Reflog
  *message* faithfulness is pre-existing behaviour this change does not touch; a reflog entry is written
  for each ref update as today.)
- **R5 (mutation-testable).** The framing decision and no-op handling are unit-testable in the
  domain/application tier (Stryker mutates `src` against `test/unit` only; `test/integration/*` is skipped),
  with interop as the faithfulness pin.
- **R6 (`pull` composes).** `pull`'s over-the-wire fast-forward / merge works for the advanced-remote case
  with **no** change to `pull` — it composes `fetch` + merge.
- **R7 (both transports).** The fix lives in the transport-agnostic request builder, so incremental fetch
  works over HTTP and SSH alike.

## Design

### Core: fix the `compute-end` framing in `buildUploadPackRequest`

`domain/protocol/upload-pack.ts` `buildUploadPackRequest` currently concatenates
`wantStream + haveStream + trailer`, where `haveStream = encodePktStream(haves.map(haveLine))` always
carries a trailing flush. The fix makes the have-list terminator depend on `done`:

- **`done === true`** → emit the want-list flush (from `encodePktStream(wantPayloads)`), then have
  pkt-lines with **no** trailing flush, then the `done` pkt-line. Grammar:
  `want-list flush have-list done`.
- **`done` falsy** (a genuine negotiation round, e.g. the existing "haves and no done" test) → keep the
  current behaviour: `have-list` terminated by a flush.
- **`haves` empty** → unchanged (clone: `want-list flush done`).

This is a ~3-line change plus a new helper that concatenates pkt-lines without the terminating flush
(the flush-appending behaviour of `encodePktStream` is the source of the bug and must not be reused for
the `done` branch). It is purely additive to the request grammar; `depth`/`filter`/multi-want paths are
untouched. It fixes both HTTP (stateless-rpc) and SSH (stateful) — R7 — because both call this one builder.

No ADR divergence is required: the fix makes Strategy 1 behave as [ADR-010](../adr/010-fetch-haves-strategy.md)
already specifies.

### No-op / empty-pack faithfulness

With correct framing the server always returns *something* — at minimum a 32-byte 0-object pack (case E,
`objectCount = 0` confirmed on the wire) — so `downloadPack`'s existing `packBytes.length === 0` "already
up to date" guard no longer fires for HTTP. `fetchPack` gains an **additional** guard: treat a **0-object
pack** as "nothing to write" — skip `writePackArtifacts` so no empty `pack-*.pack` / `.idx` lands on disk
(R2), returning the same empty result shape. The existing zero-byte guard is retained (defensive, still
reachable for a server that closes without a pack). `parsePackHeader`/`walkPackEntries` already expose the
object count; the new guard is a single `entries.length === 0` check before artifact writing.

Optionally (Decision #3) `fetch` also short-circuits like git's `everything_local`: if every wanted oid
already exists locally, skip the exchange POST entirely and return the no-op result. This matches git's
wire (no request sent) and avoids a pointless round-trip, at the cost of a per-want existence check.

### `multi_ack_detailed` capability

`selectFetchCapabilities` (upload-pack-client.ts:37) strips `multi_ack_detailed`. The framing fix works
with it stripped (case B) — the recommended, ADR-010-consistent path. Un-stripping it (Decision #2) moves
the wire closer to git (`ACK … common` lines, which the parser already handles) with **zero** change to
the resulting pack/refs — it would amend ADR-010's "not requested" note but change no observable state.
Either way, **no multi-round loop is added**: the client sends all (≤256) haves + `done` in one POST, per
ADR-010. Multi-round batching (`ready`/`no-done`) is a bandwidth optimisation the fixtures cannot observe
and is out of scope (Decision #1 / ADR-010 defers it).

### Response parsing — already handled

`parseUploadPackResponse` already: parses `ACK <oid> common` and the final `ACK <oid>` (cases C/D), the
lone final `ACK` (case B), and `NAK` (case F); buffers the first non-meta pkt-line and streams the
side-band pack body from there. No parser change is needed — confirmed against every pinned case above.

### Error semantics

Unchanged. A non-200 discovery/exchange still raises `HTTP_ERROR`; a malformed pack still raises via
`verifyPackTrailer` / `walkPackEntries`; an unknown ACK status still raises `unknownAckStatus`. The 0-object
pack is a *success* (empty result), not an error.

## Decision candidates

| # | Choice | Alternatives (≤3) | Recommendation | Why |
|---|---|---|---|---|
| 1 | **Negotiation strategy** (the load-bearing one) | **A.** Fix the `compute-end` framing, keep ADR-010 single-round v1 (`have`s + `done` in one POST). **B.** Adopt full v1 multi-round stateless-rpc negotiation (progressive `have` batches, read `ACK common`/`ready`, then `done`) — reopens ADR-010 Strategy 2. **C.** Adopt protocol **v2** `fetch` command (`version=2` capability, `ls-refs` ref discovery, `fetch` with `acknowledgments`/`packfile` sections) — new subsystem, reopens ADR-005. | **A** | Empirically A alone fixes the bug (case B/D) and produces byte-identical packs/refs/reflogs to git (R4). B and C add large surface (multi-round response state machine / new ref-discovery + v2 section parser + `Git-Protocol` header plumbing in the CGI harness) for **zero** observable-result difference on any fixture — they only optimise bandwidth on deeply-diverged histories or modernise the wire. A realizes the accepted ADR-010 with no divergence; B/C each reopen an accepted ADR. Defer B/C as their own backlog items. |
| 2 | **`multi_ack_detailed` advertisement** (only if #1 = A) | **A.** Keep it stripped — matches ADR-010 as written (case B). **B.** Un-strip it — wire matches git's single-round ACK shape (case D), parser already handles `common`. | **A** | Case B (stripped) and case D (un-stripped) produce identical packs/refs — the difference is wire-cosmetic and the prime directive does not bind the negotiation wire. Keeping it stripped needs no ADR change and is the smallest diff. Choose un-strip only if wire fidelity to git is judged worth an ADR-010 amendment (it is nearly free — one filter term). |
| 3 | **No-op / empty-pack handling** (required to hold R2) | **A.** `fetchPack` treats a 0-object pack as "nothing to write" (skip artifacts). **B.** A + `fetch` `everything_local` short-circuit (skip the POST when all wants are local). **C.** Do nothing. | **B** | C is rejected: it writes a spurious empty `pack-*.pack` on every no-op fetch — an on-disk-state faithfulness violation git never commits. A is the minimum that holds R2 (git-faithful on disk). B additionally matches git's wire (verified: git sends 0 want/have on a no-op) and avoids a wasted round-trip for a small, well-contained check — recommended, but A is an acceptable minimal fallback. |

## Test strategy

**Unit (`test/unit`, mutation-visible — R5):**

- `domain/protocol/upload-pack.test.ts` — **new** `Given haves and done=true` → decode the built request
  and assert the kind sequence `data(want) / flush / data(have) / data(done)` with **no flush between the
  last have and `done`**, and the `done` payload is `done\n`. This is the primary kill-test for the fix
  (a StringLiteral/boolean mutant that re-introduces the flush must fail it). Keep the existing
  `Given haves and no done` (negotiation round → trailing flush) and `Given wants and done=true` (clone).
- `application/primitives/fetch-pack.test.ts` — a 0-object pack (32-byte header+trailer) is drained and
  produces an empty result **without** writing `pack-*.pack` / `.idx` (Decision #3-A). Assert no
  `writeExclusive` for the pack path.
- `application/commands/fetch.test.ts` — advanced-remote path threads the real `have`/`want` and updates
  the remote-tracking ref; and (if Decision #3-B) the `everything_local` short-circuit makes **no**
  `exchange` call when every want is local.
- `upload-pack-client` `selectFetchCapabilities` — assert whether `multi_ack_detailed` is retained,
  per the Decision #2 outcome.

**Property test (`upload-pack.properties.test.ts`, per CLAUDE.md lens 1/3):** `buildUploadPackRequest` is a
serializer over an algebraic grammar (`wants` / `haves` / `depth` / `filter` / `done`). Property: for any
non-empty `wants`, any `haves`, and any `done`, decoding the built request yields
`want⁺ [depth] [filter] flush have* (flush XOR done)` — `depth`/`filter` sit inside the want-list before
its terminating flush, and the have-list is terminated by a flush **iff** `done` is false and by `done`
**iff** `done` is true, never both. This proves the grammar-level invariant
the example tests document literally. Tier: `numRuns: 100`.

**Interop (`test/integration/network`, the faithfulness pin — R4):** a **new**
`incremental-fetch-http-backend.test.ts` (sibling of `fetch-http-backend.test.ts`, reusing
`test/bench/support/http-backend-server.ts` `startGitHttpBackend`). Unlike the static `clone-source`
fixture, this needs a **mutable** source: `git init --bare` a source in a mktemp dir, seed `C0`, clone it
with tsgit over HTTP, advance the remote to `C1` (a real `git push` from a seed worktree into the bare
repo — `GIT_*` scrubbed, signing off), then tsgit `fetch` over HTTP and assert `refs/remotes/origin/main
== C1`, `C1`'s objects present, and full history reachable. Twin the fetch with real git into a parallel
clone and compare `refs/remotes/*` oids + the fetched object set. Gate on `git --version` + discoverable
`git-http-backend`; skip under
Stryker (`process.cwd().includes('.stryker-tmp')`), per the existing suites.

**`pull` composition (R6):** a `pull-http-backend` advanced-remote scenario (fast-forward after the remote
advances) confirms `pull` composes with no `pull` change; may be a case added to the existing
`pull-http-backend.test.ts`.

**SSH (R7):** the fix is transport-agnostic; an advanced-remote case in `ssh-transport-interop.test.ts`
optionally pins SSH incremental fetch, but HTTP is the primary faithfulness pin.

## Out of scope

- **Full v1 multi-round negotiation** (progressive `have` batches, `ready`, `no-done`) — bandwidth
  optimisation with no observable-result difference on the fixtures; ADR-010 already defers it (Decision #1-B).
- **Protocol v2** (`version=2`, `ls-refs`, `fetch` command sections) — the backlog *title* but not the
  requirement; a separate subsystem reopening ADR-005 and needing `Git-Protocol` header plumbing in the
  CGI harness (Decision #1-C). Incremental fetch is fully delivered without it.
- **`thin-pack` / `no-progress`** — still stripped ([transport.md](transport.md)); unrelated to negotiation.
- **Changing `MAX_HAVES` or the haves-derivation walk** — ADR-010's 256-cap single walk is retained as-is.
- **`pull` changes** — none; it composes (R6).
