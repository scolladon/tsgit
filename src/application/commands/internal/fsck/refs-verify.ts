import type { ObjectId, RefName } from '../../../../domain/objects/index.js';
import { ZERO_OID } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import { enumerateRefs } from '../../../primitives/enumerate-refs.js';
import { probeLooseOid } from '../../../primitives/internal/loose-oid-cache.js';
import type { PackRegistry } from '../../../primitives/pack-registry.js';
import { getPackRegistry } from '../../../primitives/read-object.js';
import { getRefStore } from '../../../primitives/ref-store.js';
import { EXIT_MISSING, EXIT_REFS_CONTENT } from './exit-codes.js';
import type { FsckFinding } from './types.js';

type BadRefFinding = FsckFinding & { readonly type: 'bad-ref' };

/** Matches valid SHA-1 (40-hex) or SHA-256 (64-hex) OID. */
const OID_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/**
 * Whether an invalid-pointer verdict (bit 8) should ride alongside a miss's
 * bit 2, for `oid`. Two independent sources, both mode-independent, both
 * lazy and memoised for the whole pass (never consulted until a target
 * actually misses):
 *
 * - An `.idx` this generation could not even PARSE (`health()`'s `unusable`,
 *   `layer: 'index'`) has no derivable oid list, so membership cannot be
 *   checked — but this only reports as a REPOSITORY-WIDE hedge when there is
 *   no other WORKING pack left to authoritatively rule a miss out
 *   (`accessible.length === 0`): measured against git 2.55.0, a repository
 *   whose ONLY pack is in this state reports every otherwise-unresolvable
 *   target as an invalid pointer (`C1`/`C2`), but the SAME fault sitting
 *   alongside an unrelated, healthy, WORKING pack leaves an unrelated miss
 *   at bit 2 alone — real git can still trust that working pack's own clean
 *   "not present" verdict.
 * - `registry.knownUnreadableOids()` is a PRECISE, per-oid set: a `.idx`
 *   this generation DID parse, whose `.pack` is unreadable or absent. A
 *   fault here must NOT taint an unrelated miss — measured against git
 *   2.55.0, a `.pack` fault nothing references leaves an unrelated missing
 *   ref at bit 2 alone.
 */
function createInvalidPointerCheck(registry: PackRegistry): (oid: ObjectId) => Promise<boolean> {
  let indexLayerFault: Promise<boolean> | undefined;
  let knownUnreadable: Promise<ReadonlySet<ObjectId>> | undefined;
  return async (oid: ObjectId): Promise<boolean> => {
    indexLayerFault ??= registry
      .health()
      .then(
        ({ accessible, unusable }) =>
          accessible.length === 0 && unusable.some((entry) => entry.layer === 'index'),
      );
    if (await indexLayerFault) return true;
    knownUnreadable ??= registry.knownUnreadableOids();
    return (await knownUnreadable).has(oid);
  };
}

/**
 * Whether `oid` resolves to a readable object: present in `universe`, and,
 * when `universe` may optimistically admit an oid whose housing pack later
 * turns out inaccessible (`connectivityOnly`'s ungated pack half), confirmed
 * via a targeted loose-then-pack probe rather than trusted at face value.
 * Never attempts to read the object's own bytes — `probeLooseOid` is a
 * cached existence check and `registry.lookup` stops at the pack's header
 * gate, the same structural probe `health()` performs.
 */
async function isKnownOid(
  ctx: Context,
  registry: PackRegistry,
  universe: ReadonlySet<ObjectId>,
  oid: ObjectId,
  confirmPackAccessibility: boolean,
): Promise<boolean> {
  if (!universe.has(oid)) return false;
  if (!confirmPackAccessibility) return true;
  if (await probeLooseOid(ctx, oid)) return true;
  return (await registry.lookup(oid)) !== undefined;
}

/**
 * Classify and report findings for a single loose ref's raw content.
 * Returns findings + accumulated exit-bit contribution.
 *
 * Content format check (badRefContent) gated by `checkContentFormat`.
 * Absent-OID check (badRefOid) always run, matching git's behaviour with
 * `--no-references` (pinned: matrix #9a, exit 2 both ways).
 */
