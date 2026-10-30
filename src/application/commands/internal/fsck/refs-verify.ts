import { errorDataCode } from '../../../../domain/error-data-code.js';
import type { FsckSeverityTable } from '../../../../domain/fsck/index.js';
import { retypeSeverity } from '../../../../domain/fsck/index.js';
import type { ObjectId, RefName } from '../../../../domain/objects/index.js';
import { zeroOid } from '../../../../domain/objects/index.js';
import type { Context } from '../../../../ports/context.js';
import type { RefIntegrityFinding, RefStore } from '../../../primitives/ref-store.js';
import { getRefStore } from '../../../primitives/ref-store.js';
import { resolveRef, UNREADABLE_REF_CODES } from '../../../primitives/resolve-ref.js';
import { EXIT_MISSING, EXIT_REFS_CONTENT } from './exit-codes.js';
import { objectIsPresent } from './object-presence.js';
import { snapshotWorktreeHeads, type UnreadableHead } from './roots.js';
import type { FsckFinding } from './types.js';
import type { ParseCheck } from './verified-copies.js';

type BadRefFinding = FsckFinding & { readonly type: 'bad-ref' };
type RefFinding = FsckFinding & { readonly type: 'bad-ref' | 'no-default-references' };

const NO_DEFAULT_REFERENCES: RefFinding = { type: 'no-default-references' };

/**
 * How a ref's target is judged present. `universe`: membership is proof.
 * `confirm-packs`: membership must be confirmed through `objectIsPresent`,
 * since `connectivityOnly`'s ungated universe may admit an oid whose pack
 * later fails its header gate. `probe-packs`: an oid outside a `--no-full`
 * universe is still present when a pack holds it — git's `parse_object`
 * reads packs whatever `--no-full` skipped verifying.
 */
export type RefTargetCheck = 'universe' | 'confirm-packs' | 'probe-packs';

async function isHeld(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  oid: ObjectId,
  check: RefTargetCheck,
): Promise<boolean> {
  if (universe.has(oid)) return check !== 'confirm-packs' || objectIsPresent(ctx, oid);
  return check === 'probe-packs' && objectIsPresent(ctx, oid);
}

/** git's `parse_object` on a ref tip: held, and the copy served first hashes to it. */
async function isKnownOid(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  oid: ObjectId,
  check: RefTargetCheck,
  parses: ParseCheck,
): Promise<boolean> {
  return (await isHeld(ctx, universe, oid, check)) && parses(oid);
}

/** One sub-check's own findings and the exit bits they carry. */
interface PassResult {
  readonly findings: ReadonlyArray<RefFinding>;
  readonly exitBit: number;
}

/**
 * git's deprecation notice for a symbolic link standing in for a symref:
 * one notice per link under `refs/`, defaulting to a warning that
 * contributes no exit bit — and re-typed, like every catalogue message, by
 * the repository's own `fsck.<msg-id>` table.
 */
function collectSymlinkNotices(
  integrityFindings: ReadonlyArray<RefIntegrityFinding>,
  severities: FsckSeverityTable,
): PassResult {
  const severity = retypeSeverity(severities, 'symlinkRef', 'warning');
  if (severity === 'ignore') return { findings: [], exitBit: 0 };
  const findings = integrityFindings
    .filter((finding) => finding.msgId === 'symlinkRef')
    .map(
      (finding): BadRefFinding => ({
        type: 'bad-ref',
        ref: finding.ref,
        msgId: 'symlinkRef',
        severity,
      }),
    );
  const exitBit = severity === 'error' && findings.length > 0 ? EXIT_REFS_CONTENT : 0;
  return { findings, exitBit };
}

/**
 * A ref whose content is not an object name: the content notice, gated by
 * `checkContentFormat`, with a severity `fsck.<msg-id>` can re-type. The zero
 * pointer git reports for it is not synthesised here: the snapshot carries one
 * for every ref the store lists by name and cannot resolve.
 *
 * git's ref-store content check stops at every symbolic link, so a name read
 * through one carries no content notice; its pointer still stands under the
 * linked name.
 */
function collectBadContentNotices(
  integrityFindings: ReadonlyArray<RefIntegrityFinding>,
  checkContentFormat: boolean,
  severities: FsckSeverityTable,
): PassResult {
  const severity = retypeSeverity(severities, 'badRefContent', 'error');
  const reportContent = checkContentFormat && severity !== 'ignore';
  const findings: BadRefFinding[] = [];
  let exitBit = 0;
  for (const finding of integrityFindings) {
    if (finding.msgId !== 'badRefContent') continue;
    const gradeContent = reportContent && !finding.throughSymlink;
    if (gradeContent) {
      findings.push({ type: 'bad-ref', ref: finding.ref, msgId: 'badRefContent', severity });
    }
    if (gradeContent && severity === 'error') exitBit |= EXIT_REFS_CONTENT;
  }
  return { findings, exitBit };
}

const HEAD = 'HEAD' as RefName;

type RefEntries = Awaited<ReturnType<RefStore['listRefs']>>;

/** The chain failures git's `refs_resolve_ref_unsafe` returns NULL on: the ref's content
 *  or its end names no object, it loops, or it outruns the depth git follows. A permission
 *  fault on the read is one too — git snapshots the ref with the zero oid. */
const ZERO_POINTER_CODES: ReadonlySet<string | undefined> = new Set([
  ...UNREADABLE_REF_CODES,
  'REF_NOT_FOUND',
  'PERMISSION_DENIED',
]);

