/** The `git describe` options a `%(describe:…)` placeholder hands to the describe run. */
export interface DescribeArgs {
  readonly tags: boolean | undefined;
  readonly abbrev: number | undefined;
  readonly match: ReadonlyArray<string>;
  readonly exclude: ReadonlyArray<string>;
}

export interface ParsedDescribe {
  readonly args: DescribeArgs;
  readonly length: number;
}

export const DESCRIBE_PREFIX = '(describe';

const NO_ARGS: DescribeArgs = { tags: undefined, abbrev: undefined, match: [], exclude: [] };
const CLOSE = ')';
const SEPARATOR = ',';
const ASSIGN = '=';
const ARG_LIST = ':';
const STRTOL_DECIMAL = /^[\t\n\v\f\r ]*[+-]?\d+$/;
const TRUE_WORDS: ReadonlyArray<string> = ['true', 'yes', 'on'];
const FALSE_WORDS: ReadonlyArray<string> = ['false', 'no', 'off', ''];
const GIT_INTEGER = /^[\t\n\v\f\r ]*[+-]?(?:0x([0-9a-f]+)|(0[0-7]*)|([1-9]\d*))[kmg]?$/i;
const NON_ZERO_DIGIT = /[1-9a-f]/i;

interface ArgMatch {
  readonly value: string | undefined;
  readonly next: number;
}

const utf8FromByteString = (text: string): string =>
  new TextDecoder().decode(Uint8Array.from(text, (char) => char.charCodeAt(0)));

type Step = { readonly args: DescribeArgs; readonly next: number } | 'none' | 'fail';

/** git's `match_placeholder_arg_value`: `name[=value]` ended by `,` (consumed) or `)` (kept). */
const matchArg = (text: string, at: number, name: string): ArgMatch | undefined => {
  if (!text.startsWith(name, at)) return undefined;
  let cursor = at + name.length;
  let value: string | undefined;
  if (text[cursor] === ASSIGN) {
    const rest = text.slice(cursor + 1).search(/[,)]/);
    // Stryker disable next-line ConditionalExpression: equivalent — with no `,` or `)` left the cursor stops on `=` instead of the end, and neither is a separator nor a close, so the match fails either way
    const end = rest === -1 ? text.length : cursor + 1 + rest;
    value = text.slice(cursor + 1, end);
    cursor = end;
  }
  if (text[cursor] === SEPARATOR) return { value, next: cursor + 1 };
  return text[cursor] === CLOSE ? { value, next: cursor } : undefined;
};

/** git's `git_parse_maybe_bool`; `undefined` where git yields -1. */
const parseMaybeBool = (value: string): boolean | undefined => {
  const word = value.toLowerCase();
  if (TRUE_WORDS.includes(word)) return true;
  if (FALSE_WORDS.includes(word)) return false;
  if (!GIT_INTEGER.test(value)) return undefined;
  // Outside its digits an integer holds only blanks, a sign, `0x` and a `kmg` unit, none a non-zero digit.
  return NON_ZERO_DIGIT.test(value);
};

const stepTags = (text: string, at: number, args: DescribeArgs): Step => {
  const found = matchArg(text, at, 'tags');
  if (!found) return 'none';
  const tags = found.value === undefined ? true : parseMaybeBool(found.value);
  return { args: tags === undefined ? args : { ...args, tags }, next: found.next };
};

const stepAbbrev = (text: string, at: number, args: DescribeArgs): Step => {
  const found = matchArg(text, at, 'abbrev');
  if (!found) return 'none';
  if (!found.value || !STRTOL_DECIMAL.test(found.value)) return 'fail';
  return { args: { ...args, abbrev: Number.parseInt(found.value, 10) }, next: found.next };
};

const stepPattern = (
  text: string,
  at: number,
  args: DescribeArgs,
  name: 'match' | 'exclude',
): Step => {
  const found = matchArg(text, at, name);
  if (!found) return 'none';
  if (!found.value) return 'fail';
  return {
    args: { ...args, [name]: [...args[name], utf8FromByteString(found.value)] },
    next: found.next,
  };
};

const stepOne = (text: string, at: number, args: DescribeArgs): Step => {
  for (const step of [
    () => stepTags(text, at, args),
    () => stepAbbrev(text, at, args),
    () => stepPattern(text, at, args, 'exclude'),
    () => stepPattern(text, at, args, 'match'),
  ]) {
    const result = step();
    if (result !== 'none') return result;
  }
  return 'none';
};

/** git's `parse_describe_args`: the cursor after the last option, or the start on failure. */
const parseArgList = (text: string, start: number): { args: DescribeArgs; next: number } => {
  let current = { args: NO_ARGS, next: start };
  for (;;) {
    const step = stepOne(text, current.next, current.args);
    if (step === 'fail') return { args: NO_ARGS, next: start };
    if (step === 'none') return current;
    current = step;
  }
};

/**
 * Parses `(describe[:args])` at `fmt[at]` (the `(`); `undefined` where git declines the
 * placeholder. Pattern values are read as UTF-8, as the describe run receives them.
 */
export const parseDescribePlaceholder = (
  fmt: Uint8Array,
  at: number,
): ParsedDescribe | undefined => {
  const text = Array.from(fmt.subarray(at), (byte) => String.fromCharCode(byte)).join('');
  if (!text.startsWith(DESCRIBE_PREFIX)) return undefined;
  const afterPrefix = DESCRIBE_PREFIX.length;
  const parsed =
    text[afterPrefix] === ARG_LIST
      ? parseArgList(text, afterPrefix + 1)
      : { args: NO_ARGS, next: afterPrefix };
  if (text[parsed.next] !== CLOSE) return undefined;
  return { args: parsed.args, length: parsed.next + 1 };
};