async function checkLooseRef(
  ctx: Context,
  registry: PackRegistry,
  ref: RefName,
  raw: string,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
  confirmPackAccessibility: boolean,
  isInvalidPointer: (oid: ObjectId) => Promise<boolean>,
): Promise<{ readonly findings: ReadonlyArray<BadRefFinding>; readonly exitBit: number }> {
  const content = raw.replace(/[\r\n]+$/, '');

  if (content.startsWith('ref: ')) {
    // Symref — absent symref targets are not an error (unborn branch = OK, matrix #9c)
    return { findings: [], exitBit: 0 };
  }

  if (!OID_RE.test(content)) {
    // Malformed content: badRefContent (gated) + synthesised zero-OID pointer (always)
    const badFindings: BadRefFinding[] = [];
    let bit = EXIT_MISSING; // zero-OID pointer always contributes bit 2
    if (checkContentFormat) {
      badFindings.push({ type: 'bad-ref', ref, msgId: 'badRefContent', severity: 'error' });
      bit |= EXIT_REFS_CONTENT;
    }
    badFindings.push({
      type: 'bad-ref',
      ref,
      msgId: 'badRefOid',
      severity: 'error',
      target: ZERO_OID,
    });
    if (await isInvalidPointer(ZERO_OID)) bit |= EXIT_REFS_CONTENT;
    return { findings: badFindings, exitBit: bit };
  }

  const oid = content as ObjectId;
  if (await isKnownOid(ctx, registry, universe, oid, confirmPackAccessibility)) {
    return { findings: [], exitBit: 0 };
  }
  // Valid OID format but absent from object store
  let bit = EXIT_MISSING;
  if (await isInvalidPointer(oid)) bit |= EXIT_REFS_CONTENT;
  return {
    findings: [{ type: 'bad-ref', ref, msgId: 'badRefOid', severity: 'error', target: oid }],
    exitBit: bit,
  };
}

/**
 * Verify ref content format and OID-reachability.
 *
 * Two sub-checks run independently:
 * - **Content format** (gated by `checkReferences`): loose-ref must be a hex OID or
 *   `ref: <target>`. Malformed → `badRefContent` (bit 8) + synthesised zero-OID → `badRefOid`
 *   (bit 2). Pinned: matrix #9b, composite exit 10 = 2|8.
 * - **OID presence** (always): ref OID (loose + packed) must be in object universe.
 *   Absent → `badRefOid` (bit 2). Pinned: matrix #9a, exit 2 same with/without `--no-references`.
 *
 * A target present in `universe` but whose housing pack the scan already knows it cannot
 * fully account for (a `.idx` it parsed naming an unreadable `.pack`, or an `.idx` with no
 * `.pack` at all) is git-faithfully an invalid pointer, not a plain miss — it additionally
 * contributes bit 8, mode-independently (`confirmPackAccessibility` only widens WHICH targets
 * this pass treats as missing when `universe` was built without pack-accessibility narrowing;
 * the invalid-pointer bit itself never depends on it).
 */
export async function runRefsVerifyPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
  confirmPackAccessibility: boolean,
): Promise<{ readonly findings: ReadonlyArray<BadRefFinding>; readonly exitBit: number }> {
  const findings: BadRefFinding[] = [];
  let exitBit = 0;

  const registry = getPackRegistry(ctx);
  const isInvalidPointer = createInvalidPointerCheck(registry);
  const refStore = getRefStore(ctx);
  const refNames = await enumerateRefs(ctx);

  for (const ref of refNames) {
    const raw = await refStore.readLooseRaw(ref);
    if (raw !== undefined) {
      const { findings: f, exitBit: b } = await checkLooseRef(
        ctx,
        registry,
        ref,
        raw,
        universe,
        checkContentFormat,
        confirmPackAccessibility,
        isInvalidPointer,
      );
      findings.push(...f);
      exitBit |= b;
      continue;
    }

    // Not a loose ref — check packed-refs entry for OID presence
    const packed = await refStore.getPackedRefs();
    for (const entry of packed.entries) {
      if (entry.name !== ref) continue;
      if (!(await isKnownOid(ctx, registry, universe, entry.id, confirmPackAccessibility))) {
        findings.push({
          type: 'bad-ref',
          ref,
          msgId: 'badRefOid',
          severity: 'error',
          target: entry.id,
        });
        exitBit |= EXIT_MISSING;
        if (await isInvalidPointer(entry.id)) exitBit |= EXIT_REFS_CONTENT;
      }
      break;
    }
  }

  return { findings, exitBit };
}