/** The object a ref names — a symbolic one through its chain. A ref whose chain git cannot
 *  resolve is snapshotted with the zero oid; any other fault of the read propagates. */
async function targetOf(ctx: Context, entry: RefEntries[number]): Promise<ObjectId> {
  if (entry.value.kind === 'direct') return entry.value.id;
  try {
    // Stryker disable next-line ObjectLiteral: equivalent — peel defaults to false in resolveRef; {} and { peel: false } produce identical behavior.
    return await resolveRef(ctx, entry.name, { peel: false });
  } catch (err) {
    if (ZERO_POINTER_CODES.has(errorDataCode(err))) return zeroOid(ctx.hashConfig);
    throw err;
  }
}

/** What git's ref snapshot met: the targets it keeps, and the HEAD files it could not read. */
interface RefSnapshot {
  readonly targets: ReadonlyArray<{ readonly ref: RefName; readonly id: ObjectId }>;
  readonly unreadable: ReadonlyArray<UnreadableHead>;
}

/** git's snapshot order: every ref by name, then every worktree's HEAD. */
async function snapshotTargets(
  ctx: Context,
  entries: RefEntries,
  names: ReadonlyArray<RefName>,
): Promise<RefSnapshot> {
  const entryByName = new Map(entries.map((entry) => [entry.name, entry]));
  const refs: { readonly ref: RefName; readonly id: ObjectId }[] = [];
  for (const ref of names) {
    if (ref === HEAD) continue;
    const entry = entryByName.get(ref);
    refs.push({
      ref,
      id: entry === undefined ? zeroOid(ctx.hashConfig) : await targetOf(ctx, entry),
    });
  }
  const { heads, unreadable } = await snapshotWorktreeHeads(ctx);
  return { targets: [...refs, ...heads], unreadable };
}

/** git's `cannot read ref file` error: the file is skipped and the run exits with bit 8. */
const unreadableHeadFinding = ({ ref, path }: UnreadableHead): BadRefFinding => ({
  type: 'bad-ref',
  ref,
  msgId: 'cannotReadRef',
  severity: 'error',
  path,
  reason: 'PERMISSION_DENIED',
});

/** Every ref — symbolic ones through their chain, every worktree's HEAD
 *  included — naming an object the universe does not hold and no promisor
 *  pack promises: git's `invalid sha1 pointer`. When every snapshotted ref
 *  is one, git counts no default reference and says so. */
async function collectAbsentTargets(
  ctx: Context,
  entries: RefEntries,
  names: ReadonlyArray<RefName>,
  universe: ReadonlySet<ObjectId>,
  check: RefTargetCheck,
  promised: ReadonlySet<ObjectId>,
  parses: ParseCheck,
): Promise<PassResult> {
  const { targets, unreadable } = await snapshotTargets(ctx, entries, names);
  const unreadableFindings = unreadable.map(unreadableHeadFinding);
  const findings: RefFinding[] = [];
  for (const { ref, id } of targets) {
    if (promised.has(id) || (await isKnownOid(ctx, universe, id, check, parses))) continue;
    findings.push({ type: 'bad-ref', ref, msgId: 'badRefOid', severity: 'error', target: id });
  }
  const exitBit =
    (findings.length > 0 ? EXIT_MISSING : 0) | (unreadable.length > 0 ? EXIT_REFS_CONTENT : 0);
  const noDefault = findings.length === targets.length ? [NO_DEFAULT_REFERENCES] : [];
  return { findings: [...unreadableFindings, ...findings, ...noDefault], exitBit };
}

/**
 * Verify ref content format and OID-reachability.
 *
 * Two sub-checks run independently:
 * - **Content format** (gated by `checkReferences`): a malformed loose ref —
 *   reported by the store's own `verifyIntegrity` as `badRefContent` —
 *   contributes `badRefContent` (bit 8, gated).
 * - **OID presence** (always): git snapshots every ref by name. One whose
 *   chain resolves to an object must find it in the object universe, confirmed
 *   via `isKnownOid` as `check` says (see `RefTargetCheck`), and its served
 *   copy must hash to it (`parses`), as git's `parse_object` checks. One whose
 *   chain does not resolve — a body git rejects, a referent naming no ref, a
 *   loop, an unreadable file — is snapshotted with the zero oid, as is every
 *   ref leading to it: the names `listRefNames` holds that `listRefs` does
 *   not. Absent → `badRefOid` (bit 2), with AND without `--no-references`.
 *   An unborn branch behind HEAD never contributes. A promisor object
 *   (`promised`) is never absent, as git's `snapshot_ref` excuses it.
 */
export async function runRefsVerifyPass(
  ctx: Context,
  universe: ReadonlySet<ObjectId>,
  checkContentFormat: boolean,
  check: RefTargetCheck,
  severities: FsckSeverityTable,
  promised: ReadonlySet<ObjectId>,
  parses: ParseCheck,
): Promise<PassResult> {
  const refStore = getRefStore(ctx);
  const [entries, names, integrityFindings] = await Promise.all([
    refStore.listRefs(),
    refStore.listRefNames(),
    refStore.verifyIntegrity(),
  ]);

  const symlinks = collectSymlinkNotices(integrityFindings, severities);
  const badContent = collectBadContentNotices(integrityFindings, checkContentFormat, severities);
  const absent = await collectAbsentTargets(ctx, entries, names, universe, check, promised, parses);

  return {
    findings: [...symlinks.findings, ...badContent.findings, ...absent.findings],
    exitBit: symlinks.exitBit | badContent.exitBit | absent.exitBit,
  };
}
