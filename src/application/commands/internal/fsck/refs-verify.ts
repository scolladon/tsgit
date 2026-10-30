import { errorDataCode } from '../../../../domain/error-data-code.js';
import type { FsckConfiguredSeverity, FsckSeverityTable } from '../../../../domain/fsck/index.js';
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
type UnreadablePathFinding = FsckFinding & { readonly type: 'unreadable-ref-path' };
type RefsVerifyEndedFinding = FsckFinding & { readonly type: 'refs-verify-ended' };
type RefFinding = FsckFinding & {
  readonly type: 'bad-ref' | 'no-default-references' | 'unreadable-ref-path' | 'refs-verify-ended';
};

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

const REFS_PREFIX = 'refs/';

type ContentFinding = Extract<
  RefIntegrityFinding,
  {
    readonly msgId:
      | 'badRefContent'
      | 'cannotReadRef'
      | 'badReferentName'
      | 'symrefTargetIsNotARef'
      | 'trailingRefContent'
      | 'refMissingNewline';
  }
>;

/** The configured grade of each message the content pass reports. */
interface ContentGrades {
  readonly badContent: FsckConfiguredSeverity;
  readonly badReferent: FsckConfiguredSeverity;
  readonly notARef: FsckConfiguredSeverity;
  readonly trailing: FsckConfiguredSeverity;
  readonly missingNewline: FsckConfiguredSeverity;
}

const gradesOf = (severities: FsckSeverityTable): ContentGrades => ({
  badContent: retypeSeverity(severities, 'badRefContent', 'error'),
  badReferent: retypeSeverity(severities, 'badReferentName', 'error'),
  notARef: retypeSeverity(severities, 'symrefTargetIsNotARef', 'info'),
  trailing: retypeSeverity(severities, 'trailingRefContent', 'info'),
  missingNewline: retypeSeverity(severities, 'refMissingNewline', 'info'),
});

const unreadablePathFinding = ({
  path,
  operation,
}: Extract<
  RefIntegrityFinding,
  { readonly msgId: 'unreadableRefPath' }
>): UnreadablePathFinding => ({
  type: 'unreadable-ref-path',
  path,
  operation,
  reason: 'PERMISSION_DENIED',
});

const refsVerifyEndedFinding = ({
  ref,
  path,
  reason,
}: Extract<
  RefIntegrityFinding,
  { readonly msgId: 'refsVerifyEnded' }
>): RefsVerifyEndedFinding => ({
  type: 'refs-verify-ended',
  ref,
  path,
  reason,
});

const CONTENT_MSG_IDS: ReadonlySet<string> = new Set([
  'badRefContent',
  'cannotReadRef',
  'badReferentName',
  'symrefTargetIsNotARef',
  'trailingRefContent',
  'refMissingNewline',
]);

const isContentFinding = (finding: RefIntegrityFinding): finding is ContentFinding =>
  CONTENT_MSG_IDS.has(finding.msgId);

/**
 * The severity a loose-ref content finding is reported at, or `undefined` when it is not
 * reported. Each message is re-typed by its own `fsck.<msg-id>`; `cannotReadRef` is always
 * an error — no setting and no `--strict` re-types it. A ref whose referent is an error
 * is not also told it points at a non-ref.
 */
function contentSeverity(
  finding: ContentFinding,
  grades: ContentGrades,
  shadowed: ReadonlySet<RefName>,
): BadRefFinding['severity'] | undefined {
  if (finding.msgId === 'cannotReadRef') return 'error';
  if (finding.msgId === 'symrefTargetIsNotARef') {
    const dropped = grades.badReferent === 'error' && shadowed.has(finding.ref);
    return dropped || grades.notARef === 'ignore' ? undefined : grades.notARef;
  }
  const grade = ownGrade(finding.msgId, grades);
  return grade === 'ignore' ? undefined : grade;
}

const ownGrade = (
  msgId: ContentFinding['msgId'],
  grades: ContentGrades,
): FsckConfiguredSeverity => {
  if (msgId === 'badReferentName') return grades.badReferent;
  if (msgId === 'trailingRefContent') return grades.trailing;
  if (msgId === 'refMissingNewline') return grades.missingNewline;
  return grades.badContent;
};

function contentFinding(
  finding: ContentFinding,
  severity: BadRefFinding['severity'],
): BadRefFinding {
  if (finding.msgId === 'cannotReadRef') {
    const { ref, path, reason } = finding;
    return { type: 'bad-ref', ref, msgId: 'cannotReadRef', severity, path, reason };
  }
  if (finding.msgId === 'badRefContent') {
    return { type: 'bad-ref', ref: finding.ref, msgId: 'badRefContent', severity };
  }
  if (finding.msgId === 'refMissingNewline') {
    return { type: 'bad-ref', ref: finding.ref, msgId: 'refMissingNewline', severity };
  }
  if (finding.msgId === 'trailingRefContent') {
    const { ref, trailing } = finding;
    const base = { type: 'bad-ref', ref, msgId: 'trailingRefContent', severity } as const;
    return trailing === undefined ? base : { ...base, trailing };
  }
  const { ref, msgId, referent } = finding;
  return { type: 'bad-ref', ref, msgId, severity, referent };
}

