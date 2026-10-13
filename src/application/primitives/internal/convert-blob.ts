import { eolRoundTripUnsafe } from '../../../domain/commands/error.js';
import type { ChunkTransform } from '../../../domain/eol/chunk-transform.js';
import { type EolSettings, outputLineEnding } from '../../../domain/eol/crlf-action.js';
import {
  crlfToGit,
  crlfToWorkingTree,
  type EolNotice,
  type LineEndingLoss,
} from '../../../domain/eol/crlf-conversion.js';
import { identToGit, identToWorkingTree } from '../../../domain/eol/ident.js';
import { createIdentTransform } from '../../../domain/eol/ident-transform.js';
import { createLfToCrlfTransform } from '../../../domain/eol/lf-to-crlf-transform.js';
import { gatherTextStats, isBinaryText } from '../../../domain/eol/text-stats.js';
import type { FilePath, ObjectId } from '../../../domain/objects/object-id.js';
import type { Context } from '../../../ports/context.js';
import { readBlob } from '../read-blob.js';
import { type Conversion, convertsInCore, isIdentityConversion } from '../resolve-conversion.js';
import { undefinedWhenBlobAbsent } from './absent-blob.js';
import { applyCleanFilter } from './apply-clean-filter.js';
import { applySmudgeFilter, type SmudgeTarget } from './apply-smudge-filter.js';
import { serializeAndHash } from './serialize-and-hash.js';

/** Selects the safecrlf arming and the index-CRLF rule. */
export type ConversionRoute = 'write' | 'compare' | 'renormalize';

export interface ToGitRequest {
  readonly path: FilePath;
  readonly bytes: Uint8Array;
  readonly conversion: Conversion;
  readonly route: ConversionRoute;
  readonly settings: EolSettings;
  /** The stage-0 entry, else stage 2, for the index-CRLF rule. */
  readonly indexBlob?: ObjectId;
}

export interface ToGitResult {
  readonly bytes: Uint8Array;
  readonly notice?: EolNotice;
}

/** git `has_crlf_in_index`: the stored blob is text and carries a CRLF. */
const indexBlobHasCrlf = async (ctx: Context, id: ObjectId | undefined): Promise<boolean> => {
  if (id === undefined) return false;
  const blob = await undefinedWhenBlobAbsent(() => readBlob(ctx, id));
  if (blob === undefined) return false;
  const stats = gatherTextStats(blob.content);
  return !isBinaryText(stats) && stats.crlf > 0;
};

/** safecrlf arms on writes only: a comparison or renormalization must not refuse. */
const noticeFor = (
  path: FilePath,
  route: ConversionRoute,
  settings: EolSettings,
  roundTrip: LineEndingLoss | undefined,
): EolNotice | undefined => {
  if (route !== 'write' || roundTrip === undefined || settings.safeCrlf === false) return undefined;
  const notice = { path, ...roundTrip };
  if (settings.safeCrlf === true) throw eolRoundTripUnsafe(notice);
  return notice;
};

export const convertToGit = async (ctx: Context, request: ToGitRequest): Promise<ToGitResult> => {
  const { path, bytes, conversion, route, settings, indexBlob } = request;
  // Stryker disable next-line ConditionalExpression: equivalent — an identity conversion runs the pipeline as no-ops that hand the same bytes back by reference, so skipping the early return changes nothing observable.
  if (isIdentityConversion(conversion)) return { bytes };
  const cleaned = await applyCleanFilter(ctx, ctx.command, path, bytes, conversion.filter);
  const crlf = await crlfToGit({
    bytes: cleaned,
    action: conversion.crlf,
    settings,
    renormalize: route === 'renormalize',
    indexHasCrlf: () => indexBlobHasCrlf(ctx, indexBlob),
  });
  const notice = noticeFor(path, route, settings, crlf.roundTrip);
  return {
    bytes: conversion.ident ? identToGit(crlf.bytes) : crlf.bytes,
    ...(notice !== undefined && { notice }),
  };
};

