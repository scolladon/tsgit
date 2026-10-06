/**
 * git's `parse_options` over `git merge`'s option table, for a command line
 * held in config (`branch.<b>.mergeoptions`): the options tsgit's merge
 * models are set, the ones that only shape output are accepted, and the
 * others refuse until tsgit runs them. Arguments that are not options, and
 * everything after `--`, are ignored as git ignores them there.
 */
import { ambiguousOption, invalidOption, unknownOption } from '../commands/error.js';
import { GIT_C_INT_MAX, GIT_C_INT_MIN, parseGitInt } from '../config/config-ini.js';
import { unsupportedOperation } from '../error.js';

/** The merge options a command line sets; an absent field was not given. */
export interface MergeCommandLine {
  readonly fastForward?: 'only' | 'never' | 'allow';
  readonly squash?: boolean;
  readonly commit?: boolean;
  readonly strategy?: ReadonlyArray<string>;
  readonly strategyOptions?: ReadonlyArray<string>;
  readonly message?: string;
  readonly log?: boolean | number;
  readonly allowUnrelatedHistories?: boolean;
  readonly autostash?: boolean;
}

type Apply = (line: MergeCommandLine, value: string | undefined, spelt: string) => MergeCommandLine;

interface MergeOption {
  readonly long?: string;
  readonly short?: string;
  readonly value: 'none' | 'required' | 'optional';
  /** Whether git also takes `--no-<long>`. */
  readonly negatable: boolean;
  readonly set: Apply;
  readonly unset: Apply;
}

interface Parsed {
  readonly line: MergeCommandLine;
  readonly next: number;
}

const END_OF_OPTIONS = '--';
const NEGATION = 'no-';
const REQUIRES_VALUE = 'requires a value';
const TAKES_NO_VALUE = 'takes no value';
const NOT_AN_INTEGER = 'expects an integer value with an optional k/m/g suffix';
/** git's `value <v> for option `<name>' not in range [<min>,<max>]`, past the option. */
const outOfRange = (value: string): string =>
  `value ${value} not in range [${GIT_C_INT_MIN},${GIT_C_INT_MAX}]`;
const PARAGRAPH_BREAK = '\n\n';

const ignore: Apply = (line) => line;

const refuse: Apply = (_line, _value, spelt) => {
  throw unsupportedOperation('merge', spelt);
};

const assign =
  <K extends keyof MergeCommandLine>(key: K, value: MergeCommandLine[K]): Apply =>
  (line) => ({ ...line, [key]: value });

const appendTo =
  (key: 'strategy' | 'strategyOptions'): Apply =>
  (line, value) => ({ ...line, [key]: [...(line[key] ?? []), value!] });

/** git's `option_parse_message`: each `-m` is a paragraph of its own. */
const appendMessage: Apply = (line, value) => ({
  ...line,
  message: line.message ? `${line.message}${PARAGRAPH_BREAK}${value!}` : value!,
});

/** `--log` alone asks for git's default count; `--log=<n>` is a C `int` with a k/m/g unit. */
const setLog: Apply = (line, value, spelt) => {
  if (value === undefined) return { ...line, log: true };
  const parsed = parseGitInt(value, BigInt(GIT_C_INT_MAX));
  if (!parsed.ok)
    throw invalidOption(
      spelt,
      parsed.reason === 'out of range' ? outOfRange(value) : NOT_AN_INTEGER,
    );
  if (parsed.value < GIT_C_INT_MIN) throw invalidOption(spelt, outOfRange(value));
  return { ...line, log: parsed.value };
};

const flag = (long: string, set: Apply, unset: Apply, short?: string): MergeOption => ({
  long,
  ...(short === undefined ? {} : { short }),
  value: 'none',
  negatable: true,
  set,
  unset,
});

const valued = (long: string, set: Apply, unset: Apply, short?: string): MergeOption => ({
  ...flag(long, set, unset, short),
  value: 'required',
});