const refsWithInvalidReferent = (
  integrityFindings: ReadonlyArray<RefIntegrityFinding>,
): ReadonlySet<RefName> =>
  new Set(
    integrityFindings.flatMap((finding) =>
      finding.msgId === 'badReferentName' ? [finding.ref] : [],
    ),
  );

/** The notices of the walk that are not content verdicts: a refused path, and git's
 *  deprecation notice for a symbolic link standing in for a symref — re-typed, like every
 *  catalogue message, by the repository's own `fsck.<msg-id>` table. */
const walkNoticeOf = (
  finding: RefIntegrityFinding,
  symlinkGrade: FsckConfiguredSeverity,
): BadRefFinding | UnreadablePathFinding | undefined => {
  if (finding.msgId === 'unreadableRefPath') return unreadablePathFinding(finding);
  if (finding.msgId !== 'symlinkRef' || symlinkGrade === 'ignore') return undefined;
  return { type: 'bad-ref', ref: finding.ref, msgId: 'symlinkRef', severity: symlinkGrade };
};

/**
 * Every notice of git's ref-store walk, in the walk's order — a link's deprecation notice
 * ahead of the referent verdicts that follow it. A ref whose content is not an object name,
 * or whose file the permissions refuse: the content notice, gated by `checkContentFormat`.
 * The zero pointer git reports for either is not synthesised here: the snapshot carries one for every ref the store lists by name and
 * cannot resolve. git's root-ref check (the files beside `refs/`) ends at its first
 * error-severity finding, an unreadable file included.
 */
function collectContentNotices(
  integrityFindings: ReadonlyArray<RefIntegrityFinding>,
  checkContentFormat: boolean,
  severities: FsckSeverityTable,
): PassResult {
  const grades = gradesOf(severities);
  const symlinkGrade = retypeSeverity(severities, 'symlinkRef', 'warning');
  const shadowed = refsWithInvalidReferent(integrityFindings);
  const findings: Array<BadRefFinding | UnreadablePathFinding> = [];
  let rootCheckEnded = false;
  for (const finding of integrityFindings) {
    if (!checkContentFormat) continue;
    const walkNotice = walkNoticeOf(finding, symlinkGrade);
    if (walkNotice !== undefined) findings.push(walkNotice);
    if (!isContentFinding(finding)) continue;
    const severity = contentSeverity(finding, grades, shadowed);
    if (severity === undefined) continue;
    const isRootRef = !finding.ref.startsWith(REFS_PREFIX);
    if (isRootRef && rootCheckEnded) continue;
    findings.push(contentFinding(finding, severity));
    rootCheckEnded ||= isRootRef && severity === 'error';
  }
  const exitBit = findings.some((found) => found.type === 'bad-ref' && found.severity === 'error')
    ? EXIT_REFS_CONTENT
    : 0;
  return { findings, exitBit };
}

/** The end of git's refs-verify walk on a link it cannot resolve: reported whatever the
 *  findings before it, and it fails the verify. */
function collectWalkEnd(
  integrityFindings: ReadonlyArray<RefIntegrityFinding>,
  checkContentFormat: boolean,
): PassResult {
  if (!checkContentFormat) return { findings: [], exitBit: 0 };
  const findings = integrityFindings.flatMap((finding) =>
    finding.msgId === 'refsVerifyEnded' ? [refsVerifyEndedFinding(finding)] : [],
  );
  return { findings, exitBit: findings.length > 0 ? EXIT_REFS_CONTENT : 0 };
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

/** How the snapshot's targets are judged present, and whether the unreadable HEADs count. */
interface PresenceCheck {
  readonly universe: ReadonlySet<ObjectId>;
  readonly check: RefTargetCheck;
  readonly promised: ReadonlySet<ObjectId>;
  readonly parses: ParseCheck;
  readonly checkContentFormat: boolean;
}

/** Every ref — symbolic ones through their chain, every worktree's HEAD
 *  included — naming an object the universe does not hold and no promisor
 *  pack promises: git's `invalid sha1 pointer`. When every snapshotted ref
 *  is one, git counts no default reference and says so. */
async function collectAbsentTargets(
  ctx: Context,
  entries: RefEntries,
  names: ReadonlyArray<RefName>,
  presence: PresenceCheck,
): Promise<PassResult> {
  const { universe, check, promised, parses, checkContentFormat } = presence;
  const { targets, unreadable: snapshotUnreadable } = await snapshotTargets(ctx, entries, names);
  const unreadable = checkContentFormat ? snapshotUnreadable : [];
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

  const badContent = collectContentNotices(integrityFindings, checkContentFormat, severities);
  const walkEnd = collectWalkEnd(integrityFindings, checkContentFormat);
  const absent = await collectAbsentTargets(ctx, entries, names, {
    universe,
    check,
    promised,
    parses,
    checkContentFormat,
  });

  return {
    findings: [...badContent.findings, ...walkEnd.findings, ...absent.findings],
    exitBit: badContent.exitBit | walkEnd.exitBit | absent.exitBit,
  };
}
