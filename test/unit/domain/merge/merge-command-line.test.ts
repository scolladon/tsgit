import { describe, expect, it } from 'vitest';
import type { TsgitError } from '../../../../src/domain/error.js';
import { parseMergeCommandLine } from '../../../../src/domain/merge/merge-command-line.js';

const refusal = (argv: ReadonlyArray<string>): unknown => {
  try {
    parseMergeCommandLine(argv);
    return undefined;
  } catch (error) {
    return (error as TsgitError).data;
  }
};

describe('parseMergeCommandLine', () => {
  describe.each([
    ['nothing', [], {}],
    ['--squash', ['--squash'], { squash: true }],
    ['--no-squash', ['--no-squash'], { squash: false }],
    ['--commit', ['--commit'], { commit: true }],
    ['--no-commit', ['--no-commit'], { commit: false }],
    ['--ff', ['--ff'], { fastForward: 'allow' }],
    ['--no-ff', ['--no-ff'], { fastForward: 'never' }],
    ['--ff-only', ['--ff-only'], { fastForward: 'only' }],
    ['--ff-only then --no-ff', ['--ff-only', '--no-ff'], { fastForward: 'never' }],
    [
      '--allow-unrelated-histories',
      ['--allow-unrelated-histories'],
      { allowUnrelatedHistories: true },
    ],
    [
      '--no-allow-unrelated-histories',
      ['--no-allow-unrelated-histories'],
      { allowUnrelatedHistories: false },
    ],
    ['--autostash', ['--autostash'], { autostash: true }],
    ['--no-autostash', ['--no-autostash'], { autostash: false }],
    ['--log', ['--log'], { log: true }],
    ['--log=5', ['--log=5'], { log: 5 }],
    ['--log=1k', ['--log=1k'], { log: 1024 }],
    ['--no-log', ['--no-log'], { log: false }],
    ['-s with a separate value', ['-s', 'resolve'], { strategy: ['resolve'] }],
    [
      '-s with an attached value',
      ['-sort', '--strategy=ours', '--strategy', 'resolve'],
      { strategy: ['ort', 'ours', 'resolve'] },
    ],
    ['--no-strategy', ['-s', 'ours', '--no-strategy'], { strategy: ['ours'] }],
    [
      '-X in every spelling',
      ['-Xours', '-X', 'patience', '--strategy-option=theirs', '--strategy-option', 'no-renames'],
      { strategyOptions: ['ours', 'patience', 'theirs', 'no-renames'] },
    ],
    [
      '--no-strategy-option',
      ['-X', 'ours', '--no-strategy-option', '-X', 'theirs'],
      { strategyOptions: ['theirs'] },
    ],
    ['-m twice', ['-m', 'a', '--message=b'], { message: 'a\n\nb' }],
    ['--no-message', ['-m', 'a', '--no-message'], { message: '' }],
    ['bundled short flags', ['-nqs', 'ours'], { strategy: ['ours'] }],
    [
      'output-only options',
      [
        '-n',
        '--stat',
        '--no-stat',
        '--summary',
        '--compact-summary',
        '--no-compact-summary',
        '-v',
        '--verbose',
        '-q',
        '--quiet',
        '--progress',
        '--no-progress',
      ],
      {},
    ],
    [
      'negations of options tsgit never takes',
      [
        '--no-edit',
        '--no-cleanup',
        '--no-rerere-autoupdate',
        '--no-verify-signatures',
        '--no-into-name',
        '--no-abort',
        '--no-quit',
        '--no-continue',
        '--overwrite-ignore',
        '--no-signoff',
        '--verify',
      ],
      {},
    ],
    ['arguments that are not options', ['side', '', '-', '--', '--bogus'], {}],
    ['an abbreviated flag', ['--squ'], { squash: true }],
    ['an abbreviated negation', ['--no-squ'], { squash: false }],
    [
      'an abbreviated valued option',
      ['--strategy-o=ours', '--strategy-opt', 'patience'],
      { strategyOptions: ['ours', 'patience'] },
    ],
    ['an abbreviation one option alone starts', ['--allow'], { allowUnrelatedHistories: true }],
    ['--no-verify, whose hooks tsgit never runs', ['--no-verify'], {}],
    ['--no-no-verify', ['--no-no-verify'], {}],
    ['-S', ['-S'], { sign: true }],
    ['-S with a key', ['-SKEY'], { sign: true, signKey: 'KEY' }],
    ['--gpg-sign with a key, then without', ['--gpg-sign=KEY', '--gpg-sign'], { sign: true }],
    ['--no-gpg-sign', ['-SKEY', '--no-gpg-sign'], { sign: false }],
  ] as const)('Given %s', (_, argv, expected) => {
    describe('When parsed', () => {
      it('Then it yields the options git sets', () => {
        // Arrange
        const sut = parseMergeCommandLine;

        // Act
        const result = sut(argv);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });

  describe.each([
    ['an unknown long option', ['--bogus'], { code: 'UNKNOWN_OPTION', option: '--bogus' }],
    ['an unknown switch', ['-x'], { code: 'UNKNOWN_OPTION', option: '-x' }],
    ['an unknown switch after a known one', ['-qx'], { code: 'UNKNOWN_OPTION', option: '-x' }],
    [
      'a negation git does not take',
      ['--no-ff-only'],
      { code: 'UNKNOWN_OPTION', option: '--no-ff-only' },
    ],
    [
      'a switch missing its value',
      ['-s'],
      { code: 'INVALID_OPTION', option: '-s', reason: 'requires a value' },
    ],
    [
      'an option missing its value',
      ['--strategy'],
      { code: 'INVALID_OPTION', option: '--strategy', reason: 'requires a value' },
    ],
    [
      'a flag given a value',
      ['--squash=1'],
      { code: 'INVALID_OPTION', option: '--squash', reason: 'takes no value' },
    ],
    [
      'a negation given a value',
      ['--no-squash=1'],
      { code: 'INVALID_OPTION', option: '--no-squash', reason: 'takes no value' },
    ],
    [
      'a log count that is not an integer',
      ['--log=abc'],
      {
        code: 'INVALID_OPTION',
        option: '--log',
        reason: 'expects an integer value with an optional k/m/g suffix',
      },
    ],
    [
      'a log count past a C int',
      ['--log=2g'],
      {
        code: 'INVALID_OPTION',
        option: '--log',
        reason: 'value 2g not in range [-2147483648,2147483647]',
      },
    ],
    [
      'a log count below a C int',
      ['--log=-3g'],
      {
        code: 'INVALID_OPTION',
        option: '--log',
        reason: 'value -3g not in range [-2147483648,2147483647]',
      },
    ],
    [
      'an option tsgit does not take',
      ['--signoff'],
      { code: 'UNSUPPORTED_OPERATION', operation: 'merge', reason: '--signoff' },
    ],
    [
      'a switch tsgit does not take',
      ['-e'],
      { code: 'UNSUPPORTED_OPERATION', operation: 'merge', reason: '-e' },
    ],
    [
      'a valued option tsgit does not take',
      ['-F', 'msg'],
      { code: 'UNSUPPORTED_OPERATION', operation: 'merge', reason: '-F' },
    ],
    [
      'the inverse of an option tsgit does not take',
      ['--no-overwrite-ignore'],
      { code: 'UNSUPPORTED_OPERATION', operation: 'merge', reason: '--no-overwrite-ignore' },
    ],
    [
      'an abbreviation several options start',
      ['--co'],
      { code: 'AMBIGUOUS_OPTION', option: '--co', candidates: ['--commit', '--continue'] },
    ],
    [
      'an abbreviation two valued options start, with its value',
      ['--strat=ours'],
      {
        code: 'AMBIGUOUS_OPTION',
        option: '--strat=ours',
        candidates: ['--strategy', '--strategy-option'],
      },
    ],
    [
      'a prefix of no- itself',
      ['--no'],
      { code: 'AMBIGUOUS_OPTION', option: '--no', candidates: ['--no-signoff', '--no-verify'] },
    ],
    [
      'an abbreviation an option and a no- option start',
      ['--ver'],
      { code: 'AMBIGUOUS_OPTION', option: '--ver', candidates: ['--verbose', '--no-no-verify'] },
    ],
    [
      'an abbreviated negation several options start',
      ['--no-ver'],
      { code: 'AMBIGUOUS_OPTION', option: '--no-ver', candidates: ['--no-verbose', '--no-verify'] },
    ],
    [
      'an abbreviation of an option tsgit does not take',
      ['--sig'],
      { code: 'UNSUPPORTED_OPERATION', operation: 'merge', reason: '--signoff' },
    ],
    [
      'an abbreviated negation of an option tsgit does not take',
      ['--no-overwrite'],
      { code: 'UNSUPPORTED_OPERATION', operation: 'merge', reason: '--no-overwrite-ignore' },
    ],
    [
      'an abbreviated option missing its value',
      ['--fi'],
      { code: 'INVALID_OPTION', option: '--file', reason: 'requires a value' },
    ],
  ] as const)('Given %s', (_, argv, expected) => {
    describe('When parsed', () => {
      it('Then it refuses as git does', () => {
        // Arrange
        const sut = refusal;

        // Act
        const result = sut(argv);

        // Assert
        expect(result).toEqual(expected);
      });
    });
  });
});