/** `builtin/merge.c`'s `builtin_merge_options`, in its order. */
const OPTIONS: ReadonlyArray<MergeOption> = [
  { short: 'n', value: 'none', negatable: false, set: ignore, unset: ignore },
  flag('stat', ignore, ignore),
  flag('summary', ignore, ignore),
  flag('compact-summary', ignore, ignore),
  { ...flag('log', setLog, assign('log', false)), value: 'optional' },
  flag('squash', assign('squash', true), assign('squash', false)),
  flag('commit', assign('commit', true), assign('commit', false)),
  flag('edit', refuse, ignore, 'e'),
  valued('cleanup', refuse, ignore),
  flag('ff', assign('fastForward', 'allow'), assign('fastForward', 'never')),
  { ...flag('ff-only', assign('fastForward', 'only'), ignore), negatable: false },
  flag('rerere-autoupdate', refuse, ignore),
  flag('verify-signatures', refuse, ignore),
  valued('strategy', appendTo('strategy'), ignore, 's'),
  valued('strategy-option', appendTo('strategyOptions'), assign('strategyOptions', []), 'X'),
  valued('message', appendMessage, assign('message', ''), 'm'),
  { ...valued('file', refuse, ignore, 'F'), negatable: false },
  valued('into-name', refuse, ignore),
  flag('verbose', ignore, ignore, 'v'),
  flag('quiet', ignore, ignore, 'q'),
  flag('abort', refuse, ignore),
  flag('quit', refuse, ignore),
  flag('continue', refuse, ignore),
  flag(
    'allow-unrelated-histories',
    assign('allowUnrelatedHistories', true),
    assign('allowUnrelatedHistories', false),
  ),
  flag('progress', ignore, ignore),
  { ...flag('gpg-sign', refuse, ignore, 'S'), value: 'optional' },
  flag('autostash', assign('autostash', true), assign('autostash', false)),
  flag('overwrite-ignore', ignore, refuse),
  flag('signoff', refuse, ignore),
  // tsgit's merge runs no pre-merge-commit or commit-msg hook, so it already merges as `--no-verify` does.
  flag('no-verify', ignore, ignore),
];

/** git's `parse_options` over `argv`, as `parse_branch_merge_options` runs it. */
export const parseMergeCommandLine = (argv: ReadonlyArray<string>): MergeCommandLine => {
  let parsed: Parsed = { line: {}, next: 0 };
  while (parsed.next < argv.length && argv[parsed.next] !== END_OF_OPTIONS) {
    parsed = parseArgument(argv, parsed);
  }
  return parsed.line;
};

const parseArgument = (argv: ReadonlyArray<string>, { line, next }: Parsed): Parsed => {
  const arg = argv[next]!;
  if (!arg.startsWith('-') || arg === '-') return { line, next: next + 1 };
  return arg.startsWith('--') ? parseLong(argv, line, next) : parseShorts(argv, line, next);
};

const parseLong = (argv: ReadonlyArray<string>, line: MergeCommandLine, at: number): Parsed => {
  const body = argv[at]!.slice(2);
  const equals = body.indexOf('=');
  const name = equals < 0 ? body : body.slice(0, equals);
  const attached = equals < 0 ? undefined : body.slice(equals + 1);
  const { option, negated } = findLong(argv[at]!, name);
  const spelt = `--${negated ? NEGATION : ''}${option.long!}`;
  if (negated || option.value === 'none') {
    if (attached !== undefined) throw invalidOption(spelt, TAKES_NO_VALUE);
    return { line: (negated ? option.unset : option.set)(line, undefined, spelt), next: at + 1 };
  }
  if (attached !== undefined || option.value === 'optional') {
    return { line: option.set(line, attached, spelt), next: at + 1 };
  }
  return takeNextValue(argv, line, at, option, spelt);
};

interface LongMatch {
  readonly option: MergeOption;
  readonly negated: boolean;
}

/** What `--<name>` asks for once git's `parse_long_opt` peeled its `no-` prefixes. */
interface LongName {
  readonly rest: string;
  readonly negated: boolean;
  /** `--no-no-<name>`: only an option itself named `no-<name>` can match. */
  readonly doubled: boolean;
}

