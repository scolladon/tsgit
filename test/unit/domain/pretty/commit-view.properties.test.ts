import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseCommitView } from '../../../../src/domain/pretty/commit-view.js';

const NUM_RUNS = 200;

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array | undefined): string | undefined =>
  bytes === undefined ? undefined : new TextDecoder().decode(bytes);

const hexArb = fc.stringMatching(/^[0-9a-f]{40}$/);
const identArb = fc.stringMatching(
  /^[A-Za-z]{1,8} <[a-z]{1,8}@[a-z]{1,4}> [0-9]{1,10} [+-][0-9]{4}$/,
);
const encodingArb = fc.option(fc.stringMatching(/^[A-Za-z0-9-]{1,12}$/), { nil: undefined });
// A non-blank line starts with a visible byte; later bytes may be anything but LF and NUL.
const lineArb = fc.stringMatching(/^[A-Za-z][A-Za-z \t]{0,10}$/);
const subjectArb = fc.array(lineArb, { minLength: 1, maxLength: 3 });
const bodyArb = fc.array(fc.stringMatching(/^[A-Za-z \t]{0,10}$/), { maxLength: 4 }).chain((rest) =>
  fc.oneof(
    fc.constant(''),
    lineArb.map((first) => `${[first, ...rest].join('\n')}\n`),
  ),
);

interface CommitFields {
  readonly tree: string;
  readonly parents: ReadonlyArray<string>;
  readonly author: string;
  readonly committer: string;
  readonly encoding: string | undefined;
  readonly subject: ReadonlyArray<string>;
  readonly body: string;
}

const fieldsArb: fc.Arbitrary<CommitFields> = fc.record({
  tree: hexArb,
  parents: fc.array(hexArb, { maxLength: 3 }),
  author: identArb,
  committer: identArb,
  encoding: encodingArb,
  subject: subjectArb,
  body: bodyArb,
});

/** Test-side serialiser, independent of the parser under test. */
const serialise = (fields: CommitFields): { raw: Uint8Array; message: string; subject: string } => {
  const headers = [
    `tree ${fields.tree}`,
    ...fields.parents.map((parent) => `parent ${parent}`),
    `author ${fields.author}`,
    `committer ${fields.committer}`,
    ...(fields.encoding === undefined ? [] : [`encoding ${fields.encoding}`]),
  ];
  const subject = `${fields.subject.join('\n')}\n`;
  const message = fields.body === '' ? subject : `${subject}\n${fields.body}`;
  return { raw: encode(`${headers.join('\n')}\n\n${message}`), message, subject };
};

const isWithin = (part: Uint8Array | undefined, raw: Uint8Array): boolean =>
  part === undefined ||
  (part.buffer === raw.buffer &&
    part.byteOffset >= raw.byteOffset &&
    part.byteOffset + part.length <= raw.byteOffset + raw.length);

describe('Given arbitrary bytes, When parsing a commit view', () => {
  it('Then it never throws and every byte field is a slice of the input', () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 96 }), (raw) => {
        // Arrange
        const sut = parseCommitView;

        // Act
        const result = sut(raw);

        // Assert
        const slices = [
          result.author,
          result.committer,
          result.encoding,
          result.message,
          result.subject,
          result.body,
        ];
        expect(slices.every((slice) => isWithin(slice, raw))).toBe(true);
        expect(result.body.length).toBeLessThanOrEqual(result.message.length);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

describe('Given a commit serialised from generated fields, When parsing it', () => {
  it('Then every field is recovered', () => {
    fc.assert(
      fc.property(fieldsArb, (fields) => {
        // Arrange
        const sut = parseCommitView;
        const { raw, message, subject } = serialise(fields);

        // Act
        const result = sut(raw);

        // Assert
        expect({
          tree: result.tree,
          parents: result.parents,
          author: decode(result.author),
          committer: decode(result.committer),
          encoding: decode(result.encoding),
          message: decode(result.message),
          subject: decode(result.subject),
          body: decode(result.body),
        }).toEqual({
          tree: fields.tree,
          parents: fields.parents,
          author: fields.author,
          committer: fields.committer,
          encoding: fields.encoding,
          message,
          subject,
          body: fields.body,
        });
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
