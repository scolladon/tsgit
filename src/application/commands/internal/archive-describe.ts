import { errorDataCode } from '../../../domain/error-data-code.js';
import type { ObjectId } from '../../../domain/objects/index.js';
import type { DescribeArgs } from '../../../domain/pretty/describe-placeholder.js';
import type { Context } from '../../../ports/context.js';
import {
  abbreviateObjectId,
  abbreviateObjectIdFrom,
} from '../../primitives/abbreviate-object-id.js';
import { type DescribeResult, describe } from '../describe.js';

/** `parse_opt_abbrev_cb`'s floor for a non-zero `--abbrev`. */
const MINIMUM_ABBREV = 4;
const NAME_ONLY = 0;

/** `describe --abbrev=<n>` as git clamps it: 0 keeps the name alone, else 4…hex length. */
const describeAbbrevLength = (ctx: Context, abbrev: number): number =>
  abbrev === NAME_ONLY
    ? NAME_ONLY
    : Math.min(Math.max(abbrev, MINIMUM_ABBREV), ctx.hashConfig.hexLength);

const describeSuffix = async (
  ctx: Context,
  oid: ObjectId,
  abbrev: number | undefined,
): Promise<string | undefined> => {
  if (abbrev === undefined) return abbreviateObjectId(ctx, oid);
  const length = describeAbbrevLength(ctx, abbrev);
  return length === NAME_ONLY ? undefined : abbreviateObjectIdFrom(ctx, oid, length);
};

const renderDescription = async (
  ctx: Context,
  { name, distance, oid, exact }: DescribeResult,
  abbrev: number | undefined,
): Promise<string> => {
  if (exact) return name;
  const suffix = await describeSuffix(ctx, oid, abbrev);
  return suffix === undefined ? name : `${name}-${distance}-g${suffix}`;
};

/**
 * What `%(describe…)` prints: git runs `git describe <commit>` with the placeholder's options
 * and discards its stderr, so a describe refusal prints nothing.
 */
export const describeForFormat = async (
  ctx: Context,
  commitId: ObjectId,
  args: DescribeArgs,
): Promise<string> => {
  const { tags, match, exclude } = args;
  let result: DescribeResult;
  try {
    result = await describe(ctx, commitId, {
      ...(tags === undefined ? {} : { tags }),
      match,
      exclude,
    });
  } catch (error) {
    if (errorDataCode(error) === undefined) throw error;
    return '';
  }
  return renderDescription(ctx, result, args.abbrev);
};