const peelNegation = (name: string): LongName => {
  if (!name.startsWith(NEGATION)) return { rest: name, negated: false, doubled: false };
  const rest = name.slice(NEGATION.length);
  if (!rest.startsWith(NEGATION)) return { rest, negated: true, doubled: false };
  return { rest: rest.slice(NEGATION.length), negated: false, doubled: true };
};

/** git's `register_abbrev`: a second abbreviation makes the first one ambiguous. */
interface Abbreviations {
  readonly abbrev?: LongMatch;
  readonly ambiguous?: LongMatch;
}

const register = ({ abbrev }: Abbreviations, match: LongMatch): Abbreviations =>
  abbrev === undefined ? { abbrev: match } : { abbrev: match, ambiguous: abbrev };

const spellMatch = ({ option, negated }: LongMatch): string =>
  `--${negated ? NEGATION : ''}${option.long!}`;

interface Reading {
  readonly own: LongName;
  readonly negated: boolean;
}

/** How `option` reads the wanted name, or `undefined` where git's `parse_long_opt` loop skips it. */
const readingOf = (option: MergeOption, wanted: LongName): Reading | undefined => {
  if (option.long === undefined) return undefined;
  const own = peelNegation(option.long);
  if (!own.negated && wanted.doubled) return undefined;
  const negated = wanted.negated !== own.negated;
  if (negated && !option.negatable) return undefined;
  return { own, negated };
};

const exactLong = (wanted: LongName): LongMatch | undefined => {
  for (const option of OPTIONS) {
    const reading = readingOf(option, wanted);
    if (reading?.own.rest === wanted.rest) return { option, negated: reading.negated };
  }
  return undefined;
};

/** Every option the name abbreviates; a prefix of `no-` itself abbreviates each negatable one. */
const abbreviationsOf = (arg: string, wanted: LongName): Abbreviations => {
  const prefixOfNegation = NEGATION.startsWith(arg.slice(2));
  let found: Abbreviations = {};
  for (const option of OPTIONS) {
    const reading = readingOf(option, wanted);
    if (reading === undefined) continue;
    if (reading.own.rest.startsWith(wanted.rest))
      found = register(found, { option, negated: reading.negated });
    if (option.negatable && prefixOfNegation)
      found = register(found, { option, negated: !reading.own.negated });
  }
  return found;
};

/** git's `parse_long_opt`: an exact name wins at once; otherwise a unique abbreviation. */
const findLong = (arg: string, name: string): LongMatch => {
  const wanted = peelNegation(name);
  return exactLong(wanted) ?? settleAbbreviation(arg, abbreviationsOf(arg, wanted));
};

const settleAbbreviation = (arg: string, { abbrev, ambiguous }: Abbreviations): LongMatch => {
  if (ambiguous !== undefined)
    throw ambiguousOption(arg, [spellMatch(ambiguous), spellMatch(abbrev!)]);
  if (abbrev === undefined) throw unknownOption(arg);
  return abbrev;
};

/** A bundle of switches (`-nqs ours`): flags apply in turn; the first valued one takes the rest. */
const parseShorts = (argv: ReadonlyArray<string>, start: MergeCommandLine, at: number): Parsed => {
  const arg = argv[at]!;
  let line = start;
  for (let index = 1; index < arg.length; index++) {
    const spelt = `-${arg[index]!}`;
    const option = OPTIONS.find((candidate) => candidate.short === arg[index]);
    if (option === undefined) throw unknownOption(spelt);
    if (option.value === 'none') {
      line = option.set(line, undefined, spelt);
      continue;
    }
    const rest = arg.slice(index + 1);
    if (rest !== '' || option.value === 'optional') {
      return { line: option.set(line, rest === '' ? undefined : rest, spelt), next: at + 1 };
    }
    return takeNextValue(argv, line, at, option, spelt);
  }
  return { line, next: at + 1 };
};

const takeNextValue = (
  argv: ReadonlyArray<string>,
  line: MergeCommandLine,
  at: number,
  option: MergeOption,
  spelt: string,
): Parsed => {
  const value = argv[at + 1];
  if (value === undefined) throw invalidOption(spelt, REQUIRES_VALUE);
  return { line: option.set(line, value, spelt), next: at + 2 };
};