export interface ToWorkingTreeRequest {
  /** The blob is the id an ident expansion writes; a normalizing smudge does not forward it. */
  readonly target: SmudgeTarget & { readonly blob: ObjectId };
  readonly conversion: Conversion;
  readonly settings: EolSettings;
  /** git `renormalize_buffer`: CRLF is skipped unless a smudge or process driver is named. */
  readonly normalizing?: boolean;
}

const namesSmudgeOrProcess = ({ filter }: Conversion): boolean =>
  // Stryker disable next-line ConditionalExpression: equivalent — a non-external filter carries no smudge or process field, so the kind test only narrows the type.
  filter.kind === 'external' && (filter.smudge !== undefined || filter.process !== undefined);

const withoutBlob = (target: SmudgeTarget, normalizing: boolean): SmudgeTarget => {
  if (!normalizing) return target;
  const { blob: _unsent, ...metadataFree } = target;
  return metadataFree;
};

export const convertToWorkingTree = async (
  ctx: Context,
  request: ToWorkingTreeRequest,
): Promise<Uint8Array> => {
  const { target, conversion, settings, normalizing = false } = request;
  // Stryker disable next-line ConditionalExpression: equivalent — an identity conversion runs the pipeline as no-ops that hand the same bytes back by reference, so skipping the early return changes nothing observable.
  if (isIdentityConversion(conversion)) return target.bytes;
  const expanded = conversion.ident ? identToWorkingTree(target.bytes, target.blob) : target.bytes;
  const skipsCrlf = normalizing && !namesSmudgeOrProcess(conversion);
  const converted = skipsCrlf ? expanded : crlfToWorkingTree(expanded, conversion.crlf, settings);
  const smudged = { ...withoutBlob(target, normalizing), bytes: converted };
  return applySmudgeFilter(ctx, ctx.command, smudged, conversion.filter);
};

const composeTransforms = (first: ChunkTransform, second: ChunkTransform): ChunkTransform => ({
  push: (chunk) => first.push(chunk).flatMap((piece) => second.push(piece)),
  // Stryker disable next-line MethodExpression: equivalent — first's pending bytes at flush are an ident keyword prefix that never holds LF, so routing them through second changes nothing.
  flush: () => [...first.flush().flatMap((piece) => second.push(piece)), ...second.flush()],
});

/** git `get_stream_filter`: ident then LF to CRLF; `undefined` writes the blob raw. */
export const workingTreeStreamTransform = (
  conversion: Conversion,
  blob: ObjectId,
  settings: EolSettings,
): ChunkTransform | undefined => {
  if (isIdentityConversion(conversion) || convertsInCore(conversion)) return undefined;
  const steps: ChunkTransform[] = [];
  if (conversion.ident) steps.push(createIdentTransform(blob));
  if (outputLineEnding(conversion.crlf, settings) === 'crlf') steps.push(createLfToCrlfTransform());
  return steps.reduce<ChunkTransform | undefined>(
    (composed, step) => (composed === undefined ? step : composeTransforms(composed, step)),
    undefined,
  );
};

/** The id the in-core ident expander writes: the hash of the bytes as a blob. */
const blobIdOf = async (ctx: Context, bytes: Uint8Array): Promise<ObjectId> =>
  (await serializeAndHash(ctx, { type: 'blob', id: '' as ObjectId, content: bytes })).id;

/** git `renormalize_buffer`: out to the working tree form, then back in on the renormalize route. */
export const renormalizeBuffer = async (
  ctx: Context,
  path: FilePath,
  bytes: Uint8Array,
  conversion: Conversion,
  settings: EolSettings,
): Promise<Uint8Array> => {
  // Stryker disable next-line ConditionalExpression: equivalent — an identity conversion runs the pipeline as no-ops that hand the same bytes back by reference, so skipping the early return changes nothing observable.
  if (isIdentityConversion(conversion)) return bytes;
  const blob = conversion.ident ? await blobIdOf(ctx, bytes) : ('' as ObjectId);
  const workingTree = await convertToWorkingTree(ctx, {
    target: { path, blob, bytes },
    conversion,
    settings,
    normalizing: true,
  });
  const result = await convertToGit(ctx, {
    path,
    bytes: workingTree,
    conversion,
    route: 'renormalize',
    settings,
  });
  return result.bytes;
};
